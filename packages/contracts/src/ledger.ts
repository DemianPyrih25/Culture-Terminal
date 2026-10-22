import { z } from "zod";
import {
  BarsPayload,
  GeoLiftPayload,
  MatrixPayload,
  MomentumPayload,
  PositionPayload,
  QuadrantPayload,
  RankedPayload,
  ScorecardPayload,
  SlatePayload,
  SlopePayload,
  TrendWindow,
  type DatasetKind,
} from "./datasets";
import {
  Badge,
  CacheStatus,
  Comparator,
  FindingKind,
  IsoDateTime,
  Flag,
  MetricUnit,
  NoValueReason,
  Severity,
  SkillId,
  SkillStatus,
} from "./enums";
import { DatasetIdSchema, EvidenceIdSchema, FindingIdSchema, MetricIdSchema } from "./ids";
import { QlooPath } from "./qloo-types";

/**
 * The evidence ledger (PLAN §6): E# bundles of Qloo calls, M# metrics computed from them,
 * D# datasets and F# findings. Every number in a note traces M# → E# → request id.
 */

const isoTs = IsoDateTime;

/** Metadata the Qloo client returns with every call (PLAN §5.1). A cached call keeps its original request id and fetch time. */
export const QlooCallMeta = z.object({
  qlooCallId: z.string().min(1),
  /** `x-qloo-request-id` of the response that produced the data. */
  requestId: z.string().min(1),
  cache: CacheStatus,
  fetchedAt: isoTs,
  ms: z.number().nonnegative(),
  /** Served from an expired or pinned entry after a network failure (STALE_CACHE). */
  stale: z.boolean(),
  /** The run that first fetched a cached response; drives REUSED chips. Null for this run's own network calls. */
  originRunId: z.string().nullable(),
});
export type QlooCallMeta = z.infer<typeof QlooCallMeta>;

export interface QlooResult<T> {
  data: T;
  meta: QlooCallMeta;
}

/** One request in the Qloo kit's provenance envelope (D30). Query values are canonical strings, lists comma-joined. */
export const ProvenanceRequest = z.object({
  method: z.literal("GET"),
  path: QlooPath,
  query: z.record(z.string(), z.string()),
});
export type ProvenanceRequest = z.infer<typeof ProvenanceRequest>;

export const Provenance = z.object({ requests: z.array(ProvenanceRequest) });
export type Provenance = z.infer<typeof Provenance>;

/**
 * E#: one skill evidence bundle. `qlooCallIds`, `requestIds` and `provenance.requests` are parallel
 * arrays, one entry per call.
 */
export const Evidence = z
  .object({
    id: EvidenceIdSchema,
    skill: SkillId,
    purpose: z.string(),
    status: SkillStatus,
    qlooCallIds: z.array(z.string().min(1)).min(1),
    requestIds: z.array(z.string().min(1)).min(1),
    /** True when no call in the bundle went to the network (hit, stale, coalesced or reused). */
    cached: z.boolean(),
    /** Earliest fetch time among the calls: the "fetched" on exhibit source lines. */
    fetchedAt: isoTs,
    provenance: Provenance,
    summary: z.string(),
    flags: z.array(Flag),
  })
  .refine(
    (e) => e.requestIds.length === e.qlooCallIds.length && e.provenance.requests.length === e.qlooCallIds.length,
    { message: "qlooCallIds, requestIds and provenance.requests must align" },
  );
export type Evidence = z.infer<typeof Evidence>;

/**
 * M#: a number computed by code (QUANT) with a FORMULAS id. `value` is null exactly when the badge is
 * UNAVAILABLE, and `reason` says why. A STALE metric carries its window (CHECKER V8).
 */
export const Metric = z
  .object({
    id: MetricIdSchema,
    /** Stable machine key, e.g. "subs.similarity" or "share.youth_tilt". */
    key: z.string().min(1),
    label: z.string(),
    /** What the metric is about: R# / T# refs, market or metro ids, or neighbourhood ids. */
    subjectRefs: z.array(z.string().min(1)),
    value: z.number().nullable(),
    reason: NoValueReason.nullable(),
    /** Formatted for prose and chips, e.g. "0.82", "2 of 7", "Rising". */
    display: z.string(),
    unit: MetricUnit,
    badge: Badge,
    formulaId: z.string().min(1),
    evidenceIds: z.array(EvidenceIdSchema),
    /** Sample size behind the value, when meaningful. */
    n: z.int().nonnegative().nullable(),
    /** Per-metric confidence m_badge·(1−1/√n), 0–1 (§6.4). */
    conf: z.number().min(0).max(1).nullable(),
    comparator: Comparator.nullable(),
    window: TrendWindow.nullable(),
  })
  .refine((m) => (m.value === null) === (m.badge === "UNAVAILABLE"), {
    message: "value is null exactly when the badge is UNAVAILABLE",
  })
  .refine((m) => (m.value === null) === (m.reason !== null), { message: "an UNAVAILABLE metric needs a reason" })
  .refine((m) => m.badge !== "STALE" || m.window !== null, { message: "a STALE metric needs its window" });
export type Metric = z.infer<typeof Metric>;

export const FindingSuggestion = z.object({ tool: SkillId, reason: z.string() });
export type FindingSuggestion = z.infer<typeof FindingSuggestion>;

/** F#: a code detector result that can drive an ANALYST follow-up (PLAN §4.4). */
export const Finding = z.object({
  id: FindingIdSchema,
  kind: FindingKind,
  severity: Severity,
  text: z.string(),
  metricIds: z.array(MetricIdSchema),
  /** The suggested follow-up tool, or null when the finding needs none (e.g. a CODE FALLBACK). */
  suggestion: FindingSuggestion.nullable(),
});
export type Finding = z.infer<typeof Finding>;

const envelopeShape = {
  id: DatasetIdSchema,
  title: z.string(),
  /** Evidence behind the exhibit: its source line names their endpoints, request ids and fetch times. */
  evidenceIds: z.array(EvidenceIdSchema),
  /** FORMULAS ids for the exhibit's ⓘ link to /method. */
  formulaIds: z.array(z.string().min(1)),
};

/** D#: a dataset with its kind-specific payload. The viz is chosen by VIZ_COMPAT[kind]. */
export const DatasetEnvelope = z.discriminatedUnion("kind", [
  z.object({ ...envelopeShape, kind: z.literal("Matrix"), payload: MatrixPayload }),
  z.object({ ...envelopeShape, kind: z.literal("Quadrant"), payload: QuadrantPayload }),
  z.object({ ...envelopeShape, kind: z.literal("Bars"), payload: BarsPayload }),
  z.object({ ...envelopeShape, kind: z.literal("Slope"), payload: SlopePayload }),
  z.object({ ...envelopeShape, kind: z.literal("GeoLift"), payload: GeoLiftPayload }),
  z.object({ ...envelopeShape, kind: z.literal("Ranked"), payload: RankedPayload }),
  z.object({ ...envelopeShape, kind: z.literal("Slate"), payload: SlatePayload }),
  z.object({ ...envelopeShape, kind: z.literal("Momentum"), payload: MomentumPayload }),
  z.object({ ...envelopeShape, kind: z.literal("Scorecard"), payload: ScorecardPayload }),
  z.object({ ...envelopeShape, kind: z.literal("Position"), payload: PositionPayload }),
]);
export type DatasetEnvelope = z.infer<typeof DatasetEnvelope>;
export type DatasetOf<K extends DatasetKind> = Extract<DatasetEnvelope, { kind: K }>;
