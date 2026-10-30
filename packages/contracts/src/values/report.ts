/**
 * Zod-free report values (PLAN §6, §7): report limits, the verdict-tag rule, the confidence tables, the fixed
 * disclaimers and the context-block headings. ../report.ts builds the schemas from these.
 */

// submit_report limits (PLAN §7, SPEC §7.1) ----------------------------------------------------------

export const REPORT_LIMITS = {
  headline: 120,
  thesis: 600,
  part: 400,
  note: 300,
  argumentsMin: 3,
  argumentsMax: 5,
  hypothesisVerdictsMax: 4,
  bearCaseMax: 3,
  nextMovesMin: 2,
  nextMovesMax: 4,
  recommendationsMax: 5,
  exhibitsMax: 10,
  openQuestionsMax: 5,
} as const;

/** The verdict tag (Report.verdict.tag): two to five words, at most 32 characters, no digits or tokens (CHECKER V9). */
export const VERDICT_TAG_LIMITS = { wordsMin: 2, wordsMax: 5, chars: 32 } as const;

/** The words of a verdict tag: runs of non-space characters. */
export function verdictTagWords(tag: string): string[] {
  return tag.split(/\s+/).filter((w) => w !== "");
}

/**
 * How a verdict tag breaks its rule, one predicate per problem ("has 7 words, not 2 to 5"); empty when
 * it keeps it. Surrounding spaces do not count.
 */
export function verdictTagProblems(tag: string): string[] {
  const L = VERDICT_TAG_LIMITS;
  const trimmed = tag.trim();
  if (trimmed === "") return ["is empty"];
  const out: string[] = [];
  const words = verdictTagWords(trimmed).length;
  if (words < L.wordsMin || words > L.wordsMax) {
    out.push(`has ${words} ${words === 1 ? "word" : "words"}, not ${L.wordsMin} to ${L.wordsMax}`);
  }
  if (trimmed.length > L.chars) out.push(`has ${trimmed.length} characters, more than ${L.chars}`);
  if (/\d/.test(trimmed)) out.push("contains digits");
  // {{WINDOW}} has no digits; a list row or the running head would print any token raw.
  if (/[{}[\]]/.test(trimmed)) out.push("contains tokens");
  return out;
}

/** True when the tag keeps its rule, so a list row or the running head may print it. */
export function isVerdictTag(tag: unknown): tag is string {
  return typeof tag === "string" && verdictTagProblems(tag).length === 0;
}

// GHOST (§6.6) --------------------------------------------------------------------------------------

export const GHOST_PICK_CATEGORY_VALUES = ["competitors", "markets", "neighbourhoods", "tenants", "partners", "creators"] as const;

export const GHOST_HONESTY_LINE = "Agreement is measured against Qloo's taste graph, not outcomes.";

// CHECKER (§6.2) ----------------------------------------------------------------------------------------

/**
 * V11 (Part 9): every SEC, Census or OpenStreetMap metric appears with its period token, and no prose links
 * a financial figure to a taste metric causally. V12 (Part 11, R2/R7): concept and area honesty (no proxy
 * metric cited, no winner from a category-level read, no hidden pocket called the best, no confirmed or
 * refuted hypothesis without a real test). V13 (Part 11): an about-level difference never leads the answer.
 */
export const VALIDATION_RULE_VALUES = ["V1", "V2", "V3", "V4", "V5", "V6", "V7", "V8", "V9", "V10", "V11", "V12", "V13"] as const;

// Confidence (§6.4, R1, D47) ------------------------------------------------------------------------------

export const CONFIDENCE_RULE_VALUES = [
  "dropped_entity",
  "code_fallback",
  "coarse_geohash",
  "stale_momentum",
  "thin_result",
  "quality_gate_drop",
  "checker_warning",
  "insufficient_evidence",
  "read_as_nearest_job",
  "concept_partly_tagged",
  "signal_mixed",
  "signal_weak",
  "thin_sample",
  "category_level",
] as const;
type ConfidenceRuleV = (typeof CONFIDENCE_RULE_VALUES)[number];
type ConfidenceBandV = "HIGH" | "MED" | "LOW";

/**
 * Points subtracted from 100 per occurrence (coarse_geohash, stale_momentum, insufficient_evidence,
 * read_as_nearest_job and concept_partly_tagged count once). insufficient_evidence alone puts a note in the
 * LOW band: V7 left no reading to trust. The cap rules (CONFIDENCE_CAP) subtract nothing: they bound the
 * score instead.
 */
export const CONFIDENCE_PENALTY: Readonly<Record<ConfidenceRuleV, number>> = {
  dropped_entity: 15,
  code_fallback: 10,
  coarse_geohash: 10,
  stale_momentum: 20,
  thin_result: 10,
  quality_gate_drop: 5,
  checker_warning: 5,
  insufficient_evidence: 60,
  read_as_nearest_job: 5,
  concept_partly_tagged: 0,
  signal_mixed: 0,
  signal_weak: 0,
  thin_sample: 0,
  category_level: 0,
};

/**
 * Score ceilings (R1, D47): a rule here caps the score instead of (or as well as) subtracting points. The
 * score is min(100 − penalties, the lowest fired cap), so confidence follows the strength of the signal
 * and of the sample behind the headline:
 * - signal_mixed 70: a mixed signal is never HIGH;
 * - signal_weak 45: a weak signal is LOW;
 * - thin_sample 70: the headline rests on a thin sample (Metric.thin), never HIGH;
 * - category_level 60: the concept was read only at category level (R2);
 * - concept_partly_tagged 70 (D2 of the Part 9 close-out): part of the concept was never tested.
 */
export const CONFIDENCE_CAP: Readonly<Partial<Record<ConfidenceRuleV, number>>> = {
  signal_mixed: 70,
  signal_weak: 45,
  thin_sample: 70,
  category_level: 60,
  concept_partly_tagged: 70,
};

export function confidenceBand(score: number): ConfidenceBandV {
  if (score >= 75) return "HIGH";
  if (score >= 50) return "MED";
  return "LOW";
}

// Fixed text (§6.3) ---------------------------------------------------------------------------------------

export const FIXED_DISCLAIMERS = [
  "Analytics, not financial advice.",
  "Aggregated group-level taste signals; no individual-level inference.",
  "Affinity ≠ sales, share or causation.",
] as const;

/**
 * Source lines for public data (PLAN §6), added to the disclaimers only when the note used that source.
 * `period` names the fiscal periods shown (e.g. "FY2022 to FY2024 and the latest quarter"); `vintage`
 * the ACS release (e.g. "2019-2023"); `asOf` the OpenStreetMap data date (YYYY-MM-DD).
 */
export function secDisclaimer(period: string): string {
  return `Financial figures: SEC EDGAR filings as reported, ${period}.`;
}
export function censusDisclaimer(vintage: string): string {
  return `Area figures: US Census ACS 5-year estimates, ${vintage}.`;
}
export function osmDisclaimer(asOf: string | null): string {
  const date = asOf === null ? "" : `, data as of ${asOf.slice(0, 10)}`;
  return `Place counts: OpenStreetMap via the Overpass API, © OpenStreetMap contributors (ODbL)${date}; counts are a floor.`;
}

/** The data line closing every disclaimer list; `window` is shown only when the note used trending. */
export function dataDisclaimer(fetchedAt: string, window: { start: string; end: string } | null): string {
  const w = window ? `; trending window ${window.start}..${window.end}` : "";
  return `Data: Qloo hackathon dataset, fetched ${fetchedAt}${w}.`;
}

// Context blocks (R4, R5, D45) -----------------------------------------------------------------------------

/** What an item of "What AI knows (not verified)" is about. */
export const AI_CONTEXT_KIND_VALUES = ["deal", "footprint", "operator", "risk", "context"] as const;
export const AI_CONTEXT_KIND_LABEL = {
  deal: "Deals and ownership",
  footprint: "Where it already operates",
  operator: "Local operators",
  risk: "Brand-safety risks",
  context: "Context",
} as const satisfies Record<(typeof AI_CONTEXT_KIND_VALUES)[number], string>;

/**
 * How a context block settled: ok (at least one item), empty (nothing citable or well-known), off (turned
 * off on this server or in economy mode), timed_out, failed. The block's `note` says which in reader words.
 */
export const CONTEXT_STATUS_VALUES = ["ok", "empty", "off", "timed_out", "failed"] as const;

/** Item limits of the AI block: items, topic and text characters, presence markets. */
export const AI_CONTEXT_LIMITS = { items: 8, topic: 60, text: 240, presence: 12 } as const;
/** Item limits of the web block: items, claim, title and cited-text characters. */
export const WEB_CONTEXT_LIMITS = { items: 6, claim: 280, title: 160, citedText: 160 } as const;

export const AI_CONTEXT_HEADING = "What AI knows (not verified)";
export const AI_CONTEXT_CAPTION =
  "From the AI model's own knowledge, which can be out of date or wrong. Not measured and not checked by Culture Terminal. It never changes the measured answer above.";
export const WEB_CONTEXT_HEADING = "From the web";
export const WEB_CONTEXT_CAPTION =
  "Found by a web search when this answer was made. Not checked by Culture Terminal: read the source. It never changes the measured answer above.";
/** The chip on a market row the AI block reports the subject already operates in (R4). Ranking is unchanged. */
export const PRESENCE_CHIP_LABEL = "Already there (AI knowledge, not verified)";
