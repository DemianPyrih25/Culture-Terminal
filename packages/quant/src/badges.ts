import { Badge, type Strength, type TrendWindow } from "@ct/contracts";

/**
 * Badges (D7) and per-metric confidence (SPEC §6.4).
 *
 * Seam file: metricConfidence is used by the skills workstream and is fixed for the parallel build;
 * the quant-policy workstream implements it and adds the badge helpers.
 */

/** Absorbs floating-point error when a computed confidence lands exactly on a pill threshold. */
const EPS = 1e-9;

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/**
 * m_badge in conf = m_badge·(1 − 1/√n), fixed by D7 (SPEC §0.1) as m = 1 / 1 / 0.6 / F / 0 for
 * MEASURED / DERIVED / ESTIMATED / STALE / UNAVAILABLE.
 * - MEASURED and DERIVED 1: a value Qloo returned and exact code arithmetic over such values are
 *   trusted alike; n carries how much data stands behind them.
 * - ESTIMATED 0.6: a fitted or modelled value that depends on modelling choices as well as the data.
 * - UNAVAILABLE 0: there is no value.
 * STALE has no fixed weight: its m is the freshness F of its trending window (see badgeWeight).
 */
export const BADGE_WEIGHT: Readonly<Record<Exclude<Badge, "STALE">, number>> = {
  MEASURED: 1,
  DERIVED: 1,
  ESTIMATED: 0.6,
  UNAVAILABLE: 0,
};

/** Months over which freshness falls by a factor of e (FORMULAS mom.freshness). */
export const FRESHNESS_SCALE_MONTHS = 12;

/**
 * F for a STALE metric whose caller passes no freshness: the value F reaches twelve months after the
 * window ends. The trending window is historical by design (D19), so an unknown age reads as old
 * rather than fresh.
 */
export const STALE_DEFAULT_FRESHNESS = Math.exp(-1);

const DATE_PREFIX = /^(\d{4})-(\d{2})-(\d{2})/;

/**
 * Whole calendar months from the end of `window` to `asOf` (ISO dates or date-times, read as
 * calendar dates), 0 when `asOf` is not after the end, null when either date does not parse. The
 * trending limitation states the same age, so its reader can recompute F.
 */
export function windowAgeMonths(window: TrendWindow, asOf: string): number | null {
  const a = DATE_PREFIX.exec(window.end);
  const b = DATE_PREFIX.exec(asOf);
  if (!a || !b) return null;
  const [ay, am, ad] = a.slice(1).map(Number) as [number, number, number];
  const [by, bm, bd] = b.slice(1).map(Number) as [number, number, number];
  return Math.max(0, (by - ay) * 12 + (bm - am) - (bd < ad ? 1 : 0));
}

/**
 * Momentum freshness F = exp(−m/12), m = whole months since the trending window ended (FORMULAS
 * mom.freshness): 1 at the window's end, about 0.37 a year later. Null when a date does not parse.
 */
export function freshness(window: TrendWindow, asOf: string): number | null {
  const months = windowAgeMonths(window, asOf);
  return months === null ? null : Math.exp(-months / FRESHNESS_SCALE_MONTHS);
}

/**
 * m for one badge. STALE takes `freshness` clamped to 0–1, or STALE_DEFAULT_FRESHNESS when none is
 * given; the other badges ignore it.
 */
export function badgeWeight(badge: Badge, freshness?: number | null): number {
  if (badge !== "STALE") return BADGE_WEIGHT[badge];
  return typeof freshness === "number" && Number.isFinite(freshness) ? clamp01(freshness) : STALE_DEFAULT_FRESHNESS;
}

/**
 * Per-metric confidence conf = m_badge·(1 − 1/√n), clamped to 0–1. Null when the badge is
 * UNAVAILABLE or n is null or below 1. `freshness` is F for a STALE metric (see freshness); other
 * badges ignore it.
 */
export function metricConfidence(badge: Badge, n: number | null, freshness?: number | null): number | null {
  if (badge === "UNAVAILABLE" || n === null || !Number.isFinite(n) || n < 1) return null;
  return clamp01(badgeWeight(badge, freshness) * (1 - 1 / Math.sqrt(n)));
}

/**
 * Lower bounds of the evidence-strength pills. A MEASURED or DERIVED metric is STRONG from n = 7 and
 * MODERATE from n = 3; an ESTIMATED one is MODERATE from n = 6 and never STRONG alone. A STALE
 * 26-week momentum series is STRONG up to three months after its window ends, MODERATE up to nine
 * months and THIN after that. Anything weaker is THIN.
 */
export const STRENGTH_THRESHOLD = { STRONG: 0.6, MODERATE: 0.35 } as const;

/** The pill for one confidence value; a missing confidence is THIN. */
export function evidenceStrength(conf: number | null): Strength {
  if (conf === null || !Number.isFinite(conf)) return "THIN";
  if (conf >= STRENGTH_THRESHOLD.STRONG - EPS) return "STRONG";
  if (conf >= STRENGTH_THRESHOLD.MODERATE - EPS) return "MODERATE";
  return "THIN";
}

/**
 * The pill for an argument from the confidences of the metrics it cites: their mean, so one weak
 * number pulls a strong one down and one strong number lifts weak ones. Metrics without a
 * confidence (UNAVAILABLE, or no n) are left out; an argument with none at all is THIN.
 */
export function argumentStrength(confs: readonly (number | null)[]): Strength {
  const known = confs.filter((c): c is number => c !== null && Number.isFinite(c));
  if (known.length === 0) return "THIN";
  return evidenceStrength(known.reduce((sum, c) => sum + c, 0) / known.length);
}

/**
 * How a metric's value came about.
 * - measured: Qloo returned it as is (popularity, a pair similarity, a demographic index).
 * - derived: exact code arithmetic over measured values (within-call percentile, youth tilt, lift).
 * - estimated: a fit or a model (a Theil–Sen residual, a MAD-z score, an area rollup).
 */
export type MetricOrigin = "measured" | "derived" | "estimated";

const ORIGIN_BADGE: Readonly<Record<MetricOrigin, Badge>> = {
  measured: "MEASURED",
  derived: "DERIVED",
  estimated: "ESTIMATED",
};

/**
 * The badge for one metric, picked the same way by every skill: no value is UNAVAILABLE (never 0),
 * a value from a historical window is STALE and must carry that window (CHECKER V8), and otherwise
 * the origin decides. A response served from an expired cache keeps its origin badge and raises
 * the STALE_CACHE flag instead, because STALE always means a trending window.
 */
export function pickBadge(args: { origin: MetricOrigin; value: number | null; window?: TrendWindow | null }): Badge {
  if (args.value === null || !Number.isFinite(args.value)) return "UNAVAILABLE";
  if (args.window) return "STALE";
  return ORIGIN_BADGE[args.origin];
}

/**
 * The badge of a value computed from other metrics: the latest input in Badge order decides
 * (MEASURED, DERIVED, ESTIMATED, STALE, UNAVAILABLE), and arithmetic over MEASURED inputs gives
 * DERIVED. STALE outranks ESTIMATED whatever its freshness, so a result built on trending data keeps
 * its window. No inputs, or any UNAVAILABLE input, gives UNAVAILABLE; drop unavailable inputs first
 * when the formula allows it.
 */
export function derivedBadge(inputs: readonly Badge[]): Badge {
  if (inputs.length === 0) return "UNAVAILABLE";
  const order = Badge.options;
  const weakest = inputs.reduce<Badge>((w, b) => (order.indexOf(b) > order.indexOf(w) ? b : w), "MEASURED");
  return weakest === "MEASURED" ? "DERIVED" : weakest;
}

/** The distinct badges among `badges`, in display order (MEASURED first), e.g. for an exhibit's chips. */
export function distinctBadges(badges: readonly Badge[]): Badge[] {
  const present = new Set(badges);
  return Badge.options.filter((b) => present.has(b));
}
