import {
  LocationMethod,
  METRO_LABEL,
  type FindingKind,
  type FindingSuggestion,
  type MetroId,
  type Severity,
  type SkillId,
} from "@ct/contracts";
import { spearman } from "./stats";
import { TASTE_ISLAND_LAST_SHARE, TASTE_ISLAND_MIN_ROWS } from "./subs";

/**
 * Finding detectors (PLAN §4.4): code rules whose results drive ANALYST turn 2. Detectors are pure
 * and return drafts; the skill that ran the analysis adds them to the ledger with its metric ids.
 *
 * Seam file: FindingDraft and the five SUBS/generic builders below are fixed for the parallel
 * build; the quant-policy workstream implements them and adds the detectors for the other kinds.
 *
 * Inputs are values QUANT already computed (ranks, percentiles, z-scores, names), never Qloo
 * payloads. Builders fire unconditionally because their rule ran upstream; detectors return null
 * when their rule does not fire.
 */

export interface FindingDraft {
  kind: FindingKind;
  severity: Severity;
  /** One plain sentence for the trace and the model; names, no Qloo ids, no raw affinities. */
  text: string;
  suggestion: FindingSuggestion | null;
}

/**
 * The follow-up tool per finding kind (PLAN §4.4), null where the table names no tool. METRO_OUTLIER
 * suggests geo_lift only for a gazetteer metro. EMPTY_RESULT has no fixed tool: the way to broaden
 * (a tag union, a dropped filter, another type, named peers) depends on the call, so
 * emptyResultFinding carries the caller's suggestion.
 */
export const FINDING_SUGGESTION: Readonly<Record<FindingKind, SkillId | null>> = {
  TASTE_ISLAND: "cross_domain",
  NEAR_SUBSTITUTES: "share_of_taste",
  OUTSIDE_CATEGORY_NEIGHBOUR: "peer_landscape",
  GENERATIONAL_SPLIT: null,
  METRO_OUTLIER: "geo_lift",
  HIDDEN_POCKET: null,
  LATENT_DEMAND: "block_dna",
  BLOCK_NEW_TAGS: "rank_candidates",
  EMPTY_RESULT: null,
  DROPPED_CANDIDATES: null,
  NO_TREND_SIGNAL: null,
  POPULARITY_DOMINANCE: "cross_domain",
  LOCATION_FALLBACK: null,
};

/**
 * Severity per kind: high when a call gave nothing to read, medium for a lead worth a follow-up,
 * low for context the note should mention. A METRO_OUTLIER outside the gazetteer is low, since no
 * follow-up can map it.
 */
export const FINDING_SEVERITY: Readonly<Record<FindingKind, Severity>> = {
  TASTE_ISLAND: "medium",
  NEAR_SUBSTITUTES: "medium",
  OUTSIDE_CATEGORY_NEIGHBOUR: "medium",
  GENERATIONAL_SPLIT: "medium",
  METRO_OUTLIER: "medium",
  HIDDEN_POCKET: "low",
  LATENT_DEMAND: "medium",
  BLOCK_NEW_TAGS: "medium",
  EMPTY_RESULT: "high",
  DROPPED_CANDIDATES: "low",
  NO_TREND_SIGNAL: "low",
  POPULARITY_DOMINANCE: "medium",
  LOCATION_FALLBACK: "low",
};

// Thresholds (SPEC §4.4) --------------------------------------------------------------------------

// TASTE_ISLAND reuses TASTE_ISLAND_LAST_SHARE and TASTE_ISLAND_MIN_ROWS from subs.ts, so the
// finding and the Substitution Map can never disagree on what a taste island is.
/** Youth tilt spans −1..1; a target 0.4 above the set median skews clearly younger than its peers. */
export const GENERATIONAL_SPLIT_MIN_GAP = 0.4;
/** Two places from its median metro rank: one place is within the noise of compressed metro scores. */
export const METRO_OUTLIER_MIN_RANK_GAP = 2;
/** A MAD-z residual of 2 is far above what the popularity fit predicts. */
export const HIDDEN_POCKET_MIN_Z = 2;
/** Top 30% of demand among eligible neighbourhoods. */
export const LATENT_DEMAND_MIN_DEMAND = 0.7;
/** Bottom 30% of venue supply density. */
export const LATENT_DEMAND_MAX_SUPPLY = 0.3;
/** Three new WHAT tags make a concept direction worth ranking tenants against; one or two may be noise. */
export const BLOCK_NEW_TAGS_MIN = 3;
/** A rank correlation over fewer (FIT, popularity) pairs is too unstable to call dominance. */
export const POPULARITY_DOMINANCE_MIN_PAIRS = 8;
/** Spearman ρ between FIT and popularity at which the ranking mostly restates popularity. */
export const POPULARITY_DOMINANCE_MIN_RHO = 0.8;
/** A result above this popularity is among the most popular entities Qloo has. */
export const HIGH_POPULARITY = 0.95;
/** More than this share of results above HIGH_POPULARITY means the list is mostly mainstream names. */
export const POPULARITY_DOMINANCE_MAX_HIGH_SHARE = 0.7;
/** The first popularity cap to suggest (PLAN §4.4). */
export const SUGGESTED_POPULARITY_CAP = 0.85;
/** Each further re-run lowers the cap by this much. */
export const POPULARITY_CAP_STEP = 0.1;
/** The lowest cap cross_domain accepts. */
export const POPULARITY_CAP_FLOOR = 0.5;
/** Texts name at most this many entities, then "and N more". */
export const MAX_NAMES_IN_TEXT = 3;

// Helpers -------------------------------------------------------------------------------------------

/** Absorbs floating-point error when a computed value lands exactly on a threshold. */
const EPS = 1e-9;

const finite = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x);
const atLeast = (x: number, threshold: number): boolean => x >= threshold - EPS;
const atMost = (x: number, threshold: number): boolean => x <= threshold + EPS;

function distinctNames(names: readonly string[]): string[] {
  return [...new Set(names.map((n) => n.trim()).filter((n) => n !== ""))];
}

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
function listNames(names: readonly string[]): string {
  const shown = names.slice(0, MAX_NAMES_IN_TEXT);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${rest} more`;
  if (shown.length <= 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1]}`;
}

const capitalise = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** A draft whose suggestion uses the kind's tool from FINDING_SUGGESTION; no reason, no suggestion. */
function draft(kind: FindingKind, text: string, reason: string | null, severity = FINDING_SEVERITY[kind]): FindingDraft {
  const tool = FINDING_SUGGESTION[kind];
  return { kind, severity, text, suggestion: tool !== null && reason !== null ? { tool, reason } : null };
}

// S1 Substitution Map ---------------------------------------------------------------------------------

/** TASTE_ISLAND: the target is last in ≥ 75% of the rows where it is scored (suggests cross_domain). */
export function tasteIslandFinding(args: {
  targetName: string;
  lastInRows: number;
  scoredRows: number;
  /** The target's most similar entity, if any. */
  nearestName: string | null;
}): FindingDraft | null {
  const { targetName, lastInRows, scoredRows, nearestName } = args;
  if (!Number.isInteger(lastInRows) || !Number.isInteger(scoredRows) || lastInRows > scoredRows) return null;
  if (scoredRows < TASTE_ISLAND_MIN_ROWS || !atLeast(lastInRows / scoredRows, TASTE_ISLAND_LAST_SHARE)) return null;
  const nearest = nearestName ? `; its closest peer is ${nearestName}` : "";
  return draft(
    "TASTE_ISLAND",
    `${targetName} ranks last in ${lastInRows} of ${scoredRows} peer rows, so its audience taste sits apart from this peer set${nearest}.`,
    `Look for ${targetName}'s cultural home outside this peer set.`,
  );
}

/** NEAR_SUBSTITUTES: mutual rank 1 and similarity ≥ p90 (suggests share_of_taste for the pair). */
export function nearSubstitutesFinding(args: { aName: string; bName: string }): FindingDraft {
  const { aName, bName } = args;
  return draft(
    "NEAR_SUBSTITUTES",
    `${aName} and ${bName} are each other's closest match, with similarity in the top tenth of the peer set: near-substitutes by audience taste.`,
    `Compare where ${aName} and ${bName} each win by age and metro.`,
  );
}

/**
 * The OUTSIDE_CATEGORY_NEIGHBOUR rule (SPEC §4.4): the top cross-category discovery result sits
 * outside the target's category and scores at least as high as the best same-category result. Both
 * discovery calls share the target as their signal, so their scores sit on one scale (probe G1).
 * With no scored same-category result, the outside neighbour is the closest match by default.
 */
export function isOutsideCategoryNeighbour(args: {
  neighbourInCategory: boolean;
  neighbourScore: number | null;
  bestInCategoryScore: number | null;
}): boolean {
  const { neighbourInCategory, neighbourScore, bestInCategoryScore } = args;
  if (neighbourInCategory || !finite(neighbourScore)) return false;
  return !finite(bestInCategoryScore) || atLeast(neighbourScore, bestInCategoryScore);
}

/**
 * OUTSIDE_CATEGORY_NEIGHBOUR: the top cross-category discovery result sits outside the target's
 * category. The ANALYST PIVOT is a peer_landscape call either way: a neighbour left out of the map
 * is added to it, while one that already holds a slot gets a map of its own, as the target.
 */
export function outsideCategoryNeighbourFinding(args: {
  targetName: string;
  neighbourName: string;
  /** The neighbour's category label (its genre tag name), when known. */
  neighbourCategory: string | null;
  /** Whether the neighbour already holds a slot in the Substitution Map. */
  neighbourInMap: boolean;
}): FindingDraft {
  const { targetName, neighbourName, neighbourCategory, neighbourInMap } = args;
  const category = neighbourCategory ? ` (${neighbourCategory})` : "";
  return draft(
    "OUTSIDE_CATEGORY_NEIGHBOUR",
    `${neighbourName}${category} sits outside ${targetName}'s category yet matches its audience at least as closely as any same-category peer.`,
    neighbourInMap
      ? `Map ${neighbourName}'s own peers, with ${neighbourName} as the target.`
      : `Add ${neighbourName} to the Substitution Map as a cross-category peer.`,
  );
}

// S2 Share-of-Taste ---------------------------------------------------------------------------------

/**
 * GENERATIONAL_SPLIT: the target's youth tilt minus the set median is ≥ 0.4 (SPEC §4.4). The rule is
 * one-sided: a target that skews older than its peers is not a finding.
 */
export function generationalSplitFinding(args: {
  targetName: string;
  /** Mean pct over the two youngest buckets minus the two oldest (share.youth_tilt). */
  targetTilt: number | null;
  /** Median youth tilt over the set the target was ranked in. */
  setMedianTilt: number | null;
}): FindingDraft | null {
  const { targetName, targetTilt, setMedianTilt } = args;
  if (!finite(targetTilt) || !finite(setMedianTilt)) return null;
  if (!atLeast(targetTilt - setMedianTilt, GENERATIONAL_SPLIT_MIN_GAP)) return null;
  return draft(
    "GENERATIONAL_SPLIT",
    `${targetName} skews clearly younger than its peer set: its youth tilt sits well above the set median.`,
    null,
  );
}

/**
 * METRO_OUTLIER: the target's rank in one metro context is ≥ 2 places from its median metro rank.
 * Suggests geo_lift only when the metro is a gazetteer metro (neighbourhood polygons exist).
 */
export function metroOutlierFinding(args: {
  targetName: string;
  /** Display name of the market, e.g. "Austin". */
  marketLabel: string;
  /** The target's rank in this metro context, 1 = best. */
  metroRank: number;
  /** The target's median rank over all metro contexts in the call set. */
  medianRank: number;
  /** Entities ranked in each context. */
  setSize: number;
  /** The gazetteer metro this market is, or null outside the gazetteer. */
  gazetteerMetro: MetroId | null;
}): FindingDraft | null {
  const { targetName, marketLabel, metroRank, medianRank, setSize, gazetteerMetro } = args;
  if (!Number.isInteger(metroRank) || !Number.isInteger(setSize) || metroRank < 1 || metroRank > setSize) return null;
  if (!finite(medianRank)) return null;
  const gap = medianRank - metroRank;
  if (!atLeast(Math.abs(gap), METRO_OUTLIER_MIN_RANK_GAP)) return null;
  const text = `${targetName} ranks ${metroRank} of ${setSize} in ${marketLabel}, clearly ${gap > 0 ? "better" : "worse"} than its median rank across metros.`;
  if (gazetteerMetro === null) return draft("METRO_OUTLIER", text, null, "low");
  return draft(
    "METRO_OUTLIER",
    text,
    `Map where ${targetName}'s taste concentrates inside ${METRO_LABEL[gazetteerMetro]}, then profile the top neighbourhood.`,
  );
}

// S5 Travel taste -------------------------------------------------------------------------------------

export interface HiddenPocketCandidate {
  name: string;
  /** MAD-z of the residual from the Theil–Sen fit of FIT on popularity (trvl.hidden_pocket). */
  residualZ: number | null;
  popularity: number | null;
}

/** The HIDDEN_POCKET rule: MAD-z residual ≥ 2 and popularity below the within-set median (D17). */
export function isHiddenPocket(candidate: HiddenPocketCandidate, medianPopularity: number): boolean {
  const { residualZ, popularity } = candidate;
  if (!finite(residualZ) || !finite(popularity) || !finite(medianPopularity)) return false;
  return atLeast(residualZ, HIDDEN_POCKET_MIN_Z) && popularity < medianPopularity;
}

/** HIDDEN_POCKET: destinations that over-index for the audience against their popularity, strongest first. */
export function hiddenPocketFinding(args: {
  /** Who the audience is: the seeds' names, e.g. "Artist Nova". */
  seedLabel: string;
  destinations: readonly HiddenPocketCandidate[];
  /** Median popularity over the same destination set. */
  medianPopularity: number;
}): FindingDraft | null {
  const pockets = args.destinations
    .filter((d) => isHiddenPocket(d, args.medianPopularity))
    .sort((a, b) => (b.residualZ ?? 0) - (a.residualZ ?? 0));
  const names = distinctNames(pockets.map((d) => d.name));
  if (names.length === 0) return null;
  const one = names.length === 1;
  return draft(
    "HIDDEN_POCKET",
    `${listNames(names)} ${one ? "ranks" : "rank"} higher in the travel taste of the ${args.seedLabel} audience than ${one ? "its" : "their"} popularity predicts: ${one ? "a hidden pocket" : "hidden pockets"} for experiential or pop-up ideas.`,
    null,
  );
}

// S6 Lift and white space -----------------------------------------------------------------------------

export interface LatentDemandCandidate {
  name: string;
  /** Percentile of the neighbourhood's lift among eligible neighbourhoods. */
  demandPct: number | null;
  /** Percentile of venue supply density. */
  supplyPct: number | null;
}

/** The LATENT_DEMAND rule: Demand_pct ≥ 0.7 and Supply_pct ≤ 0.3. */
export function isLatentDemand(demandPct: number | null, supplyPct: number | null): boolean {
  return finite(demandPct) && finite(supplyPct) && atLeast(demandPct, LATENT_DEMAND_MIN_DEMAND) && atMost(supplyPct, LATENT_DEMAND_MAX_SUPPLY);
}

/** LATENT_DEMAND: high-demand, low-supply neighbourhoods, most white space first (suggests block_dna on the top one). */
export function latentDemandFinding(args: {
  metroLabel: string;
  neighbourhoods: readonly LatentDemandCandidate[];
}): FindingDraft | null {
  const whiteSpace = (n: LatentDemandCandidate): number => (n.demandPct ?? 0) * (1 - (n.supplyPct ?? 0));
  const open = args.neighbourhoods
    .filter((n) => isLatentDemand(n.demandPct, n.supplyPct))
    .sort((a, b) => whiteSpace(b) - whiteSpace(a));
  const names = distinctNames(open.map((n) => n.name));
  const top = names[0];
  if (top === undefined) return null;
  return draft(
    "LATENT_DEMAND",
    `${listNames(names)} in ${args.metroLabel} ${names.length === 1 ? "shows" : "show"} high demand for this concept with low venue supply: latent, open white space.`,
    `Profile the Block DNA of ${top} to see what its venue-goers favour.`,
  );
}

// S7 Block DNA ---------------------------------------------------------------------------------------

/** BLOCK_NEW_TAGS: ≥ 3 WHAT-family tags in the area's top 20 that are absent from the city's top 50. */
export function blockNewTagsFinding(args: {
  areaName: string;
  /** Names of the NEW WHAT tags, most distinctive first. */
  newWhatTags: readonly string[];
}): FindingDraft | null {
  const tags = distinctNames(args.newWhatTags);
  if (tags.length < BLOCK_NEW_TAGS_MIN) return null;
  return draft(
    "BLOCK_NEW_TAGS",
    `Among its top tags, ${args.areaName} has WHAT tags that are not among the city's top tags, led by ${listNames(tags)}.`,
    `Rank tenant brands carrying ${tags.slice(0, 2).join(" or ")} at this site against the city.`,
  );
}

const LOCATION_LABEL: Readonly<Record<LocationMethod, string>> = {
  POLYGON: "the neighbourhood boundary",
  POINT: "its centre point",
  QUERY: "a place-name search",
};

/**
 * LOCATION_FALLBACK: a CODE FALLBACK down the location ladder POLYGON → POINT → QUERY. No follow-up;
 * the step itself costs confidence. Throws when `to` is not below `from`, which is a caller bug.
 */
export function locationFallbackFinding(args: {
  areaName: string;
  from: LocationMethod;
  to: LocationMethod;
}): FindingDraft {
  const { areaName, from, to } = args;
  if (LocationMethod.options.indexOf(to) <= LocationMethod.options.indexOf(from)) {
    throw new RangeError(`locationFallbackFinding: ${from} → ${to} is not a step down the location ladder`);
  }
  return draft(
    "LOCATION_FALLBACK",
    `Location for ${areaName} fell back from ${LOCATION_LABEL[from]} to ${LOCATION_LABEL[to]} (a CODE FALLBACK).`,
    null,
  );
}

// S4 Momentum ----------------------------------------------------------------------------------------

/** NO_TREND_SIGNAL: entities whose series has no valid window (too few points or distinct values). */
export function noTrendSignalFinding(args: { names: readonly string[] }): FindingDraft | null {
  const names = distinctNames(args.names);
  if (names.length === 0) return null;
  return draft(
    "NO_TREND_SIGNAL",
    `${listNames(names)} ${names.length === 1 ? "has" : "have"} no usable trend in Qloo's trending window; no signal means the trend is unknown, not flat.`,
    null,
  );
}

// Generic --------------------------------------------------------------------------------------------

/**
 * The cap to suggest for a re-run: 0.85 first, then 0.1 lower each time down to cross_domain's floor
 * of 0.5. Null when the call already used the floor, so no re-run can help.
 */
export function suggestedPopularityCap(currentCap: number | null): number | null {
  if (!finite(currentCap) || currentCap > SUGGESTED_POPULARITY_CAP + EPS) return SUGGESTED_POPULARITY_CAP;
  if (atMost(currentCap, POPULARITY_CAP_FLOOR)) return null;
  return Math.max(POPULARITY_CAP_FLOOR, Math.round((currentCap - POPULARITY_CAP_STEP) * 100) / 100);
}

export interface PopularityDominanceResult {
  /** The result's FIT: its within-call affinity percentile, or the raw score, since ρ reads ranks only. */
  fit: number | null;
  popularity: number | null;
}

/**
 * Spearman ρ between FIT and popularity over the results where both are known, with the number of
 * pairs it rests on; rho is null with fewer than two pairs or when either side is constant.
 */
export function fitPopularityRho(results: readonly PopularityDominanceResult[]): { rho: number | null; pairs: number } {
  const pairs = results.filter((r): r is { fit: number; popularity: number } => finite(r.fit) && finite(r.popularity));
  const rho = pairs.length < 2 ? null : spearman(pairs.map((r) => r.fit), pairs.map((r) => r.popularity));
  return { rho, pairs: pairs.length };
}

/**
 * POPULARITY_DOMINANCE: FIT mostly restates popularity, by either rule: more than 70% of results
 * above popularity 0.95 (SPEC §4.4; results with an unknown popularity stay in the denominator), or
 * Spearman ρ(FIT, popularity) ≥ 0.8 over at least 8 pairs where both are known. Meant for
 * cross_domain results, the only tool with popularity_max: it suggests a cross_domain re-run with a
 * lower cap, unless the cap is already at the floor.
 */
export function popularityDominanceFinding(args: {
  /** The results as a noun phrase, e.g. "the music results". */
  context: string;
  /** Every result of the call, in result order. */
  results: readonly PopularityDominanceResult[];
  /** The popularity cap the call used, or null for none. */
  popularityMax: number | null;
}): FindingDraft | null {
  const { context, results, popularityMax } = args;
  if (results.length === 0) return null;
  const highShare = results.filter((r) => finite(r.popularity) && r.popularity > HIGH_POPULARITY).length / results.length;
  const mostlyMainstream = highShare > POPULARITY_DOMINANCE_MAX_HIGH_SHARE + EPS;
  const { rho, pairs } = fitPopularityRho(results);
  const tracksPopularity = pairs >= POPULARITY_DOMINANCE_MIN_PAIRS && finite(rho) && atLeast(rho, POPULARITY_DOMINANCE_MIN_RHO);
  if (!mostlyMainstream && !tracksPopularity) return null;
  const text = mostlyMainstream
    ? `Most of ${context} are among the most popular entities in Qloo, so the ranking leans on mainstream names.`
    : `In ${context}, taste fit closely tracks popularity, so the ranking leans on mainstream names.`;
  const cap = suggestedPopularityCap(popularityMax);
  return draft(
    "POPULARITY_DOMINANCE",
    text,
    cap === null ? null : `Re-run with popularity_max ${cap} to surface less mainstream picks.`,
  );
}

/** DROPPED_CANDIDATES: entities a call did not score in some context ("not scored here"). */
export function droppedCandidatesFinding(args: { names: readonly string[]; context: string }): FindingDraft | null {
  const names = distinctNames(args.names);
  if (names.length === 0) return null;
  const one = names.length === 1;
  return draft(
    "DROPPED_CANDIDATES",
    `${listNames(names)} ${one ? "was" : "were"} not scored in ${args.context}, so ${one ? "it is" : "they are"} shown as not scored there, not ranked last.`,
    null,
  );
}

/**
 * EMPTY_RESULT: a call returned nothing usable. The caller picks the way to broaden, since it depends
 * on the call (FINDING_SUGGESTION has no fixed tool for this kind).
 */
export function emptyResultFinding(args: {
  /**
   * The call as a noun phrase, e.g. "the concept heatmap for Austin"; the builder appends "returned
   * no usable results", so pass no verb. A blank value reads "The call".
   */
  what: string;
  /** How to broaden (a tag union, a dropped filter, another type), or null when nothing can help. */
  suggestion: FindingSuggestion | null;
}): FindingDraft {
  const what = args.what.trim().replace(/\s+/g, " ") || "the call";
  return {
    kind: "EMPTY_RESULT",
    severity: FINDING_SEVERITY.EMPTY_RESULT,
    text: `${capitalise(what)} returned no usable results.`,
    suggestion: args.suggestion,
  };
}
