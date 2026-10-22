/** Percentile with linear interpolation between closest ranks; null for an empty sample. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(p >= 0 && p <= 100)) throw new RangeError(`percentile must be within 0..100, got ${p}`);
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (rank - lo);
}

/** The median. With two runs per config it is their mean. */
export function p50(values: readonly number[]): number | null {
  return percentile(values, 50);
}

export function sum(values: readonly number[]): number {
  return values.reduce((acc, v) => acc + v, 0);
}
