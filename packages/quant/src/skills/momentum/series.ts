import type { MomentumTrend, QlooTrendingPoint, TrendWindow } from "@ct/contracts";
import { isoWeekKey, madZ, mannKendall, median, theilSen, winsorize } from "../../stats";

/**
 * The S4 series pipeline (SPEC §5.3 S4, probe G11): read Qloo trending points, keep the latest
 * segment after a scale break, resample the step-shaped series to ISO-week medians, apply the
 * flatline and length guards, then the trend statistics. Pure; the skill turns the result into
 * STALE ledger metrics and the Momentum dataset.
 */

/** The frozen trending window (G11). Mirrors PROBE_FACTS.trendingWindow in @ct/qloo; a test keeps them equal. */
export const TRENDING_WINDOW: TrendWindow = { start: "2025-04-01", end: "2025-09-30" };

/**
 * The flatline guard (G11): a series with fewer distinct percentile values than this across the
 * window is a placeholder. Live series were step-shaped (8 distinct values in 46 points), so the old
 * "4 equal points in a row" rule would have discarded real series.
 */
export const FLATLINE_MIN_DISTINCT = 3;
/** Fewer ISO weeks than this give no trend signal (SPEC S4 minimum data). */
export const MIN_WEEKS = 8;
/** Adjacent segments on different scales whose raw medians differ by more than this factor are a scale break; the latest segment is kept. */
export const SCALE_BREAK_RATIO = 5;
/** A week is an outlier beyond this robust z (Iglewicz–Hoaglin); only outliers are winsorised and get a ^ caret. */
export const OUTLIER_MAD_Z = 3.5;
/** Δpct_26w reports the Theil–Sen slope per week over this many weeks. */
export const DELTA_WEEKS = 26;
/** mom.label: Rising needs Δ ≥ 0.02 and p < 0.1, Declining the mirror image. */
export const LABEL_MIN_DELTA = 0.02;
export const LABEL_MAX_P = 0.1;

/** Absorbs floating-point error when Δ lands exactly on a label threshold. */
const EPS = 1e-9;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})/;

export interface DatedValue {
  /** YYYY-MM-DD. */
  date: string;
  /** Trending percentile on 0–1. */
  pct: number;
}

/** Why a series shows NO SIGNAL rather than a trend ("no signal" is never "flat"). */
export type NoSignalCause = "no_points" | "flatline" | "too_short";

export interface TrendStats {
  /** Theil–Sen slope per week × 26, on the 0–1 percentile scale. */
  delta26w: number;
  tau: number;
  p: number;
  label: MomentumTrend;
  /**
   * The weekly values as drawn: an outlier week beyond the p5/p95 bounds is pulled in to the bound and
   * marked for a ^ caret; every other week is its measured median.
   */
  plotted: { value: number; clipped: boolean }[];
}

/** A point as read: `pct` on 0–1, `raw` as Qloo sent it (0–1, or 0–100), which the scale-break guard reads. */
export interface ReadPoint extends DatedValue {
  raw: number;
}

export interface SeriesAnalysis {
  /** Valid points inside the window that the analysis reads: after a scale break, the latest segment's. */
  rawPoints: number;
  /** Distinct percentile values among them: the flatline guard reads this. */
  distinctValues: number;
  /** ISO-week medians, oldest first; after a scale break only the latest segment. */
  weeks: DatedValue[];
  scaleBreak: boolean;
  /** Null when the series has a trend. */
  noSignal: NoSignalCause | null;
  trend: TrendStats | null;
}

function isoDate(value: string): string | null {
  const m = ISO_DATE.exec(value.trim());
  if (m === null) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  return Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? null : date;
}

/**
 * Points inside the window, oldest first (Qloo sends them newest first). A percentile above 1 is on
 * the 0–100 scale and is divided by 100, point by point (SPEC S4; G11 saw 0–1), so a mixed-scale
 * series never shrinks its 0–1 part. Points without a valid date or with a percentile outside 0–100
 * are skipped. The rank is not read: the percentile carries the series.
 */
export function readPoints(points: readonly QlooTrendingPoint[], window: TrendWindow): ReadPoint[] {
  return points
    .flatMap((p) => {
      const date = isoDate(p.date);
      const raw = p.population_percentile;
      if (date === null || !Number.isFinite(raw) || raw < 0 || raw > 100 || date < window.start || date > window.end) return [];
      return [{ date, pct: raw > 1 ? raw / 100 : raw, raw }];
    })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** The Monday that starts the ISO week of a YYYY-MM-DD date. */
export function isoWeekStart(date: string): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  const weekday = new Date(ms).getUTCDay() || 7;
  return new Date(ms - (weekday - 1) * DAY_MS).toISOString().slice(0, 10);
}

/** ISO-week medians of points in date order, each dated by its week's Monday. */
export function resampleWeekly(points: readonly DatedValue[]): DatedValue[] {
  const weeks = new Map<string, { date: string; values: number[] }>();
  for (const p of points) {
    const key = isoWeekKey(p.date);
    const week = weeks.get(key);
    if (week === undefined) weeks.set(key, { date: isoWeekStart(p.date), values: [p.pct] });
    else week.values.push(p.pct);
  }
  return [...weeks.values()].map((w) => ({ date: w.date, pct: median(w.values)! }));
}

function ratio(a: number, b: number): number {
  return Math.max(a, b) / Math.min(a, b);
}

/**
 * Where the kept segment starts, read on the raw percentiles in date order: the latest step that
 * changes scale (one side above 1, the other at or below it), jumps by more than 5×, and whose raw
 * medians on either side differ by more than 5× too, so a single stray point is never a break. On
 * one scale a 5× move is a real move (a low-percentile breakout), never a break. Non-positive values
 * cannot form a ratio and never start one. 0 when there is no break.
 */
export function scaleBreakStart(raw: readonly number[]): number {
  let start = 0;
  for (let k = 1; k < raw.length; k++) {
    const a = raw[k - 1]!;
    const b = raw[k]!;
    if (a <= 0 || b <= 0 || (a > 1) === (b > 1) || ratio(a, b) <= SCALE_BREAK_RATIO) continue;
    const before = median(raw.slice(start, k));
    const after = median(raw.slice(k));
    if (before !== null && after !== null && before > 0 && after > 0 && ratio(before, after) > SCALE_BREAK_RATIO) start = k;
  }
  return start;
}

/** Rising, Declining or Flat from Δ and the Mann–Kendall p (FORMULAS mom.label). */
export function momentumLabel(delta26w: number, p: number): MomentumTrend {
  if (p < LABEL_MAX_P && delta26w >= LABEL_MIN_DELTA - EPS) return "rising";
  if (p < LABEL_MAX_P && delta26w <= -LABEL_MIN_DELTA + EPS) return "declining";
  return "flat";
}

/**
 * The weekly values for the strip: a week whose robust z exceeds 3.5 and that lies outside the
 * p5/p95 bounds is pulled in to the bound and gets a caret. Every other week keeps its measured
 * median, so a clean series draws no carets, even at its lowest and highest weeks.
 */
export function plottedWeeks(values: readonly number[]): TrendStats["plotted"] {
  const w = winsorize(values);
  const z = madZ(values);
  return values.map((value, i) =>
    Math.abs(z[i] ?? 0) > OUTLIER_MAD_Z && w.clipped[i] === true ? { value: w.values[i]!, clipped: true } : { value, clipped: false },
  );
}

/**
 * Theil–Sen Δpct_26w over weeks since the first week (gaps keep their real spacing), Mann–Kendall
 * on the weekly medians, and the values for the strip. Null for a constant series, where the test
 * is undefined: that is a flatline, never Flat.
 */
export function trendOf(weeks: readonly DatedValue[]): TrendStats | null {
  const first = weeks[0];
  if (first === undefined) return null;
  const origin = Date.parse(`${first.date}T00:00:00Z`);
  const x = weeks.map((w) => Math.round((Date.parse(`${w.date}T00:00:00Z`) - origin) / WEEK_MS));
  const y = weeks.map((w) => w.pct);
  const fit = theilSen(x, y);
  const mk = mannKendall(y);
  if (fit === null || mk === null) return null;
  const delta26w = fit.slope * DELTA_WEEKS;
  return { delta26w, tau: mk.tau, p: mk.p, label: momentumLabel(delta26w, mk.p), plotted: plottedWeeks(y) };
}

/** The whole S4 pipeline for one entity's trending response. */
export function analyseSeries(points: readonly QlooTrendingPoint[], window: TrendWindow = TRENDING_WINDOW): SeriesAnalysis {
  const all = readPoints(points, window);
  const start = scaleBreakStart(all.map((p) => p.raw));
  const read = all.slice(start);
  const distinctValues = new Set(read.map((p) => p.pct)).size;
  const weeks = resampleWeekly(read);
  const base = { rawPoints: read.length, distinctValues, weeks, scaleBreak: start > 0 };
  if (read.length === 0) return { ...base, noSignal: "no_points", trend: null };
  if (distinctValues < FLATLINE_MIN_DISTINCT) return { ...base, noSignal: "flatline", trend: null };
  if (weeks.length < MIN_WEEKS) return { ...base, noSignal: "too_short", trend: null };
  const trend = trendOf(weeks);
  return trend === null ? { ...base, noSignal: "flatline", trend: null } : { ...base, noSignal: null, trend };
}
