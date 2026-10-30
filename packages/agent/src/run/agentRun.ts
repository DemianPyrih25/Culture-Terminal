import {
  DEFAULT_RUN_LIMITS,
  FindingIdSchema,
  isId,
  isPublicDataTool,
  normalizeIntent,
  RunLimits,
  SkillId,
  StepIdSchema,
  type ErrorCode,
  type EventInputOf,
  type Flag,
  type Intent,
  type Limitation,
  type MarketId,
  type Phase,
  type RegisteredEntity,
  type Report,
  type SafetyCategory,
  type StepId,
  type SubmitPlanInputShape,
  type TerminalRunStatus,
} from "@ct/contracts";
import { publicEventFrom } from "@ct/publicdata";
import { qlooErrorCode, qlooEventFrom } from "@ct/qloo";
import { runAnalyst, type AnalystOutcome, type AnalystToolCall, type AnalystToolEnd } from "../analyst";
import { ANALYST_MODELS, CLERK_MODEL } from "../anthropic";
import { assembleReport, buildIncompleteReport, draftCitedMetrics, type ReportContext } from "../assemble";
import { createRunBudget } from "../budget";
import { checkReport, repairMessage, type CheckResult } from "../checker";
import { runClerk, sanitizeQuestion } from "../clerk";
import { createRunLedger, type RunLedger } from "../ledger";
import { DIRECTOR_PROMPT } from "../prompts";
import { createEntityRegistry } from "../registry";
import type { AgentRunOptions, AgentRunResult } from "../run";
import { POSITION_FAILED, recordPosition } from "../report/position";
import { recordScorecard } from "../scorecard";
import { SIDE_TIMEOUTS, startSideContext, WEB_SEARCH_USD_PER_SEARCH, type ContextCache, type SideClient, type SideConfig, type SideContextHandle, type SideContextResult } from "../side";
import { areaMentionsToGeo } from "./areaMentions";
import { runAreaMetros } from "./areas";
import { loadRunAudiences, NO_RUN_AUDIENCES } from "./audiences";
import { buildRunCandidates, withJobCandidates, withKnownMarkets } from "./candidates";
import { ALL_SKILLS, toolLabel, UNAVAILABLE_SKILLS } from "./catalogue";
import { conceptPartlyTagged, conceptSubstitutes, questionConcepts, unusedRefs } from "./conceptCoverage";
import { buildRunContext, evidenceStatus, findingLeads, type RanCall } from "./context";
import { createFollowupDeadline, type FollowupDeadline } from "./followup";
import { gazetteer } from "./gazetteer";
import {
  EMPTY_GATE,
  expectedMissingText,
  gateEvidence,
  privatePersonNames,
  privatePersonRefusal,
  runResolutionGate,
  type GateResolved,
} from "./gate";
import { RunEvents, RunMeter } from "./meter";
import { compareCities, MARKET_CATALOGUE, runMarkets, unknownMarketIssues } from "./markets";
import { unconfiguredTools } from "./publicConfig";
import { chainFeed, emptyScan, namedAreaIds, planScan, type ScanPlan } from "./scan";
import { estimateSkillCalls, runSkillCall, shortError, SkillsRan, type SkillCallOutcome, type SkillRunnerDeps } from "./tools";

/**
 * runAgent's body (PLAN §4.1 A–H, SPEC §4.1): CLERK → resolution gate → opening scan in parallel
 * with ANALYST turn 1 → follow-ups → submit_report → CHECKER (≤1 repair) → ASSEMBLE. Every stage
 * reports through the caller's emit; the caller writes run.end from the returned status. No work
 * outlives the call: background scan and tool runs are stopped or awaited before it returns.
 */

/**
 * The fixed safety categories CLERK refuses on (clerk.md "Safety"); financial_advice is answered as
 * taste-signal health. out_of_scope is no refusal category (D41): a business question is read as its
 * nearest job, and only a question with no business or taste content at all gets OUT_OF_SCOPE_CARD.
 */
const REFUSAL_CATEGORIES: ReadonlySet<SafetyCategory> = new Set([
  "private_individual",
  "sensitive_inference",
  "political_targeting",
  "eligibility",
  "residential_screening",
  "injection",
]);

/** The plain card for a question with no business or taste content at all (D41): no reframe, no Qloo call. */
export const OUT_OF_SCOPE_CARD =
  "This is not something Culture Terminal answers: it reads audience taste for business decisions about brands, " +
  "places, markets, partners and audiences, and the question has none of those to read.";

export const SCAN_RESULTS_HEADER =
  "OPENING SCAN RESULTS: code ran these with default arguments in parallel with your turn; cite them like any other evidence.";

type JsonArgs = EventInputOf<"pivot">["args"];

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/**
 * Code is authoritative over CLERK's safety call: a refusal category refuses even if `allowed` says
 * otherwise. out_of_scope never refuses a question CLERK read as a nearest job (D41); without one it
 * gets the plain out-of-scope card when CLERK did not allow it.
 */
export function refusalOf(intent: Intent): string | null {
  const { allowed, category, reframe } = intent.safety;
  if (category === "out_of_scope") return allowed || intent.read_as.nearest ? null : OUT_OF_SCOPE_CARD;
  if (allowed && (category === null || !REFUSAL_CATEGORIES.has(category))) return null;
  if (reframe !== null && reframe.trim() !== "") return reframe.trim();
  return `The question was declined${category === null ? "" : ` (${category.replace(/_/g, " ")})`}, and no group-level reframe applies.`;
}

/** Emits the `plan` event once, before the first wave-1 tool.start, with per-step estimates. */
class PlanEvent {
  #plan: SubmitPlanInputShape | null = null;
  #sent = false;

  constructor(private readonly events: RunEvents) {}

  get plan(): SubmitPlanInputShape | null {
    return this.#plan;
  }

  set(plan: SubmitPlanInputShape): void {
    this.#plan ??= plan;
  }

  /**
   * Sends the plan once. Each step is estimated from the wave-1 call that carries it out (its
   * estimate keyed by tool call id), and at 0 when no call does yet.
   */
  flush(calls: readonly AnalystToolCall[] = [], callEstimates: ReadonlyMap<string, number | null> = new Map()): void {
    const plan = this.#plan;
    if (this.#sent || plan === null) return;
    this.#sent = true;
    const estimates: { stepId: StepId; calls: number }[] = [];
    for (const step of plan.steps) {
      const stepId = StepIdSchema.safeParse(step.id);
      if (!stepId.success) continue;
      const call = calls.find((c) => c.name === step.tool && isRecord(c.input) && c.input.step_id === step.id);
      estimates.push({ stepId: stepId.data, calls: (call === undefined ? null : callEstimates.get(call.id)) ?? 0 });
    }
    this.events.emit({ type: "plan", plan, estimates });
  }
}

/** The step and trigger a skill call names, read leniently from input that may not have passed its schema. */
function callMeta(input: unknown): { stepId: StepId | null; triggerFindingId: EventInputOf<"tool.start">["triggerFindingId"] } {
  const raw = isRecord(input) ? input : {};
  const step = StepIdSchema.safeParse(raw.step_id);
  const trigger = FindingIdSchema.safeParse(raw.trigger_finding_id);
  return { stepId: step.success ? step.data : null, triggerFindingId: trigger.success ? trigger.data : null };
}

const phaseOfTurn = (turn: 1 | 2 | 3): Phase => (turn === 1 ? "wave1" : "followup");

/** The tools a concept test runs: the follow-up reserve holds calls for them (D24, Part 9 open issue 1). */
const CONCEPT_CLAIMANTS: ReadonlySet<SkillId> = new Set<SkillId>(["find_tags", "concept_vector", "geo_lift"]);

/** Tools whose call on the subject says nothing about Qloo's data for it: lookups and public data. */
const SUBJECT_EXEMPT: ReadonlySet<SkillId> = new Set<SkillId>(["find_tags", "resolve_entities", "company_financials", "area_economics", "local_supply"]);

/** Every string anywhere in a tool input: the refs it sends, among other values. */
function stringsOf(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") out.add(value);
  else if (Array.isArray(value)) for (const v of value) stringsOf(v, out);
  else if (isRecord(value)) for (const v of Object.values(value)) stringsOf(v, out);
  return out;
}

/** "Austin, TX": the market label of an id config/metros.json lists, or null. */
function marketLabel(id: string): string | null {
  const m = MARKET_CATALOGUE.find((x) => x.id === id);
  return m === undefined ? null : `${m.label}, ${m.state}`;
}

/**
 * The place the side context calls read the question in: its map city, else the market a named venue is in,
 * else the cities a comparison names; null when it names none.
 */
export function placeLabelOf(intent: Intent): string | null {
  const own = intent.geo.metro ?? intent.geo.market;
  const label = own === null ? null : marketLabel(own);
  if (label !== null) return label;
  const cities = compareCities(intent).flatMap((id) => marketLabel(id) ?? []);
  return cities.length === 0 ? null : cities.join("; ");
}

/**
 * The one AI-context line the ANALYST ever sees (D45): the validated market ids the side call reports the
 * subject already operates in. It is model knowledge, never cited and never a number; nothing else from the
 * side calls reaches any model.
 */
export function presenceLine(ids: readonly MarketId[]): string | null {
  const labels = [...new Set(ids)].flatMap((id) => marketLabel(id) ?? []);
  if (labels.length === 0) return null;
  return (
    `AI CONTEXT (model knowledge, not measured, never cite it): the subject is reported to already operate in ${labels.join("; ")}. ` +
    "When you recommend new markets, prefer others, or say that it already operates there."
  );
}

/** The SUBJECT_NO_DATA limitation (V7 extension, 1.13). */
export function subjectNoDataText(subject: string): string {
  const name = subject.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 60).trim();
  return `Qloo returned no data for ${name}. No look-alike was used in its place.`;
}

/**
 * The ANALYST's LLM caps net of what CLERK already spent, so the run as a whole stays within
 * RunLimits.usdNudge/usdHard (PLAN §4.2: they are per run, CLERK included).
 */
export function analystLimits(limits: RunLimits, spentUsd: number): RunLimits {
  const left = (cap: number): number => Math.max(cap - spentUsd, Number.MIN_VALUE);
  return { ...limits, usdNudge: left(limits.usdNudge), usdHard: left(limits.usdHard) };
}

/** The side calls a run makes: `side` as given, else built from `sideConfig` and the run's own client. */
function sideOptionsOf(
  options: Pick<AgentRunOptions, "side" | "sideConfig" | "contextCache" | "anthropic">,
): { client: SideClient; cache: ContextCache | null; config: SideConfig } | null {
  if (options.side) return options.side;
  if (!options.sideConfig) return null;
  const { anthropic } = options;
  return {
    client: { create: (req, opts) => Promise.resolve(anthropic.messages.create(req, opts)) },
    cache: options.contextCache ?? null,
    config: options.sideConfig,
  };
}

export async function executeRun(options: AgentRunOptions): Promise<AgentRunResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const limits = RunLimits.parse(options.limits ?? DEFAULT_RUN_LIMITS);
  const qlooEnabled = options.qlooEnabled ?? true;
  const question = sanitizeQuestion(options.question);
  const events = new RunEvents(options.emit);
  const meter = new RunMeter(now, startedAt);
  const model = ANALYST_MODELS[options.mode];

  // Aborted on cancel, at the end of the run, or when the ANALYST stops (hard wall clock): it stops
  // in-flight Qloo calls so no skill keeps running after runAgent returns.
  const runAbort = new AbortController();
  const forwardAbort = () => runAbort.abort(options.signal.reason);
  if (options.signal.aborted) forwardAbort();
  else options.signal.addEventListener("abort", forwardAbort, { once: true });
  const abortCode = (): ErrorCode => (options.signal.aborted ? "cancelled" : "timeout");

  let ledger: RunLedger | null = null;
  /** The side context calls (R4, R5): started once CLERK's intent passes the safety checks. */
  let side: SideContextHandle | null = null;
  const sideAbort = new AbortController();
  /** CLERK's intent once it passed the safety check; it stays null when CLERK failed or refused. */
  let intent: Intent | null = null;
  let analystModel: string | null = null;
  let lastCheck: CheckResult | null = null;

  const end = (status: TerminalRunStatus, reason: string | null, report: Report | null = null): AgentRunResult => {
    events.emit(meter.usageEvent());
    return {
      status,
      report,
      ledger: ledger?.snapshot() ?? { evidence: [], metrics: [], datasets: [], findings: [] },
      intent,
      model: analystModel,
      usage: meter.tokens(),
      usd: meter.usd(),
      qloo: meter.qloo(),
      validation: lastCheck === null ? null : { issues: lastCheck.issues, numbersTraced: lastCheck.numbersTraced },
      reason: status === "completed" ? null : reason,
      elapsedMs: meter.elapsedMs(),
    };
  };
  const fail = (code: ErrorCode, message: string, retryable: boolean, reason: string, report: Report | null = null) => {
    events.emit({ type: "error", code, message, retryable });
    return end("failed", reason, report);
  };
  const cancelled = () => end("cancelled", "the run was cancelled");
  /**
   * Settles the side calls within `waitMs` (an unfinished call is aborted) and meters their spend: tokens as
   * LLM spend, search fees as unmetered spend, so the receipt, the daily breaker and /method include them
   * (D45). Once only; null when they never started.
   */
  const settleSide = async (waitMs: number): Promise<SideContextResult | null> => {
    const handle = side;
    if (handle === null) return null;
    side = null;
    const result = await handle.settled(waitMs);
    const fees = result.webSearches * WEB_SEARCH_USD_PER_SEARCH;
    meter.addLlm(result.usage, Math.max(0, result.usd - fees));
    meter.addUnmetered(Math.min(fees, result.usd));
    return result;
  };

  try {
    events.emit({
      type: "run.created",
      question,
      mode: options.mode,
      lane: options.lane,
      limits,
      parentRunId: options.parent?.runId ?? null,
      model,
    });

    // A: CLERK, or the intent a preview already read from this question ------------------------------
    let read: Intent;
    if (options.intent !== undefined) {
      if (options.signal.aborted) return cancelled();
      // A preview's intent may predate CLERK's area backstop, so it is applied again (it is idempotent).
      read = withJobCandidates(withKnownMarkets(areaMentionsToGeo(normalizeIntent(options.intent), gazetteer())));
      events.emit({ type: "clerk", intent: read, ms: 0 });
    } else {
      const clerkStarted = now();
      const clerk = await runClerk({ client: options.anthropic, question: options.question, signal: options.signal });
      meter.addLlm(clerk.usage, clerk.usd);
      if (options.signal.aborted) return cancelled();
      if (clerk.kind === "error") {
        if (clerk.code === "cancelled") return cancelled();
        const code: ErrorCode = clerk.code === "empty_question" ? "internal" : "llm_error";
        return fail(code, `CLERK: ${clerk.message}`, clerk.retryable, `CLERK could not read the question: ${clerk.message}`);
      }
      if (clerk.kind === "refusal") {
        return end("refused", clerk.explanation ?? "CLERK declined the question.");
      }
      read = withJobCandidates(withKnownMarkets(normalizeIntent(clerk.intent)));
      events.emit({ type: "clerk", intent: read, ms: Math.max(0, now() - clerkStarted) });
    }
    const refusal = refusalOf(read) ?? privatePersonRefusal(read);
    if (refusal !== null) return end("refused", refusal);
    intent = read;
    const { job, pillar } = read;

    // R4/R5 (D45): the side context calls start now and run beside the gate, the scan and turn 1. Each
    // block's event goes out when it settles; the run waits for them only just before ASSEMBLE.
    const sideCost = { aiUsd: 0, webUsd: 0 };
    const sideStartedAt = now();
    const sideOptions = sideOptionsOf(options);
    if (sideOptions) {
      side = startSideContext({
        runId: options.runId,
        question,
        intent: read,
        mode: options.mode,
        // Only a mention CLERK marked primary is the subject: a launch_test's named comparisons are not the
        // product, so their footprint never reads as the subject's presence.
        subjectName: read.mentions.find((m) => m.role === "primary")?.text ?? null,
        placeLabel: placeLabelOf(read),
        client: sideOptions.client,
        cache: sideOptions.cache,
        config: sideOptions.config,
        signal: AbortSignal.any([options.signal, sideAbort.signal]),
        emit: (e) => {
          if (e.type === "context.ai") sideCost.aiUsd = e.usd;
          else if (e.type === "context.web") sideCost.webUsd = e.usd;
          events.emit(e);
        },
        now,
      });
    }
    const concepts = questionConcepts(read);
    /** Every skill call that ran, with the findings it issued, so a listed follow-up never repeats one. */
    const ranCalls: RanCall[] = [];
    /** True once a concept test (a claimant) has run in turn 2: the reserve is then released. */
    let claimantFollowupRan = false;
    const registry = createEntityRegistry();
    // R8 (D51): the qloo and evidence events carry names, never entity ids.
    events.scrubWith((id) => registry.byEntityId(id)?.name ?? null);
    /**
     * D24's follow-up reserve: while a concept part has no exact tag and no concept test has answered yet,
     * other follow-up calls leave limits.conceptReserveCalls for one (Part 9 open issue 1).
     */
    const conceptReserveActive = (): boolean => {
      if (concepts.length === 0 || claimantFollowupRan) return false;
      // A concept test that already answered (the scan's, on the concept or its category) is what the reserve
      // was kept for: holding calls for a repeat would starve the question's other parts (partners, podcasts).
      if (ranCalls.some((c) => c.tool === "concept_vector" && (c.status === "ok" || c.status === "partial"))) return false;
      const tags = registry.tags();
      if (tags.some((t) => t.conceptMatch === "category" || t.conceptMatch === "proxy")) return true;
      if (conceptSubstitutes({ concepts, calls: ranCalls }).length > 0) return true;
      return !tags.some((t) => t.conceptMatch === "exact");
    };

    // B: the run's Qloo scope, registry, ledger and the resolution gate --------------------------------
    let phase: Phase = "scan";
    const runQloo = options.qloo.forRun({
      runId: options.runId,
      lane: options.lane,
      pillar,
      limits,
      phase: () => phase,
      onCall: (record) => {
        meter.recordCall(record);
        events.emit(qlooEventFrom(record));
      },
      onWarn: () => events.emit(meter.usageEvent()),
      signal: runAbort.signal,
      reserve: {
        calls: limits.conceptReserveCalls,
        claims: (tool) => tool !== null && CONCEPT_CLAIMANTS.has(tool),
        active: conceptReserveActive,
      },
    });
    // SEC and Census reads: their calls are logged and shown apart from Qloo's and cost no Qloo call.
    const runPublic =
      options.publicdata?.forRun({
        runId: options.runId,
        onCall: (record) => {
          meter.recordPublicCall(record);
          events.emit(publicEventFrom(record));
        },
        signal: runAbort.signal,
      }) ?? null;
    // D7: a source the client cannot read (no SEC_USER_AGENT, no CENSUS_API_KEY) is never planned or run.
    const publicConfigured = runPublic === null ? null : (options.publicdata?.configured ?? null);
    const unconfigured = unconfiguredTools(publicConfigured);
    /** Run-level limitation flags raised outside any skill: the not-configured sources the run needed. */
    const runFlags = new Set<Flag>();
    /** Flag limitations with their own text (the names, the parent company, the subject), once each. */
    const flagLimitations: Limitation[] = [];
    const addFlagLimitation = (flag: Flag, text: string): void => {
      if (!flagLimitations.some((l) => l.text === text)) flagLimitations.push({ source: "flag", flag, text });
    };
    /** Plain limitation lines the run adds (no flag). */
    const runLimitations: string[] = [];
    const runLedger = createRunLedger({
      emit: events.emit,
      provenanceOf: (id) => runQloo.provenance(id) ?? runPublic?.provenance(id) ?? null,
    });
    ledger = runLedger;
    const geo = gazetteer();
    // The AREAS lists the model sees (every map city the run reads): prose may name these areas, digits and all (V3).
    const areaMetros = runAreaMetros(read);
    const areas = areaMetros.flatMap((metro) => geo.neighbourhoods(metro).map((n) => n.name));

    let gate: GateResolved = EMPTY_GATE;
    if (qlooEnabled) {
      const outcome = await runResolutionGate({ intent: read, qloo: runQloo.forTool(null), registry, pins: options.pins ?? {} });
      if (options.signal.aborted) {
        await settleSide(0);
        return cancelled();
      }
      if (outcome.kind === "failed") {
        await settleSide(0);
        const code = qlooErrorCode(outcome.error) ?? "internal";
        const message = shortError(outcome.error);
        const retryable = code === "qloo_unavailable" || code === "qloo_rate_limited";
        return fail(code, message, retryable, `The question's main entity could not be looked up: ${message}`);
      }
      if (outcome.kind === "refused") {
        await settleSide(0);
        return end("refused", outcome.reason);
      }
      if (outcome.entities.length > 0) events.emit({ type: "resolve", entities: outcome.entities });
      if (outcome.kind === "needs_input") {
        events.emit(outcome.picker);
        await settleSide(0);
        return end("needs_input", outcome.reason);
      }
      gate = outcome;
    }
    const missing = expectedMissingText(gate);
    if (missing !== null) addFlagLimitation("EXPECTED_CANDIDATE_MISSING", missing);
    const skillsRan = new SkillsRan();
    const drops = gateEvidence(gate);
    if (drops !== null) {
      runLedger.addEvidence(drops);
      skillsRan.add(drops.skill, drops.flags);
    }

    // The desk's AUDIENCES from the pinned catalogue (D21): read once, offered to the ANALYST and checked on every call.
    const audiences = qlooEnabled ? await loadRunAudiences(options.qloo, pillar) : NO_RUN_AUDIENCES;

    // R3: the run's candidates, handed to every skill and to the scan's sets.
    const markets = await runMarkets(options.localities ?? null, geo);
    const candidates = buildRunCandidates({ intent: read, gate, geo, markets });

    // C: the opening scan, started before the ANALYST so it runs alongside turn 1 -------------------
    const deps: SkillRunnerDeps = {
      runId: options.runId,
      pillar,
      events,
      qloo: runQloo,
      publicdata: runPublic,
      publicConfigured,
      onFlag: (flag) => runFlags.add(flag),
      ledger: runLedger,
      registry,
      geo,
      localities: options.localities ?? null,
      audiences: audiences.keys,
      budget: createRunBudget({
        limits,
        qlooNetworkUsed: () => runQloo.networkUsed(),
        followupNetworkUsed: () => runQloo.followupNetworkUsed(),
        phase: () => phase,
        llmUsd: () => meter.usd(),
        startedAt,
        now,
      }),
      qlooEnabled,
      privatePersons: privatePersonNames(read),
      now,
      abortCode,
      // Only a skill that put evidence in the note adds its limitations to the report.
      onResult: (tool, result, input) => {
        if (result.evidenceIds.length > 0) skillsRan.add(tool, result.flags, input);
      },
      questionAreas: read.geo.metro === null ? null : { metro: read.geo.metro, ids: namedAreaIds(read, geo) },
      concepts,
      candidates,
      onLimitation: addFlagLimitation,
    };
    const scan: ScanPlan = qlooEnabled
      ? planScan(job, {
          intent: read,
          primary: gate.primary,
          peers: gate.peers,
          geo,
          markets,
          publicData: runPublic !== null,
          publicConfigured: publicConfigured ?? undefined,
          candidates: {
            entities: gate.candidates.flatMap((c) => registry.entity(c.ref) ?? []),
            areas: candidates.areas,
            markets: candidates.markets,
          },
        })
      : emptyScan();
    for (const flag of scan.flags) runFlags.add(flag);
    for (const l of scan.limitations) {
      if (l.flag === null) runLimitations.push(l.text);
      else addFlagLimitation(l.flag, l.text);
    }
    // Estimated before the scan starts: once its requests are in flight the probe counts them as cached.
    const scanEstimates = new Map(
      await Promise.all(scan.steps.map(async (s) => [s.toolCallId, await estimateSkillCalls(deps, s.tool, s.input)] as const)),
    );
    const work = new Set<Promise<unknown>>();
    const track = <T>(p: Promise<T>): Promise<T> => {
      work.add(p);
      void p.then(
        () => work.delete(p),
        () => work.delete(p),
      );
      return p;
    };
    /** The tool of every opening-scan call, so the loop never calls a plan step naming one still to run. */
    const scanTools: SkillId[] = [];
    const scanCall = async (toolCallId: string, tool: SkillId, input: unknown, estimatedCalls: number | null) => {
      const outcome = await runSkillCall(
        deps,
        { toolCallId, tool, input, phase: "scan", stepId: null, triggerFindingId: null, estimatedCalls },
        runAbort.signal,
      );
      ranCalls.push({ tool, input, findingIds: outcome.result?.findingIds ?? [], rows: outcome.result?.forModel.top_rows ?? null, status: callStatus(outcome) });
      scanTools.push(tool);
      return outcome;
    };
    /** Entities wave-1 resolve_entities calls matched exactly: the peers a deferred scan step waits for. */
    const wavePeers: RegisteredEntity[] = [];
    /** Entities the opening scan's own rows registered (cultural neighbours): a deferred step's fallback peers. */
    const scanPeers: RegisteredEntity[] = [];
    const notePeers = (outcome: SkillCallOutcome, into: RegisteredEntity[] = wavePeers): void => {
      const digest = outcome.result?.forModel;
      const refs = [...(digest?.top_rows ?? []).map((row) => row.ref), ...(digest?.registered ?? []).map((r) => r.ref)];
      for (const ref of refs) {
        const entity = ref !== null && isId("R", ref) ? registry.entity(ref) : null;
        if (entity !== null && !into.includes(entity)) into.push(entity);
      }
    };
    /**
     * The deferred scan steps, once wave 1 has returned, on the peers it resolved, else on the scan's
     * own neighbours of the primary's type (an audience question often names no peer, and the age read
     * behind GENERATIONAL_SPLIT should not wait on the ANALYST naming one): each digest, or a note when
     * neither holds one to use. They run before turn 1 closes, so what they find is listed for turn 2
     * and their calls stay out of turn 2's allowance.
     */
    const deferredDigests = async (): Promise<string[]> => {
      const digests: string[] = [];
      for (const step of scan.deferred) {
        const input = step.input(wavePeers) ?? step.input(scanPeers);
        if (input === null) {
          digests.push(`SCAN NOTE: ${toolLabel(step.tool)} did not run: neither wave 1 nor the scan holds a peer of the primary's type to compare.`);
          continue;
        }
        const outcome = await track(scanCall(step.toolCallId, step.tool, input, await estimateSkillCalls(deps, step.tool, input)));
        digests.push(outcome.content);
      }
      return digests;
    };
    const scanDigests = track(
      (async () => {
        const outcomes = await Promise.all(scan.steps.map((s) => scanCall(s.toolCallId, s.tool, s.input, scanEstimates.get(s.toolCallId) ?? null)));
        for (const o of outcomes) notePeers(o, scanPeers);
        const digests = outcomes.map((o) => o.content);
        const ran: { tool: SkillId; outcome: SkillCallOutcome }[] = outcomes.map((outcome, i) => ({ tool: scan.steps[i]!.tool, outcome }));
        // Chained steps read what their scan step returned (geo_lift on find_tags' rows, scoring on
        // cross_domain's), not the whole registry, which wave-1 calls running alongside may already have
        // added to. A chained step may follow another, so each one's outcome joins `ran` in turn.
        const feedFrom = (tool: SkillId) => {
          const results = ran.flatMap((r) => (r.tool === tool && r.outcome.result !== null ? [r.outcome.result] : []));
          const ids = new Set<string>(results.flatMap((r) => r.datasetIds));
          return {
            ...chainFeed(
              results.map((r) => r.forModel),
              { registry, ledger: runLedger, geo, metros: areaMetros },
            ),
            // The datasets the step made: local_supply reads a lift map's popular areas from them (R7).
            datasets: runLedger.snapshot().datasets.filter((d) => ids.has(d.id)),
          };
        };
        // Consecutive chained steps that follow the same step, and not one another, run in parallel
        // (city_compare's per-city fingerprints and lift maps after find_tags); digests keep table order.
        const groups: (typeof scan.chained)[] = [];
        for (const step of scan.chained) {
          const last = groups.at(-1);
          const joins = last !== undefined && last[0]!.after === step.after && !last.some((s) => s.tool === step.after);
          if (joins) last.push(step);
          else groups.push([step]);
        }
        for (const group of groups) {
          const feed = feedFrom(group[0]!.after);
          // Inputs and estimates first, then every call starts in table order.
          const planned = await Promise.all(
            group.map(async (step) => {
              const input = step.input(feed);
              return { step, input, estimate: input === null ? null : await estimateSkillCalls(deps, step.tool, input) };
            }),
          );
          const results = await Promise.all(
            planned.map(async ({ step, input, estimate }) => {
              if (input === null) {
                // A quiet step (the category retry) not running is the usual case, not news.
                if (step.quiet === true) return { step, outcome: null, content: null };
                return { step, outcome: null, content: `SCAN NOTE: ${toolLabel(step.tool)} did not run: ${toolLabel(step.after)} returned nothing it can use.` };
              }
              const outcome = await scanCall(step.toolCallId, step.tool, input, estimate);
              return { step, outcome, content: outcome.content };
            }),
          );
          for (const r of results) {
            if (r.outcome !== null) ran.push({ tool: r.step.tool, outcome: r.outcome });
            if (r.content !== null) digests.push(r.content);
          }
        }
        return digests;
      })(),
    );

    // D–G: the ANALYST with the CHECKER as its report review ------------------------------------------
    const firstUserMessage = buildRunContext({
      today: new Date(startedAt).toISOString().slice(0, 10),
      mode: options.mode,
      intent: read,
      limits,
      registry,
      geo,
      scan: { plan: scan, estimates: scanEstimates },
      markets,
      audiences: audiences.segments,
      // With Qloo off, only the public-data tools can still answer, and only with a public-data client;
      // a public-data tool whose source is not configured never answers (D7).
      unavailable: [
        ...new Set([
          ...(qlooEnabled ? UNAVAILABLE_SKILLS : ALL_SKILLS.filter((s) => runPublic === null || !isPublicDataTool(s))),
          ...unconfigured,
        ]),
      ],
      qlooEnabled,
      publicData: runPublic !== null,
      caseSummary: options.parent?.caseSummary ?? null,
      question: options.question,
      localSupply: runPublic !== null && !unconfigured.includes("local_supply"),
    });
    const planEvent = new PlanEvent(events);
    analystModel = model;
    /**
     * The subject's name when it resolved but every Qloo call that read it came back empty or failed (V7
     * extension, SUBJECT_NO_DATA); null otherwise. Refused calls never ran and do not count.
     */
    const subjectNoData = (): string | null => {
      const primary = gate.primary;
      if (!qlooEnabled || primary === null) return null;
      const used = ranCalls.filter((c) => !SUBJECT_EXEMPT.has(c.tool) && c.status !== null && c.status !== undefined && stringsOf(c.input).has(primary.ref));
      if (used.length === 0) return null;
      return used.every((c) => c.status === "empty" || c.status === "error") ? primary.name : null;
    };
    /** What the CHECKER's honesty rules read from the run (V7 extension, V9 disclosure, V12). */
    const honestyInput = () => ({
      concepts,
      disclosure: { concept: conceptSubstitutes({ concepts, calls: ranCalls }).length > 0, readAs: read.read_as.nearest },
      subjectNoData: subjectNoData(),
      // V12 (e): the question's own peers and areas (You named) apart from CLERK's expected ones.
      named: {
        entities: candidates.entities.some((e) => e.source === "user_named"),
        areas: candidates.areas.some((a) => a.source === "user_named"),
      },
    });
    /** Network calls turn 2 could still make: its own allowance, within what the run has left. */
    const followupCallsLeft = (): number =>
      Math.min(limits.qlooCalls - runQloo.networkUsed(), limits.followupCalls - runQloo.followupNetworkUsed());
    /** Started by the first turn-2 tool call; every later follow-up shares it. */
    let followup: FollowupDeadline | null = null;
    const followupDeadline = (): FollowupDeadline =>
      (followup ??= createFollowupDeadline({
        ms: limits.followupMs,
        signal: AbortSignal.timeout(limits.followupMs),
        track: (call) => void track(call),
      }));

    const outcome: AnalystOutcome = await runAnalyst({
      client: options.anthropic,
      model: options.mode,
      systemPrompt: DIRECTOR_PROMPT,
      firstUserMessage,
      limits: analystLimits(limits, meter.usd()),
      signal: options.signal,
      now,
      startedAt,
      executeTools: (calls, turn, signal) =>
        track(
          (async () => {
            signal.addEventListener("abort", () => runAbort.abort(signal.reason), { once: true });
            phase = phaseOfTurn(turn);
            const deadline = turn === 1 ? null : followupDeadline();
            const estimates = new Map(
              await Promise.all(
                calls.map(async (c) => [c.id, qlooEnabled ? await estimateSkillCalls(deps, c.name, c.input) : 0] as const),
              ),
            );
            if (turn === 1) planEvent.flush(calls, estimates);
            return Promise.all(
              calls.map(async (call) => {
                const meta = { ...callMeta(call.input), estimatedCalls: estimates.get(call.id) ?? null, deadline };
                const o = await runSkillCall(deps, { toolCallId: call.id, tool: call.name, input: call.input, phase, ...meta }, signal);
                ranCalls.push({
                  id: call.id,
                  tool: call.name,
                  input: call.input,
                  findingIds: o.result?.findingIds ?? [],
                  rows: o.result?.forModel.top_rows ?? null,
                  status: callStatus(o),
                });
                // A concept test ran in turn 2: the follow-up reserve held for it is released.
                if (turn !== 1 && CONCEPT_CLAIMANTS.has(call.name) && o.result !== null) claimantFollowupRan = true;
                if (turn === 1 && call.name === "resolve_entities") notePeers(o);
                return { tool_use_id: call.id, content: o.content, ...(o.isError ? { is_error: true } : {}) };
              }),
            );
          })(),
        ),
      findingExists: (id) => runLedger.finding(id) !== undefined,
      findings: () => runLedger.snapshot().findings,
      // A market id outside MARKETS parses (MarketId is a format) but could only come back as an unavailable row.
      checkInput: (tool, input) => unknownMarketIssues(tool, input, markets),
      scanTools: () => scanTools,
      turnContext: async (closed) => {
        if (closed !== 1) return [];
        planEvent.flush();
        const digests = [...(await scanDigests), ...(await deferredDigests())];
        // D45: the presence markets only, if the AI-context call has them by now (no wait).
        const presence = side === null ? null : await side.presence(0);
        const line = presence === null ? null : presenceLine(presence);
        return [...(digests.length === 0 ? [] : [SCAN_RESULTS_HEADER, ...digests]), ...(line === null ? [] : [line])];
      },
      // Written once the loop knows whether follow-ups are still allowed, so it never contradicts TURN 3.
      closingContext: (closed, next) => {
        if (closed !== 1) return [];
        const status = evidenceStatus(runLedger.snapshot().evidence, qlooEnabled, next === 2);
        return status === null ? [] : [status];
      },
      // With no network call left for turn 2 (its allowance or the run's), or its time spent, a listed
      // lead could only come back BUDGET_TRUNCATED. The TURN 2 guide covers planned steps sharing what is left.
      followupLeads: () => {
        if (followupCallsLeft() <= 0 || followup?.signal.aborted === true) return [];
        const { findings, metrics } = runLedger.snapshot();
        return findingLeads({ findings, metrics, qlooEnabled, primary: gate.primary?.ref ?? null, ran: ranCalls });
      },
      // (c) of the owner's o03 decision: a lookup sent with other calls keeps turn 2 open once while it found
      // a ref no call used yet, so a concept test on a tag just found is not starved by the turn closing.
      lookupsPending: (lookups) => {
        if (followupCallsLeft() <= 0 || followup?.signal.aborted === true) return false;
        const ids = new Set(lookups.map((c) => c.id));
        const found = ranCalls
          .filter((c) => c.id !== undefined && ids.has(c.id))
          .flatMap((c) => (c.rows ?? []).flatMap((row) => (row.ref !== null && row.values.use !== "label_only" ? [row.ref] : [])));
        return unusedRefs(found, ranCalls).length > 0;
      },
      reviewReport: (draft, context) => {
        const check = checkReport({
          draft,
          plan: planEvent.plan,
          ledger: runLedger.snapshot(),
          qlooEnabled,
          registry,
          areas,
          competitionAsked: job === "site_selection",
          attempt: context.final ? 2 : 1,
          ...honestyInput(),
        });
        lastCheck = check;
        events.emit({
          type: "validation",
          ok: !check.reject,
          attempt: context.attempt,
          issues: check.issues,
          numbersTraced: check.numbersTraced,
          adviceTerms: check.adviceTerms,
        });
        return check.reject ? { ok: false, feedback: repairMessage(check.issues, draft) } : { ok: true };
      },
      onThinking: (text) => events.emit({ type: "note", text }),
      onToolEnd: (toolEnd) => emitRejectedCall(events, toolEnd),
      onUsage: (usage, usd) => {
        meter.addLlm(usage, usd);
        events.emit(meter.usageEvent());
      },
      onPlan: (plan) => planEvent.set(plan),
      onReportDraft: (draft, attempt) => events.emit({ type: "report.draft", draft, attempt }),
      onPivot: (pivot) =>
        events.emit({
          type: "pivot",
          triggerFindingId: pivot.triggerFindingId,
          tool: pivot.tool,
          args: pivot.args as JsonArgs,
          toolCallId: pivot.toolCallId,
        }),
    });
    meter.addUnmetered(outcome.unmeteredUsd);
    // The loop saw the cost cap net of CLERK's spend; the reason names the run's own cap.
    const reason =
      outcome.code === "usd_limit" ? `the next response could pass the per-run cost cap of $${limits.usdHard}` : outcome.reason;

    // Nothing may keep running. A completed run has nothing left but follow-up calls refused at their
    // deadline; any other run is stopped mid-work. Either way the work is stopped, then awaited.
    runAbort.abort();
    await Promise.allSettled([...work]);
    planEvent.flush();

    if (outcome.status === "cancelled" || options.signal.aborted) {
      await settleSide(0);
      return cancelled();
    }
    if (outcome.status === "refused") {
      await settleSide(0);
      return end("refused", outcome.reason ?? "the ANALYST declined the question");
    }

    // R4/R5: the context blocks settle now, waiting at most until SIDE_TIMEOUTS.webMs after they started and
    // never past the hard stop; median ANALYST time is longer, so this wait is usually zero.
    const hardStopAt = startedAt + limits.hardMs;
    const sideResult = await settleSide(Math.max(0, Math.min(sideStartedAt + SIDE_TIMEOUTS.webMs, hardStopAt) - now()));
    if (sideResult !== null) events.emit(meter.usageEvent());

    // H: ASSEMBLE ------------------------------------------------------------------------------------
    const plan = outcome.submittedPlan ?? planEvent.plan;
    // The accepted draft is the one the CHECKER saw last; checking it again is only a fallback.
    const check =
      outcome.status === "completed" && outcome.draft !== null
        ? (lastCheck ??
          checkReport({
            draft: outcome.draft,
            plan,
            ledger: runLedger.snapshot(),
            qlooEnabled,
            registry,
            areas,
            competitionAsked: job === "site_selection",
            attempt: 2,
            ...honestyInput(),
          }))
        : null;
    let report: Report;
    try {
      recordScorecard(runLedger, plan, check?.patchedDraft ?? null);
      // The card is optional: if it cannot be built the note ships without it, and says so.
      const cardLimitations: string[] = [];
      try {
        const cited = check === null ? [] : draftCitedMetrics(check.patchedDraft);
        recordPosition({ job, ledger: runLedger, registry, subject: gate.primary, resolution: gate.primaryCalls, cited });
      } catch (err) {
        cardLimitations.push(`${POSITION_FAILED}: ${shortError(err)}`);
      }
      const snapshot = runLedger.snapshot();
      // The owner's o03 decision: a concept with no tag of its own is tested on its nearest category (or
      // not at all), and the note says so at the top; either way it counts as partly tested (D2).
      const substitutes = conceptSubstitutes({ concepts, calls: ranCalls });
      // R2 (D48): a concept read through its broader category is a category-level read for the whole note.
      if (substitutes.some((s) => s.categories.length > 0)) runFlags.add("CATEGORY_LEVEL_READ");
      const noData = subjectNoData();
      if (noData !== null) addFlagLimitation("SUBJECT_NO_DATA", subjectNoDataText(noData));
      const context: ReportContext = {
        runId: options.runId,
        question,
        job,
        mode: options.mode,
        createdAt: new Date(now()).toISOString(),
        plan,
        ledger: snapshot,
        qlooCalls: meter.receiptCalls(),
        publicCalls: meter.receiptPublicCalls(),
        usage: { elapsedMs: meter.elapsedMs(), llmUsd: meter.usd(), tokens: meter.tokens() },
        models: {
          clerk: CLERK_MODEL,
          analyst: outcome.model,
          ghost: null,
          ...(sideResult === null ? {} : { context: sideResult.models.ai, web: sideResult.models.web }),
        },
        droppedEntities: gate.dropped,
        codeFallbacks: events.fallbacks,
        skillLimitations: [...skillsRan.limitations(), ...gate.limitations, ...cardLimitations],
        subject: gate.primary?.ref ?? null,
        peers: gate.peers.map((p) => p.ref),
        // D41: a question read as its nearest job says what the data does not cover, and costs 5 points.
        // normalizeIntent keeps a financial_advice question off this path (D9): its reframe already says so.
        readAs: read.read_as.nearest ? { notCovered: read.read_as.not_covered } : null,
        runFlags: [...runFlags],
        // D2: part of the question's concept never tested by a tag some call used.
        conceptPartlyTagged:
          substitutes.length > 0 ||
          conceptPartlyTagged({
            concepts,
            calls: ranCalls,
            findings: snapshot.findings,
          }),
        conceptSubstitutes: substitutes,
        flagLimitations,
        runLimitations,
        ...(sideResult === null
          ? {}
          : {
              aiContext: sideResult.ai,
              webContext: sideResult.web,
              sideCost: { aiUsd: sideCost.aiUsd, webUsd: sideCost.webUsd, webSearches: sideResult.webSearches },
            }),
      };
      report = check !== null ? assembleReport({ ...context, check }) : buildIncompleteReport({ ...context, reason });
    } catch (err) {
      return fail("internal", `ASSEMBLE: ${shortError(err)}`, false, `The report could not be assembled: ${shortError(err)}`);
    }
    events.emit({ type: "report.final", report });

    if (outcome.status === "failed") {
      const code: ErrorCode = outcome.code === "api_error" ? "llm_error" : "internal";
      const why = reason ?? "the ANALYST failed";
      return fail(code, why, outcome.error?.retryable ?? false, why, report);
    }
    return end(outcome.status === "completed" ? "completed" : "incomplete", reason, report);
  } catch (err) {
    // A bug, not a data condition: the run still ends with a typed error instead of a rejection.
    if (options.signal.aborted) return cancelled();
    return fail("internal", shortError(err), false, `The run failed unexpectedly: ${shortError(err)}`);
  } finally {
    options.signal.removeEventListener("abort", forwardAbort);
    runAbort.abort();
    // Nothing outlives the run: a side call still in flight is aborted.
    sideAbort.abort();
    events.close();
  }
}

/**
 * How a skill call ended for SUBJECT_NO_DATA: its status, "error" when it threw (TOOL_FAILED), and null when
 * it was refused before it ran (it read nothing).
 */
function callStatus(outcome: SkillCallOutcome): RanCall["status"] {
  if (outcome.result !== null) return outcome.result.status;
  return outcome.content.startsWith("TOOL_FAILED") ? "error" : null;
}

/**
 * A skill call the loop answered itself (INVALID_INPUT, UNTRIGGERED_FOLLOWUP, …) still shows in the
 * trace as a failed step, so a refused follow-up is visible. Submissions have their own events.
 */
function emitRejectedCall(events: RunEvents, toolEnd: AnalystToolEnd): void {
  if (toolEnd.executed || toolEnd.code === null) return;
  const tool = SkillId.safeParse(toolEnd.use.name);
  if (!tool.success) return;
  const { use } = toolEnd;
  events.emit({
    type: "tool.start",
    toolCallId: use.id,
    tool: tool.data,
    phase: phaseOfTurn(toolEnd.turn),
    args: (isRecord(use.input) ? use.input : {}) as JsonArgs,
    ...callMeta(use.input),
    estimatedCalls: null,
  });
  events.emit({
    type: "tool.end",
    toolCallId: use.id,
    tool: tool.data,
    ok: false,
    status: "error",
    ms: 0,
    evidenceIds: [],
    metricIds: [],
    datasetIds: [],
    findingIds: [],
    flags: [],
    error: { code: "invalid_tool_input", message: shortError(toolEnd.content) },
  });
}

