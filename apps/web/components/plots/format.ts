import { MINUS } from "../figures/format";

/**
 * Number formatting shared by the plot primitives. Plots print the display string the caller gives;
 * these helpers build the common ones, and a missing value always reads "No data", never zero.
 */

/** What a missing value reads everywhere: in plots, tables and captions. */
export const NO_DATA = "No data";

/** A signed value with the typographic minus: "+0.31", "−0.18", "0.00". */
export function signed(value: number, digits = 2): string {
  const body = Math.abs(value).toFixed(digits);
  if (Number(body) === 0) return body;
  return value < 0 ? `${MINUS}${body}` : `+${body}`;
}

/** A lift as the design prints it: "2.4×" (one digit) or "1.31×" (two). */
export function times(value: number, digits = 1): string {
  return `${value.toFixed(digits)}×`;
}

/** A share of a track, 0–1, from a value and the scale's maximum; 0 for a missing or non-positive scale. */
export function share(value: number | null, max: number): number {
  if (value === null || !Number.isFinite(value) || !(max > 0)) return 0;
  return Math.min(1, Math.max(0, value / max));
}

/**
 * How far a lift sits from its baseline, for bar lengths: |log2(v / baseline)| for ratios (the design
 * draws 0.5× as long as 2×), |v − baseline| for linear values. Null for a missing or unusable value.
 */
export function distance(value: number | null, baseline: number, scale: "log2" | "linear" = "log2"): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  if (scale === "linear") return Math.abs(value - baseline);
  if (!(value > 0) || !(baseline > 0)) return null;
  return Math.abs(Math.log2(value / baseline));
}

/** A percentage width for inline styles, rounded so markup stays stable. */
export function pct(fraction: number): string {
  return `${Math.round(Math.min(1, Math.max(0, fraction)) * 10000) / 100}%`;
}
