import { stripTokens, type GeoLiftPayload, type Metric } from "@ct/contracts";
import { MIN_BUSY_AREA_VENUES } from "@ct/quant";

/**
 * CHECKER V10, competition (SPEC §6.2, PLAN §8.3). A claim that states a competitor count or supply level
 * ("no competitors", "few rivals", "three similar venues", "the only bookstore", "underserved", "white
 * space", "little coffee supply", "crowded") must cite, in its own part, a supply metric that can back it.
 * The rule is geo_lift's supply-label rule (@ct/quant, geoLift/lift): a capped sample's 0 is no count
 * (geo_lift writes it UNAVAILABLE; a stored 0 labelled capped reads the same), a sample too thin to read
 * leaves the count unknown, and a crowded or saturated reading needs at least MIN_BUSY_AREA_VENUES venues
 * in the area. The rule judges every run that measured supply or asked about competition, so a run that
 * counted venues in one metro and not in another still judges every uncited claim. A clause that says the
 * count is unknown, or that the figure is only a sample, claims nothing and passes; an unknown about
 * something else in the same sentence does not excuse it.
 */

/** Metric keys whose value counts or ranks similar venues (geo_lift supply and white space). */
const SUPPLY_KEYS: ReadonlySet<string> = new Set(["lift.supply", "lift.white_space"]);

/** True when some geo_lift call could not count similar venues: an UNAVAILABLE lift.supply metric. */
export function competitionUnknown(metrics: readonly Pick<Metric, "key" | "value">[]): boolean {
  return metrics.some((m) => m.key === "lift.supply" && m.value === null);
}

/** A geo_lift supply or white-space metric, with a value or without: the run measured (or tried to measure) supply. */
export function measuresSupply(metric: Pick<Metric, "key">): boolean {
  return SUPPLY_KEYS.has(metric.key);
}

/** A capped sample's 0 stored as a value (runs before geo_lift wrote it UNAVAILABLE): no count. */
function cappedZero(metric: Pick<Metric, "key" | "value" | "label">): boolean {
  return metric.key === "lift.supply" && metric.value === 0 && /\bcapped\b/i.test(metric.label);
}

/**
 * A metric that counts or ranks similar venues and can back a competition claim: a supply or white-space
 * metric with a value, never a capped sample's 0. A `busy` claim (crowded, saturated, heavy competition)
 * citing a venue count needs at least MIN_BUSY_AREA_VENUES of them; a white-space metric exists only where
 * the area's quadrant passed the rule.
 */
export function countsSupply(metric: Pick<Metric, "key" | "value" | "label">, busy = false): boolean {
  if (!SUPPLY_KEYS.has(metric.key) || metric.value === null || cappedZero(metric)) return false;
  return !busy || metric.key !== "lift.supply" || metric.value >= MIN_BUSY_AREA_VENUES;
}

/** A lift map that counted similar venues: a venue sample and no supply gap. */
export function mapCountsSupply(payload: Pick<GeoLiftPayload, "supply" | "supplyGap">): boolean {
  return payload.supply !== null && payload.supplyGap === undefined;
}

const COUNT_WORDS = "\\d+|one|two|three|four|five|six|seven|eight|nine|ten|a few|a couple of|a handful of|several|many|dozens of|no|zero";
/** Nouns that name a kind of venue; generic words (options, spots, places, sites) are left out, since plain site comparison uses them. */
const VENUE_NOUNS =
  "venues?|businesses|business|shops?|stores?|bookstores?|bookshops?|outlets?|bars?|pubs?|taprooms?|lounges?|restaurants?|eateries|eatery|" +
  "cafes?|coffeehouses?|bakeries|bakery|breweries|brewery|gyms?|studios?|salons?|boutiques?|pizzerias?|operators?|competitors?|rivals?";
/** Words for a venue kind that may stand before the noun ("coffee shops", "wine bars", "record stores"). */
const KIND = "(?:[a-z][a-z'-]*\\s+){0,2}";
const SCARCE = "low|few|scarce|thin|light|limited|absent|minimal|sparse|weak|non-existent|nonexistent";
const DENSE = "high|heavy|dense|stiff|intense|fierce|strong|crowded|saturated|plentiful";
/** "supply", but not the sample or data it comes from ("the supply sample is thin" is about the sample). */
const SUPPLY = "supply\\b(?!\\s+(?:sample|data|count|side))";

/** Phrases that state or imply a competitor count or a supply level. */
const CLAIMS: readonly RegExp[] = [
  // "no competitors", "few direct rivals", "little competition", "low competition", "little to no competition"
  /\b(?:no|zero|few|fewer|little|less|low|limited|minimal|scant|thin|light|sparse|modest|lower|lighter|thinner|not much|hardly any|barely any)\s+(?:to\s+no\s+)?(?:direct\s+|local\s+|nearby\s+|existing\s+|real\s+|similar\s+|other\s+)?(?:competitors?|competition|rivals?)\b/i,
  // "competition is thin", "competition in Lark Hill is low", "rivals are few"
  new RegExp(
    `\\b(?:competitors?|competition|rivals?)\\b(?:\\s+[\\w'-]+){0,5}?\\s+(?:is|are|looks?|seems?|remains?|stays?|appears?)\\s+(?:still\\s+|very\\s+|relatively\\s+|fairly\\s+|quite\\s+|almost\\s+)?(?:${SCARCE})\\b`,
    "i",
  ),
  // "a handful of rival shops", "two competing options"
  new RegExp(`\\b(?:${COUNT_WORDS})\\s+(?:competing|rival)\\s+[a-z]+\\b`, "i"),
  // "three similar venues", "several existing bookstores"
  new RegExp(`\\b(?:${COUNT_WORDS})\\s+(?:similar|existing|other|nearby)\\s+${KIND}(?:${VENUE_NOUNS})\\b`, "i"),
  // "no other bookstores", "no coffee shops yet", "zero wine bars"
  new RegExp(`\\b(?:no|zero)\\s+(?:other\\s+|similar\\s+|competing\\s+|rival\\s+)?${KIND}(?:${VENUE_NOUNS})\\b`, "i"),
  // "the only bookstore in Lark Hill", "the only wine bar nearby"
  new RegExp(`\\bthe\\s+only\\s+${KIND}(?:${VENUE_NOUNS})\\b`, "i"),
  // supply levels that need a count
  /\b(?:uncontested|underserved|under-served|undersupplied|under-supplied|oversupplied|over-supplied|saturated|oversaturated|white[\s-]?space|untapped|unserved|uncrowded|first[\s-]mover|lack of competition|gap in the market|market gap)\b/i,
  /\bno one else\b/i,
  // "little coffee supply", "low supply", "thin bookstore supply"
  new RegExp(`\\b(?:no|little|less|low|lower|limited|minimal|scant|thin|light|sparse|scarce|modest|not much)\\s+${KIND}${SUPPLY}`, "i"),
  // "supply is thin", "coffee supply in Lark Hill looks low"
  new RegExp(`\\b${SUPPLY}(?:\\s+[\\w'-]+){0,5}?\\s+(?:is|are|looks?|seems?|remains?|stays?|appears?)\\s+(?:still\\s+|very\\s+|relatively\\s+|fairly\\s+|quite\\s+|almost\\s+)?(?:${SCARCE})\\b`, "i"),
];

/** Phrases that state a high competitor count or supply level: a count needs several venues to back them. */
const BUSY_CLAIMS: readonly RegExp[] = [
  // "crowded", "saturated", "busy with rivals", "proven & crowded"
  /\b(?:crowded|overcrowded|saturated|oversaturated|oversupplied|over-supplied|busy with (?:rivals|competitors|competition))\b/i,
  // "heavy competition", "many competitors", "stiff rivals"
  new RegExp(`\\b(?:${DENSE}|many|plenty of|lots of|a lot of|numerous)\\s+(?:direct\\s+|local\\s+|nearby\\s+|existing\\s+)?(?:competitors?|competition|rivals?)\\b`, "i"),
  // "competition is heavy", "rivals are dense"
  new RegExp(`\\b(?:competitors?|competition|rivals?)\\b(?:\\s+[\\w'-]+){0,5}?\\s+(?:is|are|looks?|seems?|remains?|stays?|appears?)\\s+(?:still\\s+|very\\s+|relatively\\s+|fairly\\s+|quite\\s+|almost\\s+)?(?:${DENSE})\\b`, "i"),
  // "high coffee supply", "supply is dense"
  new RegExp(`\\b(?:high|heavy|dense|ample|abundant)\\s+${KIND}${SUPPLY}`, "i"),
  new RegExp(`\\b${SUPPLY}(?:\\s+[\\w'-]+){0,5}?\\s+(?:is|are|looks?|seems?|remains?|stays?|appears?)\\s+(?:still\\s+|very\\s+|relatively\\s+|fairly\\s+|quite\\s+|almost\\s+)?(?:${DENSE})\\b`, "i"),
];

/** A clause that says the count is unknown: it states the limit, not a count. */
const STATES_UNKNOWN =
  /\b(?:unknown|not known|not counted|not measured|uncounted|unavailable|can(?:not|'t)\s+(?:be\s+)?(?:count|tell|say|know|confirm|claim|call|rule)|could(?:\s+not|n't)\s+(?:be\s+)?(?:count|tell|say|confirm|rule)|ruled out|no verified|no reliable|not enough venue data|whether|unclear|uncertain|not clear)\b/i;

/** A clause that says the figure is only a sample, not a count of businesses: it states the limit. */
const STATES_SAMPLE = /\b(?:(?:only|just|merely)\s+(?:a\s+)?(?:capped\s+|small\s+|thin\s+|partial\s+)?sample|not\s+(?:a\s+(?:full\s+)?count|every\s+business|a\s+census))\b/i;

/** Typographic apostrophes read as plain ones (built from its char code, so the source stays ASCII). */
const CURLY_APOSTROPHE = new RegExp(String.fromCharCode(0x2019), "g");

/** Where a sentence splits into clauses: a stop, a comma, colon or semicolon, or a joining word. */
const SENTENCES = /(?<=[.!?;])\s+/;
const CLAUSES = /\s*[,:;]\s+|\s+(?:but|while|whereas|although|though|yet|and|so|because)\s+/i;

/** One competition claim: the phrase, and whether it states a high level (crowded) rather than a low one or a count. */
export interface CompetitionClaim {
  text: string;
  busy: boolean;
}

/**
 * The competition claims of one prose text (tokens removed), at most one per clause, a high level read
 * first. A clause that says the count is unknown, or only a sample, is skipped; the rest of its sentence
 * is still read.
 */
export function competitionClaimsOf(text: string): CompetitionClaim[] {
  const plain = stripTokens(text).replace(CURLY_APOSTROPHE, "'");
  const out: CompetitionClaim[] = [];
  for (const sentence of plain.split(SENTENCES)) {
    for (const clause of sentence.split(CLAUSES)) {
      if (STATES_UNKNOWN.test(clause) || STATES_SAMPLE.test(clause)) continue;
      const hit = firstClaim(BUSY_CLAIMS, clause, true) ?? firstClaim(CLAIMS, clause, false);
      if (hit !== null) out.push(hit);
    }
  }
  return out;
}

function firstClaim(patterns: readonly RegExp[], clause: string, busy: boolean): CompetitionClaim | null {
  for (const re of patterns) {
    const hit = re.exec(clause);
    if (hit !== null) return { text: hit[0], busy };
  }
  return null;
}

/** The phrases of competitionClaimsOf. */
export function competitionClaims(text: string): string[] {
  return competitionClaimsOf(text).map((c) => c.text);
}
