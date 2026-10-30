import { z } from "zod";
import {
  PILLAR_VALUES,
  JOB_VALUES,
  JOB_MNEMONIC,
  ROLE_VALUES,
  BADGE_VALUES,
  SIGNAL_VALUES,
  COMPARATOR_VALUES,
  FLAG_VALUES,
  FINDING_KIND_VALUES,
  SEVERITY_VALUES,
  KIT_WORKFLOW_VALUES,
  SKILL_ID_VALUES,
  TOOL_NAME_VALUES,
  TOOL_MNEMONIC,
  RUN_STATUS_VALUES,
  TERMINAL_RUN_STATUS_VALUES,
  MODE_VALUES,
  LANE_VALUES,
  PHASE_VALUES,
  CACHE_STATUS_VALUES,
  EVIDENCE_SOURCE_VALUES,
  PUBLIC_SOURCE_VALUES,
  SKILL_STATUS_VALUES,
  AGE_BUCKET_VALUES,
  GENDER_VALUES,
  ENTITY_TYPE_VALUES,
  DOMAIN_VALUES,
  TRENDING_TYPE_VALUES,
  TAG_SCOPE_VALUES,
  MATCH_CLASS_VALUES,
  MENTION_ROLE_VALUES,
  CANDIDATE_SOURCE_VALUES,
  CONCEPT_MATCH_VALUES,
  AREA_STANDING_VALUES,
  SPONSOR_CATEGORY_VALUES,
  METRO_ID_VALUES,
  MARKET_ID_RE,
  QUADRANT_NAME_VALUES,
  WHITE_SPACE_QUADRANT_VALUES,
  BLOCK_FAMILY_VALUES,
  LOCATION_METHOD_VALUES,
  MOMENTUM_TREND_VALUES,
  POSITION_AXIS_VALUES,
  NO_VALUE_REASON_VALUES,
  METRIC_UNIT_VALUES,
  CONFIDENCE_BAND_VALUES,
  STRENGTH_VALUES,
  ARGUMENT_SECTION_VALUES,
  PRIORITY_VALUES,
  HYPOTHESIS_VERDICT_VALUES,
  SCORECARD_VERDICT_VALUES,
  SAFETY_CATEGORY_VALUES,
} from "./values/enums";

/**
 * The shared vocabulary as zod enums, built from the zod-free value arrays in ./values/enums.ts (which also
 * holds the label maps). Everything there is re-exported here, so the barrel API is unchanged.
 */
export * from "./values/enums";

/** An ISO 8601 timestamp, UTC `Z` or with an explicit offset (database drivers return either). */
export const IsoDateTime = z.iso.datetime({ offset: true });

// Desks and jobs (PLAN §2.2) ---------------------------------------------------------------------

export const Pillar = z.enum(PILLAR_VALUES);
export type Pillar = z.infer<typeof Pillar>;

export const Job = z.enum(JOB_VALUES);
export type Job = z.infer<typeof Job>;

export type JobMnemonic = (typeof JOB_MNEMONIC)[Job];

// Roles (D10) --------------------------------------------------------------------------------------

export const Role = z.enum(ROLE_VALUES);
export type Role = z.infer<typeof Role>;

// Evidence vocabulary (D7, D8, §6) -----------------------------------------------------------------

export const Badge = z.enum(BADGE_VALUES);
export type Badge = z.infer<typeof Badge>;

/** The verdict "for this question" (D8). Never buy/sell, price targets or ratings. */
export const Signal = z.enum(SIGNAL_VALUES);
export type Signal = z.infer<typeof Signal>;

/** What every delta is measured against (§2.4). `<Delta>` will not render without one. */
export const Comparator = z.enum(COMPARATOR_VALUES);
export type Comparator = z.infer<typeof Comparator>;

/**
 * Data-quality flags. They feed limitations (§6) and confidence (§6.4), never findings.
 * - CANDIDATES_UNSCORED: some requested candidate has no score somewhere (umbrella limitation).
 * - DROPPED_CANDIDATES: Qloo omitted requested candidates from a context (G2).
 * - NOT_SCORED: candidates tied at the row's floor value, treated as unscored, never ranked (G1).
 * - THIN_RESULT: a call returned fewer than 5 rows (a §6.4 confidence penalty).
 * - SUPPLY_UNAVAILABLE: similar venues could not be counted (no verified category tag for the place
 *   type), so the competitor count is unknown, never 0.
 * - READ_AS_NEAREST_JOB: the question was read as the nearest job (D41); the limitation names what the
 *   data does not cover (sales, prices, rents, foot traffic …).
 * - NOT_A_LISTED_COMPANY: the brand maps to no SEC-listed company in config/listed_companies.json
 *   (private or not mapped), so no financial figures are shown and none are guessed.
 * - CENSUS_RESIDENTS_ONLY: Census figures describe residents of the area, not its visitors or customers,
 *   and are kept apart from taste signals.
 * - SEC_NOT_CONFIGURED / CENSUS_NOT_CONFIGURED: the source is not configured on this server, so its tool
 *   was not planned or run (D7 of the Part 9 close-out). The limitation states PUBLIC_NOT_CONFIGURED_REASON
 *   verbatim; no figure from that source is shown or guessed.
 * - CONCEPT_NOT_IN_DATA: a product or concept the question names has no tag in the data, so it was tested
 *   at category level (the nearest category its tag search returned) or not at all. Code writes the
 *   limitation with the names (conceptDisclosure in the agent), puts it first and opens the thesis with it.
 * - EXPECTED_CANDIDATE_MISSING (R3): names a specialist would check first (CLERK's obvious candidates) were
 *   not found under that name in the data; one limitation lists them, and no look-alike takes their place.
 * - CATEGORY_LEVEL_READ (R2): the concept is not in the data, so the answer reads its broader category; it
 *   gives no winner, keep or veto for the concept itself and caps confidence (category_level).
 * - PROXY_TAG_IGNORED (R2): a look-alike tag that stands in for the concept was found and not used for a verdict.
 * - SUBJECT_NO_DATA: the primary entity resolved, but every call that used it returned empty or failed; the
 *   signal is insufficient_evidence and no look-alike is used in its place (CHECKER V7).
 * - OSM_NOT_CONFIGURED: OpenStreetMap is not configured on this server (no OSM_USER_AGENT), so local_supply
 *   was not planned or run; the limitation states PUBLIC_NOT_CONFIGURED_REASON.osm verbatim.
 * - OSM_SUPPLY_FLOOR: OpenStreetMap is mapped by volunteers, so every count is a floor, not a census.
 * - NOT_SEPARATELY_REPORTED: the brand is part of a listed parent; SEC filings report the parent as a whole,
 *   so no figures are shown for the brand.
 */
export const Flag = z.enum(FLAG_VALUES);
export type Flag = z.infer<typeof Flag>;

/**
 * Code detectors that drive ANALYST turn 2 (PLAN §4.4).
 * - PARTNERS_ONE_CATEGORY (brand_collab): most of the discovered partners share one top-level category
 *   after the subject's own category is left out; suggests sponsor_slate seeded by the subject over the
 *   sponsor categories the discovered partners do not cover, so the pivot is structural.
 * - OVERSUPPLIED / UNDERSUPPLIED (local_supply): an area has many more (index ≥ 1.5 and at least 5 places) or
 *   many fewer (index ≤ 0.5) places of a type per km² than its city; suggests block_dna. Severity medium.
 * - LOW_STREET_ACTIVITY (local_supply): an area has under 0.3 × its city's shops, food and drink places per
 *   km². No follow-up. Severity low.
 */
export const FindingKind = z.enum(FINDING_KIND_VALUES);
export type FindingKind = z.infer<typeof FindingKind>;

export const Severity = z.enum(SEVERITY_VALUES);
export type Severity = z.infer<typeof Severity>;

/** The Qloo kit's 9 workflows (D30); the README maps every tool to them. */
export const KitWorkflow = z.enum(KIT_WORKFLOW_VALUES);
export type KitWorkflow = z.infer<typeof KitWorkflow>;

// Tools (PLAN §4.3) -----------------------------------------------------------------------------------

/**
 * The 17 skill tools: each is backed by one QUANT skill. All but three cost Qloo calls; company_financials
 * (SEC EDGAR), area_economics (US Census ACS) and local_supply (OpenStreetMap) read public data and cost 0
 * Qloo calls.
 */
export const SkillId = z.enum(SKILL_ID_VALUES);
export type SkillId = z.infer<typeof SkillId>;

/** The 19 ANALYST tools: the 17 skill tools plus the two submit tools. */
export const ToolName = z.enum(TOOL_NAME_VALUES);
export type ToolName = z.infer<typeof ToolName>;

export type ToolMnemonic = (typeof TOOL_MNEMONIC)[ToolName];

// Runs ------------------------------------------------------------------------------------------------

export const RunStatus = z.enum(RUN_STATUS_VALUES);
export type RunStatus = z.infer<typeof RunStatus>;

/** Statuses a run can end in. needs_input ends the run: the picker starts a new run with pins. */
export const TerminalRunStatus = RunStatus.extract(TERMINAL_RUN_STATUS_VALUES);
export type TerminalRunStatus = z.infer<typeof TerminalRunStatus>;

export const Mode = z.enum(MODE_VALUES);
export type Mode = z.infer<typeof Mode>;

export const Lane = z.enum(LANE_VALUES);
export type Lane = z.infer<typeof Lane>;

/** Where the ANALYST loop is when a skill runs (D4). */
export const Phase = z.enum(PHASE_VALUES);
export type Phase = z.infer<typeof Phase>;

/**
 * How a Qloo or public-data call was served. `reused` is a cache hit first fetched by another run
 * (REUSED chip).
 */
export const CacheStatus = z.enum(CACHE_STATUS_VALUES);
export type CacheStatus = z.infer<typeof CacheStatus>;

/** Where an evidence bundle's data came from: Qloo, or one of the public sources (SEC EDGAR, US Census, OpenStreetMap). */
export const EvidenceSource = z.enum(EVIDENCE_SOURCE_VALUES);
export type EvidenceSource = z.infer<typeof EvidenceSource>;

/** The public data sources (PLAN §5.2). They cost no Qloo calls. */
export const PublicSource = z.enum(PUBLIC_SOURCE_VALUES);
export type PublicSource = z.infer<typeof PublicSource>;

/** Outcome of one skill or tool call. */
export const SkillStatus = z.enum(SKILL_STATUS_VALUES);
export type SkillStatus = z.infer<typeof SkillStatus>;

// Qloo vocabulary -----------------------------------------------------------------------------------

/** Qloo's six age buckets, in ascending order (G12). */
export const AgeBucket = z.enum(AGE_BUCKET_VALUES);
export type AgeBucket = z.infer<typeof AgeBucket>;



export const Gender = z.enum(GENDER_VALUES);
export type Gender = z.infer<typeof Gender>;

/** Entity types the resolution gate and the tools work with. */
export const EntityType = z.enum(ENTITY_TYPE_VALUES);
export type EntityType = z.infer<typeof EntityType>;

export const entityTypeUrn = (t: EntityType): `urn:entity:${EntityType}` => `urn:entity:${t}`;

/** Result domains for the cultural neighbourhood (S9). */
export const Domain = EntityType.extract(DOMAIN_VALUES);
export type Domain = z.infer<typeof Domain>;

/** Types /v2/trending returns points for in the frozen window (G11). Artists and persons are UNAVAILABLE. */
export const TrendingType = EntityType.extract(TRENDING_TYPE_VALUES);
export type TrendingType = z.infer<typeof TrendingType>;

/** Which entity family a concept should map to when looking up tags. */
export const TagScope = z.enum(TAG_SCOPE_VALUES);
export type TagScope = z.infer<typeof TagScope>;

/** Resolution outcome per mention (D20). Only `exact` is ever applied. */
export const MatchClass = z.enum(MATCH_CLASS_VALUES);
export type MatchClass = z.infer<typeof MatchClass>;

export const MentionRole = z.enum(MENTION_ROLE_VALUES);
export type MentionRole = z.infer<typeof MentionRole>;

/** Where a candidate in a set came from (R3, D49); see CANDIDATE_SOURCE_VALUES. Absent on a row = `data`. */
export const CandidateSource = z.enum(CANDIDATE_SOURCE_VALUES);
export type CandidateSource = z.infer<typeof CandidateSource>;

/** How a concept tag matches the question's concept (R2, D48); see CONCEPT_MATCH_VALUES. */
export const ConceptMatch = z.enum(CONCEPT_MATCH_VALUES);
export type ConceptMatch = z.infer<typeof ConceptMatch>;

/** Where an area stands for a concept (R7, D50); see AREA_STANDING_VALUES. */
export const AreaStanding = z.enum(AREA_STANDING_VALUES);
export type AreaStanding = z.infer<typeof AreaStanding>;

/** Sponsor categories (S10, built from probes G14, P5 and C2). A run uses at most six. */
export const SponsorCategory = z.enum(SPONSOR_CATEGORY_VALUES);
export type SponsorCategory = z.infer<typeof SponsorCategory>;

// Geography (D28) ------------------------------------------------------------------------------------

/**
 * Gazetteer metros, the 13 map cities: the ones with neighbourhood polygons (LIFT, BLOCK, areas), D28.
 * Nashville ships Census ZIP areas (D37), Austin its planning areas, New York its community districts,
 * and the other ten Census ZIP areas clipped to their core counties (D39).
 */
export const MetroId = z.enum(METRO_ID_VALUES);
export type MetroId = z.infer<typeof MetroId>;


/**
 * A market metro for locality-signal contexts (SHARE metros, SLATE markets, RANK metro contexts).
 * Markets are a wider list than the gazetteer metros: config/metros.json maps each id to a /search
 * query and kv pins its locality UUID. Every MetroId is also a MarketId.
 */
export const MarketId = z
  .string()
  .regex(MARKET_ID_RE, { message: "expected a market id such as nashville" })
  .describe("market metro id from the MARKETS list in the run context, e.g. nashville");
export type MarketId = z.infer<typeof MarketId>;

// Exhibit vocabulary -------------------------------------------------------------------------------

/** Travel-taste and sponsor quadrants, split at within-set medians (D17). */
export const QuadrantName = z.enum(QUADRANT_NAME_VALUES);
export type QuadrantName = z.infer<typeof QuadrantName>;

/** Neighbourhood white-space quadrants (S6): demand × supply split at medians. */
export const WhiteSpaceQuadrant = z.enum(WHITE_SPACE_QUADRANT_VALUES);
export type WhiteSpaceQuadrant = z.infer<typeof WhiteSpaceQuadrant>;

/** Block DNA tag families (S7). WHO is shown as "venue-goer taste tags". */
export const BlockFamily = z.enum(BLOCK_FAMILY_VALUES);
export type BlockFamily = z.infer<typeof BlockFamily>;

/** The BLOCK location ladder; each step down is a CODE FALLBACK (PROBE consequence 6: no radius). */
export const LocationMethod = z.enum(LOCATION_METHOD_VALUES);
export type LocationMethod = z.infer<typeof LocationMethod>;

export const MomentumTrend = z.enum(MOMENTUM_TREND_VALUES);
export type MomentumTrend = z.infer<typeof MomentumTrend>;

/** Taste Position card axes, in display order (§5.4). */
export const PositionAxis = z.enum(POSITION_AXIS_VALUES);
export type PositionAxis = z.infer<typeof PositionAxis>;

/**
 * Why a value is missing. UNAVAILABLE is never encoded as 0: a cell carries value null plus one of these.
 * - not_scored: tied at the row's floor value (G1); dropped: Qloo omitted the candidate (G2)
 * - not_measured: no data block for the entity (G12); no_signal: flat or too-short series (S4)
 * - unavailable: Qloo offers no data of this kind for the type; quality_gate: popularity < 0.01
 * - budget_truncated: the call was not made; insufficient_n / coarse: below the lift gates (D18)
 * - self: matrix diagonal; error: the call failed
 * - not_listed: the brand maps to no SEC-listed company; not_reported: the filings carry no value for
 *   the concept and period; suppressed: Census withheld or could not compute the estimate (ACS null or
 *   a negative sentinel such as -666666666)
 * - not_configured: the public source (SEC EDGAR or US Census) is not configured on this server
 */
export const NoValueReason = z.enum(NO_VALUE_REASON_VALUES);
export type NoValueReason = z.infer<typeof NoValueReason>;

/**
 * How a metric's value reads. `affinity` is a raw per-query score: CHECKER V6 forbids comparing two across
 * calls. `usd` is a reported dollar amount (SEC), `years` an age such as a median age and `people` a head
 * count such as a population (Census).
 */
export const MetricUnit = z.enum(METRIC_UNIT_VALUES);
export type MetricUnit = z.infer<typeof MetricUnit>;

export const ConfidenceBand = z.enum(CONFIDENCE_BAND_VALUES);
export type ConfidenceBand = z.infer<typeof ConfidenceBand>;

/** Evidence-strength pills on arguments (§6.4). */
export const Strength = z.enum(STRENGTH_VALUES);
export type Strength = z.infer<typeof Strength>;

export const ArgumentSection = z.enum(ARGUMENT_SECTION_VALUES);
export type ArgumentSection = z.infer<typeof ArgumentSection>;

export const Priority = z.enum(PRIORITY_VALUES);
export type Priority = z.infer<typeof Priority>;

/** Verdict on a hypothesis as the ANALYST writes it in submit_report. */
export const HypothesisVerdict = z.enum(HYPOTHESIS_VERDICT_VALUES);
export type HypothesisVerdict = z.infer<typeof HypothesisVerdict>;

/** The same verdict as the Scorecard pill shows it. */
export const ScorecardVerdict = z.enum(SCORECARD_VERDICT_VALUES);
export type ScorecardVerdict = z.infer<typeof ScorecardVerdict>;

export const toScorecardVerdict = (v: HypothesisVerdict): ScorecardVerdict =>
  v.toUpperCase() as ScorecardVerdict;

/** CLERK refusal and reframe categories (clerk.md, §4.5). financial_advice is reframed, not refused. */
export const SafetyCategory = z.enum(SAFETY_CATEGORY_VALUES);
export type SafetyCategory = z.infer<typeof SafetyCategory>;
