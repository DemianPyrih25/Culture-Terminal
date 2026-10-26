import { OLD_AGE_BUCKETS, YOUNG_AGE_BUCKETS, type NoValueReason } from "@ct/contracts";
import { METRO_OUTLIER_MIN_RANK_GAP } from "../../findings";
import { mean, median } from "../../stats";
import { displayRanks } from "../format";
import { commonRanks, missingReason, type GridRow, type ScoreGrid } from "../rankCandidates/scoring";

/**
 * The S2 quantities read off the Share-of-Taste grid (SPEC §5.3 S2): youth tilt, metros won, metro
 * outliers and the subject's best and worst context. Pure, so the same grid always gives the same
 * numbers.
 */

const YOUNG: readonly string[] = YOUNG_AGE_BUCKETS;
const OLD: readonly string[] = OLD_AGE_BUCKETS;

export interface YouthTilts {
  /** Rows of the queried young and old buckets, in grid order. */
  young: GridRow[];
  old: GridRow[];
  /** Per candidate: mean pct over the young rows minus mean pct over the old rows; null when it has none. */
  values: (number | null)[];
  /** Why a tilt is missing; null where there is one. */
  reasons: (NoValueReason | null)[];
  /** Whole ranks of the tilts, 1 = leans youngest; null without a tilt. */
  ranks: (number | null)[];
}

/**
 * Youth tilt per candidate (FORMULAS share.youth_tilt) over the young and old buckets the call
 * queried, so every candidate's tilt rests on the same buckets, and among the members every one of
 * those buckets ranked (commonRanks), so the percentiles it subtracts compare the same set. Null when
 * no young or no old bucket was queried. A candidate outside that set, or every candidate when a
 * bucket ranked nothing, has no tilt, with the reason.
 */
export function youthTilts(grid: ScoreGrid): YouthTilts | null {
  const ages = grid.rows.filter((r) => r.spec.kind === "age");
  const young = ages.filter((r) => r.spec.subject !== null && YOUNG.includes(r.spec.subject));
  const old = ages.filter((r) => r.spec.subject !== null && OLD.includes(r.spec.subject));
  if (young.length === 0 || old.length === 0) return null;
  const rows = [...young, ...old];
  const common = rows.every((r) => r.scored > 0) ? commonRanks(rows, grid.candidates.length) : null;
  const cells = common?.cells ?? rows.map((r) => r.cells);
  const values: (number | null)[] = [];
  const reasons: (NoValueReason | null)[] = [];
  grid.candidates.forEach((_, j) => {
    const pcts = cells.map((row) => row[j]?.pct ?? null);
    if (common === null || pcts.some((p) => p === null)) {
      values.push(null);
      reasons.push(missingReason([...rows.map((r) => r.gap), ...cells.map((row) => row[j]?.reason)]));
      return;
    }
    const present = pcts as number[];
    values.push(mean(present.slice(0, young.length))! - mean(present.slice(young.length))!);
    reasons.push(null);
  });
  return { young, old, values, reasons, ranks: displayRanks(values) };
}

/** The median tilt of the candidates that have one (GENERATIONAL_SPLIT compares the subject with it). */
export function medianTilt(tilts: YouthTilts): number | null {
  return median(tilts.values.filter((v): v is number => v !== null));
}

export interface MetroWins {
  /** Metro rows that ranked something: M in "wins K of M". */
  ranked: GridRow[];
  /** Per candidate: metros where it ranks first (ties share first). */
  won: number[];
  /** Per candidate: metros where its percentile is at least 0.5. */
  topHalf: number[];
  /** Per candidate: ranked metros that ranked it. */
  rankedIn: number[];
  /** Per candidate: why it has no count (no ranked metro ranked it); null when it has one. */
  reasons: (NoValueReason | null)[];
}

/**
 * Metros won (FORMULAS share.metros_won) over the metro rows that ranked; null without metro
 * contexts. A member no metro ranked has no count, never a measured 0: the reason is the metro
 * calls' gap, else its own cells' (dropped, not_scored, insufficient_n).
 */
export function metroWins(grid: ScoreGrid): MetroWins | null {
  const metros = grid.rows.filter((r) => r.spec.kind === "metro");
  if (metros.length === 0) return null;
  const ranked = metros.filter((r) => r.scored > 0);
  const won = grid.candidates.map((_, j) => ranked.filter((r) => r.cells[j]?.rank === 1).length);
  const topHalf = grid.candidates.map((_, j) => ranked.filter((r) => (r.cells[j]?.pct ?? -1) >= 0.5).length);
  const rankedIn = grid.candidates.map((_, j) => ranked.filter((r) => (r.cells[j]?.rank ?? null) !== null).length);
  const reasons = grid.candidates.map((_, j) => {
    if ((rankedIn[j] ?? 0) > 0) return null;
    const from = ranked.length > 0 ? ranked : metros;
    return missingReason(from.flatMap((r) => [r.gap, r.cells[j]?.reason]));
  });
  return { ranked, won, topHalf, rankedIn, reasons };
}

/**
 * The rows where a candidate fares best and worst: highest and lowest percentile among the rows
 * that rank it, ties going to the better rank, then grid order. `worst` is null when it would be the
 * same row as `best`.
 */
export function bestAndWorst(grid: ScoreGrid, j: number): { best: number | null; worst: number | null } {
  const scored = grid.rows
    .map((row, index) => ({ index, pct: row.cells[j]?.pct ?? null, rank: row.cells[j]?.rank ?? Number.POSITIVE_INFINITY }))
    .filter((r): r is { index: number; pct: number; rank: number } => r.pct !== null);
  if (scored.length === 0) return { best: null, worst: null };
  const better = (a: (typeof scored)[number], b: (typeof scored)[number]) => b.pct - a.pct || a.rank - b.rank || a.index - b.index;
  const sorted = [...scored].sort(better);
  const best = sorted[0]!.index;
  const worst = sorted[sorted.length - 1]!.index;
  return { best, worst: worst === best ? null : worst };
}

/** The subject's whole ranks in the metro rows that rank it, with their median (METRO_OUTLIER). */
export function metroRanks(grid: ScoreGrid, j: number): { rows: { row: GridRow; rank: number }[]; median: number | null } {
  const rows = grid.rows
    .filter((r) => r.spec.kind === "metro" && r.scored > 0)
    .flatMap((row) => {
      const rank = row.cells[j]?.rank ?? null;
      return rank === null ? [] : [{ row, rank }];
    });
  return { rows, median: median(rows.map((r) => r.rank)) };
}

export interface MetroOutlier {
  row: GridRow;
  rank: number;
  median: number;
}

/**
 * The metros where a candidate ranks clearly better and clearly worse than its median metro rank
 * (METRO_OUTLIER_MIN_RANK_GAP places or more), the strongest each way, better first; at most two.
 */
export function metroOutliers(grid: ScoreGrid, j: number): MetroOutlier[] {
  const { rows, median: mid } = metroRanks(grid, j);
  if (mid === null) return [];
  const strongest = (sign: 1 | -1) =>
    rows
      .filter((r) => sign * (mid - r.rank) >= METRO_OUTLIER_MIN_RANK_GAP)
      .sort((a, b) => sign * (a.rank - b.rank))[0];
  return [strongest(1), strongest(-1)].flatMap((r) => (r === undefined ? [] : [{ row: r.row, rank: r.rank, median: mid }]));
}

/** The pair's within-call split in a row: the first candidate's share of the two affinities; null unless both are ranked. */
export function pairSplit(row: GridRow): number | null {
  const [a, b] = row.affinity;
  if (a === null || a === undefined || b === null || b === undefined || a + b <= 0) return null;
  return a / (a + b);
}
