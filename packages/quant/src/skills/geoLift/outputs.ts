import {
  METRO_LABEL,
  type DatasetId,
  type DigestRow,
  type EvidenceId,
  type Finding,
  type Flag,
  type GeoLiftPayload,
  type Metric,
  type MetricId,
  type MetroId,
  type NoValueReason,
  type SkillCtx,
} from "@ct/contracts";
import { isLatentDemand, latentDemandFinding, type FindingDraft } from "../../findings";
import type { FormulaId } from "../../formulas";
import { addSkillMetric } from "../common";
import { fixed2, safeFullName, safeName } from "../format";
import { HEATMAP_BASELINE } from "../findTags/curated";
import {
  MIN_AREA_CELLS,
  MIN_BUSY_AREA_VENUES,
  NO_CLAIM_PRECISION,
  precisionFactor,
  QUADRANT_LABEL,
  THIN_SUPPLY_LABEL,
  type AreaLift,
  type AreaSupply,
  type LiftGrid,
} from "./lift";

/**
 * What one geo_lift run writes: a bounded metric set, the GeoLift dataset behind the LiftMap, the
 * LATENT_DEMAND finding and the digest rows. Raw heat tracks popularity (G6), so the model sees lift
 * and white space only, each as a metric it can cite.
 */

export interface LiftRun {
  ctx: SkillCtx;
  metro: MetroId;
  flags: Set<Flag>;
  evidenceIds: EvidenceId[];
  metrics: Metric[];
  findings: Finding[];
  datasetIds: DatasetId[];
  notices: string[];
}

/** Evidence the numbers rest on: the two heatmaps for lift, plus the places sample for white space. */
export interface LiftEvidence {
  maps: EvidenceId[];
  supply: EvidenceId[];
}

/**
 * Why similar venues (competitors) were not counted although supply was asked for. `text` is the
 * reader's sentence (the UNAVAILABLE metric's label and the map's supplyGap); a count is then unknown,
 * never 0 (PLAN §8.3).
 */
export interface SupplyGap {
  reason: NoValueReason;
  text: string;
}

/** Neighbourhood lifts that get a metric: the top five and, for contrast, the lowest. */
export const TOP_AREA_METRICS = 5;
/** With named areas, which come first with up to four metrics each, the top three and the lowest, so the digest keeps its rows. */
export const TOP_AREA_METRICS_WITH_FOCUS = 3;
/**
 * Top neighbourhoods that also get a confidence metric, and the most open ones a white-space metric.
 * It equals MAX_NAMES_IN_TEXT, so every neighbourhood LATENT_DEMAND names has a metric to cite.
 */
export const TOP_DETAIL_METRICS = 3;

export function addFindingDraft(run: LiftRun, draft: FindingDraft, metricIds: readonly MetricId[]): Finding {
  const finding = run.ctx.ledger.addFinding({ ...draft, metricIds: [...metricIds] });
  run.findings.push(finding);
  return finding;
}

function push(run: LiftRun, metric: Metric): Metric {
  run.metrics.push(metric);
  return metric;
}

/** Areas with a lift, highest first; ties by id so the order never depends on the gazetteer's. */
export function byLift(areas: readonly AreaLift[]): AreaLift[] {
  return areas.filter((a) => a.lift !== null).sort((a, b) => (b.lift ?? 0) - (a.lift ?? 0) || (a.id < b.id ? -1 : 1));
}

export interface OpenArea {
  area: AreaLift;
  supply: AreaSupply;
  whiteSpace: number;
  latent: boolean;
}

/**
 * Areas with a white-space value, the LATENT_DEMAND ones first, each group by white space and then
 * id. latentDemandFinding keeps this order (its sort is stable), so the areas it names are the first
 * ones here and get the white-space metrics.
 */
export function byOpenness(areas: readonly AreaLift[], supply: ReadonlyMap<string, AreaSupply>): OpenArea[] {
  return areas
    .flatMap((area) => {
      const s = supply.get(area.id);
      if (s === undefined || s.whiteSpace === null) return [];
      return [{ area, supply: s, whiteSpace: s.whiteSpace, latent: isLatentDemand(area.demandPct, s.supplyPct) }];
    })
    .sort((x, y) => Number(y.latent) - Number(x.latent) || y.whiteSpace - x.whiteSpace || (x.area.id < y.area.id ? -1 : 1));
}

/** Why no neighbourhood has a lift, for the one metric that says so. */
export function missingLiftReason(areas: readonly AreaLift[], grid: LiftGrid | null, gap: NoValueReason | null): NoValueReason {
  if (gap !== null) return gap;
  if (grid !== null && grid.precision <= NO_CLAIM_PRECISION) return "coarse";
  if (areas.length === 0) return "unavailable";
  return areas.some((a) => a.reason === "insufficient_n") ? "insufficient_n" : "not_measured";
}

export interface LiftMetrics {
  precision: Metric | null;
  /** lift.area by neighbourhood id, plus the metro-wide UNAVAILABLE one under the metro id. */
  areas: Map<string, Metric>;
  confidence: Map<string, Metric>;
  whiteSpace: Map<string, Metric>;
  /** lift.rank by neighbourhood id: a named area's rank among the areas with a lift. */
  rank: Map<string, Metric>;
  /** lift.supply by neighbourhood id (sampled similar venues), plus the metro-wide UNAVAILABLE one under the metro id. */
  supply: Map<string, Metric>;
}

/** Why a named area has no lift, in a reader's words. */
export function noLiftWhy(a: AreaLift): string {
  switch (a.reason) {
    case "insufficient_n":
      return a.n === 0
        ? `no gated cell, and a reliable lift needs ${MIN_AREA_CELLS}`
        : `only ${a.n} of the ${MIN_AREA_CELLS} gated cells a reliable lift needs`;
    case "not_measured":
      return "the concept and baseline maps share no cell in it";
    case "coarse":
      return "the maps are too coarse for any neighbourhood claim";
    default:
      return "no lift was measured in this run";
  }
}

/**
 * The S6 metric set, in KPI order (site_selection takes three lift.area metrics and one
 * lift.confidence): the map precision first, then neighbourhood lifts highest first with the lowest
 * last, confidence for the top three and white space for the three most open, latent ones first.
 * At most 1 + 6 + 3 + 3 = 13. With no neighbourhood lift there is one UNAVAILABLE lift.area metric
 * with the reason.
 */
export function addLiftMetrics(
  run: LiftRun,
  args: {
    grid: LiftGrid | null;
    areas: readonly AreaLift[];
    supply: ReadonlyMap<string, AreaSupply>;
    conceptRefs: readonly string[];
    evidence: LiftEvidence;
    gap: NoValueReason | null;
    /** The named areas (focus_areas the gazetteer knows), in the question's order. */
    focus?: readonly AreaLift[];
    /** Set when supply was asked for and no similar venue was counted. */
    supplyGap?: SupplyGap | null;
    /** Whether the venue sample came back full, so more venues may exist than it holds. */
    capped?: boolean;
  },
): LiftMetrics {
  const { grid, areas, supply, conceptRefs, evidence, gap } = args;
  const focus = args.focus ?? [];
  const supplyGap = args.supplyGap ?? null;
  const ledger = run.ctx.ledger;
  const metro = METRO_LABEL[run.metro];
  const out: LiftMetrics = { precision: null, areas: new Map(), confidence: new Map(), whiteSpace: new Map(), rank: new Map(), supply: new Map() };

  if (grid !== null) {
    const prec = precisionFactor(grid.precision);
    const coarse = grid.precision <= NO_CLAIM_PRECISION ? " · too coarse for neighbourhood claims" : "";
    out.precision = push(
      run,
      addSkillMetric(ledger, {
        key: "lift.precision",
        label: `map grid precision in ${metro} (the finest grid gives full weight)`,
        subjectRefs: [run.metro],
        value: prec,
        reason: "not_measured",
        // The brief reads "<grid> · <factor>[ · note]" (apps/web key figures): the grid in words first.
        display: `${gridWords(grid.precision)} · ${fixed2(prec)}${coarse}`,
        unit: "ratio",
        badge: "DERIVED",
        formulaId: "lift.confidence",
        evidenceIds: evidence.maps,
        n: grid.cells.length,
        comparator: null,
      }),
    );
  }

  const ranked = byLift(areas);
  const top = focus.length > 0 ? TOP_AREA_METRICS_WITH_FOCUS : TOP_AREA_METRICS;
  const lowest = ranked.length > top ? ranked[ranked.length - 1] : undefined;
  const open = byOpenness(areas, supply);

  // Competitors in the metro: unknown, with the reason, whenever supply was asked for and not counted.
  if (supplyGap !== null) {
    out.supply.set(
      run.metro,
      push(
        run,
        addSkillMetric(ledger, {
          key: "lift.supply",
          label: `similar venues (competitors) in ${metro}: unknown, never 0. ${supplyGap.text}`,
          subjectRefs: [run.metro, ...conceptRefs],
          value: null,
          reason: supplyGap.reason,
          display: "",
          unit: "count",
          badge: "MEASURED",
          formulaId: "lift.white_space",
          evidenceIds: evidence.maps,
          n: null,
          comparator: null,
        }),
      ),
    );
  }

  // The areas the question names come first, each with its own numbers whatever its rank, or why it has none.
  for (const a of focus) addFocusMetrics(run, out, { area: a, ranked, supply, conceptRefs, evidence, supplyGap, capped: args.capped === true });

  for (const a of [...ranked.slice(0, top), ...(lowest === undefined ? [] : [lowest])]) {
    if (out.areas.has(a.id)) continue;
    out.areas.set(
      a.id,
      push(
        run,
        addSkillMetric(ledger, {
          key: "lift.area",
          label: `lift of ${safeName(a.name)} vs the restaurant baseline${a === lowest ? " (lowest in the metro)" : ""}`,
          subjectRefs: [a.id, ...conceptRefs],
          value: a.lift,
          reason: a.reason ?? "insufficient_n",
          display: a.lift === null ? "" : `${fixed2(a.lift)}×`,
          unit: "lift",
          badge: "ESTIMATED",
          formulaId: "lift.area",
          evidenceIds: evidence.maps,
          n: a.n,
          comparator: "BASELINE",
        }),
      ),
    );
  }
  if (ranked.length === 0) {
    out.areas.set(
      run.metro,
      push(
        run,
        addSkillMetric(ledger, {
          key: "lift.area",
          label: `neighbourhood lift in ${metro} vs the restaurant baseline`,
          subjectRefs: [run.metro, ...conceptRefs],
          value: null,
          reason: missingLiftReason(areas, grid, gap),
          display: "",
          unit: "lift",
          badge: "ESTIMATED",
          formulaId: "lift.area",
          evidenceIds: evidence.maps,
          n: null,
          comparator: "BASELINE",
        }),
      ),
    );
  }

  for (const a of ranked.slice(0, TOP_DETAIL_METRICS)) {
    if (!out.confidence.has(a.id)) out.confidence.set(a.id, push(run, confidenceMetric(run, a, evidence)));
  }
  for (const o of open.slice(0, TOP_DETAIL_METRICS)) {
    if (!out.whiteSpace.has(o.area.id)) out.whiteSpace.set(o.area.id, push(run, whiteSpaceMetric(run, o, conceptRefs, evidence, open.length)));
  }
  return out;
}

/**
 * A named area's numbers: its lift (or UNAVAILABLE with why, e.g. too few gated cells), and with a
 * lift its rank among the areas with one, its confidence and its sampled similar venues when supply
 * was counted. A capped sample's 0 is no count (the supply-label rule in ./lift): its lift.supply is
 * UNAVAILABLE with the reason, so no claim can cite it as few or none. Its white-space quadrant, or
 * THIN_SUPPLY_LABEL, is in its digest row; the three most open areas keep their metrics.
 */
function addFocusMetrics(
  run: LiftRun,
  out: LiftMetrics,
  args: {
    area: AreaLift;
    ranked: readonly AreaLift[];
    supply: ReadonlyMap<string, AreaSupply>;
    conceptRefs: readonly string[];
    evidence: LiftEvidence;
    supplyGap: SupplyGap | null;
    capped: boolean;
  },
): void {
  const { area: a, ranked, conceptRefs, evidence } = args;
  const ledger = run.ctx.ledger;
  const name = safeName(a.name);
  out.areas.set(
    a.id,
    push(
      run,
      addSkillMetric(ledger, {
        key: "lift.area",
        label:
          a.lift === null
            ? `lift of ${name} vs the restaurant baseline: not measured, ${noLiftWhy(a)}`
            : `lift of ${name} vs the restaurant baseline (named in the question)`,
        subjectRefs: [a.id, ...conceptRefs],
        value: a.lift,
        reason: a.reason ?? "insufficient_n",
        display: a.lift === null ? "" : `${fixed2(a.lift)}×`,
        unit: "lift",
        badge: "ESTIMATED",
        formulaId: "lift.area",
        evidenceIds: evidence.maps,
        n: a.n,
        comparator: "BASELINE",
      }),
    ),
  );
  const rank = ranked.indexOf(a);
  if (a.lift === null || rank < 0) return;
  out.rank.set(
    a.id,
    push(
      run,
      addSkillMetric(ledger, {
        key: "lift.rank",
        label: `rank of ${name} by lift among the ${ranked.length} areas with one (1 = highest)`,
        subjectRefs: [a.id, ...conceptRefs],
        value: rank + 1,
        reason: "not_measured",
        display: `${rank + 1} of ${ranked.length}`,
        unit: "rank",
        badge: "DERIVED",
        formulaId: "lift.area",
        evidenceIds: evidence.maps,
        n: ranked.length,
        comparator: null,
      }),
    ),
  );
  out.confidence.set(a.id, push(run, confidenceMetric(run, a, evidence)));
  const s = args.supply.get(a.id);
  if (args.supplyGap === null && s !== undefined && s.count !== null) {
    out.supply.set(a.id, push(run, focusSupplyMetric(run, a, { ...s, count: s.count }, conceptRefs, evidence, args.capped)));
  }
}

/** A named area's sampled similar venues: a count, or for a capped sample's 0 an UNAVAILABLE metric that says why. */
function focusSupplyMetric(run: LiftRun, a: AreaLift, s: AreaSupply & { count: number }, conceptRefs: readonly string[], evidence: LiftEvidence, capped: boolean): Metric {
  const name = safeName(a.name);
  const base = {
    key: "lift.supply",
    subjectRefs: [a.id, ...conceptRefs],
    unit: "count",
    badge: "MEASURED",
    formulaId: "lift.white_space",
    evidenceIds: evidence.supply,
    n: null,
    comparator: null,
  } as const;
  if (capped && s.count === 0) {
    return addSkillMetric(run.ctx.ledger, {
      ...base,
      label:
        `similar venues in ${name}: unknown, not 0 (${THIN_SUPPLY_LABEL.toLowerCase()}). None of the venues in Qloo's capped sample is in ${name}, ` +
        "and a capped sample cannot show how many exist there, so it supports no competitor claim",
      value: null,
      reason: "insufficient_n",
      display: "",
    });
  }
  const thin = s.thin ? ` (${THIN_SUPPLY_LABEL.toLowerCase()}: too few to call the area crowded; ${MIN_BUSY_AREA_VENUES} needed)` : "";
  return addSkillMetric(run.ctx.ledger, {
    ...base,
    label: `similar venues in ${name} in a${capped ? " capped" : ""} sample of Qloo-indexed venues, not every business${thin}`,
    value: s.count,
    reason: "not_measured",
    display: `${s.count} in the sample`,
  });
}

/** A lift's weight in words: the band a reader can act on. */
function weightWords(conf: number): string {
  if (conf >= 0.75) return "solid";
  if (conf >= 0.5) return "moderate";
  return "weak";
}

/** The map grid in words, finest first (geohash length 7 = finest). */
function gridWords(precision: number): string {
  if (precision >= 7) return "fine";
  if (precision === 6) return "medium";
  if (precision === 5) return "coarse";
  return "very coarse";
}

function confidenceMetric(run: LiftRun, a: AreaLift, evidence: LiftEvidence): Metric {
  return addSkillMetric(run.ctx.ledger, {
    key: "lift.confidence",
    label: `confidence of the ${safeName(a.name)} lift (map cells, grid)`,
    subjectRefs: [a.id],
    value: a.conf,
    reason: a.reason ?? "insufficient_n",
    display: a.conf === null ? "" : `${fixed2(a.conf)} · ${weightWords(a.conf)}`,
    unit: "ratio",
    badge: "DERIVED",
    formulaId: "lift.confidence",
    evidenceIds: evidence.maps,
    n: a.n,
    comparator: null,
  });
}

function whiteSpaceMetric(run: LiftRun, o: OpenArea, conceptRefs: readonly string[], evidence: LiftEvidence, n: number): Metric {
  return addSkillMetric(run.ctx.ledger, {
    key: "lift.white_space",
    label: `white space in ${safeName(o.area.name)} (demand percentile × open supply, from a sample of Qloo-indexed venues)`,
    subjectRefs: [o.area.id, ...conceptRefs],
    value: o.whiteSpace,
    reason: "not_measured",
    display: `${fixed2(o.whiteSpace)} · ${o.supply.quadrant === null ? "" : QUADRANT_LABEL[o.supply.quadrant]}`,
    unit: "score",
    badge: "ESTIMATED",
    formulaId: "lift.white_space",
    evidenceIds: [...evidence.maps, ...evidence.supply],
    n,
    comparator: null,
  });
}

/**
 * LATENT_DEMAND (SPEC §4.4): high-demand, low-supply neighbourhoods. The candidates go in the
 * byOpenness order addLiftMetrics used, so the areas the text names are the ones holding the
 * white-space metrics it cites; any further latent area cites its lift metric when it has one.
 */
export function addLatentDemand(run: LiftRun, areas: readonly AreaLift[], supply: ReadonlyMap<string, AreaSupply>, metrics: LiftMetrics): void {
  const open = byOpenness(areas, supply);
  const draft = latentDemandFinding({
    metroLabel: METRO_LABEL[run.metro],
    neighbourhoods: open.map((o) => ({ name: safeName(o.area.name), demandPct: o.area.demandPct, supplyPct: o.supply.supplyPct })),
  });
  if (draft === null) return;
  const ids = open.filter((o) => o.latent).flatMap((o) => metrics.whiteSpace.get(o.area.id)?.id ?? metrics.areas.get(o.area.id)?.id ?? []);
  addFindingDraft(run, draft, ids);
}

export const LIFT_FORMULA_IDS: readonly FormulaId[] = ["lift.cell", "lift.area", "lift.confidence"];

export interface SupplyPoint {
  lat: number;
  lon: number;
  label: string;
}

/** The GeoLift dataset behind the LiftMap: RAW, BASE and LIFT layers per cell, neighbourhoods, supply. */
export function addLiftMap(
  run: LiftRun,
  args: {
    grid: LiftGrid;
    areas: readonly AreaLift[];
    supply: ReadonlyMap<string, AreaSupply>;
    points: readonly SupplyPoint[] | null;
    capped: boolean;
    concept: GeoLiftPayload["concept"];
    /** The named areas' ids, shown first. */
    focus?: readonly string[];
    /** Why similar venues were not counted; every supplyCount is then null ("unknown"), never 0. */
    supplyGap?: SupplyGap | null;
    areaOf: (geohash: string) => string | null;
    evidenceIds: readonly EvidenceId[];
  },
): DatasetId {
  const { grid, areas, supply, points, capped, concept, areaOf } = args;
  const focus = args.focus ?? [];
  const supplyGap = args.supplyGap ?? null;
  const prec = precisionFactor(grid.precision);
  const coarse = grid.precision <= NO_CLAIM_PRECISION;
  const metro = METRO_LABEL[run.metro];
  const ordered = [...byLift(areas), ...areas.filter((a) => a.lift === null)];
  const payload: GeoLiftPayload = {
    metro: run.metro,
    precision: grid.precision,
    precisionFactor: prec,
    coarse,
    concept,
    baseline: { label: HEATMAP_BASELINE.label, tag: HEATMAP_BASELINE.tagId },
    cells: grid.cells.map((c) => ({
      geohash: c.geohash,
      raw: c.raw,
      base: c.base,
      lift: c.lift,
      gated: c.gated,
      conf: c.lift === null ? 0 : prec,
      neighbourhood: areaOf(c.geohash),
    })),
    neighbourhoods: ordered.map((a) => {
      const s = supply.get(a.id);
      return {
        id: a.id,
        name: safeFullName(a.name),
        n: a.n,
        lift: a.lift,
        conf: a.conf,
        demandPct: a.demandPct,
        supplyPct: s?.supplyPct ?? null,
        // A gap means unknown for every area, never a count of 0.
        supplyCount: supplyGap === null ? (s?.count ?? null) : null,
        whiteSpace: s?.whiteSpace ?? null,
        quadrant: s?.quadrant ?? null,
        reason: a.reason,
      };
    }),
    supply: points === null ? null : { source: "places_sample", capped, points: points.map((p) => ({ ...p, ref: null })) },
    boundarySource: run.ctx.geo.boundarySource(run.metro),
    caption:
      `Lift = the concept's taste heat against the pinned restaurant baseline, relative within ${metro} · geohash ${grid.precision}` +
      (coarse ? " (coarse: no neighbourhood claims)" : "") +
      (points === null ? "" : " · supply: a capped sample of Qloo-indexed venues, not every business") +
      (supplyGap === null ? "" : " · similar venues: unknown"),
    ...(focus.length > 0 ? { focusAreas: [...focus] } : {}),
    ...(supplyGap === null ? {} : { supplyGap: supplyGap.text }),
  };
  const dataset = run.ctx.ledger.addDataset({
    kind: "GeoLift",
    title: `Lift Map · ${safeName(concept.label)} in ${metro}`,
    evidenceIds: [...args.evidenceIds],
    formulaIds: [...LIFT_FORMULA_IDS, ...(points === null ? [] : (["lift.white_space"] as const))],
    payload,
  });
  run.datasetIds.push(dataset.id);
  return dataset.id;
}

/**
 * One row per neighbourhood the maps measured: those with a lift highest first, then the rest by
 * gated cells. A row names the metrics that hold its numbers instead of repeating them (cell counts
 * live in the metrics' n), and its neighbourhood id is the `ref` a block_dna area takes.
 */
export function liftDigestRows(
  areas: readonly AreaLift[],
  supply: ReadonlyMap<string, AreaSupply>,
  metrics: LiftMetrics,
  focus: readonly AreaLift[] = [],
): DigestRow[] {
  const ranked = byLift(areas);
  const named = new Set(focus.map((a) => a.id));
  const rest = areas
    .filter((a) => a.lift === null && a.covered > 0 && !named.has(a.id))
    .sort((a, b) => b.n - a.n || b.covered - a.covered || (a.id < b.id ? -1 : 1));
  return [...focus, ...ranked.filter((a) => !named.has(a.id)), ...rest].map((a) => {
    const s = supply.get(a.id);
    const values: DigestRow["values"] = { area: a.id };
    if (named.has(a.id)) values.named = "in the question";
    if (a.lift !== null) {
      values.lift_rank = ranked.indexOf(a) + 1;
      if (named.has(a.id)) values.ranked_of = ranked.length;
      values.lift_metric = metrics.areas.get(a.id)?.id ?? null;
    } else {
      values.unscored = a.reason;
      if (named.has(a.id)) values.gated_cells = a.n;
    }
    const rank = metrics.rank.get(a.id);
    if (rank !== undefined) values.rank_metric = rank.id;
    const conf = named.has(a.id) ? metrics.confidence.get(a.id) : undefined;
    if (conf !== undefined) values.confidence_metric = conf.id;
    const venues = metrics.supply.get(a.id);
    if (venues !== undefined) values.supply_metric = venues.id;
    const ws = metrics.whiteSpace.get(a.id);
    if (ws !== undefined) values.white_space_metric = ws.id;
    if (s?.quadrant) values.quadrant = QUADRANT_LABEL[s.quadrant];
    else if (s?.thin) values.quadrant = THIN_SUPPLY_LABEL;
    return { ref: null, name: safeName(a.name), values };
  });
}
