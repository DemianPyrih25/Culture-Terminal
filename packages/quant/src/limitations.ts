import {
  Flag,
  PUBLIC_NOT_CONFIGURED_REASON,
  SEVERITY_RANK,
  type Limitation,
  type Pillar,
  type Severity,
  type SkillId,
  type TrendWindow,
} from "@ct/contracts";
import { windowAgeMonths } from "./badges";

/**
 * Limitations (SPEC §6.3): code-written sentences on what a note does not establish. The order is
 * fixed: data-quality flags (deduplicated, most severe first), then the desk's fixed bullets, then
 * the fixed bullets of the skills that ran, then the model's open questions. All copy is plain,
 * group-level and never advice.
 */

// Sentences shared by several lists, so buildLimitations shows each of them once.
const DEMOGRAPHIC_INDICES =
  "Age and gender figures are relative affinity indices, not population shares, and gender is binary in the source.";
const TASTE_SIMILARITY = "Peer similarity is audience taste similarity, not switching, share or sales.";
const VENUE_GOERS = "Taste signals reflect venue-goers in Qloo's data, not residents, census counts or footfall.";
const RELATIVE_WITHIN_METRO =
  "Lift and Block DNA are relative within one metro, against the named baseline or the whole city.";
const TENANT_FIT =
  "Taste fit for a commercial concept; not credit, rent capacity, sales, or any decision about a business owner or resident.";
const SPONSOR_FIT = "Sponsor fit is taste fit only; Qloo has no fee, availability, exclusivity or ROI data.";
const LOCALITY_SIGNAL = "A metro context is Qloo's locality signal for that metro, not residence, sales or ticket demand.";
const EXPLAINABILITY = "Explainability shows attribution inside Qloo's model, not causation.";
const TRAVEL_TASTE =
  "Travel taste shows places this audience's taste points to, not residence, trips taken or ticket demand.";
const COMPANY_LEVEL =
  "Company-level reported figures from SEC filings; one brand may be a small part of a company, a change in revenue can come from acquisitions or other brands, and none of this is advice.";
// The CENSUS_RESIDENTS_ONLY flag sentence: area_economics always raises the flag, so its bullet is the same sentence, shown once.
const RESIDENTS_ONLY =
  "Area figures are US Census survey estimates about the people who live there, not visitors, customers, foot traffic or spending.";

/** One honest sentence per data-quality flag. TRENDING_HISTORICAL_WINDOW gains its window through flagText. */
export const FLAG_TEXT: Readonly<Record<Flag, string>> = {
  TRENDING_HISTORICAL_WINDOW:
    "Momentum comes from Qloo trending over one fixed historical window, so it describes that period, not current demand.",
  NO_TREND_SIGNAL:
    "Some entities have no usable trend in Qloo's trending window; no signal means the trend is unknown, not flat.",
  CANDIDATES_UNSCORED:
    "Some requested entities have no score in at least one context; they are shown as not measured, never as a low rank.",
  COARSE_GEOHASH:
    "Part of the heatmap came back on a coarse grid, so neighbourhood lift there is low-confidence or not claimed.",
  LOCATION_FALLBACK:
    "A neighbourhood boundary could not be used, so the area was read from its centre point or a place-name search, a less precise reading.",
  DEMOGRAPHICS_ARE_INDICES: DEMOGRAPHIC_INDICES,
  SUPPLY_SAMPLE_ONLY: "Supply counts a capped sample of venues Qloo indexes, not every business in the area.",
  SUPPLY_UNAVAILABLE:
    "Similar venues could not be counted area by area (no verified venue category for the place type, or a venue sample that came back empty or too thin), so the number of competitors is unknown, not zero.",
  STALE_CACHE:
    "Some Qloo responses were served from an older cached copy because a fresh call failed; their fetch times show their real age.",
  BUDGET_TRUNCATED:
    "The run reached its Qloo call budget, so some planned calls were not made and those values are missing.",
  SECONDARY_ENTITY_DROPPED:
    "Some named entities had no exact match in Qloo's hackathon dataset and were left out; close candidates were never substituted.",
  QUALITY_GATE_DROPPED: "Results with near-zero popularity were dropped as likely data artifacts before ranking.",
  SENSITIVE_SEGMENT_BLOCKED:
    "Audience segments about communities, politics, beliefs or global issues are blocked by policy, so none were used.",
  INCOMPLETE_RUN:
    "The analysis did not finish, so this note is an evidence digest assembled by code, without a full written read.",
  DROPPED_CANDIDATES:
    "Qloo did not return some requested entities in some contexts; they are shown as not scored there, not ranked last.",
  NOT_SCORED:
    "Entities tied at a context's floor score show no measurable relationship to that signal, so they are not scored there, never ranked.",
  THIN_RESULT: "Some calls returned fewer than five results, so rankings from them rest on very few items.",
  READ_AS_NEAREST_JOB:
    "The question was read as the closest kind of question Culture Terminal answers, so the parts it does not cover (such as sales, prices, rents or foot traffic) are not answered here.",
  NOT_A_LISTED_COMPANY:
    "The brand is not mapped to a US-listed company (it may be private or not in our list), so no financial figures are shown and none are guessed.",
  CENSUS_RESIDENTS_ONLY: RESIDENTS_ONLY,
  SEC_NOT_CONFIGURED: `${PUBLIC_NOT_CONFIGURED_REASON.sec}, so no reported financials are shown.`,
  CENSUS_NOT_CONFIGURED: `${PUBLIC_NOT_CONFIGURED_REASON.census}, so no Census area figures are shown.`,
  CONCEPT_NOT_IN_DATA:
    "The exact product or concept asked about is not in the data, so it was tested at category level or not at all.",
  EXPECTED_CANDIDATE_MISSING:
    "Some names a specialist would expect to see had no exact match in Qloo's data, so they are not in the comparison; nothing was put in their place.",
  CATEGORY_LEVEL_READ:
    "The concept itself is not in Qloo's data, so this answer reads only its broader category; it gives no winner, keep or veto for the concept itself.",
  PROXY_TAG_IGNORED:
    "A look-alike tag that only resembles the concept was found but not used as evidence, because it would stand in for something the data does not hold.",
  SUBJECT_NO_DATA:
    "Qloo returned no data for the subject of the question, so there is no measured taste reading for it; no look-alike was used in its place.",
  OSM_NOT_CONFIGURED: `${PUBLIC_NOT_CONFIGURED_REASON.osm}, so no counts of nearby places are shown.`,
  OSM_SUPPLY_FLOOR: "OpenStreetMap is mapped by volunteers: counts are a floor, not a census.",
  NOT_SEPARATELY_REPORTED:
    "The brand is part of a larger listed company that does not report it separately, so no company figures are shown for it.",
};

/**
 * Ordering weight per flag: high when the note is missing what was asked for, medium when a reading
 * is weaker or narrower than it looks, low for standing caveats on how a number reads, info for policy.
 */
export const FLAG_SEVERITY: Readonly<Record<Flag, Severity>> = {
  INCOMPLETE_RUN: "high",
  BUDGET_TRUNCATED: "high",
  SECONDARY_ENTITY_DROPPED: "high",
  SUPPLY_UNAVAILABLE: "high",
  TRENDING_HISTORICAL_WINDOW: "medium",
  NO_TREND_SIGNAL: "medium",
  COARSE_GEOHASH: "medium",
  LOCATION_FALLBACK: "medium",
  STALE_CACHE: "medium",
  DROPPED_CANDIDATES: "medium",
  THIN_RESULT: "medium",
  CANDIDATES_UNSCORED: "medium",
  NOT_SCORED: "low",
  QUALITY_GATE_DROPPED: "low",
  DEMOGRAPHICS_ARE_INDICES: "low",
  SUPPLY_SAMPLE_ONLY: "low",
  SENSITIVE_SEGMENT_BLOCKED: "info",
  READ_AS_NEAREST_JOB: "high",
  NOT_A_LISTED_COMPANY: "medium",
  CENSUS_RESIDENTS_ONLY: "low",
  SEC_NOT_CONFIGURED: "medium",
  CENSUS_NOT_CONFIGURED: "medium",
  CONCEPT_NOT_IN_DATA: "high",
  EXPECTED_CANDIDATE_MISSING: "medium",
  CATEGORY_LEVEL_READ: "high",
  PROXY_TAG_IGNORED: "medium",
  SUBJECT_NO_DATA: "high",
  OSM_NOT_CONFIGURED: "medium",
  OSM_SUPPLY_FLOOR: "low",
  NOT_SEPARATELY_REPORTED: "medium",
};

/**
 * Umbrella flags and the specific flags that make them redundant: CANDIDATES_UNSCORED says that some
 * candidate is unscored somewhere, which DROPPED_CANDIDATES and NOT_SCORED already say more precisely.
 */
const SUBSUMED_BY: Partial<Readonly<Record<Flag, readonly Flag[]>>> = {
  CANDIDATES_UNSCORED: ["DROPPED_CANDIDATES", "NOT_SCORED"],
};

/** Fixed per-desk bullets, shown after the flag sentences. */
export const DESK_LIMITATIONS: Readonly<Record<Pillar, readonly string[]>> = {
  investment: [
    "Taste signals describe audience affinity, not revenue, market share or valuation.",
    TASTE_SIMILARITY,
    "A snapshot of Qloo's taste graph at fetch time; it holds no prices, filings or sales data.",
  ],
  location: [VENUE_GOERS, RELATIVE_WITHIN_METRO, TENANT_FIT],
  marketing: [SPONSOR_FIT, LOCALITY_SIGNAL, "Under-the-radar means taste fit above popularity, not a lower price."],
  audience: [
    "Cultural neighbours are what this audience's taste points to in Qloo's graph, not purchases, attendance or listening data.",
    EXPLAINABILITY,
    TRAVEL_TASTE,
  ],
};

/**
 * Fixed method limitations per skill (SPEC §5.3): the single copy for Skill.limitations to return,
 * so a skill bullet that repeats a desk bullet is the same string. Flag-dependent sentences, such as
 * the trending window, come from FLAG_TEXT instead.
 */
export const SKILL_LIMITATIONS: Readonly<Record<SkillId, readonly string[]>> = {
  resolve_entities: ["Only exact name and type matches are used; close candidates are offered, never applied."],
  find_tags: ["Only taxonomy tags act as taste signals; descriptive tags serve as labels."],
  rank_candidates: [
    "Ranks hold within each call's candidate set and context only.",
    "A site or city context is Qloo's location signal for that area, not residence or sales.",
  ],
  peer_landscape: [
    TASTE_SIMILARITY,
    "Each row comes from a single seed, and scores are compressed, so ranks are read rather than raw scores.",
    "Entities without a score are shown as not measured.",
  ],
  share_of_taste: ["Within-call rank among this set only.", LOCALITY_SIGNAL],
  audience_dna: [DEMOGRAPHIC_INDICES, "Facet tags are qualitative descriptors from Qloo's entity tags, not survey answers."],
  momentum: ["Qloo trending covers brands and TV shows only; artists and people have no trend data."],
  destination_affinity: ["Only Qloo's top US destinations for this audience are compared.", TRAVEL_TASTE],
  geo_lift: [RELATIVE_WITHIN_METRO, "Supply counts a sample of venues Qloo indexes, not every business in the area."],
  block_dna: [
    "Affinities are compressed, so only rank differences against the city are shown.",
    VENUE_GOERS,
    TENANT_FIT,
    "Brands favoured in an area rank higher among its venue-goers than city-wide; that does not mean they are based or sold there. Universities and colleges that Qloo lists as brands are left out.",
  ],
  cross_domain: [
    EXPLAINABILITY,
    "Seed tags add taste context next to the seeds; they are not a genre filter.",
    "Each list is capped by popularity, so the most popular names are left out by design.",
  ],
  sponsor_slate: [SPONSOR_FIT, "No return on investment is estimated."],
  taste_twins: [
    VENUE_GOERS,
    "A twin is the most similar taste pattern among the areas checked, not every area of the city, and not a forecast of sales, rents or footfall.",
    "Music (SOUND) is not compared between areas.",
  ],
  concept_vector: [
    "A VETO means the concept's taste points elsewhere in Qloo's graph, not that the analog is a weak business.",
    "Each analog is compared with the concept's 50th result (its last, when fewer come back) inside one Qloo call; Qloo has no sales or pricing data.",
  ],
  company_financials: [COMPANY_LEVEL, "Reported figures sit beside the taste signals; neither explains the other."],
  local_supply: [
    "Counts come from OpenStreetMap, mapped by volunteers: they are a floor, not a census, and say nothing about sales, rents or foot traffic.",
    "An area is compared with its city (the county or counties around it), an approximate reference.",
  ],
  area_economics: [
    RESIDENTS_ONLY,
    "Area figures add up the Census units inside each area; medians are population-weighted averages of unit medians, so they are approximate.",
  ],
};

/** "start..end", the same window format as the data disclaimer. */
function windowLabel(window: TrendWindow): string {
  return `${window.start}..${window.end}`;
}

export interface FlagTextOptions {
  /** The trending window the note used. */
  window?: TrendWindow | null;
  /** When the note was made (ISO date or date-time); with a window it adds the window's age. */
  asOf?: string | null;
}

/** The limitation sentence for a flag; TRENDING_HISTORICAL_WINDOW names its window and age when given. */
export function flagText(flag: Flag, options: FlagTextOptions = {}): string {
  const { window, asOf } = options;
  if (flag !== "TRENDING_HISTORICAL_WINDOW" || !window) return FLAG_TEXT[flag];
  const months = asOf ? windowAgeMonths(window, asOf) : null;
  const age = months !== null && months >= 1 ? `, about ${months} month${months === 1 ? "" : "s"} before this note` : "";
  return `Momentum comes from Qloo trending for ${windowLabel(window)}${age}, so it describes that period, not current demand.`;
}

/** Distinct flags, umbrella flags dropped when a specific one is present, most severe first (ties in Flag order). */
export function orderFlags(flags: readonly Flag[]): Flag[] {
  const present = new Set(flags);
  return Flag.options.filter(
    (f) => present.has(f) && !(SUBSUMED_BY[f] ?? []).some((specific) => present.has(specific)),
  ).sort((a, b) => SEVERITY_RANK[FLAG_SEVERITY[b]] - SEVERITY_RANK[FLAG_SEVERITY[a]]);
}

/** Trims, collapses whitespace, capitalises and ends the text with punctuation. */
function asSentence(text: string): string {
  const t = text.trim().replace(/\s+/g, " ");
  if (t === "") return "";
  const capitalised = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.?!]$/.test(capitalised) ? capitalised : `${capitalised}.`;
}

/** The dedup key: case, spacing and closing punctuation do not make two limitations different. */
function dedupKey(text: string): string {
  return text.trim().replace(/\s+/g, " ").replace(/[.?!]+$/, "").toLowerCase();
}

/** Words too common to tell two limitations apart. Negations are not filler: they carry the meaning. */
const FILLER = new Set(
  "a an the is are be of or and to in on at for as by it its this that with from".split(" "),
);
const NEGATIONS = new Set(["not", "no", "never", "nor", "without"]);

function contentWords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w !== "" && !FILLER.has(w)));
}

/**
 * True when `candidate` says nothing that `shown` does not: every content word of it appears in
 * `shown`, and both carry the same negations, so "shown as measured" never hides behind "shown as
 * not measured". This catches a skill's own wording of a desk bullet, e.g. "Audience taste
 * similarity, not switching, share or sales." after the investment desk's longer sentence.
 */
function restates(candidate: ReadonlySet<string>, shown: ReadonlySet<string>): boolean {
  if (candidate.size === 0) return false;
  for (const w of candidate) if (!shown.has(w)) return false;
  for (const w of shown) if (NEGATIONS.has(w) && !candidate.has(w)) return false;
  return true;
}

export interface LimitationsInput {
  /** Flags raised anywhere in the run; repeats are fine. */
  flags: readonly Flag[];
  pillar: Pillar;
  /** The model's open_questions from submit_report. */
  openQuestions: readonly string[];
  /** Sentences from Skill.limitations of the skills that ran; shown after the desk bullets. */
  skillLimitations?: readonly string[];
  /** The trending window, when the note used trending. */
  window?: TrendWindow | null;
  /** When the note was made (ISO date or date-time), for the trending window's age. */
  asOf?: string | null;
}

/**
 * The report's limitations: flag sentences (most severe first), the desk's bullets, the skills'
 * bullets, then the open questions. A sentence already shown is not repeated, whichever group it
 * comes from, and a desk or skill bullet that only restates a fixed sentence already shown is left
 * out too. Skill bullets count as desk bullets, the only other fixed source the contract has.
 */
export function buildLimitations(input: LimitationsInput): Limitation[] {
  const seen = new Set<string>();
  const fixedWords: Set<string>[] = [];
  const out: Limitation[] = [];
  const push = (limitation: Limitation): void => {
    const key = dedupKey(limitation.text);
    if (key === "" || seen.has(key)) return;
    if (limitation.source !== "open_question") {
      const words = contentWords(limitation.text);
      if (limitation.source === "desk" && fixedWords.some((shown) => restates(words, shown))) return;
      fixedWords.push(words);
    }
    seen.add(key);
    out.push(limitation);
  };
  const textOptions = { window: input.window ?? null, asOf: input.asOf ?? null };
  for (const flag of orderFlags(input.flags)) push({ source: "flag", flag, text: flagText(flag, textOptions) });
  for (const text of DESK_LIMITATIONS[input.pillar]) push({ source: "desk", flag: null, text });
  for (const text of input.skillLimitations ?? []) push({ source: "desk", flag: null, text: asSentence(text) });
  for (const text of input.openQuestions) push({ source: "open_question", flag: null, text: asSentence(text) });
  return out;
}
