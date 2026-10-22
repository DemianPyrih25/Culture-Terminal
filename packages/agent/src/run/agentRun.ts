import {
  DEFAULT_RUN_LIMITS,
  FindingIdSchema,
  normalizeIntent,
  RunLimits,
  SkillId,
  StepIdSchema,
  type ErrorCode,
  type EventInputOf,
  type GeoApi,
  type Intent,
  type Phase,
  type Report,
  type SafetyCategory,
  type StepId,
  type SubmitPlanInputShape,
  type TerminalRunStatus,
} from "@ct/contracts";
import { createGeo } from "@ct/geo";
import { qlooErrorCode, qlooEventFrom } from "@ct/qloo";
import { runAnalyst, type AnalystOutcome, type AnalystToolCall, type AnalystToolEnd } from "../analyst";
import { ANALYST_MODELS, CLERK_MODEL } from "../anthropic";
import { assembleReport, buildIncompleteReport, type ReportContext } from "../assemble";
import { createRunBudget } from "../budget";
import { checkReport, repairMessage, type CheckResult } from "../checker";
import { runClerk, sanitizeQuestion } from "../clerk";
import { createRunLedger, type RunLedger } from "../ledger";
import { DIRECTOR_PROMPT } from "../prompts";
import { createEntityRegistry } from "../registry";
import type { AgentRunOptions, AgentRunResult } from "../run";
import { recordScorecard } from "../scorecard";
import { ALL_SKILLS, UNAVAILABLE_SKILLS } from "./catalogue";
import { buildRunContext, evidenceStatus } from "./context";
import { createFollowupDeadline, type FollowupDeadline } from "./followup";
import { gateEvidence, privatePersonNames, privatePersonRefusal, runResolutionGate, type GateResolved } from "./gate";
import { RunEvents, RunMeter } from "./meter";
import { planScan, type ScanPlan } from "./scan";
import { estimateSkillCalls, runSkillCall, shortError, SkillsRan, type SkillRunnerDeps } from "./tools";

/**
 * runAgent's body (PLAN §4.1 A–H, SPEC §4.1): CLERK → resolution gate → opening scan in parallel
 * with ANALYST turn 1 → follow-ups → submit_report → CHECKER (≤1 repair) → ASSEMBLE. Every stage
 * reports through the caller's emit; the caller writes run.end from the returned status. No work
 * outlives the call: background scan and tool runs are stopped or awaited before it returns.
 */

/** Categories CLERK refuses on (clerk.md "Safety"); financial_advice is answered as taste-signal health. */
const REFUSAL_CATEGORIES: ReadonlySet<SafetyCategory> = new Set([
  "private_individual",
  "sensitive_inference",
  "political_targeting",
  "eligibility",
  "residential_screening",
  "injection",
  "out_of_scope",
]);

export const SCAN_RESULTS_HEADER =
  "OPENING SCAN RESULTS: code ran these with default arguments in parallel with your turn; cite them like any other evidence.";

type JsonArgs = EventInputOf<"pivot">["args"];

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Code is authoritative over CLERK's safety call: a refusal category refuses even if `allowed` says otherwise. */
export function refusalOf(intent: Intent): string | null {
  const { allowed, category, reframe } = intent.safety;
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

/**
 * The ANALYST's LLM caps net of what CLERK already spent, so the run as a whole stays within
 * RunLimits.usdNudge/usdHard (PLAN §4.2: they are per run, CLERK included).
 */
export function analystLimits(limits: RunLimits, spentUsd: number): RunLimits {
  const left = (cap: number): number => Math.max(cap - spentUsd, Number.MIN_VALUE);
  return { ...limits, usdNudge: left(limits.usdNudge), usdHard: left(limits.usdHard) };
}

/** The gazetteer is static data: indexed once per process, shared by every run. */
let sharedGeo: GeoApi | null = null;
const gazetteer = (): GeoApi => (sharedGeo ??= createGeo());

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

    // A: CLERK ---------------------------------------------------------------------------------------
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
    const read = normalizeIntent(clerk.intent);
    events.emit({ type: "clerk", intent: read, ms: Math.max(0, now() - clerkStarted) });
    const refusal = refusalOf(read) ?? privatePersonRefusal(read);
    if (refusal !== null) return end("refused", refusal);
    intent = read;
    const { job, pillar } = read;

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
    });
    const registry = createEntityRegistry();
    const runLedger = createRunLedger({ emit: events.emit, provenanceOf: (id) => runQloo.provenance(id) });
    ledger = runLedger;
    const geo = gazetteer();

    let gate: GateResolved = { kind: "resolved", entities: [], primary: null, peers: [], dropped: 0, limitations: [], calls: [] };
    if (qlooEnabled) {
      const outcome = await runResolutionGate({ intent: read, qloo: runQloo.forTool(null), registry, pins: options.pins ?? {} });
      if (options.signal.aborted) return cancelled();
      if (outcome.kind === "failed") {
        const code = qlooErrorCode(outcome.error) ?? "internal";
        const message = shortError(outcome.error);
        const retryable = code === "qloo_unavailable" || code === "qloo_rate_limited";
        return fail(code, message, retryable, `The question's main entity could not be looked up: ${message}`);
      }
      if (outcome.kind === "refused") return end("refused", outcome.reason);
      if (outcome.entities.length > 0) events.emit({ type: "resolve", entities: outcome.entities });
      if (outcome.kind === "needs_input") {
        events.emit(outcome.picker);
        return end("needs_input", outcome.reason);
      }
      gate = outcome;
    }
    const skillsRan = new SkillsRan();
    const drops = gateEvidence(gate);
    if (drops !== null) {
      runLedger.addEvidence(drops);
      skillsRan.add(drops.skill, drops.flags);
    }

    // C: the opening scan, started before the ANALYST so it runs alongside turn 1 -------------------
    const deps: SkillRunnerDeps = {
      runId: options.runId,
      pillar,
      events,
      qloo: runQloo,
      ledger: runLedger,
      registry,
      geo,
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
      onResult: (tool, result) => {
        if (result.evidenceIds.length > 0) skillsRan.add(tool, result.flags);
      },
    };
    const scan: ScanPlan = qlooEnabled
      ? planScan(job, { intent: read, primary: gate.primary, peers: gate.peers })
      : { steps: [], unavailable: [], skipped: [] };
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
    const scanDigests = track(
      Promise.all(
        scan.steps.map((s) =>
          runSkillCall(
            deps,
            {
              toolCallId: s.toolCallId,
              tool: s.tool,
              input: s.input,
              phase: "scan",
              stepId: null,
              triggerFindingId: null,
              estimatedCalls: scanEstimates.get(s.toolCallId) ?? null,
            },
            runAbort.signal,
          ),
        ),
      ).then((outcomes) => outcomes.map((o) => o.content)),
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
      unavailable: qlooEnabled ? UNAVAILABLE_SKILLS : ALL_SKILLS,
      qlooEnabled,
      caseSummary: options.parent?.caseSummary ?? null,
      question: options.question,
    });
    const planEvent = new PlanEvent(events);
    analystModel = model;
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
                return { tool_use_id: call.id, content: o.content, ...(o.isError ? { is_error: true } : {}) };
              }),
            );
          })(),
        ),
      findingExists: (id) => runLedger.finding(id) !== undefined,
      turnContext: async (closed) => {
        if (closed !== 1) return [];
        planEvent.flush();
        const digests = await scanDigests;
        return digests.length === 0 ? [] : [SCAN_RESULTS_HEADER, ...digests];
      },
      // Written once the loop knows whether follow-ups are still allowed, so it never contradicts TURN 3.
      closingContext: (closed, next) => {
        if (closed !== 1) return [];
        const status = evidenceStatus(runLedger.snapshot().evidence, qlooEnabled, next === 2);
        return status === null ? [] : [status];
      },
      reviewReport: (draft, context) => {
        const check = checkReport({
          draft,
          plan: planEvent.plan,
          ledger: runLedger.snapshot(),
          qlooEnabled,
          registry,
          attempt: context.final ? 2 : 1,
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
        return check.reject ? { ok: false, feedback: repairMessage(check.issues) } : { ok: true };
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

    if (outcome.status === "cancelled" || options.signal.aborted) return cancelled();
    if (outcome.status === "refused") return end("refused", outcome.reason ?? "the ANALYST declined the question");

    // H: ASSEMBLE ------------------------------------------------------------------------------------
    const plan = outcome.submittedPlan ?? planEvent.plan;
    // The accepted draft is the one the CHECKER saw last; checking it again is only a fallback.
    const check =
      outcome.status === "completed" && outcome.draft !== null
        ? (lastCheck ?? checkReport({ draft: outcome.draft, plan, ledger: runLedger.snapshot(), qlooEnabled, registry, attempt: 2 }))
        : null;
    let report: Report;
    try {
      recordScorecard(runLedger, plan, check?.patchedDraft ?? null);
      const snapshot = runLedger.snapshot();
      const context: ReportContext = {
        runId: options.runId,
        question,
        job,
        mode: options.mode,
        createdAt: new Date(now()).toISOString(),
        plan,
        ledger: snapshot,
        qlooCalls: meter.receiptCalls(),
        usage: { elapsedMs: meter.elapsedMs(), llmUsd: meter.usd(), tokens: meter.tokens() },
        models: { clerk: CLERK_MODEL, analyst: outcome.model, ghost: null },
        droppedEntities: gate.dropped,
        codeFallbacks: events.fallbacks,
        skillLimitations: [...skillsRan.limitations(), ...gate.limitations],
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
    events.close();
  }
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

