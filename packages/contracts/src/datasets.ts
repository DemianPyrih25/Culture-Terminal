import { z } from "zod";
import {
  Badge,
  BlockFamily,
  Comparator,
  EntityType,
  LocationMethod,
  MarketId,
  MetroId,
  MetricUnit,
  MomentumTrend,
  NoValueReason,
  PositionAxis,
  QuadrantName,
  ScorecardVerdict,
  SkillId,
  SponsorCategory,
  WhiteSpaceQuadrant,
} from "./enums";
import {
  DatasetIdSchema,
  EntityRefSchema,
  EvidenceIdSchema,
  HypothesisIdSchema,
  MetricIdSchema,
  TagRefSchema,
} from "./ids";

/**
 * Dataset payloads: the full data behind each exhibit (PLAN §5.3, §7, §8.4). They go to the UI
 * through `dataset.ready` and the database, never to the model. A missing value is always
 * `value: null` plus a NoValueReason, never 0, so UNAVAILABLE can never render as a number.
 */

export const DatasetKind = z.enum([
  "Matrix",
  "Quadrant",
  "Bars",
  "Slope",
  "GeoLift",
  "Ranked",
  "Slate",
  "Momentum",
  "Scorecard",
  "Position",
]);
export type DatasetKind = z.infer<typeof DatasetKind>;

// Shared atoms ---------------------------------------------------------------------------------------

const valueRule = <T extends { value: number | null; reason: NoValueReason | null }>(c: T) =>
  (c.value === null) === (c.reason !== null);
const valueRuleMessage = { message: "value is null exactly when a reason is given" };

/** A number or an explained absence. */
export const ValueCell = z
  .object({ value: z.number().nullable(), reason: NoValueReason.nullable() })
  .refine(valueRule, valueRuleMessage);
export type ValueCell = z.infer<typeof ValueCell>;

/** An ISO date window, e.g. the frozen trending window. */
export const TrendWindow = z.object({ start: z.iso.date(), end: z.iso.date() });
export type TrendWindow = z.infer<typeof TrendWindow>;

/** "k of n" among peers; rank 1 is best. */
export const PeerRank = z
  .object({ rank: z.int().positive(), of: z.int().positive() })
  .refine((r) => r.rank <= r.of, { message: "rank cannot exceed of" });
export type PeerRank = z.infer<typeof PeerRank>;

/** A labelled axis item: an entity, a context or a series. `key` is unique within its list. */
export const AxisItem = z.object({
  key: z.string().min(1),
  label: z.string(),
  ref: EntityRefSchema.nullable(),
  /** Section the item belongs to, e.g. "AGE", "AUDIENCE", "METRO" in a share grid; null when unsectioned. */
  group: z.string().nullable(),
  /** Short code for compact axes (MatrixGrid), e.g. "JC"; the reader derives one when absent. */
  code: z.string().min(1).max(4).optional(),
});
export type AxisItem = z.infer<typeof AxisItem>;

const uniqueKeys = (items: readonly { key: string }[]) => new Set(items.map((i) => i.key)).size === items.length;

// Matrix: SUBS and SHARE (MatrixGrid) ------------------------------------------------------------------

export const MatrixCell = z
  .object({
    value: z.number().nullable(),
    reason: NoValueReason.nullable(),
    /** Rank of this cell within its row among scored cells (1 = top): the glyph. Null when unscored. */
    rank: z.int().positive().nullable(),
  })
  .refine(valueRule, valueRuleMessage);
export type MatrixCell = z.infer<typeof MatrixCell>;

export const MatrixPayload = z
  .object({
    /** similarity: SUBS (colour = symmetric similarity, D13). share: SHARE (colour = within-call pct per row). */
    mode: z.enum(["similarity", "share"]),
    valueLabel: z.string(),
    unit: MetricUnit,
    comparator: Comparator,
    rows: z.array(AxisItem),
    cols: z.array(AxisItem),
    /** rows × cols, aligned with `rows` and `cols`. SUBS diagonals carry reason "self". */
    cells: z.array(z.array(MatrixCell)),
    /** Hub score (SUBS) or another per-column margin bar, aligned with `cols`. */
    margin: z.object({ label: z.string(), values: z.array(ValueCell) }).nullable(),
    /** The subject column/row to highlight. */
    targetKey: z.string().nullable(),
    /** At most two amber annotations, e.g. "Taste island: last in 5/6 rows". */
    annotations: z
      .array(z.object({ text: z.string(), rowKey: z.string().nullable(), colKey: z.string().nullable() }))
      .max(2),
  })
  .refine((m) => uniqueKeys(m.rows) && uniqueKeys(m.cols), { message: "row and column keys must be unique" })
  .refine((m) => m.cells.length === m.rows.length && m.cells.every((r) => r.length === m.cols.length), {
    message: "cells must be rows × cols",
  })
  .refine((m) => m.margin === null || m.margin.values.length === m.cols.length, {
    message: "margin values must align with cols",
  });
export type MatrixPayload = z.infer<typeof MatrixPayload>;

// Quadrant: TRVL and SLATE (QuadrantScatter) -------------------------------------------------------------

export const QuadrantPoint = z.object({
  key: z.string().min(1),
  label: z.string(),
  ref: EntityRefSchema.nullable(),
  /** x is popularity in both uses; y is within-set FIT. */
  x: z.number(),
  y: z.number(),
  quadrant: QuadrantName,
  /** Hidden-pocket score (TRVL: MAD-z of the residual) or null. */
  score: z.number().nullable(),
  /** One of the top-8 points that get a text label. */
  labelled: z.boolean(),
  /** Category (SLATE) or state (TRVL) used for colour; null when ungrouped. */
  group: z.string().nullable(),
  /** UNDER-THE-RADAR: fit at or above the median with popularity below it. */
  utr: z.boolean(),
  geo: z.object({ lat: z.number(), lon: z.number(), region: z.string().nullable() }).nullable(),
});
export type QuadrantPoint = z.infer<typeof QuadrantPoint>;

export const QuadrantPayload = z.object({
  xLabel: z.string(),
  yLabel: z.string(),
  xUnit: MetricUnit,
  yUnit: MetricUnit,
  /** Median split lines (D17). */
  xSplit: z.number(),
  ySplit: z.number(),
  /** Display text per quadrant; SLATE relabels HIDDEN_POCKET "UNDER-THE-RADAR FIT · no pricing data". */
  quadrantLabels: z.object({
    HEARTLAND: z.string(),
    HIDDEN_POCKET: z.string(),
    MASS: z.string(),
    COLD: z.string(),
  }),
  points: z.array(QuadrantPoint),
  /** Entities that could not be placed, with the reason. */
  omitted: z.array(z.object({ label: z.string(), ref: EntityRefSchema.nullable(), reason: NoValueReason })),
  /** State belts for travel taste (sum of positive residuals by admin1 region); empty for SLATE. */
  belts: z.array(z.object({ region: z.string(), value: z.number() })),
  inset: z.enum(["us_dots"]).nullable(),
  /** Fixed caption, e.g. the travel-taste caption of S5. */
  caption: z.string(),
});
export type QuadrantPayload = z.infer<typeof QuadrantPayload>;

// Bars: BLOCK and DNA (DivergingBars) ------------------------------------------------------------------

export const Bar = z
  .object({
    key: z.string().min(1),
    label: z.string(),
    tagRef: TagRefSchema.nullable(),
    /** One value per series, aligned with `series`. */
    values: z.array(ValueCell),
    /** NEW notch: absent from the city top-50 and present in the area top-20 (S7). */
    isNew: z.boolean(),
    /** Raw ranks behind a rank delta (BLOCK): subject (area) and comparator (city); null elsewhere. */
    ranks: z.object({ subject: z.int().positive().nullable(), comparator: z.int().positive().nullable() }).nullable(),
  });
export type Bar = z.infer<typeof Bar>;

export const BarGroup = z.object({
  key: z.string().min(1),
  label: z.string(),
  /** Block DNA family, or null for DNA groups (age, gender). */
  family: BlockFamily.nullable(),
  bars: z.array(Bar),
});
export type BarGroup = z.infer<typeof BarGroup>;

export const BarsPayload = z
  .object({
    /** diverging: one series; butterfly: two series mirrored (head-to-head DNA). */
    mode: z.enum(["diverging", "butterfly"]),
    /** Every diverging value is a delta against something: required (§2.4). */
    comparator: Comparator,
    valueLabel: z.string(),
    unit: MetricUnit,
    series: z.array(AxisItem).min(1).max(2),
    groups: z.array(BarGroup),
    /** BLOCK method chip (POLYGON / POINT / QUERY); null for DNA. */
    method: LocationMethod.nullable(),
    /** Symmetric display domain, or null to fit the data. */
    domain: z.object({ min: z.number(), max: z.number() }).nullable(),
    caption: z.string().nullable(),
    /**
     * How the figure draws the values: split (one bar per row around an even split, e.g. share of taste
     * within a pair), dumbbell (two series as points joined by their gap, butterfly mode only) or
     * butterfly (two mirrored bars). Absent: diverging bars for one series, butterfly for two.
     */
    display: z.enum(["split", "dumbbell", "butterfly"]).optional(),
    /** The centre line's value, e.g. 0.5 for an even split or 0 for an index centred on the average. */
    baseline: z.number().optional(),
    /** Half-width of the band around the baseline that reads as even, e.g. 0.02. */
    evenBand: z.number().nonnegative().optional(),
  })
  .refine((b) => b.display !== "dumbbell" || b.mode === "butterfly", { message: "a dumbbell draws two series (butterfly mode)" })
  .refine((b) => (b.mode === "butterfly" ? b.series.length === 2 : b.series.length === 1), {
    message: "diverging has one series, butterfly has two",
  })
  .refine((b) => b.groups.every((g) => g.bars.every((bar) => bar.values.length === b.series.length)), {
    message: "each bar needs one value per series",
  });
export type BarsPayload = z.infer<typeof BarsPayload>;

// Slope: tenant fit, market alignment, metro rank (SlopeChart) -----------------------------------------

export const SlopePoint = z
  .object({ value: z.number().nullable(), reason: NoValueReason.nullable(), rank: z.int().positive().nullable() })
  .refine(valueRule, valueRuleMessage);
export type SlopePoint = z.infer<typeof SlopePoint>;

export const SlopeLine = z.object({
  key: z.string().min(1),
  label: z.string(),
  ref: EntityRefSchema.nullable(),
  /** One point per axis, aligned with `axes`. */
  points: z.array(SlopePoint),
  /** Last axis minus first axis, in the payload's scale; null if either end is missing. */
  delta: z.number().nullable(),
  /** Climbers are highlighted. */
  highlight: z.boolean(),
  /** An optional per-line score, e.g. TenantFit (0–100). */
  score: z.number().nullable(),
});
export type SlopeLine = z.infer<typeof SlopeLine>;

export const SlopePayload = z
  .object({
    /** Two or more columns, left to right, e.g. City → Site or National → Nashville → Austin. */
    axes: z.array(z.object({ key: z.string().min(1), label: z.string() })).min(2),
    scale: z.enum(["pct", "rank"]),
    comparator: Comparator,
    valueLabel: z.string(),
    scoreLabel: z.string().nullable(),
    lines: z.array(SlopeLine),
  })
  .refine((s) => s.lines.every((l) => l.points.length === s.axes.length), {
    message: "each line needs one point per axis",
  });
export type SlopePayload = z.infer<typeof SlopePayload>;

// GeoLift: S6 (LiftMap) ----------------------------------------------------------------------------------

export const GeoLiftCell = z.object({
  geohash: z.string().min(1),
  /** Raw concept affinity (RAW mode) and raw baseline affinity (BASE mode); null if the cell is absent there. */
  raw: z.number().nullable(),
  base: z.number().nullable(),
  /** Cell lift (u+0.05)/(v+0.05) (LIFT mode); null when not computable. */
  lift: z.number().nullable(),
  /** Passed the u ≥ 0.5 gate (D18). */
  gated: z.boolean(),
  /** Fill alpha: the precision-weighted confidence of the cell, 0–1. */
  conf: z.number().min(0).max(1),
  /** Gazetteer neighbourhood id of the cell centroid, or null outside every neighbourhood. */
  neighbourhood: z.string().nullable(),
});
export type GeoLiftCell = z.infer<typeof GeoLiftCell>;

export const GeoLiftNeighbourhood = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    /** Gated cells inside it; lift needs at least 5 (D18). */
    n: z.int().nonnegative(),
    lift: z.number().nullable(),
    conf: z.number().min(0).max(1).nullable(),
    demandPct: z.number().nullable(),
    supplyPct: z.number().nullable(),
    supplyCount: z.int().nonnegative().nullable(),
    whiteSpace: z.number().nullable(),
    quadrant: WhiteSpaceQuadrant.nullable(),
    /** Why lift is missing (insufficient_n, coarse); null when lift is present. */
    reason: NoValueReason.nullable(),
  })
  .refine((n) => (n.lift === null) === (n.reason !== null), valueRuleMessage);
export type GeoLiftNeighbourhood = z.infer<typeof GeoLiftNeighbourhood>;

export const GeoLiftPayload = z.object({
  metro: MetroId,
  /** Geohash length after precision normalisation (shortest common prefix). */
  precision: z.int().min(1).max(12),
  /** gh7 = 1, gh6 = 0.8, gh5 = 0.5, gh4 or coarser = 0 (D18). */
  precisionFactor: z.number().min(0).max(1),
  /** gh4 or coarser: no neighbourhood claims (COARSE_GEOHASH). */
  coarse: z.boolean(),
  concept: z.object({
    label: z.string(),
    tagRefs: z.array(TagRefSchema),
    entityRefs: z.array(EntityRefSchema),
  }),
  /** The pinned baseline, e.g. "restaurants" with its public taxonomy tag URN. */
  baseline: z.object({ label: z.string(), tag: z.string() }),
  cells: z.array(GeoLiftCell),
  neighbourhoods: z.array(GeoLiftNeighbourhood),
  /** Supply sample of Qloo-indexed venues (G10), or null when not requested. */
  supply: z
    .object({
      source: z.literal("places_sample"),
      capped: z.boolean(),
      points: z.array(
        z.object({ lat: z.number(), lon: z.number(), label: z.string(), ref: EntityRefSchema.nullable() }),
      ),
    })
    .nullable(),
  /** Attribution for the neighbourhood boundaries. */
  boundarySource: z.string(),
  caption: z.string(),
  /**
   * Neighbourhood ids the question names, in its order: shown first, with their rank among the
   * neighbourhoods with a lift. Absent or empty when it names none.
   */
  focusAreas: z.array(z.string().min(1)).optional(),
  /**
   * Why similar venues (competitors) were not counted, in a reader's words, when supply was asked
   * for: e.g. no verified category tag for the place type. Then every supplyCount is null and reads
   * "unknown", never 0 (PLAN §8.3). Absent or null when a sample was counted or none was asked for.
   */
  supplyGap: z.string().min(1).nullable().optional(),
});
export type GeoLiftPayload = z.infer<typeof GeoLiftPayload>;

// Ranked: XDOM, local brands, single-context rank (RankedTable) ------------------------------------------

export const RankedColumn = z.object({
  key: z.string().min(1),
  label: z.string(),
  unit: MetricUnit,
  comparator: Comparator.nullable(),
});
export type RankedColumn = z.infer<typeof RankedColumn>;

/**
 * Row flags. KEEP, VETO and ADD are the concept-vector verdicts (S12): an analog the concept's taste
 * keeps, one it vetoes (never a recommendation), and an open-call result the analogs missed.
 */
export const RowFlag = z.enum(["UTR", "NEW", "LOCAL", "TARGET", "GHOST_PICK", "KEEP", "VETO", "ADD"]);
export type RowFlag = z.infer<typeof RowFlag>;

export const RankedRow = z.object({
  key: z.string().min(1),
  rank: z.int().positive().nullable(),
  label: z.string(),
  sublabel: z.string().nullable(),
  ref: EntityRefSchema.nullable(),
  tagRef: TagRefSchema.nullable(),
  type: EntityType.nullable(),
  /** One cell per column, aligned with `columns`. */
  cells: z.array(ValueCell),
  flags: z.array(RowFlag),
  /** Explainability edges kept by the share·K ≥ 1.1 rule (G15); empty otherwise. */
  explain: z.array(z.object({ seedRef: EntityRefSchema, share: z.number() })),
  /**
   * Every seed's explainability share with two or more seeds, edge or not: the tooltip of a result
   * drawn without an edge (SPEC §5.3 S9, FORMULAS xdom.edge). Absent with one seed.
   */
  shares: z.array(z.object({ seedRef: EntityRefSchema, share: z.number() })).optional(),
  /** A row shown for contrast, e.g. a rival the priors expected; drawn in the comparison colour. */
  comparison: z.boolean().optional(),
});
export type RankedRow = z.infer<typeof RankedRow>;

export const RankedPayload = z
  .object({
    columns: z.array(RankedColumn).min(1),
    /** Groups in display order, e.g. one per domain; a single group when ungrouped. */
    groups: z.array(z.object({ key: z.string().min(1), label: z.string(), rows: z.array(RankedRow) })),
    caption: z.string().nullable(),
  })
  .refine((r) => r.groups.every((g) => g.rows.every((row) => row.cells.length === r.columns.length)), {
    message: "each row needs one cell per column",
  });
export type RankedPayload = z.infer<typeof RankedPayload>;

// Slate: S10 sponsor slate (RankedTable) -------------------------------------------------------------------

/**
 * The absolute popularity ceiling of every "under the radar" or "hidden pocket" label (D3 of the Part 9
 * close-out): at or above it a name is mass-market and never flagged, however low the set's median
 * popularity falls. It applies to the UNDER-THE-RADAR flag and pick (S9 cross_domain, S10 sponsor_slate,
 * creator_fit) and to the HIDDEN_POCKET finding (S3 destination_affinity). The quadrant geometry itself
 * stays split at the within-set medians (D17).
 */
export const UNDER_THE_RADAR_MAX_POPULARITY = 0.85;

export const SlateEntry = z.object({
  ref: EntityRefSchema,
  label: z.string(),
  /** FIT: within-call percentile from the one-scale scoring call. */
  fit: ValueCell,
  popularity: z.number().nullable(),
  utr: z.boolean(),
  /** The two markets where this brand gains most vs its national fit (Δ_jm). */
  topMarkets: z.array(z.object({ market: MarketId, label: z.string(), delta: z.number() })).max(2),
});
export type SlateEntry = z.infer<typeof SlateEntry>;

export const SlateRow = z
  .object({
    category: SponsorCategory,
    label: z.string(),
    best: SlateEntry.nullable(),
    runnerUp: SlateEntry.nullable(),
    /** Why the category has no best fit (empty discovery, budget). */
    reason: NoValueReason.nullable(),
  })
  .refine((r) => (r.best === null) === (r.reason !== null), { message: "best is null exactly when a reason is given" });
export type SlateRow = z.infer<typeof SlateRow>;

export const SlatePayload = z.object({
  seed: z.object({ ref: EntityRefSchema, label: z.string() }),
  rows: z.array(SlateRow),
  markets: z.array(z.object({ id: MarketId, label: z.string() })),
  /** Fixed: "taste fit only; no fee, availability or ROI data". */
  caption: z.string(),
});
export type SlatePayload = z.infer<typeof SlatePayload>;

// Momentum: S4 (MomentumStrip) ------------------------------------------------------------------------

export const MomentumPoint = z.object({
  /** ISO-week start date. */
  date: z.iso.date(),
  /** Population percentile, 0–1. */
  pct: z.number(),
  /** Winsorised outlier: drawn as a ^ caret. */
  clipped: z.boolean(),
});
export type MomentumPoint = z.infer<typeof MomentumPoint>;

export const MomentumSeries = z
  .object({
    ref: EntityRefSchema,
    label: z.string(),
    type: EntityType,
    /** ok: a real series. no_signal: flat placeholder or too few points (hatched NO SIGNAL). unavailable: no data for the type. */
    state: z.enum(["ok", "no_signal", "unavailable"]),
    reason: NoValueReason.nullable(),
    trend: MomentumTrend.nullable(),
    points: z.array(MomentumPoint),
    /** Theil–Sen slope per week × 26, in percentile points. */
    delta26w: z.number().nullable(),
    /** Mann–Kendall τ and p. */
    tau: z.number().nullable(),
    p: z.number().nullable(),
    peerRank: PeerRank.nullable(),
    /** A >5× break between segment medians: only the latest segment is kept. */
    scaleBreak: z.boolean(),
  })
  .refine((s) => (s.state === "ok") === (s.reason === null), { message: "a series without signal needs a reason" })
  .refine((s) => s.state === "ok" || (s.trend === null && s.delta26w === null), {
    message: "a series without signal has no trend",
  });
export type MomentumSeries = z.infer<typeof MomentumSeries>;

export const MomentumPayload = z.object({
  window: TrendWindow,
  /** Always shown: "HISTORICAL · QLOO TRENDING · <window>". */
  badgeText: z.string(),
  badge: z.literal("STALE"),
  series: z.array(MomentumSeries),
});
export type MomentumPayload = z.infer<typeof MomentumPayload>;

// Scorecard: Hypothesis Scorecard (ScorecardTable) -------------------------------------------------------

export const ScorecardRow = z.object({
  hypothesisId: HypothesisIdSchema,
  statement: z.string(),
  expectation: z.string(),
  testTool: SkillId,
  verdict: ScorecardVerdict,
  metricIds: z.array(MetricIdSchema),
  evidenceIds: z.array(EvidenceIdSchema),
  /** What was measured, in prose with {{M#}} and [E#] tokens. */
  note: z.string(),
});
export type ScorecardRow = z.infer<typeof ScorecardRow>;

export const ScorecardPayload = z.object({ rows: z.array(ScorecardRow) });
export type ScorecardPayload = z.infer<typeof ScorecardPayload>;

// Position: Taste Position card (PositionCard) ---------------------------------------------------------

export const PositionAxisRow = z
  .object({
    axis: PositionAxis,
    label: z.string(),
    /** e.g. "2 of 7", "wins 3 of 6", "Rising". */
    display: z.string(),
    value: z.number().nullable(),
    reason: NoValueReason.nullable(),
    badge: Badge,
    peerRank: PeerRank.nullable(),
    /** e.g. "nearest: <peer>". */
    note: z.string().nullable(),
    metricId: MetricIdSchema.nullable(),
    /** The exhibit this axis links to. */
    datasetId: DatasetIdSchema.nullable(),
  })
  .refine(valueRule, valueRuleMessage)
  .refine((a) => (a.value === null) === (a.badge === "UNAVAILABLE"), {
    message: "an axis without a value is badged UNAVAILABLE",
  });
export type PositionAxisRow = z.infer<typeof PositionAxisRow>;

export const PositionPayload = z
  .object({
    subject: z.object({ ref: EntityRefSchema, label: z.string() }),
    peerCount: z.int().nonnegative(),
    /** Exactly the five axes, in PositionAxis order. No composite score (D14). */
    axes: z.array(PositionAxisRow).length(5),
  })
  .refine((p) => p.axes.every((a, i) => a.axis === PositionAxis.options[i]), {
    message: "axes must be the five PositionAxis values in order",
  });
export type PositionPayload = z.infer<typeof PositionPayload>;

/** Payload schema per dataset kind. */
export const DATASET_PAYLOADS = {
  Matrix: MatrixPayload,
  Quadrant: QuadrantPayload,
  Bars: BarsPayload,
  Slope: SlopePayload,
  GeoLift: GeoLiftPayload,
  Ranked: RankedPayload,
  Slate: SlatePayload,
  Momentum: MomentumPayload,
  Scorecard: ScorecardPayload,
  Position: PositionPayload,
} as const satisfies Record<DatasetKind, z.ZodType>;

export type DatasetPayload<K extends DatasetKind = DatasetKind> = z.infer<(typeof DATASET_PAYLOADS)[K]>;
