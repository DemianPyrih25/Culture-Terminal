import { METRO_LABEL, type EntityType, type GhostPickCategory, type Job, type MetroId, type Pillar, type SponsorCategory } from "@ct/contracts";

/**
 * The answer page's fixed words (design/redesign.pen, N05 and N07–N12): job labels, chart kinds and
 * captions, the AI-alone titles and the category icons. Static tables only; every name and number on the
 * page comes from the run.
 */

/** The page head's job label (PageHead/answer eyebrow). */
export const ANSWER_JOB_LABEL: Readonly<Record<Job, string>> = {
  brand_health: "Real competitors",
  head_to_head: "Compare two brands",
  site_selection: "Where to open",
  tenant_mix: "Best tenant for a space",
  sponsorship: "Sponsor fit",
  market_selection: "Launch & tour cities",
  audience_discovery: "Who they are",
  area_profile: "What an area is like",
  taste_twins: "Find an area's twin",
  brand_collab: "Brand collaborations",
  creator_fit: "Creators who fit",
  launch_test: "Test a new product",
  city_compare: "Compare cities",
};

/** The topic each desk belongs to (the tile and the eyebrow's first words). */
export type AnswerTopic = "brands" | "places" | "tours" | "audiences";

export const PILLAR_TOPIC: Readonly<Record<Pillar, AnswerTopic>> = {
  investment: "brands",
  location: "places",
  marketing: "tours",
  audience: "audiences",
};

export const TOPIC_LABEL: Readonly<Record<AnswerTopic, string>> = {
  brands: "Brands & investing",
  places: "Places",
  tours: "Sponsors & tours",
  audiences: "Audiences",
};

/** The state a metro sits in, for "Austin, TX". */
export const METRO_STATE: Readonly<Record<MetroId, string>> = {
  nashville: "TN",
  austin: "TX",
  nyc: "NY",
  los_angeles: "CA",
  chicago: "IL",
  miami: "FL",
  san_francisco: "CA",
  seattle: "WA",
  boston: "MA",
  denver: "CO",
  atlanta: "GA",
  houston: "TX",
  dallas: "TX",
};

/** "A, B or C": items in words, commas between them and the conjunction before the last. */
export function wordList(items: readonly string[], conjunction: "and" | "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/** The 13 map cities by name, A to Z: the cities a place question can name (D28). */
export const MAP_CITIES: readonly string[] = Object.values(METRO_LABEL).sort((a, b) => a.localeCompare(b));

/** The jobs that read a place: their eyebrow names it and their follow-up field asks about it. */
export const PLACE_JOBS: ReadonlySet<Job> = new Set<Job>(["site_selection", "tenant_mix", "area_profile", "taste_twins", "city_compare"]);

/** The jobs on the investment desk carry the advice line under the verdict. */
export const ADVICE_LINE = "Taste signals, not buy or sell advice.";

/** Which pick list of the AI-alone answer each job shows: its first category (GHOST_JOB_CATEGORIES in @ct/agent). */
export const GHOST_JOB_CATEGORY: Readonly<Record<Job, GhostPickCategory>> = {
  brand_health: "competitors",
  head_to_head: "competitors",
  site_selection: "neighbourhoods",
  area_profile: "tenants",
  tenant_mix: "tenants",
  sponsorship: "partners",
  market_selection: "markets",
  audience_discovery: "partners",
  taste_twins: "neighbourhoods",
  brand_collab: "partners",
  creator_fit: "creators",
  launch_test: "partners",
  city_compare: "markets",
};

/** The plural noun of a pick category: "AI alone matched 2 of the data's top 5 rivals". */
export const GHOST_NOUN: Readonly<Record<GhostPickCategory, string>> = {
  competitors: "rivals",
  markets: "cities",
  neighbourhoods: "areas",
  tenants: "tenants",
  partners: "brands",
  creators: "creators",
};

/** The title when the AI's picks are clearly better known than the data's (10 points or more). */
export const GHOST_OBVIOUS_TITLE: Readonly<Record<GhostPickCategory, string>> = {
  competitors: "AI alone named the biggest rivals",
  markets: "AI alone named the largest cities",
  neighbourhoods: "AI alone picked busier areas",
  tenants: "AI alone suggested the obvious tenants",
  partners: "AI alone named the biggest brands",
  creators: "AI alone named the most famous creators",
};

/** How many points of mean popularity make the AI's picks "obvious". */
export const GHOST_OBVIOUS_POINTS = 10;

/** Plural nouns per entity type: "vs 4 other comedians" reads "vs 4 other artists" from the data we have. */
export const ENTITY_NOUN: Readonly<Record<EntityType, string>> = {
  brand: "brands",
  artist: "artists",
  person: "people",
  podcast: "podcasts",
  tv_show: "shows",
  movie: "films",
  place: "places",
  destination: "places",
};

/** Chart kinds and captions per chart (the kind line over the title, the caption under the plot). */
export const CHART_COPY = {
  closest: { kind: "Closest audiences", caption: "1.00 = identical tastes. Shared taste, not shared customers." },
  winner: { kind: "Who wins where", caption: "Rank within the pair: who leads, not by how much. Not sales share." },
  map: { kind: "Where interest is highest", title: "Best areas for this concept" },
  moreLess: { kind: "What this area has more and less of" },
  fit: { kind: "Best fit for this corner", caption: "Fit compares the block's taste with each tenant's fans. Not rent or revenue." },
  climbers: { kind: "Who climbs here vs citywide", caption: "Rank among the candidates here and citywide. Not rent or revenue." },
  slate: { kind: "Best fit per category", caption: "Taste fit only. No fees, availability or ROI data." },
  alsoLove: { kind: "What else they love", caption: "Ranked by how much more these fans like them than average." },
  fans: { kind: "Who the fans are", caption: "How much more or less each group likes it than average. Not shares of shoppers." },
  markets: { kind: "Where it out-draws its peers" },
  twins: {
    kind: "Closest twins",
    caption:
      "Match compares how each area differs from its own city with how the source area differs from its city. 1.00 = the same mix of tastes; 0 = unrelated; below 0 = opposite.",
  },
  twinShared: {
    kind: "What the two areas share",
    caption:
      "Tastes both areas rank higher (or lower) than their own city; the numbers are places up or down, the source area first. Shared taste, not foot traffic or spending.",
  },
  verdicts: {
    kind: "AI guesses, checked against the data",
    caption:
      "Kept = the concept's taste scores it at least as high as the concept's 50th result (its last, when fewer come back), in the same request. Dropped = lower: the taste points elsewhere, which says nothing about the business. Found in the data = a top result no guess named.",
  },
  partners: { kind: "Best-fit partners", caption: "Scored on one scale in one request: 100 = the best fit among the names checked. Taste fit, not sales or deal terms." },
  creators: {
    kind: "Creators who fit",
    caption: "Ranked within each kind of creator; scores compare only within a kind. Public figures only. Taste fit, not reach or fees.",
  },
  creatorsScored: {
    kind: "Scored on one scale",
    caption: "Creators of one kind scored in one request: 100 = the best fit among the names checked. Taste fit, not reach or fees.",
  },
  fingerprints: { kind: "What sets each city apart", caption: "Tastes each city ranks higher than the other cities we map do, on average. Shared taste, not sales or foot traffic." },
  financials: {
    kind: "Reported financials",
    caption: "Company-level figures as reported in SEC filings; one brand may be a small part of its company. Not advice.",
  },
  economics: {
    kind: "Who lives there",
    caption: "Census survey estimates for residents (ACS 5-year), not customers, foot traffic or spending.",
  },
  generic: { kind: "Chart" },
} as const;

/** The category icon of a slate row. */
export const SPONSOR_ICON: Readonly<Partial<Record<SponsorCategory, "beer" | "wine" | "tent" | "shirt" | "utensils" | "glass-water">>> = {
  beer: "beer",
  spirits: "wine",
  outdoor_sporting_retail: "tent",
  apparel_footwear: "shirt",
  qsr: "utensils",
  rtd_seltzer: "glass-water",
};

/** Neighbour column heads by domain. */
export const DOMAIN_COLUMN: Readonly<Record<string, { label: string; icon: "music" | "mic" | "tv" | "shopping-bag" | "user-round" }>> = {
  person: { label: "Public figures", icon: "user-round" },
  artist: { label: "Music", icon: "music" },
  podcast: { label: "Podcasts", icon: "mic" },
  tv_show: { label: "TV", icon: "tv" },
  brand: { label: "Brands", icon: "shopping-bag" },
};

/** Block DNA families as the tenant chart groups them. */
export const BLOCK_FAMILY_LABEL: Readonly<Record<string, string>> = {
  WHO: "Who goes",
  VIBE: "The vibe",
  WHAT: "Food and venues",
  SOUND: "Music",
};

/** The verdict card when the data could not support a call. */
export const NOT_ENOUGH_LINE = "Not enough data to call this";
export const NOT_ENOUGH_LEAD = "Here's what we found.";
