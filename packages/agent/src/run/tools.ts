import {
  SkillId,
  wrapQlooData,
  type ErrorCode,
  type EventInputOf,
  type FindingId,
  type Flag,
  type GeoApi,
  type Phase,
  type Pillar,
  type RunBudget,
  type Skill,
  type SkillCtx,
  type SkillResult,
  type StepId,
  type ToolInput,
} from "@ct/contracts";
import { qlooErrorCode, type RunQloo } from "@ct/qloo";
import { normaliseName, SKILLS, skillErrorResult } from "@ct/quant";
import type { RunLedger } from "../ledger";
import { errorText } from "../llm/notices";
import type { RunRegistry } from "../registry";
import { escapeAngles } from "./context";
import type { FollowupDeadline } from "./followup";
import type { RunEvents } from "./meter";

/**
 * One skill call end to end, for opening-scan steps and ANALYST tool calls alike: tool.start, the
 * skill against its own SkillCtx (Qloo calls and findings attributed to this tool call), tool.end,
 * and the wrapped digest the model reads. A skill that throws becomes an is_error result with a
 * short, escaped message; the trace keeps the error code, never a stack.
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
  ledger: RunLedger;
  registry: RunRegistry;
  geo: GeoApi;
  budget: RunBudget;
  /** False answers every call with an error digest and makes no Qloo call (V7 fail-closed path). */
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

export const QLOO_DISABLED_NOTICE = "Qloo is disabled for this run: no data is available from any tool.";
const ERROR_MESSAGE_MAX = 200;

function skillOf(id: SkillId): Skill<unknown> {
  return SKILLS[id] as unknown as Skill<unknown>;
}

/** Network calls the input would cost now, or null when the estimate itself fails. */
export async function estimateSkillCalls(deps: Pick<SkillRunnerDeps, "qloo" | "registry">, tool: SkillId, input: unknown): Promise<number | null> {
  try {
    const n = await skillOf(tool).estimateCalls(input, deps.qloo.forTool(null), deps.registry);
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
  const message =
    `${listed} ${refused.length === 1 ? "is a person" : "are persons"} the question did not name as a public figure; ` +
    `persons are looked up only as public figures, so no Qloo call ran. Call again without ${refused.length === 1 ? "it" : "them"}.`;
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

export async function runSkillCall(deps: SkillRunnerDeps, call: SkillCall, signal: AbortSignal): Promise<SkillCallOutcome> {
  const refusal = refusePrivatePersons(deps, call);
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
    if (!deps.qlooEnabled) {
      result = skillErrorResult({ tool: call.tool, step: call.stepId }, QLOO_DISABLED_NOTICE);
    } else {
      signal.throwIfAborted();
      const qloo = deps.qloo.forTool(toolCallId);
      const ctx: SkillCtx = {
        qloo: deadline === null ? qloo : deadline.qloo(qloo),
        ledger: deps.ledger.forToolCall(toolCallId),
        geo: deps.geo,
        registry: deps.registry,
        emit: events.emit,
        budget: deadline === null ? deps.budget : deadline.budget(deps.budget),
        signal: stop,
        runId: deps.runId,
        pillar: deps.pillar,
        phase: call.phase,
        toolCallId,
      };
      result = await skillOf(call.tool).run(call.input, ctx);
    }
  } catch (err) {
    const code: ErrorCode = signal.aborted ? deps.abortCode() : (qlooErrorCode(err) ?? (stop.aborted ? "timeout" : "internal"));
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
    // The message can echo Qloo's error body, so it is escaped like any other untrusted text.
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
  return { content: wrapQlooData(result.forModel, { tool: call.tool, step: call.stepId }), isError: false, result };
}
