import type { DatasetKind } from "./datasets";
import type { CacheStatus, Flag, Lane, Mode, Phase, RunStatus, SkillStatus, ToolName } from "./enums";
import type { ErrorCode, EventOf, PickerCandidate, ResolvedMention, RunEvent, RunEventType } from "./events";
import type { DatasetId, EvidenceId, FindingId, MetricId, StepId } from "./ids";
import type { Intent } from "./intent";
import type { DatasetEnvelope, Evidence, Finding, Metric } from "./ledger";
import type { RunLimits } from "./limits";
import type {
  GhostAnswer,
  GhostDiff,
  NumbersTraced,
  Report,
  ReportDraftShape,
  SubmitPlanInputShape,
  TokenUsage,
  ValidationIssue,
} from "./report";

/**
 * The client- and server-side view of one run, rebuilt purely from its events. Live streams, 8×
 * replays and server snapshots all feed `applyEvent`. The state is plain JSON.
 */

type Stamped<T extends RunEventType> = Omit<EventOf<T>, "type" | "runId">;

export type JsonValue = EventOf<"tool.start">["args"];

export interface ToolCallState {
  toolCallId: string;
  tool: ToolName;
  phase: Phase | null;
  args: JsonValue | null;
  stepId: StepId | null;
  triggerFindingId: FindingId | null;
  estimatedCalls: number | null;
  /** "running" until tool.end arrives. */
  status: "running" | SkillStatus;
  ok: boolean | null;
  ms: number | null;
  evidenceIds: EvidenceId[];
  metricIds: MetricId[];
  datasetIds: DatasetId[];
  findingIds: FindingId[];
  flags: Flag[];
  /** Qloo calls attributed to this tool call, in arrival order. */
  qlooCallIds: string[];
  /** An ANALYST PIVOT: a follow-up the model made because of a finding. */
  pivot: boolean;
  error: { code: ErrorCode; message: string } | null;
  startedSeq: number | null;
  endedSeq: number | null;
}

export type QlooChip = Stamped<"qloo">;

export interface QlooTotals {
  /** Calls that went to the network (cache "miss"). */
  network: number;
  /** Calls served from this run's or the shared cache: hit, stale and coalesced. */
  cached: number;
  /** Cache hits first fetched by another run (REUSED chips). */
  reused: number;
  byCache: Record<CacheStatus, number>;
  chips: QlooChip[];
}

export interface DatasetState {
  id: DatasetId;
  kind: DatasetKind;
  title: string;
  bytes: number;
  /** The full dataset when it was streamed inline; otherwise fetched on demand. */
  data: DatasetEnvelope | null;
  seq: number;
}

export interface TimelineEntry {
  seq: number;
  ts: string;
  type: RunEventType;
  /** The id the entry points at (tool call, Qloo call, finding, metric, evidence or dataset), if any. */
  key: string | null;
}

export interface RunState {
  runId: string;
  /** Highest seq applied; 0 before the first event. */
  lastSeq: number;
  status: RunStatus;
  createdAt: string | null;
  updatedAt: string | null;

  question: string | null;
  mode: Mode | null;
  lane: Lane | null;
  limits: RunLimits | null;
  parentRunId: string | null;
  model: string | null;

  intent: Intent | null;
  clerkMs: number | null;
  resolves: ResolvedMention[];
  needsInput: { mention: string; entityType: ResolvedMention["entityType"]; reason: Exclude<ResolvedMention["match"], "exact">; candidates: PickerCandidate[] } | null;
  plan: { plan: SubmitPlanInputShape; estimates: { stepId: StepId; calls: number }[] } | null;
  notes: Stamped<"note">[];

  toolCalls: ToolCallState[];
  qloo: QlooTotals;
  findings: Finding[];
  fallbacks: Stamped<"fallback">[];
  pivots: Stamped<"pivot">[];
  metrics: { [id: MetricId]: Metric };
  evidence: { [id: EvidenceId]: Evidence };
  datasets: { [id: DatasetId]: DatasetState };

  draft: ReportDraftShape | null;
  draftAttempt: number | null;
  validation: { ok: boolean; attempt: number; issues: ValidationIssue[]; numbersTraced: NumbersTraced; adviceTerms: number } | null;
  report: Report | null;
  ghost: { answer: GhostAnswer; diff: GhostDiff } | null;
  usage: { llmUsd: number; tokens: TokenUsage; qloo: { network: number; cached: number; reused: number }; elapsedMs: number } | null;
  errors: Stamped<"error">[];
  ended: { status: EventOf<"run.end">["status"]; elapsedMs: number; reason: string | null } | null;

  /** Every applied event in order, for the trace rail's event log. */
  timeline: TimelineEntry[];
}

export function initialRunState(runId: string): RunState {
  return {
    runId,
    lastSeq: 0,
    status: "queued",
    createdAt: null,
    updatedAt: null,
    question: null,
    mode: null,
    lane: null,
    limits: null,
    parentRunId: null,
    model: null,
    intent: null,
    clerkMs: null,
    resolves: [],
    needsInput: null,
    plan: null,
    notes: [],
    toolCalls: [],
    qloo: {
      network: 0,
      cached: 0,
      reused: 0,
      byCache: { hit: 0, miss: 0, stale: 0, coalesced: 0, reused: 0 },
      chips: [],
    },
    findings: [],
    fallbacks: [],
    pivots: [],
    metrics: {},
    evidence: {},
    datasets: {},
    draft: null,
    draftAttempt: null,
    validation: null,
    report: null,
    ghost: null,
    usage: null,
    errors: [],
    ended: null,
    timeline: [],
  };
}

function newToolCall(toolCallId: string, tool: ToolName): ToolCallState {
  return {
    toolCallId,
    tool,
    phase: null,
    args: null,
    stepId: null,
    triggerFindingId: null,
    estimatedCalls: null,
    status: "running",
    ok: null,
    ms: null,
    evidenceIds: [],
    metricIds: [],
    datasetIds: [],
    findingIds: [],
    flags: [],
    qlooCallIds: [],
    pivot: false,
    error: null,
    startedSeq: null,
    endedSeq: null,
  };
}

/** Updates the tool call with this id, creating it first if a replay starts after its tool.start. */
function upsertTool(
  calls: ToolCallState[],
  toolCallId: string,
  tool: ToolName,
  update: (t: ToolCallState) => ToolCallState,
): ToolCallState[] {
  const i = calls.findIndex((c) => c.toolCallId === toolCallId);
  if (i === -1) return [...calls, update(newToolCall(toolCallId, tool))];
  const next = calls.slice();
  next[i] = update(calls[i] as ToolCallState);
  return next;
}

function timelineKey(event: RunEvent): string | null {
  switch (event.type) {
    case "tool.start":
    case "tool.end":
      return event.toolCallId;
    case "qloo":
      return event.qlooCallId;
    case "finding":
      return event.finding.id;
    case "metric":
      return event.metric.id;
    case "evidence":
      return event.evidence.id;
    case "dataset.ready":
      return event.datasetId;
    case "pivot":
      return event.toolCallId;
    case "needs_input":
      return event.mention;
    default:
      return null;
  }
}

function strip<T extends { type: unknown; runId: unknown }>(event: T): Omit<T, "type" | "runId"> {
  const rest: Partial<T> = { ...event };
  delete rest.type;
  delete rest.runId;
  return rest as Omit<T, "type" | "runId">;
}

const CACHE_BUCKET: Record<CacheStatus, "network" | "cached" | "reused"> = {
  miss: "network",
  hit: "cached",
  stale: "cached",
  coalesced: "cached",
  reused: "reused",
};

/**
 * Applies one event. Events for another run, duplicates and out-of-order events (seq ≤ lastSeq) are
 * ignored and the same state object is returned, so re-applying is idempotent and cheap to detect.
 * Otherwise a new state is returned; the input state is never mutated. The first run.end is final:
 * a later one is recorded in the timeline but changes neither status nor `ended`.
 */
export function applyEvent(state: RunState, event: RunEvent): RunState {
  if (event.runId !== state.runId || event.seq <= state.lastSeq) return state;

  const s: RunState = {
    ...state,
    lastSeq: event.seq,
    createdAt: state.createdAt ?? event.ts,
    updatedAt: event.ts,
    // A run leaves the queue with its first working event; a terminal status only comes from run.end.
    status: state.ended === null && state.status === "queued" && event.type !== "run.created" ? "running" : state.status,
    timeline: [...state.timeline, { seq: event.seq, ts: event.ts, type: event.type, key: timelineKey(event) }],
  };

  switch (event.type) {
    case "run.created":
      return {
        ...s,
        question: event.question,
        mode: event.mode,
        lane: event.lane,
        limits: event.limits,
        parentRunId: event.parentRunId,
        model: event.model,
      };
    case "clerk":
      return { ...s, intent: event.intent, clerkMs: event.ms };
    case "resolve":
      return { ...s, resolves: [...s.resolves, ...event.entities] };
    case "needs_input":
      return {
        ...s,
        status: s.ended === null ? "needs_input" : s.status,
        needsInput: {
          mention: event.mention,
          entityType: event.entityType,
          reason: event.reason,
          candidates: event.candidates,
        },
      };
    case "plan":
      return { ...s, plan: { plan: event.plan, estimates: event.estimates } };
    case "note":
      return { ...s, notes: [...s.notes, strip(event)] };
    case "tool.start":
      return {
        ...s,
        toolCalls: upsertTool(s.toolCalls, event.toolCallId, event.tool, (t) => ({
          ...t,
          tool: event.tool,
          phase: event.phase,
          args: event.args,
          stepId: event.stepId,
          triggerFindingId: event.triggerFindingId,
          estimatedCalls: event.estimatedCalls,
          startedSeq: event.seq,
        })),
      };
    case "tool.end":
      return {
        ...s,
        toolCalls: upsertTool(s.toolCalls, event.toolCallId, event.tool, (t) => ({
          ...t,
          status: event.status,
          ok: event.ok,
          ms: event.ms,
          evidenceIds: event.evidenceIds,
          metricIds: event.metricIds,
          datasetIds: event.datasetIds,
          findingIds: event.findingIds,
          flags: event.flags,
          error: event.error,
          endedSeq: event.seq,
        })),
      };
    case "qloo": {
      const bucket = CACHE_BUCKET[event.cache];
      const qloo: QlooTotals = {
        ...s.qloo,
        [bucket]: s.qloo[bucket] + 1,
        byCache: { ...s.qloo.byCache, [event.cache]: s.qloo.byCache[event.cache] + 1 },
        chips: [...s.qloo.chips, strip(event)],
      };
      const toolCallId = event.toolCallId;
      const toolCalls =
        toolCallId !== null && s.toolCalls.some((t) => t.toolCallId === toolCallId)
          ? s.toolCalls.map((t) =>
              t.toolCallId === toolCallId ? { ...t, qlooCallIds: [...t.qlooCallIds, event.qlooCallId] } : t,
            )
          : s.toolCalls;
      return { ...s, qloo, toolCalls };
    }
    case "finding":
      return {
        ...s,
        findings: [...s.findings.filter((f) => f.id !== event.finding.id), event.finding],
      };
    case "fallback":
      return { ...s, fallbacks: [...s.fallbacks, strip(event)] };
    case "pivot":
      return {
        ...s,
        pivots: [...s.pivots, strip(event)],
        toolCalls: upsertTool(s.toolCalls, event.toolCallId, event.tool, (t) => ({
          ...t,
          pivot: true,
          triggerFindingId: t.triggerFindingId ?? event.triggerFindingId,
        })),
      };
    case "metric":
      return { ...s, metrics: { ...s.metrics, [event.metric.id]: event.metric } };
    case "evidence":
      return { ...s, evidence: { ...s.evidence, [event.evidence.id]: event.evidence } };
    case "dataset.ready":
      return {
        ...s,
        datasets: {
          ...s.datasets,
          [event.datasetId]: {
            id: event.datasetId,
            kind: event.kind,
            title: event.title,
            bytes: event.bytes,
            data: event.inline,
            seq: event.seq,
          },
        },
      };
    case "report.draft":
      return { ...s, draft: event.draft, draftAttempt: event.attempt };
    case "validation":
      return {
        ...s,
        validation: {
          ok: event.ok,
          attempt: event.attempt,
          issues: event.issues,
          numbersTraced: event.numbersTraced,
          adviceTerms: event.adviceTerms,
        },
      };
    case "report.final":
      return { ...s, report: event.report };
    case "ghost":
      return { ...s, ghost: { answer: event.answer, diff: event.diff } };
    case "usage":
      return {
        ...s,
        usage: { llmUsd: event.llmUsd, tokens: event.tokens, qloo: event.qloo, elapsedMs: event.elapsedMs },
      };
    case "error":
      return { ...s, errors: [...s.errors, strip(event)] };
    case "run.end":
      // The first terminal event wins: a later run.end (e.g. an orphan finalizer) never rewrites it.
      if (s.ended !== null) return s;
      return {
        ...s,
        status: event.status,
        ended: { status: event.status, elapsedMs: event.elapsedMs, reason: event.reason },
      };
    default: {
      const unreachable: never = event;
      return unreachable;
    }
  }
}

/** Folds events into a state; the same idempotence and ordering rules apply. */
export function applyEvents(state: RunState, events: Iterable<RunEvent>): RunState {
  let next = state;
  for (const e of events) next = applyEvent(next, e);
  return next;
}

/** Rebuilds a run's state from its stored events (server snapshots, replays). */
export function reduceRunEvents(runId: string, events: Iterable<RunEvent>): RunState {
  return applyEvents(initialRunState(runId), events);
}

export function isTerminal(state: RunState): boolean {
  return state.ended !== null;
}
