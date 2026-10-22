import { z } from "zod";

/** An ISO 8601 timestamp, UTC `Z` or with an explicit offset (database drivers return either). */
export const IsoDateTime = z.iso.datetime({ offset: true });

// Desks and jobs (PLAN §2.2) ---------------------------------------------------------------------

export const Pillar = z.enum(["investment", "location", "marketing", "audience"]);
export type Pillar = z.infer<typeof Pillar>;

export const PILLAR_LABEL: Readonly<Record<Pillar, string>> = {
  investment: "INVESTMENT",
  location: "LOCATION",
  marketing: "MARKETING",
  audience: "AUDIENCE",
};

export const Job = z.enum([
  "brand_health",
  "head_to_head",
  "site_selection",
  "area_profile",
  "tenant_mix",
  "sponsorship",
  "market_selection",
  "audience_discovery",
]);
export type Job = z.infer<typeof Job>;

export const JOB_MNEMONIC = {
  brand_health: "HLTH",
  head_to_head: "VS",
  site_selection: "SITE",
  area_profile: "DNA",
  tenant_mix: "TEN",
  sponsorship: "SPON",
  market_selection: "MKTS",
  audience_discovery: "AUD",
} as const satisfies Record<Job, string>;
export type JobMnemonic = (typeof JOB_MNEMONIC)[Job];

export const JOB_PILLAR: Readonly<Record<Job, Pillar>> = {
  brand_health: "investment",
  head_to_head: "investment",
  site_selection: "location",
  area_profile: "location",
  tenant_mix: "location",
  sponsorship: "marketing",
  market_selection: "marketing",
  audience_discovery: "audience",
};

export const JOBS_BY_PILLAR: Readonly<Record<Pillar, readonly Job[]>> = {
  investment: ["brand_health", "head_to_head"],
  location: ["site_selection", "area_profile", "tenant_mix"],
  marketing: ["sponsorship", "market_selection"],
  audience: ["audience_discovery"],
};

// Roles (D10) --------------------------------------------------------------------------------------

export const Role = z.enum(["CLERK", "ANALYST", "QUANT", "CHECKER", "GHOST"]);
export type Role = z.infer<typeof Role>;

// Evidence vocabulary (D7, D8, §6) -----------------------------------------------------------------

export const Badge = z.enum(["MEASURED", "DERIVED", "ESTIMATED", "STALE", "UNAVAILABLE"]);
export type Badge = z.infer<typeof Badge>;

/** The verdict "for this question" (D8). Never buy/sell, price targets or ratings. */
export const Signal = z.enum(["strong", "mixed", "weak", "insufficient_evidence"]);
export type Signal = z.infer<typeof Signal>;

/** What every delta is measured against (§2.4). `<Delta>` will not render without one. */
export const Comparator = z.enum(["CITY", "PEERS", "BASELINE", "WITHIN_CALL"]);
export type Comparator = z.infer<typeof Comparator>;

export const COMPARATOR_LABEL: Readonly<Record<Comparator, string>> = {
  CITY: "Δ vs CITY",
  PEERS: "Δ vs PEERS",
  BASELINE: "Δ vs BASELINE",
  WITHIN_CALL: "Δ WITHIN-CALL",
};

/**
 * Data-quality flags. They feed limitations (§6) and confidence (§6.4), never findings.
 * - CANDIDATES_UNSCORED: some requested candidate has no score somewhere (umbrella limitation).
 * - DROPPED_CANDIDATES: Qloo omitted requested candidates from a context (G2).
 * - NOT_SCORED: candidates tied at the row's floor value, treated as unscored, never ranked (G1).
 * - THIN_RESULT: a call returned fewer than 5 rows (a §6.4 confidence penalty).
 */
export const Flag = z.enum([
  "TRENDING_HISTORICAL_WINDOW",
  "NO_TREND_SIGNAL",
  "CANDIDATES_UNSCORED",
  "COARSE_GEOHASH",
  "LOCATION_FALLBACK",
  "DEMOGRAPHICS_ARE_INDICES",
  "SUPPLY_SAMPLE_ONLY",
  "STALE_CACHE",
  "BUDGET_TRUNCATED",
  "SECONDARY_ENTITY_DROPPED",
  "QUALITY_GATE_DROPPED",
  "SENSITIVE_SEGMENT_BLOCKED",
  "INCOMPLETE_RUN",
  "DROPPED_CANDIDATES",
  "NOT_SCORED",
  "THIN_RESULT",
]);
export type Flag = z.infer<typeof Flag>;

/** Code detectors that drive ANALYST turn 2 (PLAN §4.4). */
export const FindingKind = z.enum([
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
]);
export type FindingKind = z.infer<typeof FindingKind>;

export const Severity = z.enum(["info", "low", "medium", "high"]);
export type Severity = z.infer<typeof Severity>;
export const SEVERITY_RANK: Readonly<Record<Severity, number>> = { info: 0, low: 1, medium: 2, high: 3 };

/** The Qloo kit's 9 workflows (D30); the README maps every tool to them. */
export const KitWorkflow = z.enum([
  "recommend",
  "rank",
  "compare_audiences",
  "where_popular",
  "entity_tags",
  "audience_demographics",
  "find_tags",
  "describe",
  "trends",
]);
export type KitWorkflow = z.infer<typeof KitWorkflow>;

// Tools (PLAN §4.3) -----------------------------------------------------------------------------------

/** The 12 skill tools: each is backed by one QUANT skill and costs Qloo calls. */
export const SkillId = z.enum([
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
]);
export type SkillId = z.infer<typeof SkillId>;

/** The 14 P0 ANALYST tools: the skill tools plus the two strict submit tools. */
export const ToolName = z.enum(["submit_plan", ...SkillId.options, "submit_report"]);
export type ToolName = z.infer<typeof ToolName>;

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
  submit_report: "REPORT",
} as const satisfies Record<ToolName, string>;
export type ToolMnemonic = (typeof TOOL_MNEMONIC)[ToolName];

// Runs ------------------------------------------------------------------------------------------------

export const RunStatus = z.enum([
  "queued",
  "needs_input",
  "running",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "refused",
]);
export type RunStatus = z.infer<typeof RunStatus>;

/** Statuses a run can end in. needs_input ends the run: the picker starts a new run with pins. */
export const TerminalRunStatus = RunStatus.extract([
  "needs_input",
  "completed",
  "incomplete",
  "failed",
  "cancelled",
  "refused",
]);
export type TerminalRunStatus = z.infer<typeof TerminalRunStatus>;

export const Mode = z.enum(["live", "economy", "replay_only"]);
export type Mode = z.infer<typeof Mode>;

export const Lane = z.enum(["public", "judge"]);
export type Lane = z.infer<typeof Lane>;

/** Where the ANALYST loop is when a skill runs (D4). */
export const Phase = z.enum(["scan", "wave1", "followup"]);
export type Phase = z.infer<typeof Phase>;

/** How a Qloo call was served. `reused` is a cache hit first fetched by another run (REUSED chip). */
export const CacheStatus = z.enum(["hit", "miss", "stale", "coalesced", "reused"]);
export type CacheStatus = z.infer<typeof CacheStatus>;

/** Outcome of one skill or tool call. */
export const SkillStatus = z.enum(["ok", "partial", "empty", "error"]);
export type SkillStatus = z.infer<typeof SkillStatus>;

// Qloo vocabulary -----------------------------------------------------------------------------------

/** Qloo's six age buckets, in ascending order (G12). */
export const AgeBucket = z.enum(["24_and_younger", "25_to_29", "30_to_34", "35_to_44", "45_to_54", "55_and_older"]);
export type AgeBucket = z.infer<typeof AgeBucket>;

export const AGE_BUCKET_LABEL: Readonly<Record<AgeBucket, string>> = {
  "24_and_younger": "≤24",
  "25_to_29": "25–29",
  "30_to_34": "30–34",
  "35_to_44": "35–44",
  "45_to_54": "45–54",
  "55_and_older": "55+",
};

/** Youth tilt compares these (S2/S3): mean over the young pair minus mean over the old pair. */
export const YOUNG_AGE_BUCKETS = ["24_and_younger", "25_to_29"] as const satisfies readonly AgeBucket[];
export const OLD_AGE_BUCKETS = ["45_to_54", "55_and_older"] as const satisfies readonly AgeBucket[];

export const Gender = z.enum(["male", "female"]);
export type Gender = z.infer<typeof Gender>;

/** Entity types the resolution gate and the tools work with. */
export const EntityType = z.enum(["brand", "artist", "person", "podcast", "tv_show", "movie", "place", "destination"]);
export type EntityType = z.infer<typeof EntityType>;

export const entityTypeUrn = (t: EntityType): `urn:entity:${EntityType}` => `urn:entity:${t}`;

/** Result domains for the cultural neighbourhood (S9). */
export const Domain = EntityType.extract(["artist", "podcast", "tv_show", "brand", "movie"]);
export type Domain = z.infer<typeof Domain>;

/** Types /v2/trending returns points for in the frozen window (G11). Artists and persons are UNAVAILABLE. */
export const TrendingType = EntityType.extract(["brand", "tv_show"]);
export type TrendingType = z.infer<typeof TrendingType>;

/** Which entity family a concept should map to when looking up tags. */
export const TagScope = z.enum(["place", "brand", "media"]);
export type TagScope = z.infer<typeof TagScope>;

/** Resolution outcome per mention (D20). Only `exact` is ever applied. */
export const MatchClass = z.enum(["exact", "ambiguous", "inexact", "not_found"]);
export type MatchClass = z.infer<typeof MatchClass>;

export const MentionRole = z.enum(["primary", "peer", "secondary"]);
export type MentionRole = z.infer<typeof MentionRole>;

/** Sponsor categories (S10, built from probe G14). A run uses at most six. */
export const SponsorCategory = z.enum([
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
]);
export type SponsorCategory = z.infer<typeof SponsorCategory>;

// Geography (D28) ------------------------------------------------------------------------------------

/**
 * Gazetteer metros: the ones with neighbourhood polygons (LIFT, BLOCK, areas). "nyc" is reserved
 * for P1 and joins this enum then; it is deliberately absent so P0 tools cannot accept it.
 */
export const MetroId = z.enum(["nashville", "austin"]);
export type MetroId = z.infer<typeof MetroId>;
export const RESERVED_METRO_IDS = ["nyc"] as const;

export const METRO_LABEL: Readonly<Record<MetroId, string>> = { nashville: "Nashville", austin: "Austin" };

/**
 * A market metro for locality-signal contexts (SHARE metros, SLATE markets, RANK metro contexts).
 * Markets are a wider list than the gazetteer metros: config/metros.json maps each id to a /search
 * query and kv pins its locality UUID. Every MetroId is also a MarketId.
 */
export const MarketId = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, { message: "expected a market id such as nashville" })
  .describe("market metro id from the MARKETS list in the run context, e.g. nashville");
export type MarketId = z.infer<typeof MarketId>;

// Exhibit vocabulary -------------------------------------------------------------------------------

/** Travel-taste and sponsor quadrants, split at within-set medians (D17). */
export const QuadrantName = z.enum(["HEARTLAND", "HIDDEN_POCKET", "MASS", "COLD"]);
export type QuadrantName = z.infer<typeof QuadrantName>;

/** Neighbourhood white-space quadrants (S6): demand × supply split at medians. */
export const WhiteSpaceQuadrant = z.enum(["LATENT_OPEN", "PROVEN_CROWDED", "SATURATED", "COLD"]);
export type WhiteSpaceQuadrant = z.infer<typeof WhiteSpaceQuadrant>;

/** Block DNA tag families (S7). WHO is shown as "venue-goer taste tags". */
export const BlockFamily = z.enum(["WHO", "VIBE", "WHAT", "SOUND"]);
export type BlockFamily = z.infer<typeof BlockFamily>;

/** The BLOCK location ladder; each step down is a CODE FALLBACK (PROBE consequence 6: no radius). */
export const LocationMethod = z.enum(["POLYGON", "POINT", "QUERY"]);
export type LocationMethod = z.infer<typeof LocationMethod>;

export const MomentumTrend = z.enum(["rising", "flat", "declining"]);
export type MomentumTrend = z.infer<typeof MomentumTrend>;

/** Taste Position card axes, in display order (§5.4). */
export const PositionAxis = z.enum(["distinctiveness", "reach", "next_gen_tilt", "metro_breadth", "momentum"]);
export type PositionAxis = z.infer<typeof PositionAxis>;

/**
 * Why a value is missing. UNAVAILABLE is never encoded as 0: a cell carries value null plus one of these.
 * - not_scored: tied at the row's floor value (G1); dropped: Qloo omitted the candidate (G2)
 * - not_measured: no data block for the entity (G12); no_signal: flat or too-short series (S4)
 * - unavailable: Qloo offers no data of this kind for the type; quality_gate: popularity < 0.01
 * - budget_truncated: the call was not made; insufficient_n / coarse: below the lift gates (D18)
 * - self: matrix diagonal; error: the call failed
 */
export const NoValueReason = z.enum([
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
]);
export type NoValueReason = z.infer<typeof NoValueReason>;

/** How a metric's value reads. `affinity` is a raw per-query score: CHECKER V6 forbids comparing two across calls. */
export const MetricUnit = z.enum([
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
]);
export type MetricUnit = z.infer<typeof MetricUnit>;

export const ConfidenceBand = z.enum(["HIGH", "MED", "LOW"]);
export type ConfidenceBand = z.infer<typeof ConfidenceBand>;

/** Evidence-strength pills on arguments (§6.4). */
export const Strength = z.enum(["STRONG", "MODERATE", "THIN"]);
export type Strength = z.infer<typeof Strength>;

export const ArgumentSection = z.enum(["audience", "competition", "geography", "momentum", "opportunity", "risk"]);
export type ArgumentSection = z.infer<typeof ArgumentSection>;

export const Priority = z.enum(["now", "next", "later"]);
export type Priority = z.infer<typeof Priority>;

/** Verdict on a hypothesis as the ANALYST writes it in submit_report. */
export const HypothesisVerdict = z.enum(["confirmed", "refuted", "inconclusive"]);
export type HypothesisVerdict = z.infer<typeof HypothesisVerdict>;

/** The same verdict as the Scorecard pill shows it. */
export const ScorecardVerdict = z.enum(["CONFIRMED", "REFUTED", "INCONCLUSIVE"]);
export type ScorecardVerdict = z.infer<typeof ScorecardVerdict>;

export const toScorecardVerdict = (v: HypothesisVerdict): ScorecardVerdict =>
  v.toUpperCase() as ScorecardVerdict;

/** CLERK refusal and reframe categories (clerk.md, §4.5). financial_advice is reframed, not refused. */
export const SafetyCategory = z.enum([
  "private_individual",
  "sensitive_inference",
  "political_targeting",
  "eligibility",
  "residential_screening",
  "injection",
  "financial_advice",
  "out_of_scope",
]);
export type SafetyCategory = z.infer<typeof SafetyCategory>;
