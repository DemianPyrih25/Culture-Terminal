import {
  isPublicDataTool,
  publicDataErrorCode,
  SkillId,
  wrapToolData,
  type ErrorCode,
  type EventInputOf,
  type FindingId,
  type Flag,
  type GeoApi,
  type LocalityApi,
  type MetroId,
  type Phase,
  type Pillar,
  type RunBudget,
  type Skill,
  type SkillCtx,
  type SkillResult,
  type StepId,
  type ToolInput,
} from "@ct/contracts";
import { ensureMetrosIn } from "@ct/geo";
import type { RunPublic } from "@ct/publicdata";
import { qlooErrorCode, type RunQloo } from "@ct/qloo";
import { normaliseName, SKILLS, skillErrorResult } from "@ct/quant";
import type { RunLedger } from "../ledger";
import { errorText } from "../llm/notices";
import type { RunRegistry } from "../registry";
import { unlistedAudiences } from "./audiences";
import { escapeAngles } from "./context";
import type { FollowupDeadline } from "./followup";
import type { RunEvents } from "./meter";

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
  /** Every completed skill run, e.g. to collect its limitations. */
  onResult?: (tool: SkillId, result: SkillResult) => void;
  /**
   * The gazetteer areas the question names in its map city (scan namedAreaIds). A geo_lift call in that
   * city that names none gets them (withQuestionFocus), so every lift map ranks the reader's own area.
   */
  questionAreas?: { metro: MetroId; ids: readonly string[] } | null;
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

/**
 * The skills that put evidence in the ledger and the flags they raised: the report's skill
 * limitations are Skill.limitations(flags) of these, in contracts order so the report is stable.
 */
export class SkillsRan {
  readonly #flags = new Map<SkillId, Set<Flag>>();

  add(tool: SkillId, flags: readonly Flag[]): void {
    const seen = this.#flags.get(tool) ?? new Set<Flag>();
    for (const f of flags) seen.add(f);
    this.#flags.set(tool, seen);
  }

  limitations(): string[] {
    const lines = SkillId.options.flatMap((id) => {
      const flags = this.#flags.get(id);
      return flags === undefined ? [] : skillOf(id).limitations([...flags]);
    });
    return [...new Set(lines)];
  }
}

/** Parsed tool input is plain JSON (zod output of the tool's JSON schema). */
type ToolArgs = EventInputOf<"tool.start">["args"];

export const QLOO_DISABLED_NOTICE =
  "Qloo is disabled for this run: no data is available from any Qloo tool (company_financials and area_economics still read SEC and Census data).";
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

/** A call refused before it ran: tool.start and tool.end as invalid input, and the message for the model. */
function refuseCall(deps: SkillRunnerDeps, call: SkillCall, message: string): SkillCallOutcome {
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
    error: { code: "invalid_tool_input", message },
  });
  return { content: errorText("INVALID_INPUT", message), isError: true, result: null };
}

export async function runSkillCall(deps: SkillRunnerDeps, asked: SkillCall, signal: AbortSignal): Promise<SkillCallOutcome> {
  const call = withQuestionFocus(deps, asked);
  const refusal = refusePrivatePersons(deps, call) ?? refuseUnlistedAudiences(deps, call);
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
      const qloo = deps.qloo.forTool(toolCallId);
      const ctx: SkillCtx = {
        qloo: deadline === null ? qloo : deadline.qloo(qloo),
        publicdata: deps.publicdata?.forTool(toolCallId) ?? null,
        ledger: deps.ledger.forToolCall(toolCallId),
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

  deps.onResult?.(call.tool, result);
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
