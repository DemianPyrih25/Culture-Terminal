import { z } from "zod";
import { DatasetKind } from "./datasets";
import {
  CacheStatus,
  EntityType,
  Flag,
  IsoDateTime,
  Lane,
  MatchClass,
  MentionRole,
  Mode,
  Phase,
  SkillId,
  SkillStatus,
  TerminalRunStatus,
  ToolName,
} from "./enums";
import {
  DatasetIdSchema,
  EntityRefSchema,
  EvidenceIdSchema,
  FindingIdSchema,
  MetricIdSchema,
  StepIdSchema,
} from "./ids";
import { Intent } from "./intent";
import { DatasetEnvelope, Evidence, Finding, Metric } from "./ledger";
import { RunLimits } from "./limits";
import { QlooPath } from "./qloo-types";
import {
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
 * The SSE event protocol (PLAN §4.7, SPEC §4.8). Every event is `{seq, ts, runId, type, …payload}`:
 * seq is a per-run counter from 1, which the SSE `id:` line carries for Last-Event-ID resume and
 * which makes the reducer idempotent. Producers emit an EventInput (no envelope); the run manager
 * stamps the envelope, persists it to run_events and streams it.
 */

const envelopeShape = {
  seq: z.int().min(1),
  ts: IsoDateTime,
  runId: z.string().min(1),
};
export const EventEnvelope = z.object(envelopeShape);
export type EventEnvelope = z.infer<typeof EventEnvelope>;

function event<T extends string, S extends z.ZodRawShape>(type: T, shape: S) {
  return {
    input: z.object({ type: z.literal(type), ...shape }),
    full: z.object({ ...envelopeShape, type: z.literal(type), ...shape }),
  };
}

// Payload atoms -----------------------------------------------------------------------------------------

export const ResolvedMention = z
  .object({
    mention: z.string(),
    role: MentionRole,
    entityType: EntityType,
    match: MatchClass,
    /** Set only for an exact match (D20); everything else is offered, never applied. */
    ref: EntityRefSchema.nullable(),
    name: z.string().nullable(),
    popularity: z.number().nullable(),
    disambiguation: z.string().nullable(),
    alternatives: z.array(
      z.object({ name: z.string(), disambiguation: z.string().nullable(), popularity: z.number().nullable() }),
    ),
    /** gate: the resolution gate before the ANALYST; tool: a resolve_entities call. */
    source: z.enum(["gate", "tool"]),
  })
  .refine((m) => (m.ref !== null) === (m.match === "exact"), { message: "only an exact match carries a ref" });
export type ResolvedMention = z.infer<typeof ResolvedMention>;

export const PickerCandidate = z.object({
  /** Opaque choice key; the server maps it to the Qloo entity, which never reaches the browser. */
  key: z.string().min(1),
  name: z.string(),
  disambiguation: z.string().nullable(),
  popularity: z.number().nullable(),
});
export type PickerCandidate = z.infer<typeof PickerCandidate>;

export const ErrorCode = z.enum([
  "qloo_auth",
  "qloo_rate_limited",
  "qloo_unavailable",
  "qloo_budget",
  "llm_error",
  "llm_refusal",
  "llm_budget",
  "timeout",
  "cancelled",
  "invalid_tool_input",
  "internal",
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

const QlooCounts = z.object({
  network: z.int().nonnegative(),
  cached: z.int().nonnegative(),
  reused: z.int().nonnegative(),
});

// Events --------------------------------------------------------------------------------------------------

const E = {
  runCreated: event("run.created", {
    question: z.string(),
    mode: Mode,
    lane: Lane,
    limits: RunLimits,
    /** Set on child runs launched from next_moves (§7.3). */
    parentRunId: z.string().nullable(),
    /** The ANALYST model for this run; the economy model in economy mode. */
    model: z.string(),
  }),
  clerk: event("clerk", { intent: Intent, ms: z.number().nonnegative() }),
  resolve: event("resolve", { entities: z.array(ResolvedMention) }),
  needsInput: event("needs_input", {
    mention: z.string(),
    entityType: EntityType,
    reason: MatchClass.exclude(["exact"]),
    candidates: z.array(PickerCandidate),
  }),
  plan: event("plan", {
    plan: SubmitPlanInputShape,
    /** Estimated Qloo calls per step, for estimated-vs-actual pills. */
    estimates: z.array(z.object({ stepId: StepIdSchema, calls: z.int().nonnegative() })),
  }),
  /** ANALYST thinking updates, coalesced every 300 ms. */
  note: event("note", { text: z.string() }),
  toolStart: event("tool.start", {
    /** The tool_use id, or a code-made id for opening-scan steps. */
    toolCallId: z.string().min(1),
    tool: ToolName,
    phase: Phase,
    args: z.json(),
    stepId: StepIdSchema.nullable(),
    triggerFindingId: FindingIdSchema.nullable(),
    estimatedCalls: z.int().nonnegative().nullable(),
  }),
  toolEnd: event("tool.end", {
    toolCallId: z.string().min(1),
    tool: ToolName,
    ok: z.boolean(),
    status: SkillStatus,
    ms: z.number().nonnegative(),
    evidenceIds: z.array(EvidenceIdSchema),
    metricIds: z.array(MetricIdSchema),
    datasetIds: z.array(DatasetIdSchema),
    findingIds: z.array(FindingIdSchema),
    flags: z.array(Flag),
    error: z.object({ code: ErrorCode, message: z.string() }).nullable(),
  }),
  qloo: event("qloo", {
    qlooCallId: z.string().min(1),
    /** The tool call that made it, or null for gate and scan bookkeeping calls. */
    toolCallId: z.string().nullable(),
    endpoint: QlooPath,
    filterType: z.string().nullable(),
    /** Canonical parameters with long values (WKT, id lists) shortened. Never the API key. */
    paramsRedacted: z.record(z.string(), z.string()),
    cache: CacheStatus,
    ms: z.number().nonnegative(),
    /** Null only when no response arrived. */
    requestId: z.string().nullable(),
    /** HTTP status, or null when no response arrived. */
    status: z.int().nullable(),
    rows: z.int().nonnegative().nullable(),
    /** Age of a cached response, for "[CACHE 3h]" chips. */
    cacheAgeMs: z.number().nonnegative().nullable(),
    /** The run a reused response came from ("REUSED from #A1F3"). */
    originRunId: z.string().nullable(),
    error: z.string().nullable(),
  }),
  finding: event("finding", { finding: Finding, toolCallId: z.string().nullable() }),
  /** CODE FALLBACK: a deterministic ladder step taken by code, e.g. POLYGON → POINT. */
  fallback: event("fallback", {
    from: z.string(),
    to: z.string(),
    reason: z.string(),
    toolCallId: z.string().nullable(),
    findingId: FindingIdSchema.nullable(),
  }),
  /** ANALYST PIVOT: a model decision driven by a finding. */
  pivot: event("pivot", {
    triggerFindingId: FindingIdSchema,
    tool: SkillId,
    args: z.json(),
    toolCallId: z.string().min(1),
  }),
  metric: event("metric", { metric: Metric }),
  evidence: event("evidence", { evidence: Evidence }),
  datasetReady: event("dataset.ready", {
    datasetId: DatasetIdSchema,
    kind: DatasetKind,
    title: z.string(),
    bytes: z.int().nonnegative(),
    /** The full dataset when small enough to stream; otherwise fetch /api/runs/[id]/datasets/[did]. */
    inline: DatasetEnvelope.nullable(),
  }),
  reportDraft: event("report.draft", {
    draft: ReportDraftShape,
    /** 1 for the first submission, 2 after the CHECKER repair turn. */
    attempt: z.int().min(1).max(2),
  }),
  validation: event("validation", {
    ok: z.boolean(),
    attempt: z.int().min(1).max(2),
    issues: z.array(ValidationIssue),
    numbersTraced: NumbersTraced,
    adviceTerms: z.int().nonnegative(),
  }),
  reportFinal: event("report.final", { report: Report }),
  ghost: event("ghost", { answer: GhostAnswer, diff: GhostDiff }),
  /** Running totals for the run so far; each usage event replaces the last. */
  usage: event("usage", {
    llmUsd: z.number().nonnegative(),
    tokens: TokenUsage,
    qloo: QlooCounts,
    elapsedMs: z.number().nonnegative(),
  }),
  error: event("error", { code: ErrorCode, message: z.string(), retryable: z.boolean() }),
  runEnd: event("run.end", {
    status: TerminalRunStatus,
    elapsedMs: z.number().nonnegative(),
    reason: z.string().nullable(),
  }),
};

export const RunEvent = z.discriminatedUnion("type", [
  E.runCreated.full,
  E.clerk.full,
  E.resolve.full,
  E.needsInput.full,
  E.plan.full,
  E.note.full,
  E.toolStart.full,
  E.toolEnd.full,
  E.qloo.full,
  E.finding.full,
  E.fallback.full,
  E.pivot.full,
  E.metric.full,
  E.evidence.full,
  E.datasetReady.full,
  E.reportDraft.full,
  E.validation.full,
  E.reportFinal.full,
  E.ghost.full,
  E.usage.full,
  E.error.full,
  E.runEnd.full,
]);
export type RunEvent = z.infer<typeof RunEvent>;

/** An event before the run manager stamps seq, ts and runId. */
export const RunEventInput = z.discriminatedUnion("type", [
  E.runCreated.input,
  E.clerk.input,
  E.resolve.input,
  E.needsInput.input,
  E.plan.input,
  E.note.input,
  E.toolStart.input,
  E.toolEnd.input,
  E.qloo.input,
  E.finding.input,
  E.fallback.input,
  E.pivot.input,
  E.metric.input,
  E.evidence.input,
  E.datasetReady.input,
  E.reportDraft.input,
  E.validation.input,
  E.reportFinal.input,
  E.ghost.input,
  E.usage.input,
  E.error.input,
  E.runEnd.input,
]);
export type EventInput = z.infer<typeof RunEventInput>;

export type RunEventType = RunEvent["type"];
export type EventOf<T extends RunEventType> = Extract<RunEvent, { type: T }>;
export type EventInputOf<T extends RunEventType> = Extract<EventInput, { type: T }>;

export const RUN_EVENT_TYPES = [
  "run.created",
  "clerk",
  "resolve",
  "needs_input",
  "plan",
  "note",
  "tool.start",
  "tool.end",
  "qloo",
  "finding",
  "fallback",
  "pivot",
  "metric",
  "evidence",
  "dataset.ready",
  "report.draft",
  "validation",
  "report.final",
  "ghost",
  "usage",
  "error",
  "run.end",
] as const satisfies readonly RunEventType[];

/** Parses an event object, or its JSON text from an SSE `data:` line. Throws a ZodError when invalid. */
export function parseRunEvent(raw: unknown): RunEvent {
  return RunEvent.parse(typeof raw === "string" ? JSON.parse(raw) : raw);
}

export function safeParseRunEvent(raw: unknown): ReturnType<typeof RunEvent.safeParse> {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = undefined;
    }
  }
  return RunEvent.safeParse(value);
}

/** Adds the envelope to an event input. */
export function stampEvent(input: EventInput, envelope: EventEnvelope): RunEvent {
  return { ...input, ...envelope } as RunEvent;
}

/** Splits an event into its envelope and input, e.g. to store `type` and the payload in run_events. */
export function unstampEvent(event: RunEvent): { envelope: EventEnvelope; input: EventInput } {
  const { seq, ts, runId, ...input } = event;
  return { envelope: { seq, ts, runId }, input: input as EventInput };
}

/**
 * One SSE frame. There is deliberately no `event:` line: named events never reach
 * EventSource.onmessage, so clients read `type` from the JSON instead.
 */
export function encodeSseEvent(event: RunEvent): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}
