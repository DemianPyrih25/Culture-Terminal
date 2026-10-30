import type { AreaStanding, Neighbourhood, NoValueReason, QlooHeatmapCell, WhiteSpaceQuadrant } from "@ct/contracts";
import { areaStanding } from "../../formulas";
import { geometricMean, median, withinCallPercentiles } from "../../stats";

/**
 * S6 lift arithmetic (SPEC §5.3 S6, D18): precision normalisation, within-map percentiles, the
 * u ≥ 0.5 gate, cell lift, the neighbourhood roll-up and white space. Pure, so the same heatmaps,
 * gazetteer and places sample always give the same numbers.
 *
 * Percentiles are taken over the cells both maps cover. For a tag concept map that is almost every
 * cell; an analog-only map covers about a fifth of them, mostly the most popular (P5), and ranking
 * the baseline over the whole metro would make every analog cell look cold against it. Cells outside
 * the shared support keep their raw or base value and have no lift: not measured, never low.
 */

const GEOHASH = /^[0-9b-hjkmnp-z]{1,12}$/;
/** Absorbs floating-point error when a percentile lands exactly on the gate. */
const EPS = 1e-9;

/** The concept gate: only cells in the top half of the concept map are scored (D18). */
export const LIFT_GATE = 0.5;
/** The cushion in (u + 0.05)/(v + 0.05) that stops cold baseline cells from giving huge ratios. */
export const LIFT_CUSHION = 0.05;
/** A neighbourhood needs this many gated cells for a lift (D18). */
export const MIN_AREA_CELLS = 5;
/** Gated cells at which a neighbourhood's confidence stops growing: min(1, n/12). */
export const FULL_CONFIDENCE_CELLS = 12;
/** COARSE_GEOHASH from this geohash length down: gh5 lowers confidence (§6.4), gh4 blocks claims. */
export const COARSE_PRECISION = 5;
/** At this geohash length or coarser no neighbourhood claim is made (D18). */
export const NO_CLAIM_PRECISION = 4;
/**
 * Neighbourhoods with a lift needed before Demand_pct and Supply_pct are ranked: a percentile over
 * one or two values only says first or last, which the median split and the LATENT_DEMAND bands
 * cannot read.
 */
export const MIN_RANKED_AREAS = 3;
/**
 * The evidence every supply-based label needs: a white-space quadrant, "few rivals" or "busy with rivals"
 * on the page, and a competitor claim in the note. One rule, read by geo_lift here, by the CHECKER (V10,
 * agent report/competition) and by the web answer (components/figures/lift-scale mirrors the numbers,
 * and a test keeps them equal):
 * 1. The compared set: at least MIN_RANKED_AREAS areas with a lift, holding at least MIN_SUPPLY_VENUES
 *    counted venues between them. Below that no area's count is read and competitors are unknown.
 * 2. A capped sample's zero is no count: the cap may have cut the area's venues, so the area gets no
 *    supply label at all, neither open nor crowded, and its count is not a value a claim can cite.
 * 3. A high-supply label (Proven & crowded, Saturated, "busy with rivals") needs at least
 *    MIN_BUSY_AREA_VENUES counted venues in the area itself.
 * An area with a lift that fails 2 or 3 reads THIN_SUPPLY_LABEL ("Not enough venue data").
 */

/**
 * Similar venues a places sample must place in the neighbourhoods with a lift before any area's count
 * is read (rule 1). A thinner sample says more about Qloo's index than about the street (7 coffee venues
 * for a whole metro leaves nearly every area at 0), so the competitor count is then unknown, never 0 or few.
 */
export const MIN_SUPPLY_VENUES = 10;
/**
 * Counted venues an area needs before it can be called crowded or saturated (rule 3). With one or two,
 * a single venue more or less moves the area's density across the median, and one venue in a small
 * area is not a crowd; three is the smallest count that still leaves several venues after losing one.
 */
export const MIN_BUSY_AREA_VENUES = 3;
/** The neutral label of an area with a lift whose venue count cannot carry a supply label (rules 2 and 3). */
export const THIN_SUPPLY_LABEL = "Not enough venue data";

/** Quadrants that claim high supply (many similar venues), the ones rule 3 guards. */
export const BUSY_QUADRANTS: ReadonlySet<WhiteSpaceQuadrant> = new Set(["PROVEN_CROWDED", "SATURATED"]);

/**
 * Whether an area's counted venues can carry a supply label (rules 2 and 3): never a capped sample's 0,
 * and a high-supply quadrant only with at least MIN_BUSY_AREA_VENUES venues. Rule 1 is checked over the
 * compared set (whiteSpace, sampleGap).
 */
export function supplyLabelHolds(count: number | null, capped: boolean, quadrant: WhiteSpaceQuadrant): boolean {
  if (count === null) return false;
  if (capped && count === 0) return false;
  return !BUSY_QUADRANTS.has(quadrant) || count >= MIN_BUSY_AREA_VENUES;
}

export interface HeatCell {
  geohash: string;
  affinity: number;
}

export interface HeatParse {
  cells: HeatCell[];
  /** Zero-affinity cells, excluded from every statistic (D18). */
  zero: number;
  /** Rows without a usable geohash or affinity. */
  invalid: number;
}

/** Heatmap rows as cells: zero-affinity cells excluded (D18), malformed rows skipped and counted. */
export function heatCells(rows: readonly QlooHeatmapCell[]): HeatParse {
  const cells: HeatCell[] = [];
  let zero = 0;
  let invalid = 0;
  for (const row of rows) {
    const geohash = row.location.geohash.trim().toLowerCase();
    const affinity = row.query.affinity;
    if (!GEOHASH.test(geohash) || !Number.isFinite(affinity) || affinity < 0) invalid += 1;
    else if (affinity === 0) zero += 1;
    else cells.push({ geohash, affinity });
  }
  return { cells, zero, invalid };
}

/** The shortest geohash length in any of the maps (D18), or null when they hold no cell. */
export function sharedPrecision(maps: readonly (readonly HeatCell[])[]): number | null {
  let shortest: number | null = null;
  for (const map of maps) for (const c of map) shortest = shortest === null ? c.geohash.length : Math.min(shortest, c.geohash.length);
  return shortest;
}

/** Cells re-keyed to their prefix of length `precision`, affinity averaged within each prefix (D18). */
export function rekey(cells: readonly HeatCell[], precision: number): Map<string, number> {
  const sums = new Map<string, { total: number; n: number }>();
  for (const c of cells) {
    const key = c.geohash.slice(0, precision);
    const s = sums.get(key) ?? { total: 0, n: 0 };
    s.total += c.affinity;
    s.n += 1;
    sums.set(key, s);
  }
  return new Map([...sums].map(([key, s]) => [key, s.total / s.n]));
}

/** prec in Conf_N: gh7 or finer 1, gh6 0.8, gh5 0.5, gh4 or coarser 0 (D18). */
export function precisionFactor(precision: number): number {
  if (precision >= 7) return 1;
  if (precision === 6) return 0.8;
  if (precision === 5) return 0.5;
  return 0;
}

/** L_c = (u + 0.05)/(v + 0.05). */
export function cellLift(u: number, v: number): number {
  return (u + LIFT_CUSHION) / (v + LIFT_CUSHION);
}

export interface LiftCell {
  geohash: string;
  /** Mean concept affinity in the cell (RAW); null where the concept map has no cell. */
  raw: number | null;
  /** Mean baseline affinity in the cell (BASE); null where the baseline map has no cell. */
  base: number | null;
  /** Concept and baseline percentiles over the shared cells; null outside them. */
  u: number | null;
  v: number | null;
  /** u ≥ 0.5 (D18). */
  gated: boolean;
  /** L_c for gated cells; null otherwise. */
  lift: number | null;
}

export interface LiftGrid {
  /** Geohash length after normalisation. */
  precision: number;
  /** Every cell either map covers, by geohash. */
  cells: LiftCell[];
  /** Cells both maps cover: the support of u, v and lift. */
  shared: number;
  gated: number;
}

/**
 * Both maps at their shared precision, with u, v and cell lift over the cells both cover. Without a
 * baseline (a call the budget refused or Qloo failed) the grid holds the concept's raw heat only.
 * Null when the concept map has no cell.
 */
export function liftGrid(concept: readonly HeatCell[], baseline: readonly HeatCell[] | null): LiftGrid | null {
  if (concept.length === 0) return null;
  const precision = sharedPrecision(baseline === null ? [concept] : [concept, baseline]);
  if (precision === null) return null;
  const raw = rekey(concept, precision);
  const base = baseline === null ? new Map<string, number>() : rekey(baseline, precision);
  const shared = [...raw.keys()].filter((g) => base.has(g)).sort();
  const u = withinCallPercentiles(shared.map((g) => raw.get(g) ?? null), null).pct;
  const v = withinCallPercentiles(shared.map((g) => base.get(g) ?? null), null).pct;
  const index = new Map(shared.map((g, i) => [g, i]));

  const cells = [...new Set([...raw.keys(), ...base.keys()])].sort().map((geohash): LiftCell => {
    const i = index.get(geohash);
    const ui = i === undefined ? null : (u[i] ?? null);
    const vi = i === undefined ? null : (v[i] ?? null);
    const gated = ui !== null && vi !== null && ui >= LIFT_GATE - EPS;
    return {
      geohash,
      raw: raw.get(geohash) ?? null,
      base: base.get(geohash) ?? null,
      u: ui,
      v: vi,
      gated,
      lift: gated && ui !== null && vi !== null ? cellLift(ui, vi) : null,
    };
  });
  return { precision, cells, shared: shared.length, gated: cells.filter((c) => c.gated).length };
}

export interface AreaLift {
  id: string;
  name: string;
  areaKm2: number;
  /** Shared cells whose centroid falls in the area. */
  covered: number;
  /** Gated cells with a lift: n in D18. */
  n: number;
  /** Lift_N = exp(mean ln L_c), n ≥ 5. */
  lift: number | null;
  /** Conf_N = min(1, n/12)·prec, alongside a lift. */
  conf: number | null;
  /** Why the lift is missing; null when it is present. */
  reason: NoValueReason | null;
  /** Percentile of the lift among the areas with one (Demand_pct); null with fewer than three such areas. */
  demandPct: number | null;
  /** R7: mean concept percentile u over the area's covered cells (how popular the concept already is there); null when none. */
  raw: number | null;
  /** R7: percentile of `raw` among the areas with one; null with fewer than three such areas. */
  rawPct: number | null;
  /** R7: popular, hidden (stands out for its size) or both (areaStanding); null otherwise. */
  standing: AreaStanding | null;
}

/**
 * The neighbourhood roll-up (D18): each cell goes to the area holding its centroid, and an area with
 * at least five gated cells gets the geometric mean of their lifts and its confidence. `gap` is why
 * no lift exists anywhere (the baseline was not fetched). At gh4 or coarser no area gets a lift
 * ("coarse"); an area without a shared cell is "not_measured" (an analog footprint can miss it),
 * never low; one with too few gated cells is "insufficient_n". Demand_pct is ranked only when at
 * least MIN_RANKED_AREAS areas have a lift.
 */
export function rollUp(args: {
  grid: LiftGrid;
  areas: readonly Neighbourhood[];
  /** The area holding a cell's centroid, or null outside every area. */
  areaOf: (geohash: string) => string | null;
  gap: NoValueReason | null;
}): AreaLift[] {
  const { grid, areas, areaOf, gap } = args;
  const prec = precisionFactor(grid.precision);
  const covered = new Map<string, number>();
  const lifts = new Map<string, number[]>();
  const heat = new Map<string, number>();
  for (const cell of grid.cells) {
    if (cell.u === null) continue;
    const id = areaOf(cell.geohash);
    if (id === null) continue;
    covered.set(id, (covered.get(id) ?? 0) + 1);
    heat.set(id, (heat.get(id) ?? 0) + cell.u);
    if (cell.lift !== null) lifts.set(id, [...(lifts.get(id) ?? []), cell.lift]);
  }

  const rows = areas.map((a): AreaLift => {
    const cellLifts = lifts.get(a.id) ?? [];
    const n = cellLifts.length;
    const has = covered.get(a.id) ?? 0;
    const reason: NoValueReason | null =
      gap ?? (grid.precision <= NO_CLAIM_PRECISION ? "coarse" : has === 0 ? "not_measured" : n < MIN_AREA_CELLS ? "insufficient_n" : null);
    const lift = reason === null ? geometricMean(cellLifts) : null;
    return {
      id: a.id,
      name: a.name,
      areaKm2: a.areaKm2,
      covered: has,
      n,
      lift,
      conf: lift === null ? null : Math.min(1, n / FULL_CONFIDENCE_CELLS) * prec,
      reason: lift === null ? (reason ?? "insufficient_n") : null,
      demandPct: null,
      raw: has === 0 || grid.precision <= NO_CLAIM_PRECISION ? null : (heat.get(a.id) ?? 0) / has,
      rawPct: null,
      standing: null,
    };
  });

  const eligible = rows.filter((r) => r.lift !== null);
  if (eligible.length >= MIN_RANKED_AREAS) {
    const pct = withinCallPercentiles(eligible.map((r) => r.lift), null).pct;
    eligible.forEach((r, i) => {
      r.demandPct = pct[i] ?? null;
    });
  }
  // R7: how popular the concept already is in each area, ranked among the areas the maps cover.
  const popular = rows.filter((r) => r.raw !== null);
  if (popular.length >= MIN_RANKED_AREAS) {
    const pct = withinCallPercentiles(popular.map((r) => r.raw), null).pct;
    popular.forEach((r, i) => {
      r.rawPct = pct[i] ?? null;
    });
  }
  for (const r of rows) r.standing = areaStanding(r.rawPct, r.demandPct);
  return rows;
}

/** Areas whose venue density white space can rank: a Demand_pct and a positive area. */
export function supplyRankable(areas: readonly AreaLift[]): AreaLift[] {
  return areas.filter((a) => a.demandPct !== null && a.areaKm2 > 0);
}

export interface AreaSupply {
  /** Sampled venues located in the area; null when no supply was sampled. */
  count: number | null;
  /** Supply percentile among the areas with a lift (1 = densest, 0 = none sparser); null when not measured. */
  supplyPct: number | null;
  /** WhiteSpace_N = Demand_pct·(1 − Supply_pct). */
  whiteSpace: number | null;
  quadrant: WhiteSpaceQuadrant | null;
  /**
   * True for an area with a lift whose venues were counted but cannot carry a supply label: a capped
   * sample's 0, a high-supply reading from fewer than MIN_BUSY_AREA_VENUES venues, or a compared set
   * below the rule. It reads THIN_SUPPLY_LABEL, never crowded, saturated or open.
   */
  thin: boolean;
}

/**
 * Supply_pct per area: the share of the other areas with a lower venue density, so 1 is the densest.
 * Distinct densities get the within-call percentile; tied ones share the bottom of their span, which
 * puts the areas with no sampled venue, the usual tie under a capped sample, at 0. Average ranks would
 * lift that tie to the middle of its span: once most areas hold no sampled venue it lands above the
 * LATENT_DEMAND band and on the median, and an area with no venue reads as crowded. Null for an area
 * alone, where no other area compares.
 */
export function supplyPercentiles(densities: readonly number[]): (number | null)[] {
  const others = densities.length - 1;
  return densities.map((d) => (others < 1 ? null : densities.filter((x) => x < d).length / others));
}

/** Sampled venues located in the neighbourhoods white space can rank: what MIN_SUPPLY_VENUES is checked against. */
export function rankableVenues(areas: readonly AreaLift[], counts: ReadonlyMap<string, number>): number {
  return supplyRankable(areas).reduce((n, a) => n + (counts.get(a.id) ?? 0), 0);
}

/**
 * Supply and white space. Supply_N is sampled venues per km² of the area, its percentile taken among
 * the areas with a lift so it shares Demand_pct's population. `counts` is null when no sample was
 * taken, and every count then stays null: a zero is a sampled area with no venue.
 * The supply-label rule (above MIN_SUPPLY_VENUES) decides what may carry a label:
 * - The compared set must hold at least MIN_RANKED_AREAS areas and MIN_SUPPLY_VENUES venues; otherwise
 *   no area is ranked, so a tie of zeros or a handful of venues never reads as crowded or open.
 * - A capped sample holds only the venues Qloo returned first, so an area with none of them keeps its
 *   0 in the sample but is not ranked, and the percentiles rank the areas that hold a sampled venue.
 * - A high-supply quadrant from fewer than MIN_BUSY_AREA_VENUES venues is withheld.
 * An area with a lift and a count that gets no label is `thin` (THIN_SUPPLY_LABEL), with no percentile,
 * white space or quadrant. Quadrants split at the medians, a value at the median counting as high (D17).
 */
export function whiteSpace(areas: readonly AreaLift[], counts: ReadonlyMap<string, number> | null, capped = false): Map<string, AreaSupply> {
  const out = new Map<string, AreaSupply>(
    areas.map((a) => [a.id, { count: counts === null ? null : (counts.get(a.id) ?? 0), supplyPct: null, whiteSpace: null, quadrant: null, thin: false }]),
  );
  if (counts === null) return out;
  const rankable = supplyRankable(areas);
  const markThin = (list: readonly AreaLift[]): void => {
    for (const a of list) {
      const row = out.get(a.id);
      if (row !== undefined) row.thin = true;
    }
  };
  const eligible = rankable.filter((a) => !capped || (counts.get(a.id) ?? 0) > 0);
  const venues = eligible.reduce((n, a) => n + (counts.get(a.id) ?? 0), 0);
  if (eligible.length < MIN_RANKED_AREAS || venues < MIN_SUPPLY_VENUES) {
    markThin(rankable);
    return out;
  }
  markThin(rankable.filter((a) => !eligible.includes(a)));

  const pct = supplyPercentiles(eligible.map((a) => (counts.get(a.id) ?? 0) / a.areaKm2));
  const demandSplit = median(eligible.map((a) => a.demandPct ?? 0)) ?? 0;
  const supplySplit = median(pct.flatMap((p) => (p === null ? [] : [p]))) ?? 0;
  eligible.forEach((a, i) => {
    const row = out.get(a.id);
    const supplyPct = pct[i] ?? null;
    if (row === undefined || supplyPct === null || a.demandPct === null) return;
    const quadrant = whiteSpaceQuadrant(a.demandPct, supplyPct, demandSplit, supplySplit);
    if (!supplyLabelHolds(row.count, capped, quadrant)) {
      row.thin = true;
      return;
    }
    row.supplyPct = supplyPct;
    row.whiteSpace = a.demandPct * (1 - supplyPct);
    row.quadrant = quadrant;
  });
  return out;
}

/**
 * High demand, few rivals (low supply); high demand, many rivals; low demand, many rivals (high
 * supply); low demand, few rivals.
 * A Supply_pct of 0 (no area sparser) is never high supply, even when the median falls on that tie.
 */
export function whiteSpaceQuadrant(demandPct: number, supplyPct: number, demandSplit: number, supplySplit: number): WhiteSpaceQuadrant {
  const highDemand = demandPct >= demandSplit - EPS;
  const highSupply = supplyPct > EPS && supplyPct >= supplySplit - EPS;
  if (highDemand) return highSupply ? "PROVEN_CROWDED" : "LATENT_OPEN";
  return highSupply ? "SATURATED" : "COLD";
}

/** The quadrants in a reader's words (Q1 of the Part 9 close-out); the codes stay in the data. */
export const QUADRANT_LABEL: Readonly<Record<WhiteSpaceQuadrant, string>> = {
  LATENT_OPEN: "high demand, few rivals",
  PROVEN_CROWDED: "high demand, many rivals",
  SATURATED: "low demand, many rivals",
  COLD: "low demand, few rivals",
};
