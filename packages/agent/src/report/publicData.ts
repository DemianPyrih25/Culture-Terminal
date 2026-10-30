import {
  censusDisclaimer,
  osmDisclaimer,
  secDisclaimer,
  type EvidenceSource,
  type Job,
  type Limitation,
  type Metric,
  type PublicSource,
} from "@ct/contracts";
import type { LedgerLookup } from "../ledger";
import { wordList } from "./format";

/**
 * Public data in the note (PLAN §5.2, §6; D40, D41): which metrics come from SEC EDGAR or US Census
 * evidence, the source lines and disclaimers those sources add, and the "Read as" limitation of a
 * question answered as its nearest job. SEC and Census figures sit beside the taste read: they never
 * count towards V7's ok Qloo bundles and carry their period or vintage (V11).
 */

/** An evidence bundle's source; bundles stored before Part 9 carry none and are Qloo's. */
export const evidenceSource = (e: { source?: EvidenceSource }): EvidenceSource => e.source ?? "qloo";

/** True for a bundle of Qloo calls: the only kind V7 counts and the Qloo data line dates. */
export const isQlooEvidence = (e: { source?: EvidenceSource }): boolean => evidenceSource(e) === "qloo";

/** The public source a metric's evidence comes from (SEC or Census), or null for a Qloo metric. */
export function metricPublicSource(metric: Pick<Metric, "evidenceIds">, ledger: Pick<LedgerLookup, "evidence">): PublicSource | null {
  for (const id of metric.evidenceIds) {
    const source = evidenceSource(ledger.evidence(id) ?? {});
    if (source !== "qloo") return source;
  }
  return null;
}

/** What each public source is called in a reader's words. */
export const PUBLIC_FIGURES: Readonly<Record<PublicSource, string>> = {
  sec: "SEC EDGAR financial figure",
  census: "US Census area figure",
  osm: "OpenStreetMap place count",
};

/** The leading label of a period ("FY2024" of "FY2024, 10-K filed 2025-02-14"). */
const periodHead = (period: string): string => period.split(",")[0]?.trim() ?? period.trim();

/** Distinct values in first-seen order. */
const distinct = (xs: readonly string[]): string[] => [...new Set(xs.filter((x) => x !== ""))];

/** "FY2022 to FY2024" for several periods, "FY2024 and Q2 FY2025" for two, the one for one. */
function span(periods: readonly string[]): string {
  if (periods.length <= 2) return periods.join(" and ");
  return `${periods[0]} to ${periods[periods.length - 1]}`;
}

/**
 * The public-data disclaimers of a note (PLAN §6), one per source its metrics come from: the SEC line
 * names the periods shown, the Census line the ACS release, the OpenStreetMap line its attribution and the
 * latest data date ("OpenStreetMap data as of 2026-10-01"). A source with no metric adds nothing.
 */
export function publicDisclaimers(metrics: readonly Metric[], ledger: Pick<LedgerLookup, "evidence">): string[] {
  const of = (source: PublicSource) =>
    metrics.filter((m) => m.value !== null && metricPublicSource(m, ledger) === source).flatMap((m) => (m.period ? [m.period] : []));
  const out: string[] = [];
  const sec = of("sec");
  if (sec.length > 0) out.push(secDisclaimer(span(distinct(sec.map(periodHead)))));
  const census = of("census");
  if (census.length > 0) {
    const vintages = distinct(census.flatMap((p) => p.match(/\b\d{4}-\d{4}\b/g) ?? []));
    out.push(censusDisclaimer(vintages.length > 0 ? vintages.join(" and ") : distinct(census.map(periodHead)).join(" and ")));
  }
  const osm = of("osm");
  if (osm.length > 0) {
    const dates = distinct(osm.flatMap((p) => p.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [])).sort();
    out.push(osmDisclaimer(dates.at(-1) ?? null));
  }
  return out;
}

/** How many "not covered" items a limitation names, and how long each may be: CLERK writes them, the reader sees them. */
const NOT_COVERED_MAX = 5;
const NOT_COVERED_CHARS = 40;

/** CLERK's not_covered items as a reader sees them: one line each, short, without repeats. */
export function notCoveredItems(items: readonly string[]): string[] {
  const clean = items.map((s) =>
    s
      .replace(/[\u0000-\u001f\u007f<>]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, NOT_COVERED_CHARS)
      .trim(),
  );
  const seen = new Set<string>();
  return clean.filter((s) => s !== "" && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase())).slice(0, NOT_COVERED_MAX);
}

/**
 * The READ_AS_NEAREST_JOB limitation (D41, PLAN §6): the job the question was read as, and what it
 * asks that the data does not cover, in plain words.
 */
export function readAsLimitation(job: Job, notCovered: readonly string[]): Limitation {
  const items = notCoveredItems(notCovered);
  const named = job.replace(/_/g, " ");
  const gap =
    items.length === 0
      ? "part of what it asks is outside what taste data can measure"
      : `the data does not cover ${wordList(items)}`;
  return {
    source: "flag",
    flag: "READ_AS_NEAREST_JOB",
    text: `Read as ${named}: ${gap}, so the note answers the nearest question the data can measure.`,
  };
}
