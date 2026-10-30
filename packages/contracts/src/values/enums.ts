/**
 * The zod-free values of the shared vocabulary (PLAN §4.3, §6): the enum value arrays and the label maps.
 * Client components import these from `@ct/contracts/values` so a page bundle never pulls in zod; the zod
 * enums in ../enums.ts are built from the same arrays (`z.enum(JOB_VALUES)`), so the two never drift.
 * Nothing here may import zod or a module that does (test: values entry is zod-free).
 */

// Desks and jobs (PLAN §2.2) ---------------------------------------------------------------------

export const PILLAR_VALUES = ["investment", "location", "marketing", "audience"] as const;
type PillarV = (typeof PILLAR_VALUES)[number];

export const PILLAR_LABEL: Readonly<Record<PillarV, string>> = {
  investment: "INVESTMENT",
  location: "LOCATION",
  marketing: "MARKETING",
  audience: "AUDIENCE",
};

export const JOB_VALUES = [
  "brand_health",
  "head_to_head",
  "site_selection",
  "area_profile",
  "tenant_mix",
  "sponsorship",
  "market_selection",
  "audience_discovery",
  "taste_twins",
  "brand_collab",
  "creator_fit",
  "launch_test",
  "city_compare",
] as const;
type JobV = (typeof JOB_VALUES)[number];

export const JOB_MNEMONIC = {
  brand_health: "HLTH",
  head_to_head: "VS",
  site_selection: "SITE",
  area_profile: "DNA",
  tenant_mix: "TEN",
  sponsorship: "SPON",
  market_selection: "MKTS",
  audience_discovery: "AUD",
  taste_twins: "TWIN",
  brand_collab: "COLLAB",
  creator_fit: "CRTR",
  launch_test: "LNCH",
  city_compare: "CITY",
} as const satisfies Record<JobV, string>;

export const JOB_PILLAR: Readonly<Record<JobV, PillarV>> = {
  brand_health: "investment",
  head_to_head: "investment",
  site_selection: "location",
  area_profile: "location",
  tenant_mix: "location",
  sponsorship: "marketing",
  market_selection: "marketing",
  audience_discovery: "audience",
  taste_twins: "location",
  brand_collab: "marketing",
  creator_fit: "marketing",
  launch_test: "investment",
  city_compare: "location",
};

export const JOBS_BY_PILLAR: Readonly<Record<PillarV, readonly JobV[]>> = {
  investment: ["brand_health", "head_to_head", "launch_test"],
  location: ["site_selection", "area_profile", "tenant_mix", "taste_twins", "city_compare"],
  marketing: ["sponsorship", "market_selection", "brand_collab", "creator_fit"],
  audience: ["audience_discovery"],
};

// Roles (D10) --------------------------------------------------------------------------------------

export const ROLE_VALUES = ["CLERK", "ANALYST", "QUANT", "CHECKER", "GHOST"] as const;

// Evidence vocabulary (D7, D8, §6) -----------------------------------------------------------------

export const BADGE_VALUES = ["MEASURED", "DERIVED", "ESTIMATED", "STALE", "UNAVAILABLE"] as const;

/** The verdict "for this question" (D8). Never buy/sell, price targets or ratings. */
export const SIGNAL_VALUES = ["strong", "mixed", "weak", "insufficient_evidence"] as const;

export const COMPARATOR_VALUES = ["CITY", "PEERS", "BASELINE", "WITHIN_CALL"] as const;
type ComparatorV = (typeof COMPARATOR_VALUES)[number];

export const COMPARATOR_LABEL: Readonly<Record<ComparatorV, string>> = {
  CITY: "Δ vs CITY",
  PEERS: "Δ vs PEERS",
  BASELINE: "Δ vs BASELINE",
  WITHIN_CALL: "Δ WITHIN-CALL",
};

/** Data-quality flags; ../enums.ts documents each one. */
export const FLAG_VALUES = [
  "TRENDING_HISTORICAL_WINDOW",
  "NO_TREND_SIGNAL",
  "CANDIDATES_UNSCORED",
  "COARSE_GEOHASH",
  "LOCATION_FALLBACK",
  "DEMOGRAPHICS_ARE_INDICES",
  "SUPPLY_SAMPLE_ONLY",
  "SUPPLY_UNAVAILABLE",
  "STALE_CACHE",
  "BUDGET_TRUNCATED",
  "SECONDARY_ENTITY_DROPPED",
  "QUALITY_GATE_DROPPED",
  "SENSITIVE_SEGMENT_BLOCKED",
  "INCOMPLETE_RUN",
  "DROPPED_CANDIDATES",
  "NOT_SCORED",
  "THIN_RESULT",
  "READ_AS_NEAREST_JOB",
  "NOT_A_LISTED_COMPANY",
  "CENSUS_RESIDENTS_ONLY",
  "SEC_NOT_CONFIGURED",
  "CENSUS_NOT_CONFIGURED",
  "CONCEPT_NOT_IN_DATA",
  "EXPECTED_CANDIDATE_MISSING",
  "CATEGORY_LEVEL_READ",
  "PROXY_TAG_IGNORED",
  "SUBJECT_NO_DATA",
  "OSM_NOT_CONFIGURED",
  "OSM_SUPPLY_FLOOR",
  "NOT_SEPARATELY_REPORTED",
] as const;

/** Code detectors that drive ANALYST turn 2; ../enums.ts documents the newer ones. */
export const FINDING_KIND_VALUES = [
  "TASTE_ISLAND",
  "NEAR_SUBSTITUTES",
  "OUTSIDE_CATEGORY_NEIGHBOUR",
  "GENERATIONAL_SPLIT",
  "METRO_OUTLIER",
  "HIDDEN_POCKET",
  "LATENT_DEMAND",
  "BLOCK_NEW_TAGS",
  "EMPTY_RESULT",
  "DROPPED_CANDIDATES",
  "NO_TREND_SIGNAL",
  "POPULARITY_DOMINANCE",
  "LOCATION_FALLBACK",
  "WEAK_CATEGORY_FIT",
  "TWIN_FOUND",
  "ANALOG_VETOED",
  "TASTE_FINANCIALS_SPLIT",
  "PARTNERS_ONE_CATEGORY",
  "OVERSUPPLIED",
  "UNDERSUPPLIED",
  "LOW_STREET_ACTIVITY",
] as const;

export const SEVERITY_VALUES = ["info", "low", "medium", "high"] as const;
type SeverityV = (typeof SEVERITY_VALUES)[number];
export const SEVERITY_RANK: Readonly<Record<SeverityV, number>> = { info: 0, low: 1, medium: 2, high: 3 };

/** The Qloo kit's 9 workflows (D30). */
export const KIT_WORKFLOW_VALUES = [
  "recommend",
  "rank",
  "compare_audiences",
  "where_popular",
  "entity_tags",
  "audience_demographics",
  "find_tags",
  "describe",
  "trends",
] as const;

// Tools (PLAN §4.3) -----------------------------------------------------------------------------------

/** The 17 skill tools; ../enums.ts says which read public data. */
export const SKILL_ID_VALUES = [
  "resolve_entities",
  "find_tags",
  "rank_candidates",
  "peer_landscape",
  "share_of_taste",
  "audience_dna",
  "momentum",
  "destination_affinity",
  "geo_lift",
  "block_dna",
  "cross_domain",
  "sponsor_slate",
  "taste_twins",
  "concept_vector",
  "company_financials",
  "area_economics",
  "local_supply",
] as const;

/** The 19 ANALYST tools: the 17 skill tools plus the two submit tools. */
export const TOOL_NAME_VALUES = ["submit_plan", ...SKILL_ID_VALUES, "submit_report"] as const;
type ToolNameV = (typeof TOOL_NAME_VALUES)[number];

export const TOOL_MNEMONIC = {
  submit_plan: "PLAN",
  resolve_entities: "RES",
  find_tags: "TAGS",
  rank_candidates: "RANK",
  peer_landscape: "SUBS",
  share_of_taste: "SHARE",
  audience_dna: "DNA",
  momentum: "MOM",
  destination_affinity: "TRVL",
  geo_lift: "LIFT",
  block_dna: "BLOCK",
  cross_domain: "XDOM",
  sponsor_slate: "SLATE",
  taste_twins: "TWIN",
  concept_vector: "CNPT",
  company_financials: "FIN",
  area_economics: "ECON",
  local_supply: "SUPP",
  submit_report: "REPORT",
} as const satisfies Record<ToolNameV, string>;

// Runs ------------------------------------------------------------------------------------------------

export const RUN_STATUS_VALUES = [
  "queued",
  "needs_input",
  "running",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "refused",
] as const;

/** Statuses a run can end in. needs_input ends the run: the picker starts a new run with pins. */
export const TERMINAL_RUN_STATUS_VALUES = [
  "needs_input",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "refused",
] as const satisfies readonly (typeof RUN_STATUS_VALUES)[number][];

export const MODE_VALUES = ["live", "economy", "replay_only"] as const;
export const LANE_VALUES = ["public", "judge"] as const;
export const PHASE_VALUES = ["scan", "wave1", "followup"] as const;
export const CACHE_STATUS_VALUES = ["hit", "miss", "stale", "coalesced", "reused"] as const;

/** Where an evidence bundle's data came from: Qloo, or a public source (SEC EDGAR, US Census, OpenStreetMap). */
export const EVIDENCE_SOURCE_VALUES = ["qloo", "sec", "census", "osm"] as const;
/** The public data sources (PLAN §5.2). They cost no Qloo calls. */
export const PUBLIC_SOURCE_VALUES = ["sec", "census", "osm"] as const satisfies readonly (typeof EVIDENCE_SOURCE_VALUES)[number][];

export const SKILL_STATUS_VALUES = ["ok", "partial", "empty", "error"] as const;

// Qloo vocabulary -----------------------------------------------------------------------------------

/** Qloo's six age buckets, in ascending order (G12). */
export const AGE_BUCKET_VALUES = ["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"] as const;
type AgeBucketV = (typeof AGE_BUCKET_VALUES)[number];

export const AGE_BUCKET_LABEL: Readonly<Record<AgeBucketV, string>> = {
  "24_and_younger": "≤24",
  "25_to_29": "25–29",
  "30_to_34": "30–34",
  "35_to_44": "35–44",
  "45_to_54": "45–54",
  "55_and_older": "55+",
};

/** Youth tilt compares these (S2/S3): mean over the young pair minus mean over the old pair. */
export const YOUNG_AGE_BUCKETS = ["24_and_younger", "25_to_29"] as const satisfies readonly AgeBucketV[];
export const OLD_AGE_BUCKETS = ["45_to_54", "55_and_older"] as const satisfies readonly AgeBucketV[];

export const GENDER_VALUES = ["male", "female"] as const;

/** Entity types the resolution gate and the tools work with. */
export const ENTITY_TYPE_VALUES = ["brand", "artist", "person", "podcast", "tv_show", "movie", "place", "destination"] as const;
/** Result domains for the cultural neighbourhood (S9). */
export const DOMAIN_VALUES = ["artist", "podcast", "tv_show", "brand", "movie"] as const;
/** Types /v2/trending returns points for in the frozen window (G11). */
export const TRENDING_TYPE_VALUES = ["brand", "tv_show"] as const;
export const TAG_SCOPE_VALUES = ["place", "brand", "media"] as const;
/** Resolution outcome per mention (D20). Only `exact` is ever applied. */
export const MATCH_CLASS_VALUES = ["exact", "ambiguous", "inexact", "not_found"] as const;
export const MENTION_ROLE_VALUES = ["primary", "peer", "secondary"] as const;

/**
 * Where a candidate in a set came from (R3, D49): a name the question gave (`user_named`), a name a
 * specialist would check first that CLERK listed and the gate resolved exactly (`obvious`), or one the
 * data found (`data`). Rows show the first two as "You named" and "Expected".
 */
export const CANDIDATE_SOURCE_VALUES = ["user_named", "obvious", "data"] as const;
type CandidateSourceV = (typeof CANDIDATE_SOURCE_VALUES)[number];
export const CANDIDATE_SOURCE_LABEL: Readonly<Record<CandidateSourceV, string | null>> = {
  user_named: "You named",
  obvious: "Expected",
  data: null,
};

/**
 * How a concept tag matches the question's concept (R2, D48): `exact` (the concept itself), `category`
 * (its broader category, honestly labelled a category-level read) or `proxy` (a look-alike tag standing in
 * for a concept the data lacks: never a verdict).
 */
export const CONCEPT_MATCH_VALUES = ["exact", "category", "proxy"] as const;

/**
 * Where an area stands for a concept (R7, D50): `popular` (high raw affinity: where the crowd already is),
 * `hidden` (high lift, low raw: stands out for its size) or `popular_distinct` (both).
 */
export const AREA_STANDING_VALUES = ["popular", "hidden", "popular_distinct"] as const;
type AreaStandingV = (typeof AREA_STANDING_VALUES)[number];
export const AREA_STANDING_LABEL: Readonly<Record<AreaStandingV, string>> = {
  popular: "Already popular",
  hidden: "Hidden pocket",
  popular_distinct: "Popular and distinctive",
};
/** The two area lists above the area table and on the map (R7). */
export const POPULAR_AREAS_LABEL = "Where it's already popular";
export const HIDDEN_AREAS_LABEL = "Hidden pockets (stands out for its size)";

/** Sponsor categories (S10). A run uses at most six. */
export const SPONSOR_CATEGORY_VALUES = [
  "beer",
  "spirits",
  "rtd_seltzer",
  "outdoor_sporting_retail",
  "apparel_footwear",
  "qsr",
  "energy_drinks",
  "auto",
  "telecom",
  "fintech",
  "beauty",
  "gaming",
  "travel",
  "food_delivery",
  "consumer_tech",
] as const;

// Geography (D28) ------------------------------------------------------------------------------------

/** Gazetteer metros, the 13 map cities (D28, D37, D39). */
export const METRO_ID_VALUES = [
  "nashville",
  "austin",
  "nyc",
  "los_angeles",
  "chicago",
  "miami",
  "san_francisco",
  "seattle",
  "boston",
  "denver",
  "atlanta",
  "houston",
  "dallas",
] as const;
type MetroIdV = (typeof METRO_ID_VALUES)[number];

export const METRO_LABEL: Readonly<Record<MetroIdV, string>> = {
  nashville: "Nashville",
  austin: "Austin",
  nyc: "New York City",
  los_angeles: "Los Angeles",
  chicago: "Chicago",
  miami: "Miami",
  san_francisco: "San Francisco",
  seattle: "Seattle",
  boston: "Boston",
  denver: "Denver",
  atlanta: "Atlanta",
  houston: "Houston",
  dallas: "Dallas",
};

/** A market id's shape (config/metros.json keys), e.g. nashville or washington_dc. */
export const MARKET_ID_RE = /^[a-z][a-z0-9_]{1,39}$/;

/** True for a well-formed market id; config/metros.json decides whether the market exists. */
export function isMarketIdShape(value: unknown): value is string {
  return typeof value === "string" && MARKET_ID_RE.test(value);
}

// Exhibit vocabulary -------------------------------------------------------------------------------

export const QUADRANT_NAME_VALUES = ["HEARTLAND", "HIDDEN_POCKET", "MASS", "COLD"] as const;
export const WHITE_SPACE_QUADRANT_VALUES = ["LATENT_OPEN", "PROVEN_CROWDED", "SATURATED", "COLD"] as const;
export const BLOCK_FAMILY_VALUES = ["WHO", "VIBE", "WHAT", "SOUND"] as const;
export const LOCATION_METHOD_VALUES = ["POLYGON", "POINT", "QUERY"] as const;
export const MOMENTUM_TREND_VALUES = ["rising", "flat", "declining"] as const;
export const POSITION_AXIS_VALUES = ["distinctiveness", "reach", "next_gen_tilt", "metro_breadth", "momentum"] as const;

/** Why a value is missing; ../enums.ts documents each reason. */
export const NO_VALUE_REASON_VALUES = [
  "not_scored",
  "dropped",
  "not_measured",
  "no_signal",
  "unavailable",
  "quality_gate",
  "budget_truncated",
  "insufficient_n",
  "coarse",
  "self",
  "error",
  "not_listed",
  "not_reported",
  "suppressed",
  "not_configured",
] as const;

export const METRIC_UNIT_VALUES = [
  "pct",
  "popularity",
  "affinity",
  "similarity",
  "index",
  "lift",
  "delta",
  "rank",
  "count",
  "score",
  "ratio",
  "stat",
  "usd",
  "years",
  "people",
] as const;

export const CONFIDENCE_BAND_VALUES = ["HIGH", "MED", "LOW"] as const;
export const STRENGTH_VALUES = ["STRONG", "MODERATE", "THIN"] as const;
export const ARGUMENT_SECTION_VALUES = ["audience", "competition", "geography", "momentum", "opportunity", "risk"] as const;
export const PRIORITY_VALUES = ["now", "next", "later"] as const;
export const HYPOTHESIS_VERDICT_VALUES = ["confirmed", "refuted", "inconclusive"] as const;
export const SCORECARD_VERDICT_VALUES = ["CONFIRMED", "REFUTED", "INCONCLUSIVE"] as const;

/** CLERK refusal and reframe categories (clerk.md, §4.5). financial_advice is reframed, not refused. */
export const SAFETY_CATEGORY_VALUES = [
  "private_individual",
  "sensitive_inference",
  "political_targeting",
  "eligibility",
  "residential_screening",
  "injection",
  "financial_advice",
  "out_of_scope",
] as const;

/** The display words of a value inside the about-level band (D47, Metric.level): never "leans", "wins" or "gains". */
export const ABOUT_LEVEL_WORDS = { index: "about average", difference: "about level" } as const;
