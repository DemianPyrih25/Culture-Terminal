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
import { NO_CLAIM_PRECISION, precisionFactor, QUADRANT_LABEL, type AreaLift, type AreaSupply, type LiftGrid } from "./lift";

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

/** Neighbourhood lifts that get a metric: the top five and, for contrast, the lowest. */
export const TOP_AREA_METRICS = 5;
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
  },
): LiftMetrics {
  const { grid, areas, supply, conceptRefs, evidence, gap } = args;
  const ledger = run.ctx.ledger;
  const metro = METRO_LABEL[run.metro];
  const out: LiftMetrics = { precision: null, areas: new Map(), confidence: new Map(), whiteSpace: new Map() };

  if (grid !== null) {
    const prec = precisionFactor(grid.precision);
    const coarse = grid.precision <= NO_CLAIM_PRECISION ? " · coarse, no neighbourhood claims" : "";
    out.precision = push(
      run,
      addSkillMetric(ledger, {
        key: "lift.precision",
        label: `map precision factor in ${metro} (geohash length after normalisation; 1 = full confidence)`,
        subjectRefs: [run.metro],
        value: prec,
        reason: "not_measured",
        display: `gh${grid.precision} · ${fixed2(prec)}${coarse}`,
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
  const lowest = ranked.length > TOP_AREA_METRICS ? ranked[ranked.length - 1] : undefined;
  for (const a of [...ranked.slice(0, TOP_AREA_METRICS), ...(lowest === undefined ? [] : [lowest])]) {
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
    out.confidence.set(
      a.id,
      push(
        run,
        addSkillMetric(ledger, {
          key: "lift.confidence",
          label: `confidence of the ${safeName(a.name)} lift (gated cells × map precision)`,
          subjectRefs: [a.id],
          value: a.conf,
          reason: a.reason ?? "insufficient_n",
          display: a.conf === null ? "" : fixed2(a.conf),
          unit: "ratio",
          badge: "DERIVED",
          formulaId: "lift.confidence",
          evidenceIds: evidence.maps,
          n: a.n,
          comparator: null,
        }),
      ),
    );
  }

  const open = byOpenness(areas, supply);
  for (const { area: a, supply: s, whiteSpace: ws } of open.slice(0, TOP_DETAIL_METRICS)) {
    out.whiteSpace.set(
      a.id,
      push(
        run,
        addSkillMetric(ledger, {
          key: "lift.white_space",
          label: `white space in ${safeName(a.name)} (demand percentile × open supply)`,
          subjectRefs: [a.id, ...conceptRefs],
          value: ws,
          reason: "not_measured",
          display: `${fixed2(ws)} · ${s.quadrant === null ? "" : QUADRANT_LABEL[s.quadrant]}`,
          unit: "score",
          badge: "ESTIMATED",
          formulaId: "lift.white_space",
          evidenceIds: [...evidence.maps, ...evidence.supply],
          n: open.length,
          comparator: null,
        }),
      ),
    );
  }
  return out;
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
    areaOf: (geohash: string) => string | null;
    evidenceIds: readonly EvidenceId[];
  },
): DatasetId {
  const { grid, areas, supply, points, capped, concept, areaOf } = args;
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
        supplyCount: s?.count ?? null,
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
      (points === null ? "" : " · supply: a capped sample of Qloo-indexed venues"),
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
export function liftDigestRows(areas: readonly AreaLift[], supply: ReadonlyMap<string, AreaSupply>, metrics: LiftMetrics): DigestRow[] {
  const ranked = byLift(areas);
  const rest = areas
    .filter((a) => a.lift === null && a.covered > 0)
    .sort((a, b) => b.n - a.n || b.covered - a.covered || (a.id < b.id ? -1 : 1));
  return [...ranked, ...rest].map((a) => {
    const s = supply.get(a.id);
    const values: DigestRow["values"] = { area: a.id };
    if (a.lift !== null) {
      values.lift_rank = ranked.indexOf(a) + 1;
      values.lift_metric = metrics.areas.get(a.id)?.id ?? null;
    } else {
      values.unscored = a.reason;
    }
    const ws = metrics.whiteSpace.get(a.id);
    if (ws !== undefined) values.white_space_metric = ws.id;
    if (s?.quadrant) values.quadrant = QUADRANT_LABEL[s.quadrant];
    return { ref: null, name: safeName(a.name), values };
  });
}
