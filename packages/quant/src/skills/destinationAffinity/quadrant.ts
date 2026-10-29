import { UNDER_THE_RADAR_MAX_POPULARITY, type NoValueReason, type QlooEntity, type QuadrantName } from "@ct/contracts";
import { isHiddenPocket } from "../../findings";
import { detectFloor, madZ, median, theilSen, withinCallPercentiles } from "../../stats";
import { displayRanks } from "../format";
import { passesQualityGate } from "../peerSelection";

/**
 * The S5 travel-taste quadrant (SPEC §5.3 S5, D17): QUANT over one destination call. Each scored
 * destination with a popularity is placed by FIT (its within-call percentile, A_d) against
 * popularity (p_d), split at the within-set medians; the hidden-pocket score is the MAD-z of its
 * residual from a Theil–Sen line of A on p, and state belts sum the positive residuals per
 * admin1 region. Pure, so the same response always gives the same quadrant.
 */

export const US_COUNTRY_CODE = "US";

/** One destination row as QUANT reads it, after the quality gate and the US check. */
export interface DestinationRow {
  result: QlooEntity;
  name: string;
  popularity: number | null;
  /** Raw affinity from the call, or null when the row carries none. */
  affinity: number | null;
  /** properties.geocode.admin1_region (the state), or null. */
  region: string | null;
  geo: { lat: number; lon: number } | null;
}

export interface TravelQuadrant {
  rows: DestinationRow[];
  /** Rows the §5.2 quality gate skipped (popularity below 0.01), by name. */
  gateDropped: string[];
  /** Rows whose geocode names a country other than the US (the filter should leave none, G5). */
  outsideUs: number;
  /** The shared "no relationship" affinity, or null. */
  floor: number | null;
  /** A_d by row; null when the row is unscored (no affinity, or tied at the floor). */
  fit: (number | null)[];
  /** Competition rank of A_d among the scored rows (1 = top), for "k of n" displays. */
  rank: (number | null)[];
  /** Scored rows. */
  scored: number;
  /** Why a row has no point on the quadrant; null when it is placed. */
  reasons: (NoValueReason | null)[];
  /** Placed rows (FIT and popularity both known), in row order. */
  placed: number[];
  medianFit: number | null;
  medianPopularity: number | null;
  quadrant: (QuadrantName | null)[];
  /** e_d = A_d − (α + β·p_d) by row; null when not placed or the fit is undefined. */
  residual: (number | null)[];
  /** Hidden-pocket score H_d (MAD-z of the residual) by row. */
  score: (number | null)[];
  /** Rows that pass the HIDDEN_POCKET rule (z ≥ 2, popularity below min(median, 0.85)), strongest first. */
  hiddenPockets: number[];
  /** Σ positive residuals per region, largest first; `members` counts the positive residuals. */
  belts: { region: string; value: number; members: number }[];
}

function affinityOf(r: QlooEntity): number | null {
  const a = r.query?.affinity;
  return typeof a === "number" && Number.isFinite(a) ? a : null;
}

function regionOf(r: QlooEntity): string | null {
  const region = r.properties?.geocode?.admin1_region;
  return typeof region === "string" && region.trim() !== "" ? region.trim() : null;
}

function geoOf(r: QlooEntity): { lat: number; lon: number } | null {
  const at = r.location;
  return at !== undefined && Number.isFinite(at.lat) && Number.isFinite(at.lon) ? { lat: at.lat, lon: at.lon } : null;
}

/** A row whose geocode names another country; a row without a country code is kept. */
function outsideUs(r: QlooEntity): boolean {
  const code = r.properties?.geocode?.country_code;
  return typeof code === "string" && code.trim() !== "" && code.trim().toUpperCase() !== US_COUNTRY_CODE;
}

/**
 * The travel quadrant, split at the within-set medians (D17). A destination at or above
 * UNDER_THE_RADAR_MAX_POPULARITY is well known whatever the set's median (D3 of the Part 9 close-out):
 * high fit makes it HEARTLAND, never a hidden pocket, as on the sponsor slate.
 */
export function quadrantOf(fit: number, popularity: number, medianFit: number, medianPopularity: number): QuadrantName {
  const known = popularity >= medianPopularity || popularity >= UNDER_THE_RADAR_MAX_POPULARITY;
  if (fit >= medianFit) return known ? "HEARTLAND" : "HIDDEN_POCKET";
  return popularity >= medianPopularity ? "MASS" : "COLD";
}

export function computeTravelQuadrant(results: readonly QlooEntity[]): TravelQuadrant {
  const gateDropped: string[] = [];
  let outside = 0;
  const seen = new Set<string>();
  const rows: DestinationRow[] = [];
  for (const r of results) {
    if (seen.has(r.entity_id)) continue;
    seen.add(r.entity_id);
    if (!passesQualityGate(r)) {
      gateDropped.push(r.name);
      continue;
    }
    if (outsideUs(r)) {
      outside += 1;
      continue;
    }
    rows.push({
      result: r,
      name: r.name,
      popularity: typeof r.popularity === "number" && Number.isFinite(r.popularity) ? r.popularity : null,
      affinity: affinityOf(r),
      region: regionOf(r),
      geo: geoOf(r),
    });
  }

  const scores = rows.map((r) => r.affinity);
  const floor = detectFloor(scores.filter((s): s is number => s !== null));
  const pct = withinCallPercentiles(scores, floor);
  const fit = pct.pct;
  const rank = displayRanks(fit);
  const reasons: (NoValueReason | null)[] = rows.map((r, i) =>
    fit[i] === null ? "not_scored" : r.popularity === null ? "not_measured" : null,
  );
  const placed = reasons.flatMap((reason, i) => (reason === null ? [i] : []));

  const fits = placed.map((i) => fit[i]!);
  const pops = placed.map((i) => rows[i]!.popularity!);
  const medianFit = median(fits);
  const medianPopularity = median(pops);
  const quadrant: (QuadrantName | null)[] = rows.map(() => null);
  if (medianFit !== null && medianPopularity !== null) {
    for (const i of placed) quadrant[i] = quadrantOf(fit[i]!, rows[i]!.popularity!, medianFit, medianPopularity);
  }

  // Theil–Sen needs two distinct popularities; without them there is no line and no score.
  const line = placed.length >= 2 ? theilSen(pops, fits) : null;
  const residual: (number | null)[] = rows.map(() => null);
  const score: (number | null)[] = rows.map(() => null);
  if (line !== null) {
    const e = placed.map((i) => fit[i]! - (line.intercept + line.slope * rows[i]!.popularity!));
    const z = madZ(e);
    placed.forEach((i, k) => {
      residual[i] = e[k]!;
      score[i] = z[k]!;
    });
  }

  const hiddenPockets =
    medianPopularity === null
      ? []
      : placed
          .filter((i) => isHiddenPocket({ name: rows[i]!.name, residualZ: score[i] ?? null, popularity: rows[i]!.popularity }, medianPopularity))
          .sort((a, b) => score[b]! - score[a]! || a - b);

  const byRegion = new Map<string, { value: number; members: number }>();
  for (const i of placed) {
    const e = residual[i];
    const region = rows[i]!.region;
    if (e === null || e === undefined || e <= 0 || region === null) continue;
    const belt = byRegion.get(region) ?? { value: 0, members: 0 };
    byRegion.set(region, { value: belt.value + e, members: belt.members + 1 });
  }
  const belts = [...byRegion.entries()]
    .map(([region, b]) => ({ region, ...b }))
    .sort((a, b) => b.value - a.value || (a.region < b.region ? -1 : a.region > b.region ? 1 : 0));

  return {
    rows,
    gateDropped,
    outsideUs: outside,
    floor,
    fit,
    rank,
    scored: fit.filter((v) => v !== null).length,
    reasons,
    placed,
    medianFit,
    medianPopularity,
    quadrant,
    residual,
    score,
    hiddenPockets,
    belts,
  };
}

/** Labelled points (the top 8): hidden pockets strongest first, then the highest FIT. */
export const LABELLED_POINTS = 8;

export function labelledRows(q: TravelQuadrant): number[] {
  const pockets = q.hiddenPockets;
  const rest = q.placed.filter((i) => !pockets.includes(i)).sort((a, b) => q.fit[b]! - q.fit[a]! || a - b);
  return [...pockets, ...rest].slice(0, LABELLED_POINTS);
}
