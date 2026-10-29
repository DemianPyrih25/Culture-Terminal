import { SEC_REVENUE_CONCEPTS, type SecConcept, type SecFactPoint } from "@ct/contracts";

/**
 * Company financials arithmetic (SPEC S13, FORMULAS fin.revenue, fin.margin, fin.yoy): reported
 * periods from SEC company facts, restatements resolved to the latest filing, margins over the same
 * period, and change against the period a year earlier. Pure and deterministic.
 */

/** Fiscal years shown. */
export const FISCAL_YEARS = 3;
/** Quarters shown at most: those ending after the latest fiscal year. */
export const MAX_QUARTERS = 3;
/** A year-earlier period ends 365 days before, give or take this (52/53-week years). */
const YEAR_TOLERANCE_DAYS = 20;
const DAY_MS = 86_400_000;

/** For one concept and period (start, end), only the latest-filed value: a restatement replaces the original. */
export function latestFiled(points: readonly SecFactPoint[]): SecFactPoint[] {
  const best = new Map<string, SecFactPoint>();
  for (const p of points) {
    const key = `${p.concept}|${p.start ?? ""}|${p.end}`;
    const known = best.get(key);
    if (known === undefined || p.filed > known.filed || (p.filed === known.filed && p.accession > known.accession)) best.set(key, p);
  }
  return [...best.values()];
}

export interface ReportedPeriod {
  span: "annual" | "quarterly";
  start: string | null;
  end: string;
  /** The revenue line used, the first of SEC_REVENUE_CONCEPTS reported for the period. */
  revenueConcept: SecConcept;
  revenue: SecFactPoint;
  grossProfit: SecFactPoint | null;
  operatingIncome: SecFactPoint | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  /** Revenue change against the period a year earlier; null when that period is not reported. */
  yoy: number | null;
  /** The year-earlier period's revenue point, when there is one. */
  prior: SecFactPoint | null;
}

const periodKey = (p: Pick<SecFactPoint, "start" | "end">): string => `${p.start ?? ""}|${p.end}`;
const days = (a: string, b: string): number => (Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS;

function isYearEarlier(earlier: string, later: string): boolean {
  return Math.abs(days(later, earlier) - 365) <= YEAR_TOLERANCE_DAYS;
}

/** One span's periods, newest first, each with revenue, margins and year-on-year change. */
function periodsOf(points: readonly SecFactPoint[], span: "annual" | "quarterly"): ReportedPeriod[] {
  const own = points.filter((p) => p.span === span && p.unit === "USD" && (span === "annual" ? p.form.startsWith("10-K") : true));
  const byPeriod = new Map<string, SecFactPoint[]>();
  for (const p of own) byPeriod.set(periodKey(p), [...(byPeriod.get(periodKey(p)) ?? []), p]);
  const out: Omit<ReportedPeriod, "yoy" | "prior">[] = [];
  for (const pts of byPeriod.values()) {
    const revenue = SEC_REVENUE_CONCEPTS.map((c) => pts.find((p) => p.concept === c)).find((p) => p !== undefined);
    if (revenue === undefined) continue;
    const grossProfit = pts.find((p) => p.concept === "GrossProfit") ?? null;
    const operatingIncome = pts.find((p) => p.concept === "OperatingIncomeLoss") ?? null;
    const ratio = (x: SecFactPoint | null): number | null => (x === null || revenue.value === 0 ? null : x.value / revenue.value);
    out.push({
      span,
      start: revenue.start,
      end: revenue.end,
      revenueConcept: revenue.concept,
      revenue,
      grossProfit,
      operatingIncome,
      grossMargin: ratio(grossProfit),
      operatingMargin: ratio(operatingIncome),
    });
  }
  out.sort((a, b) => (a.end < b.end ? 1 : a.end > b.end ? -1 : 0));
  return out.map((p) => {
    const prior = out.find((q) => isYearEarlier(q.end, p.end))?.revenue ?? null;
    const yoy = prior === null || prior.value === 0 ? null : p.revenue.value / prior.value - 1;
    return { ...p, prior, yoy };
  });
}

export interface Financials {
  /** The latest FISCAL_YEARS fiscal years, newest first. */
  years: ReportedPeriod[];
  /** Quarters ending after the latest fiscal year (at most MAX_QUARTERS), newest first. */
  quarters: ReportedPeriod[];
}

export function financialsOf(points: readonly SecFactPoint[]): Financials {
  const resolved = latestFiled(points);
  const years = periodsOf(resolved, "annual").slice(0, FISCAL_YEARS);
  const latestYearEnd = years[0]?.end ?? "";
  const quarters = periodsOf(resolved, "quarterly")
    .filter((q) => q.end > latestYearEnd)
    .slice(0, MAX_QUARTERS);
  return { years, quarters };
}

/** "fiscal year ended 2024-12-31" or "quarter ended 2025-03-29". */
export function periodName(p: Pick<ReportedPeriod, "span" | "end">): string {
  return `${p.span === "annual" ? "fiscal year" : "quarter"} ended ${p.end}`;
}

/** The {{PERIOD}} text of a figure: the period, the form and the filing date. */
export function periodText(p: Pick<ReportedPeriod, "span" | "end">, filing: Pick<SecFactPoint, "form" | "filed">): string {
  return `${periodName(p)} (${filing.form} filed ${filing.filed})`;
}

/** "$1.23B", "$456.7M", "$12,300": a reported dollar amount for a reader. */
export function usd(value: number): string {
  const sign = value < 0 ? "−" : "";
  const v = Math.abs(value);
  if (v >= 1e9) return `${sign}$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${sign}$${(v / 1e6).toFixed(1)}M`;
  return `${sign}$${Math.round(v).toLocaleString("en-US")}`;
}

/** "42.3%", "−1.5%". */
export function percent(share: number, signed = false): string {
  const p = (share * 100).toFixed(1);
  if (!signed) return `${share < 0 ? "−" : ""}${p.replace("-", "")}%`;
  return share > 0 ? `+${p}%` : share < 0 ? `−${p.replace("-", "")}%` : "0.0%";
}
