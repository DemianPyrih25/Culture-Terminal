/**
 * Shared statistics (SPEC §5.2). Pure and deterministic; randomness only through a seeded generator.
 *
 * Seam file: the two signatures below are used by other workstreams and are fixed for the parallel
 * build. The quant-core workstream implements them and adds the rest of the §5.2 toolkit.
 *
 * Conventions: inputs are finite numbers; a statistic that is undefined for its input (an empty
 * sample, a constant series) returns null rather than NaN, so "not measured" stays explicit.
 */

export interface WithinCallPercentiles {
  /** pct_i = 1 − (r_i − 1)/(n − 1) over the scored values (n ≥ 2; a single scored value gets 1). Null when unscored. */
  pct: (number | null)[];
  /** Descending average rank among the scored values (1 = highest). Null when unscored. */
  rank: (number | null)[];
  /** True for null inputs and for floor ties (see `floor`). */
  unscored: boolean[];
}

/**
 * Within-call percentiles. `floor` is the "no relationship" value for this skill's calls (from
 * detectFloor): any value equal to it is unscored, never ranked (probe G1).
 */
export function withinCallPercentiles(
  scores: readonly (number | null)[],
  floor: number | null,
): WithinCallPercentiles {
  // A non-finite score cannot be ranked either; it is treated like a missing one.
  const unscored = scores.map((s) => s === null || !Number.isFinite(s) || (floor !== null && s === floor));
  const scoredAt: number[] = [];
  unscored.forEach((u, i) => {
    if (!u) scoredAt.push(i);
  });
  const ranks = averageRanks(scoredAt.map((i) => scores[i] as number), "desc");
  const n = scoredAt.length;
  const pct: (number | null)[] = scores.map(() => null);
  const rank: (number | null)[] = scores.map(() => null);
  scoredAt.forEach((i, k) => {
    const r = ranks[k]!;
    rank[i] = r;
    pct[i] = n === 1 ? 1 : 1 - (r - 1) / (n - 1);
  });
  return { pct, rank, unscored };
}

/**
 * The floor value shared by candidates with no relationship to the signal: the minimum of the
 * pooled scores when it occurs at least twice (exact equality), else null. Pool every score a skill
 * received across its calls, since one call may hold a single floor value.
 */
export function detectFloor(pooledScores: readonly number[]): number | null {
  let min = Infinity;
  let count = 0;
  for (const v of pooledScores) {
    if (!Number.isFinite(v)) continue;
    if (v < min) {
      min = v;
      count = 1;
    } else if (v === min) {
      count += 1;
    }
  }
  return count >= 2 ? min : null;
}

// Location and spread ---------------------------------------------------------------------------

/** Φ⁻¹(3/4), the standard-normal upper quartile: scales a MAD to a standard deviation. */
export const NORMAL_UPPER_QUARTILE = 0.6744897501960817;

/** √(π/2): scales a mean absolute deviation to a standard deviation (the MAD = 0 fallback). */
const MEAN_ABS_DEV_SCALE = 1.2533141373155003;

export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const v of values) total += v;
  return total / values.length;
}

export function median(values: readonly number[]): number | null {
  return quantile(values, 0.5);
}

/** Hyndman–Fan type 7 quantile (the R and NumPy default): linear interpolation between order statistics. */
export function quantile(values: readonly number[], p: number): number | null {
  if (!(p >= 0 && p <= 1)) throw new RangeError(`quantile: p must be within 0..1, got ${p}`);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const h = (sorted.length - 1) * p;
  const lo = Math.floor(h);
  const a = sorted[lo]!;
  const b = sorted[Math.min(lo + 1, sorted.length - 1)]!;
  return a + (h - lo) * (b - a);
}

/** Sample standard deviation (n − 1 denominator); null below two values. */
export function stdev(values: readonly number[]): number | null {
  if (values.length < 2) return null;
  const m = mean(values)!;
  let ss = 0;
  for (const v of values) ss += (v - m) ** 2;
  return Math.sqrt(ss / (values.length - 1));
}

/** Median absolute deviation from the median, unscaled. */
export function mad(values: readonly number[]): number | null {
  const m = median(values);
  if (m === null) return null;
  return median(values.map((v) => Math.abs(v - m)));
}

/**
 * Robust z-scores Φ⁻¹(3/4)·(x − median)/MAD. When more than half the values equal the median the
 * MAD is 0; the mean absolute deviation, scaled by √(π/2), then stands in as the spread. A constant
 * sample scores 0 everywhere.
 */
export function madZ(values: readonly number[]): number[] {
  const m = median(values);
  if (m === null) return [];
  const deviations = values.map((v) => v - m);
  const madValue = median(deviations.map(Math.abs))!;
  if (madValue > 0) return deviations.map((d) => (NORMAL_UPPER_QUARTILE * d) / madValue);
  const meanAbs = mean(deviations.map(Math.abs))!;
  if (meanAbs > 0) return deviations.map((d) => d / (MEAN_ABS_DEV_SCALE * meanAbs));
  return deviations.map(() => 0);
}

export interface Winsorized {
  values: number[];
  /** The p5 and p95 bounds actually applied; null for an empty sample. */
  lo: number | null;
  hi: number | null;
  /** True where a value was pulled in to a bound (MomentumStrip draws a caret there). */
  clipped: boolean[];
}

/** Clips values to their own [p_lower, p_upper] quantiles (type 7), p5/p95 by default. */
export function winsorize(values: readonly number[], lower = 0.05, upper = 0.95): Winsorized {
  if (!(lower <= upper)) throw new RangeError(`winsorize: lower (${lower}) must not exceed upper (${upper})`);
  const lo = quantile(values, lower);
  const hi = quantile(values, upper);
  if (lo === null || hi === null) return { values: [], lo: null, hi: null, clipped: [] };
  return {
    values: values.map((v) => clamp(v, lo, hi)),
    lo,
    hi,
    clipped: values.map((v) => v < lo || v > hi),
  };
}

export function geometricMean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let logs = 0;
  for (const v of values) {
    if (!(v > 0)) throw new RangeError(`geometricMean: values must be positive, got ${v}`);
    logs += Math.log(v);
  }
  return Math.exp(logs / values.length);
}

export function clamp(x: number, lo: number, hi: number): number {
  if (lo > hi) throw new RangeError(`clamp: lo (${lo}) exceeds hi (${hi})`);
  return Math.min(hi, Math.max(lo, x));
}

// Ranks ------------------------------------------------------------------------------------------

export type RankOrder = "asc" | "desc";

/** Indices sorted by value; equal values keep index order so tie groups are contiguous and stable. */
function sortedIndices(values: readonly number[], order: RankOrder): number[] {
  const sign = order === "asc" ? 1 : -1;
  return values.map((_, i) => i).sort((a, b) => sign * (values[a]! - values[b]!) || a - b);
}

/** Visits each run of equal values in sorted order with its first and last 0-based position. */
function forEachTieGroup(
  values: readonly number[],
  order: RankOrder,
  visit: (members: number[], first: number, last: number) => void,
): void {
  const idx = sortedIndices(values, order);
  let start = 0;
  while (start < idx.length) {
    let end = start;
    while (end + 1 < idx.length && values[idx[end + 1]!] === values[idx[start]!]) end += 1;
    visit(idx.slice(start, end + 1), start, end);
    start = end + 1;
  }
}

/** 1-based ranks with ties sharing the mean of their positions ("fractional" ranking). */
export function averageRanks(values: readonly number[], order: RankOrder = "asc"): number[] {
  const ranks = new Array<number>(values.length);
  forEachTieGroup(values, order, (members, first, last) => {
    for (const i of members) ranks[i] = (first + last) / 2 + 1;
  });
  return ranks;
}

/** 1-based ranks with ties sharing the best position ("1224" ranking), for display as "k of n". */
export function competitionRanks(values: readonly number[], order: RankOrder = "asc"): number[] {
  const ranks = new Array<number>(values.length);
  forEachTieGroup(values, order, (members, first) => {
    for (const i of members) ranks[i] = first + 1;
  });
  return ranks;
}

// Trend ------------------------------------------------------------------------------------------

export interface LineFit {
  slope: number;
  intercept: number;
}

function assertSameLength(fn: string, a: readonly unknown[], b: readonly unknown[]): void {
  if (a.length !== b.length) throw new RangeError(`${fn}: length mismatch (${a.length} vs ${b.length})`);
}

/**
 * Theil–Sen line: the slope is the median of all pairwise slopes (pairs with equal x skipped), the
 * intercept the median of y − slope·x. Up to about 29% of points can be outliers without moving it.
 * Null when fewer than two distinct x values exist.
 */
export function theilSen(x: readonly number[], y: readonly number[]): LineFit | null {
  assertSameLength("theilSen", x, y);
  const slopes: number[] = [];
  for (let i = 0; i < x.length; i++) {
    for (let j = i + 1; j < x.length; j++) {
      const dx = x[j]! - x[i]!;
      if (dx !== 0) slopes.push((y[j]! - y[i]!) / dx);
    }
  }
  const slope = median(slopes);
  if (slope === null) return null;
  const intercept = median(y.map((yi, i) => yi - slope * x[i]!))!;
  return { slope, intercept };
}

export interface MannKendall {
  n: number;
  /** S = Σ_{i<j} sgn(x_j − x_i). */
  s: number;
  /** Kendall's τ = S / (n(n − 1)/2), from −1 (always falling) to 1 (always rising). */
  tau: number;
  /** Var(S) with the tie correction Σ t(t − 1)(2t + 5) over groups of equal values. */
  variance: number;
  /** (S − sgn S)/√Var(S), the continuity-corrected normal score; 0 when S is 0. */
  z: number;
  /** Two-sided p-value 2·(1 − Φ(|z|)). */
  p: number;
}

/**
 * Mann–Kendall trend test on a series in time order. Null below two points and for a constant
 * series: Var(S) is then 0 and the test is undefined, so the caller shows NO SIGNAL, never Flat.
 */
export function mannKendall(series: readonly number[]): MannKendall | null {
  const n = series.length;
  if (n < 2) return null;
  let s = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) s += Math.sign(series[j]! - series[i]!);
  }
  const tieSizes = new Map<number, number>();
  for (const v of series) tieSizes.set(v, (tieSizes.get(v) ?? 0) + 1);
  let tieTerm = 0;
  for (const t of tieSizes.values()) tieTerm += t * (t - 1) * (2 * t + 5);
  // Integer arithmetic, so this is exactly 0 only when every value is tied.
  const variance = (n * (n - 1) * (2 * n + 5) - tieTerm) / 18;
  if (variance <= 0) return null;
  const z = s === 0 ? 0 : (s - Math.sign(s)) / Math.sqrt(variance);
  // 2·Φ(−|z|) equals 2·(1 − Φ(|z|)) but keeps precision far into the tail.
  const p = Math.min(1, 2 * normalCdf(-Math.abs(z)));
  return { n, s, tau: s / ((n * (n - 1)) / 2), variance, z, p };
}

// Association and similarity ---------------------------------------------------------------------

/** Pearson correlation; null below two pairs or when either side is constant. */
export function pearson(x: readonly number[], y: readonly number[]): number | null {
  assertSameLength("pearson", x, y);
  if (x.length < 2) return null;
  const mx = mean(x)!;
  const my = mean(y)!;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < x.length; i++) {
    const dx = x[i]! - mx;
    const dy = y[i]! - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return clamp(sxy / Math.sqrt(sxx * syy), -1, 1);
}

/** Spearman ρ: Pearson correlation of average ranks, so ties are handled. */
export function spearman(x: readonly number[], y: readonly number[]): number | null {
  assertSameLength("spearman", x, y);
  return pearson(averageRanks(x), averageRanks(y));
}

/** |A ∩ B| / |A ∪ B| over distinct members; null when both are empty. */
export function jaccard<T>(a: Iterable<T>, b: Iterable<T>): number | null {
  const setA = new Set(a);
  const setB = new Set(b);
  let shared = 0;
  for (const v of setA) if (setB.has(v)) shared += 1;
  const union = setA.size + setB.size - shared;
  return union === 0 ? null : shared / union;
}

/** Cosine of the angle between two vectors; null when either has zero length. */
export function cosine(a: readonly number[], b: readonly number[]): number | null {
  assertSameLength("cosine", a, b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return null;
  return clamp(dot / Math.sqrt(na * nb), -1, 1);
}

// Normal distribution ----------------------------------------------------------------------------

/**
 * Standard-normal CDF Φ(z) by Hart's double-precision rational approximation (as given by West,
 * "Better approximations to cumulative normal functions"), with absolute error below 1e-14.
 */
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) return NaN;
  const x = Math.abs(z);
  let tail: number;
  if (x > 37) {
    tail = 0;
  } else {
    const e = Math.exp((-x * x) / 2);
    if (x < 7.07106781186547) {
      let num = 3.52624965998911e-2 * x + 0.700383064443688;
      num = num * x + 6.37396220353165;
      num = num * x + 33.912866078383;
      num = num * x + 112.079291497871;
      num = num * x + 221.213596169931;
      num = num * x + 220.206867912376;
      let den = 8.83883476483184e-2 * x + 1.75566716318264;
      den = den * x + 16.064177579207;
      den = den * x + 86.7807322029461;
      den = den * x + 296.564248779674;
      den = den * x + 637.333633378831;
      den = den * x + 793.826512519948;
      den = den * x + 440.413735824752;
      tail = (e * num) / den;
    } else {
      let cf = x + 0.65;
      cf = x + 4 / cf;
      cf = x + 3 / cf;
      cf = x + 2 / cf;
      cf = x + 1 / cf;
      tail = e / cf / 2.506628274631;
    }
  }
  return z > 0 ? 1 - tail : tail;
}

// Seeded randomness and the bootstrap ------------------------------------------------------------

/** FNV-1a over UTF-16 code units, then the murmur3 finaliser so similar seeds diverge. */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** A deterministic uniform generator on [0, 1) (mulberry32) seeded from a string. */
export function createRng(seed: string): () => number {
  let state = hashSeed(seed);
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapOptions {
  /** Resamples; SPEC §5.2 fixes 500. */
  B?: number;
  /** Same seed, same interval: replays and the eval reproduce exactly. */
  seed: string;
  /** Two-sided miss rate of the percentile interval (0.05 gives a 95% interval). */
  alpha?: number;
}

export interface BootstrapInterval {
  /** The statistic on the full sample. */
  estimate: number;
  lo: number;
  hi: number;
}

/**
 * Seeded percentile bootstrap: B resamples with replacement, interval from the type 7 quantiles of
 * the resampled statistic. Null for an empty sample or when the statistic is undefined on it.
 */
export function bootstrap(
  values: readonly number[],
  statistic: (sample: readonly number[]) => number | null,
  options: BootstrapOptions,
): BootstrapInterval | null {
  const B = options.B ?? 500;
  const alpha = options.alpha ?? 0.05;
  if (!Number.isInteger(B) || B < 1) throw new RangeError(`bootstrap: B must be a positive integer, got ${B}`);
  if (!(alpha > 0 && alpha < 1)) throw new RangeError(`bootstrap: alpha must be within (0, 1), got ${alpha}`);
  const n = values.length;
  if (n === 0) return null;
  const estimate = statistic(values);
  if (estimate === null || !Number.isFinite(estimate)) return null;
  const rng = createRng(options.seed);
  const draws: number[] = [];
  for (let b = 0; b < B; b++) {
    const sample = Array.from({ length: n }, () => values[Math.floor(rng() * n)]!);
    const stat = statistic(sample);
    if (stat !== null && Number.isFinite(stat)) draws.push(stat);
  }
  const lo = quantile(draws, alpha / 2);
  const hi = quantile(draws, 1 - alpha / 2);
  if (lo === null || hi === null) return null;
  return { estimate, lo, hi };
}

// Data hygiene and calendar ----------------------------------------------------------------------

/** Results below this Qloo popularity are dropped as artifacts (SPEC §5.2). */
export const QUALITY_GATE_MIN_POPULARITY = 0.01;

export interface QualityGateResult<T> {
  kept: T[];
  /** Each one is recorded as `quality_gate.dropped` by the calling skill. */
  dropped: T[];
}

/**
 * Drops items whose popularity is below 0.01. An item without a popularity value is kept: a missing
 * field is not evidence of an artifact.
 */
export function qualityGate<T>(
  items: readonly T[],
  popularityOf: (item: T) => number | null | undefined,
): QualityGateResult<T> {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const item of items) {
    const p = popularityOf(item);
    if (typeof p === "number" && p < QUALITY_GATE_MIN_POPULARITY) dropped.push(item);
    else kept.push(item);
  }
  return { kept, dropped };
}

const DAY_MS = 86_400_000;

/** An ISO 8601 date-time without a zone designator, which `new Date` would read as local time. */
const ZONELESS_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

/** Reads a zone-less date-time as UTC so the result never depends on the host timezone. */
function parseUtc(date: string): Date {
  const m = ZONELESS_DATE_TIME.exec(date.trim());
  return new Date(m ? `${m[1]}T${m[2]}Z` : date);
}

/**
 * ISO 8601 week key such as "2025-W14", from the UTC calendar date. Weeks start on Monday and
 * belong to the year that holds their Thursday, so early January can fall in the previous year.
 * A string is read as ISO 8601: a date-time without a zone designator counts as UTC, and an
 * explicit offset is honoured.
 */
export function isoWeekKey(date: Date | string): string {
  const d = typeof date === "string" ? parseUtc(date) : date;
  const time = d.getTime();
  if (Number.isNaN(time)) throw new RangeError(`isoWeekKey: invalid date ${String(date)}`);
  const day = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const weekday = day.getUTCDay() || 7;
  day.setUTCDate(day.getUTCDate() + 4 - weekday);
  const year = day.getUTCFullYear();
  const week = Math.floor((day.getTime() - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}
