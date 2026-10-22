/**
 * S1 Substitution Map math (SPEC §5.3 S1). Pure: the peer_landscape skill makes the Qloo calls and
 * hands the symmetric similarity matrix here.
 *
 * Seam file: the signatures below are fixed for the parallel build; the quant-core workstream
 * implements the bodies.
 */
import { competitionRanks, mean, quantile, withinCallPercentiles } from "./stats";

export interface SubsInput {
  /** Entity refs in matrix order; `targetIndex` points at the target. */
  refs: readonly string[];
  targetIndex: number;
  /**
   * sim[i][j] for i ≠ j: the pairwise score, symmetric (probe G1). Null when the pair was not scored
   * (dropped, or a floor tie, which means "no relationship", never a rank). The diagonal is ignored.
   */
  sim: readonly (readonly (number | null)[])[];
}

export interface SubsStats {
  /** Display order from average-linkage clustering on sim (indices into refs). */
  order: number[];
  /** rr[i][j]: rank of j among the scored cells of row i, 1 = most similar; null on the diagonal or unscored. */
  rankInRow: (number | null)[][];
  /** Within-row percentile of each scored cell, pct = 1 − (r − 1)/(n − 1) with average-rank ties. */
  pctInRow: (number | null)[][];
  /** Hub_j = mean over rows i ≠ j of pctInRow[i][j]; null when column j has fewer than hubMinRows(k) scored cells. */
  hub: (number | null)[];
  /** 1 − max_{i≠j} sim_ij; null when the entity has no scored pair. */
  distinctiveness: (number | null)[];
  /** Rank of each entity by distinctiveness, 1 = most distinctive; null when distinctiveness is null. */
  distinctivenessRank: (number | null)[];
  /** p90 of the scored off-diagonal similarities (upper triangle), or null with fewer than 2 values. */
  p90: number | null;
  /** Unordered pairs [i, j] (i < j) with mutual rank 1 and sim ≥ p90. */
  nearSubstitutes: [number, number][];
  /** Rows (i ≠ target) in which the target is scored and ranked last. */
  targetLastInRows: number;
  /** Rows (i ≠ target) in which the target is scored at all. */
  targetScoredRows: number;
  /** Target last in ≥ 75% of the rows where it is scored (and scored in at least 3 rows). */
  tasteIsland: boolean;
  /** Index of the target's most similar scored entity, or null. */
  targetNearest: number | null;
}

/** A taste island needs the target scored in at least this many peer rows. */
export const TASTE_ISLAND_MIN_ROWS = 3;
/** Share of the target's scored rows in which it must rank last. */
export const TASTE_ISLAND_LAST_SHARE = 0.75;
/** Near-substitutes need a similarity at or above this quantile of the scored pairs. */
export const NEAR_SUBSTITUTE_QUANTILE = 0.9;
/** A hub score needs the entity scored in at least this many rows, whatever the map size. */
export const HUB_MIN_ROWS = 2;

/**
 * Rows an entity must be scored in for its hub score: half of the other k − 1 rows, and at least
 * HUB_MIN_ROWS. A column scored in one row would take that row's percentile as its hub, so a brand
 * close to a single peer could read as the most central brand in the map.
 */
export function hubMinRows(k: number): number {
  return Math.max(HUB_MIN_ROWS, Math.ceil((k - 1) / 2));
}

/** Merge distances closer than this count as ties, so float noise cannot reorder the grid. */
const LINKAGE_TIE_EPSILON = 1e-12;

type Matrix = (number | null)[][];

export function computeSubstitution(input: SubsInput): SubsStats {
  const k = input.refs.length;
  validate(input, k);
  const sim = symmetrise(input.sim, k);
  const target = input.targetIndex;

  const rankInRow: Matrix = [];
  const pctInRow: Matrix = [];
  for (const row of sim) {
    const within = withinCallPercentiles(row, null);
    rankInRow.push(within.rank);
    pctInRow.push(within.pct);
  }

  const minRows = hubMinRows(k);
  const hub = indices(k).map((j) => {
    const column = nonNull(indices(k).map((i) => (i === j ? null : (pctInRow[i]![j] ?? null))));
    return column.length < minRows ? null : mean(column);
  });

  const distinctiveness = sim.map((row) => {
    const scored = nonNull(row);
    return scored.length === 0 ? null : 1 - Math.max(...scored);
  });
  const distinctivenessRank = rankNonNull(distinctiveness);

  const upper: number[] = [];
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const s = sim[i]![j] ?? null;
      if (s !== null) upper.push(s);
    }
  }
  const p90 = upper.length >= 2 ? quantile(upper, NEAR_SUBSTITUTE_QUANTILE) : null;

  const nearSubstitutes: [number, number][] = [];
  if (p90 !== null) {
    for (let i = 0; i < k; i++) {
      for (let j = i + 1; j < k; j++) {
        const s = sim[i]![j] ?? null;
        const mutualFirst = rankInRow[i]![j] === 1 && rankInRow[j]![i] === 1;
        if (s !== null && s >= p90 && mutualFirst) nearSubstitutes.push([i, j]);
      }
    }
  }

  let targetScoredRows = 0;
  let targetLastInRows = 0;
  for (let i = 0; i < k; i++) {
    const r = i === target ? null : (rankInRow[i]![target] ?? null);
    if (r === null) continue;
    targetScoredRows += 1;
    // Last means no scored cell ranks lower and at least one ranks higher, so a shared last place
    // counts, while a row with no ordering (the target alone, or every cell tied) does not.
    const rowRanks = nonNull(rankInRow[i]!);
    if (r === Math.max(...rowRanks) && r > Math.min(...rowRanks)) targetLastInRows += 1;
  }
  const tasteIsland =
    targetScoredRows >= TASTE_ISLAND_MIN_ROWS && targetLastInRows >= TASTE_ISLAND_LAST_SHARE * targetScoredRows;

  return {
    order: averageLinkageOrder(sim, k),
    rankInRow,
    pctInRow,
    hub,
    distinctiveness,
    distinctivenessRank,
    p90,
    nearSubstitutes,
    targetLastInRows,
    targetScoredRows,
    tasteIsland,
    targetNearest: nearestTo(sim[target]!),
  };
}

function validate(input: SubsInput, k: number): void {
  if (!Number.isInteger(input.targetIndex) || input.targetIndex < 0 || input.targetIndex >= k) {
    throw new RangeError(`computeSubstitution: targetIndex ${input.targetIndex} is outside 0..${k - 1}`);
  }
  if (input.sim.length !== k || input.sim.some((row) => row.length !== k)) {
    throw new RangeError(`computeSubstitution: sim must be ${k}×${k} to match refs`);
  }
}

/**
 * Mirrors the matrix so either triangle may carry a pair: one side null takes the other side, two
 * values average (identical under probe G1). Non-finite values and the diagonal become null.
 */
function symmetrise(raw: SubsInput["sim"], k: number): Matrix {
  const cell = (i: number, j: number): number | null => {
    const v = raw[i]![j] ?? null;
    return v !== null && Number.isFinite(v) ? v : null;
  };
  return indices(k).map((i) =>
    indices(k).map((j) => {
      if (i === j) return null;
      const a = cell(i, j);
      const b = cell(j, i);
      if (a === null) return b;
      return b === null ? a : (a + b) / 2;
    }),
  );
}

/** Ranks 1 = largest among the non-null values (ties share the best rank, shown as "k of n"). */
function rankNonNull(values: readonly (number | null)[]): (number | null)[] {
  const at: number[] = [];
  values.forEach((v, i) => {
    if (v !== null) at.push(i);
  });
  const ranks = competitionRanks(at.map((i) => values[i] as number), "desc");
  const out: (number | null)[] = values.map(() => null);
  at.forEach((i, n) => {
    out[i] = ranks[n]!;
  });
  return out;
}

/** The index of the largest scored value in a row; the lowest index wins a tie. */
function nearestTo(row: readonly (number | null)[]): number | null {
  let best: number | null = null;
  let bestValue = -Infinity;
  for (let j = 0; j < row.length; j++) {
    const v = row[j] ?? null;
    if (v !== null && (best === null || v > bestValue)) {
      best = j;
      bestValue = v;
    }
  }
  return best;
}

/**
 * Leaf order of an average-linkage (UPGMA) dendrogram on d = 1 − sim. Unscored pairs sit at the
 * maximum distance, max(1, the largest scored distance), so they join last. Clusters stay sorted by
 * their smallest member index; the first closest pair in that order merges, and the merged leaves
 * read lower-index cluster first, so the order is fully deterministic.
 */
function averageLinkageOrder(sim: Matrix, k: number): number[] {
  let maxDistance = 1;
  for (const row of sim) for (const s of row) if (s !== null) maxDistance = Math.max(maxDistance, 1 - s);
  const distance = (i: number, j: number): number => {
    const s = sim[i]![j] ?? null;
    return s === null ? maxDistance : 1 - s;
  };
  const linkage = (a: readonly number[], b: readonly number[]): number => {
    let total = 0;
    for (const i of a) for (const j of b) total += distance(i, j);
    return total / (a.length * b.length);
  };

  let clusters: number[][] = indices(k).map((i) => [i]);
  while (clusters.length > 1) {
    let bestA = 0;
    let bestB = 1;
    let bestDistance = Infinity;
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        const d = linkage(clusters[a]!, clusters[b]!);
        if (d < bestDistance - LINKAGE_TIE_EPSILON) {
          bestA = a;
          bestB = b;
          bestDistance = d;
        }
      }
    }
    const merged = [...clusters[bestA]!, ...clusters[bestB]!];
    clusters = clusters.flatMap((c, i) => (i === bestA ? [merged] : i === bestB ? [] : [c]));
  }
  return clusters[0] ?? [];
}

function indices(k: number): number[] {
  return Array.from({ length: k }, (_, i) => i);
}

function nonNull(values: readonly (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null);
}
