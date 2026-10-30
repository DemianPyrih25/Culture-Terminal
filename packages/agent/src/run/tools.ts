import {
  isId,
  isPublicDataTool,
  NO_RUN_CANDIDATES,
  publicDataErrorCode,
  SkillId,
  wrapToolData,
  type ErrorCode,
  type EventInputOf,
  type FindingId,
  type Flag,
  type GeoApi,
  type Ledger,
  type LocalityApi,
  type MetroId,
  type Phase,
  type Pillar,
  type RunBudget,
  type RunCandidates,
  type Skill,
  type SkillCtx,
  type SkillResult,
  type StepId,
  type ToolInput,
} from "@ct/contracts";
import { ensureMetrosIn } from "@ct/geo";
import type { RunPublic } from "@ct/publicdata";
import { qlooErrorCode, type RunQloo } from "@ct/qloo";
import { normaliseName, SKILL_LIMITATIONS, SKILLS, skillErrorResult, stampCandidateSources } from "@ct/quant";
import type { RunLedger } from "../ledger";
import { errorText, type AnalystToolErrorCode } from "../llm/notices";
import type { RunRegistry } from "../registry";
import { unlistedAudiences } from "./audiences";
import { escapeAngles } from "./context";
import type { FollowupDeadline } from "./followup";
import { listedRelationOf, notSeparatelyReported } from "./listedBrands";
import type { RunEvents } from "./meter";
import { NOT_CONFIGURED_FLAG, notConfiguredRefusal, unconfiguredSource, type PublicConfigured } from "./publicConfig";

/**
 * One skill call end to end, for opening-scan steps and ANALYST tool calls alike: tool.start, the
 * skill against its own SkillCtx (Qloo and public-data calls and findings attributed to this tool
 * call), tool.end, and the wrapped digest the model reads (`<public_data>` for the SEC and Census
 * tools, `<qloo_data>` otherwise). A skill that throws becomes an is_error result with a short,
 * escaped message; the trace keeps the error code, never a stack.
 */

export interface SkillCall {
  /** The tool_use id, or "scan-N" for an opening-scan step. */
  toolCallId: string;
  tool: SkillId;
  /** Input already parsed by the tool's schema (ToolInput<tool>). */
  input: unknown;
  phase: Phase;
  stepId: StepId | null;
  triggerFindingId: FindingId | null;
  /** A cost estimate made earlier (the scan's, before its requests were in flight); estimated here when absent. */
  estimatedCalls?: number | null;
  /** The follow-up time budget a turn-2 call runs under; null or absent otherwise. */
  deadline?: FollowupDeadline | null;
}

export interface SkillCallOutcome {
  /** The tool_result text: a wrapped digest, or a short error. */
  content: string;
  isError: boolean;
  result: SkillResult | null;
}

export interface SkillRunnerDeps {
  runId: string;
  pillar: Pillar;
  events: RunEvents;
  qloo: RunQloo;
  /**
   * The run's SEC EDGAR and US Census scope (company_financials, area_economics); null when the server
   * has no public-data client, and those skills then answer UNAVAILABLE with a plain reason. Absent: null.
   */
  publicdata?: RunPublic | null;
  /**
   * Which public sources the client can read (PublicDataClient.configured). A call to a public-data tool
   * whose source is not configured is refused before it runs, with PUBLIC_NOT_CONFIGURED_REASON verbatim,
   * and raises the source's not-configured flag through onFlag (D7). Absent or null: no check.
   */
  publicConfigured?: PublicConfigured | null;
  /** A run-level limitation flag raised outside any skill (D7's not-configured flags). */
  onFlag?: (flag: Flag) => void;
  ledger: RunLedger;
  registry: RunRegistry;
  geo: GeoApi;
  /** The run's pinned market localities (kv); null when it has none, so metro and city contexts are unavailable. */
  localities: LocalityApi | null;
  /**
   * The audience keys of the run's AUDIENCES list (the pinned catalogue on this desk, D21). A call
   * that sends any other audience is refused before any Qloo call.
   */
  audiences: ReadonlySet<string>;
  budget: RunBudget;
  /**
   * False answers every Qloo tool with an error digest and makes no Qloo call (V7 fail-closed path).
   * The public-data tools still run: they make no Qloo call.
   */
  qlooEnabled: boolean;
  /**
   * Normalised names of the persons CLERK did not mark as public figures (gate privatePersonNames).
   * A call that would search for one is refused before any Qloo call (SPEC §4.6).
   */
  privatePersons?: ReadonlySet<string>;
  now: () => number;
  /** The error code for a call stopped by its signal: "cancelled" on a cancel, "timeout" at the hard stop. */
  abortCode: () => ErrorCode;
  /** Every completed skill run with the input it ran on, e.g. to collect its limitations. */
  onResult?: (tool: SkillId, result: SkillResult, input: unknown) => void;
  /**
   * The gazetteer areas the question names in its map city (scan namedAreaIds). A geo_lift call in that
   * city that names none gets them (withQuestionFocus), so every lift map ranks the reader's own area.
   */
  questionAreas?: { metro: MetroId; ids: readonly string[] } | null;
  /** The question's concept parts (questionConcepts), handed to every skill (R2). Absent: none. */
  concepts?: readonly string[];
  /** The run's user-named and obvious candidates (R3), handed to every skill. Absent: NO_RUN_CANDIDATES. */
  candidates?: RunCandidates;
  /**
   * A limitation the run raises outside any skill, with its own text: NOT_SEPARATELY_REPORTED for a brand
   * inside a larger listed company whose financials a call asked for.
   */
  onLimitation?: (flag: Flag, text: string) => void;
}

/**
 * The call with the question's areas as geo_lift focus_areas when it is in the question's map city
 * and names none itself: the ANALYST's own lift maps (another concept, supply off) then still carry
 * the named areas' lift, rank and confidence, whichever map the answer shows. Any other call as is.
 */
export function withQuestionFocus(deps: Pick<SkillRunnerDeps, "questionAreas">, call: SkillCall): SkillCall {
  const areas = deps.questionAreas ?? null;
  if (call.tool !== "geo_lift" || areas === null || areas.ids.length === 0) return call;
  const input = call.input as ToolInput<"geo_lift">;
  if (input.metro !== areas.metro || (input.focus_areas ?? []).length > 0) return call;
  return { ...call, input: { ...input, focus_areas: [...areas.ids] } };
}

/** rank_candidates contexts that read a location signal: the skill's "site or city context" bullet is about these. */
const LOCATION_CONTEXT_KINDS: ReadonlySet<string> = new Set(["site", "city", "metro"]);

/** rank_candidates' fixed bullet on site and city contexts: true only when a call ranked under one (Q4). */
const isLocationContextBullet = (text: string): boolean => /\bsite or city context\b/i.test(text);

/** share_of_taste's fixed bullet on metro contexts: true only when a call read a metro context (Q4). */
const isMetroContextBullet = (text: string): boolean => /\bmetro context\b/i.test(text);

/** True when a share_of_taste input reads at least one metro context. */
function sharesInMetros(input: unknown): boolean {
  const metros = (input as Partial<ToolInput<"share_of_taste">> | null)?.metros;
  return Array.isArray(metros) && metros.length > 0;
}

/** True when a rank_candidates input ranks under a site, city or metro context. */
function ranksInPlace(input: unknown): boolean {
  const contexts = (input as Partial<ToolInput<"rank_candidates">> | null)?.contexts;
  return Array.isArray(contexts) && contexts.some((c) => LOCATION_CONTEXT_KINDS.has(c.kind));
}

/**
 * The skills that put evidence in the ledger, the flags they raised and the inputs they ran on: the
 * report's skill limitations are Skill.limitations(flags) of these, in contracts order so the report is
 * stable. A fixed bullet about an input the run never sent is left out (Q4): rank_candidates' "site or
 * city context" line shows only when a call ranked under a site, city or metro context, and
 * share_of_taste's "metro context" line only when a call read a metro.
 */
export class SkillsRan {
  readonly #flags = new Map<SkillId, Set<Flag>>();
  #rankedInPlace = false;
  #sharedInMetros = false;

  add(tool: SkillId, flags: readonly Flag[], input?: unknown): void {
    const seen = this.#flags.get(tool) ?? new Set<Flag>();
    for (const f of flags) seen.add(f);
    this.#flags.set(tool, seen);
    if (tool === "rank_candidates" && ranksInPlace(input)) this.#rankedInPlace = true;
    if (tool === "share_of_taste" && sharesInMetros(input)) this.#sharedInMetros = true;
  }

  limitations(): string[] {
    const lines = SkillId.options.flatMap((id) => {
      const flags = this.#flags.get(id);
      if (flags === undefined) return [];
      const own = skillOf(id).limitations([...flags]);
      if (id === "rank_candidates" && !this.#rankedInPlace) return own.filter((t) => !isLocationContextBullet(t));
      if (id === "share_of_taste" && !this.#sharedInMetros) return own.filter((t) => !isMetroContextBullet(t));
      return own;
    });
    return [...new Set(lines)];
  }
}

/** The share_of_taste bullet SkillsRan leaves out without a metro context; exported for its test. */
export const SHARE_METRO_BULLET: string | undefined = SKILL_LIMITATIONS.share_of_taste.find(isMetroContextBullet);

/** The rank_candidates bullet SkillsRan leaves out without a location context; exported for its test. */
export const RANK_LOCATION_BULLET: string | undefined = SKILL_LIMITATIONS.rank_candidates.find(isLocationContextBullet);

/** Parsed tool input is plain JSON (zod output of the tool's JSON schema). */
type ToolArgs = EventInputOf<"tool.start">["args"];

export const QLOO_DISABLED_NOTICE =
  "Qloo is disabled for this run: no data is available from any Qloo tool (company_financials, area_economics and local_supply still read SEC, Census and OpenStreetMap data).";
const ERROR_MESSAGE_MAX = 200;

function skillOf(id: SkillId): Skill<unknown> {
  return SKILLS[id] as unknown as Skill<unknown>;
}

/** Network calls the input would cost now, or null when the estimate itself fails. */
export async function estimateSkillCalls(
  deps: Pick<SkillRunnerDeps, "qloo" | "registry" | "localities" | "geo">,
  tool: SkillId,
  input: unknown,
): Promise<number | null> {
  // SEC and Census reads cost no Qloo call, whatever they fetch.
  if (isPublicDataTool(tool)) return 0;
  try {
    // The metros the input names load their neighbourhood polygons first (createGeo loads them lazily).
    await ensureMetrosIn(deps.geo, input);
    const n = await skillOf(tool).estimateCalls(input, deps.qloo.forTool(null), deps.registry, { localities: deps.localities, geo: deps.geo });
    return Number.isInteger(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/** The first line of an error message, cut short: enough for the model and the trace, never a stack. */
export function shortError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const line = raw.split("\n", 1)[0]?.trim() || "unknown error";
  return line.length <= ERROR_MESSAGE_MAX ? line : `${line.slice(0, ERROR_MESSAGE_MAX - 1)}…`;
}

/** The free text a call would send to a Qloo search: resolve_entities mentions and find_tags concepts. */
function searchTexts(call: SkillCall): string[] {
  if (call.tool === "resolve_entities") return (call.input as ToolInput<"resolve_entities">).mentions.map((m) => m.text);
  if (call.tool === "find_tags") return (call.input as ToolInput<"find_tags">).concepts.map((c) => c.text);
  return [];
}

/**
 * The code backstop behind the tool description's rule (SPEC §4.6): a name CLERK read as a person who
 * is not a public figure is never searched, whatever type the call gives it. The whole call is
 * refused before any Qloo call, so the model can call again without the name.
 */
function refusePrivatePersons(deps: SkillRunnerDeps, call: SkillCall): SkillCallOutcome | null {
  const names = deps.privatePersons;
  if (names === undefined || names.size === 0) return null;
  const refused = [...new Set(searchTexts(call).filter((t) => names.has(normaliseName(t))))];
  if (refused.length === 0) return null;
  const listed = refused.map((t) => `'${escapeAngles(t)}'`).join(", ");
  return refuseCall(
    deps,
    call,
    `${listed} ${refused.length === 1 ? "is a person" : "are persons"} the question did not name as a public figure; ` +
      `persons are looked up only as public figures, so no Qloo call ran. Call again without ${refused.length === 1 ? "it" : "them"}.`,
  );
}

/**
 * D21: every audience a call sends must be on the run's AUDIENCES list (the pinned catalogue on this
 * desk). The call is refused before any Qloo call, so the model can call again with listed keys.
 */
function refuseUnlistedAudiences(deps: SkillRunnerDeps, call: SkillCall): SkillCallOutcome | null {
  const unlisted = unlistedAudiences(call, deps.audiences);
  if (unlisted.length === 0) return null;
  const listed = unlisted.map((a) => `'${escapeAngles(a)}'`).join(", ");
  const fix = deps.audiences.size === 0 ? "this run has no AUDIENCES, so call again without audiences" : "call again with keys from AUDIENCES only";
  return refuseCall(deps, call, `${listed} ${unlisted.length === 1 ? "is" : "are"} not in the AUDIENCES list, so no Qloo call ran; ${fix}.`);
}

/**
 * D7: a public-data tool whose source is not configured on this server is never run. The call is
 * refused before it runs with PUBLIC_NOT_CONFIGURED_REASON verbatim, and the source's flag joins the
 * report's limitations, so the reason is never paraphrased.
 */
function refuseNotConfigured(deps: SkillRunnerDeps, call: SkillCall): SkillCallOutcome | null {
  const source = unconfiguredSource(call.tool, deps.publicConfigured);
  if (source === null) return null;
  deps.onFlag?.(NOT_CONFIGURED_FLAG[source]);
  return refuseCall(deps, call, notConfiguredRefusal(call.tool, source), { code: "SOURCE_NOT_CONFIGURED", trace: "public_unavailable" });
}

/** A call refused before it ran: tool.start and tool.end (invalid input unless `as` says otherwise), and the message for the model. */
function refuseCall(
  deps: SkillRunnerDeps,
  call: SkillCall,
  message: string,
  as: { code: AnalystToolErrorCode; trace: ErrorCode } = { code: "INVALID_INPUT", trace: "invalid_tool_input" },
): SkillCallOutcome {
  const { events } = deps;
  const base = { toolCallId: call.toolCallId, tool: call.tool };
  events.emit({
    type: "tool.start",
    ...base,
    phase: call.phase,
    args: call.input as ToolArgs,
    stepId: call.stepId,
    triggerFindingId: call.triggerFindingId,
    estimatedCalls: 0,
  });
  events.emit({
    type: "tool.end",
    ...base,
    ok: false,
    status: "error",
    ms: 0,
    evidenceIds: [],
    metricIds: [],
    datasetIds: [],
    findingIds: [],
    flags: [],
    error: { code: as.trace, message },
  });
  return { content: errorText(as.code, message), isError: true, result: null };
}

/**
 * Part 9 open issue 6: a brand config/listed_companies.json maps to a larger company (relation `parent`)
 * has no figures of its own in the filings, so company_financials is never run for it: the call is
 * refused before it runs and the run carries NOT_SEPARATELY_REPORTED, naming the parent, instead of the
 * parent's figures read as the brand's.
 */
function refuseParentBrand(deps: SkillRunnerDeps, call: SkillCall): SkillCallOutcome | null {
  if (call.tool !== "company_financials") return null;
  const brand = (call.input as Partial<ToolInput<"company_financials">> | null)?.brand;
  const entity = isId("R", brand) ? deps.registry.entity(brand) : null;
  if (entity === null) return null;
  const relation = listedRelationOf(entity.name);
  if (relation.kind !== "parent") return null;
  const text = notSeparatelyReported(entity.name, relation.parent);
  deps.onLimitation?.("NOT_SEPARATELY_REPORTED", text);
  return refuseCall(deps, call, `${escapeAngles(text)} No call ran; say so plainly if the question needs financial figures.`);
}

export async function runSkillCall(deps: SkillRunnerDeps, asked: SkillCall, signal: AbortSignal): Promise<SkillCallOutcome> {
  const call = withQuestionFocus(deps, asked);
  const refusal =
    refuseNotConfigured(deps, call) ?? refuseParentBrand(deps, call) ?? refusePrivatePersons(deps, call) ?? refuseUnlistedAudiences(deps, call);
  if (refusal !== null) return refusal;
  const { events } = deps;
  const { toolCallId } = call;
  const deadline = call.deadline ?? null;
  // What the skill watches: the run's stop, and for a follow-up also its time budget.
  const stop = deadline === null ? signal : AbortSignal.any([signal, deadline.signal]);
  const estimatedCalls =
    call.estimatedCalls !== undefined ? call.estimatedCalls : deps.qlooEnabled ? await estimateSkillCalls(deps, call.tool, call.input) : 0;
  events.emit({
    type: "tool.start",
    toolCallId,
    tool: call.tool,
    phase: call.phase,
    args: call.input as ToolArgs,
    stepId: call.stepId,
    triggerFindingId: call.triggerFindingId,
    estimatedCalls,
  });
  const started = deps.now();
  const ms = () => Math.max(0, deps.now() - started);

  let result: SkillResult;
  try {
    if (!deps.qlooEnabled && !isPublicDataTool(call.tool)) {
      result = skillErrorResult({ tool: call.tool, step: call.stepId }, QLOO_DISABLED_NOTICE);
    } else {
      signal.throwIfAborted();
      // The tool rides along so the run's follow-up reserve knows a concept test's calls (D24).
      const qloo = deps.qloo.forTool(toolCallId, call.tool);
      const ctx: SkillCtx = {
        qloo: deadline === null ? qloo : deadline.qloo(qloo),
        publicdata: deps.publicdata?.forTool(toolCallId) ?? null,
        ledger: withCandidateSources(deps.ledger.forToolCall(toolCallId), deps.registry),
        geo: deps.geo,
        localities: deps.localities,
        registry: deps.registry,
        emit: events.emit,
        budget: deadline === null ? deps.budget : deadline.budget(deps.budget),
        signal: stop,
        runId: deps.runId,
        pillar: deps.pillar,
        phase: call.phase,
        toolCallId,
        concepts: deps.concepts ?? [],
        candidates: deps.candidates ?? NO_RUN_CANDIDATES,
      };
      await ensureMetrosIn(deps.geo, call.input);
      result = await skillOf(call.tool).run(call.input, ctx);
    }
  } catch (err) {
    const code: ErrorCode = signal.aborted ? deps.abortCode() : (qlooErrorCode(err) ?? publicErrorCode(err) ?? (stop.aborted ? "timeout" : "internal"));
    const message = shortError(err);
    events.emit({
      type: "tool.end",
      toolCallId,
      tool: call.tool,
      ok: false,
      status: "error",
      ms: ms(),
      evidenceIds: [],
      metricIds: [],
      datasetIds: [],
      findingIds: [],
      flags: [],
      error: { code, message },
    });
    // The message can echo a Qloo, SEC or Census error body, so it is escaped like any other untrusted text.
    return { content: `TOOL_FAILED: ${call.tool} failed (${code}): ${escapeAngles(message)}`, isError: true, result: null };
  }

  deps.onResult?.(call.tool, result, call.input);
  events.emit({
    type: "tool.end",
    toolCallId,
    tool: call.tool,
    ok: result.status !== "error",
    status: result.status,
    ms: ms(),
    evidenceIds: result.evidenceIds,
    metricIds: result.metricIds,
    datasetIds: result.datasetIds,
    findingIds: result.findingIds,
    flags: result.flags,
    error: null,
  });
  return { content: wrapToolData(result.forModel, { tool: call.tool, step: call.stepId }), isError: false, result };
}

/**
 * The trace code of a public-data error a skill let through (skills normally answer UNAVAILABLE
 * themselves): a 429 after retries is rate limiting, anything else (not configured, not found, a
 * network or 5xx failure, a bad request or response) is the source being unavailable. Null for any
 * other error.
 */
export function publicErrorCode(err: unknown): ErrorCode | null {
  const code = publicDataErrorCode(err);
  if (code === null) return null;
  return code === "rate_limited" ? "public_rate_limited" : "public_unavailable";
}

/** A tool call's ledger whose datasets carry the run's candidate marks (R3): "You named" and "Expected" rows. */
function withCandidateSources(ledger: Ledger, registry: RunRegistry): Ledger {
  const addDataset: Ledger["addDataset"] = (input) => ledger.addDataset({ ...input, payload: stampCandidateSources(input.payload, registry) } as typeof input);
  return new Proxy(ledger, {
    get: (target, prop, receiver) => {
      if (prop === "addDataset") return addDataset;
      const value: unknown = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}
