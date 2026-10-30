import type { z } from "zod";
import type {
  CandidateSource,
  ConceptMatch,
  EntityType,
  Flag,
  KitWorkflow,
  MarketId,
  MetroId,
  Phase,
  Pillar,
  PublicSource,
  SkillId,
  SkillStatus,
  ToolMnemonic,
} from "./enums";
import type { EventInput } from "./events";
import type { DatasetId, EntityRef, EvidenceId, FindingId, MetricId, TagRef } from "./ids";
import type { DatasetEnvelope, Evidence, Finding, Metric, QlooCallMeta, QlooResult } from "./ledger";
import type { PublicCallMeta, PublicDataApi } from "./public-data";
import type { RunLimits } from "./limits";
import type {
  InsightsFilterType,
  InsightsResponse,
  QlooAudiencesResponse,
  QlooEntitiesResponse,
  QlooParams,
  QlooPath,
  QlooSearchResponse,
  QlooTagsResponse,
  QlooTrendingResponse,
} from "./qloo-types";
import type { ModelDigest, ToolInput } from "./tools";

/**
 * The skill contract (PLAN §10.1). A skill is one QUANT analysis behind one ANALYST tool; opening
 * scans run the same skills with default arguments. Skills reach Qloo, the ledger, the gazetteer and
 * the registry only through SkillCtx, so every number they produce lands in the ledger with receipts.
 */

export type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

// Qloo (implemented by @ct/qloo) ---------------------------------------------------------------------

/**
 * The Qloo client as skills see it: GET-only, allowlisted, cached, rate-limited and budgeted. It
 * throws on any parameter outside the frozen allowlist, and a budget gate failure surfaces as a
 * typed error that the skill turns into BUDGET_TRUNCATED. `/v2/analysis/compare` is not part of P0
 * (probe G13). The scoped instance in SkillCtx attributes every call to the current tool call.
 */
export interface QlooApi {
  search(params: QlooParams): Promise<QlooResult<QlooSearchResponse>>;
  entities(entityIds: readonly string[]): Promise<QlooResult<QlooEntitiesResponse>>;
  tags(params: QlooParams): Promise<QlooResult<QlooTagsResponse>>;
  audiences(params: QlooParams): Promise<QlooResult<QlooAudiencesResponse>>;
  /** `filter.type` is the first argument and must not be repeated in `params`. */
  insights<F extends InsightsFilterType>(filterType: F, params: QlooParams): Promise<QlooResult<InsightsResponse<F>>>;
  trending(params: QlooParams): Promise<QlooResult<QlooTrendingResponse>>;
}

/** Answers "would this exact request be served from cache?" without spending a call. */
export interface CacheProbe {
  has(path: QlooPath, params: QlooParams): Promise<boolean>;
}

// Ledger (implemented by the agent with @ct/db) --------------------------------------------------------

interface EvidenceInputBase {
  skill: SkillId;
  purpose: string;
  status: SkillStatus;
  summary: string;
  flags: readonly Flag[];
  /** Results this bundle's quality gate dropped (QUALITY_GATE_DROPPED; −5 each, §6.4). Default 0. */
  qualityGateDrops?: number;
}

/**
 * One evidence bundle to record. The calls are of one source: Qloo calls (source absent or "qloo"), or
 * the SEC or Census calls of a public-data skill, whose `source` must match every call's source. The
 * ledger derives ids, request ids or references, caching and provenance from them.
 */
export type EvidenceInput = EvidenceInputBase &
  (
    | { source?: "qloo"; calls: readonly QlooCallMeta[] }
    | { source: PublicSource; calls: readonly PublicCallMeta[] }
  );
export type MetricInput = Omit<Metric, "id">;
export type FindingInput = Omit<Finding, "id">;
export type DatasetInput = DistributiveOmit<DatasetEnvelope, "id">;

/**
 * Run-scoped ledger. Each add validates its input, assigns the next id (E#, M#, D#, F#), stores it
 * and emits the matching event (`evidence`, `metric`, `dataset.ready`, `finding`), so a skill cannot
 * produce a number the trace and the CHECKER do not see.
 */
export interface Ledger {
  addEvidence(input: EvidenceInput): Evidence;
  addMetric(input: MetricInput): Metric;
  addDataset(input: DatasetInput): DatasetEnvelope;
  addFinding(input: FindingInput): Finding;
  evidence(id: EvidenceId): Evidence | undefined;
  metric(id: MetricId): Metric | undefined;
  dataset(id: DatasetId): DatasetEnvelope | undefined;
  finding(id: FindingId): Finding | undefined;
}

// Gazetteer (implemented by @ct/geo) -------------------------------------------------------------------

export interface LatLon {
  lat: number;
  lon: number;
}

export interface Neighbourhood {
  /** Stable slug, e.g. east_nashville; the `ref` of an `{kind: "nbhd"}` area. */
  id: string;
  name: string;
  metro: MetroId;
  centroid: LatLon;
  areaKm2: number;
}

export interface GeoApi {
  metros(): readonly MetroId[];
  neighbourhoods(metro: MetroId): readonly Neighbourhood[];
  neighbourhood(metro: MetroId, id: string): Neighbourhood | null;
  /** Matches CLERK's area text (e.g. "East Nashville") to a neighbourhood by normalised name. */
  matchNeighbourhood(metro: MetroId, text: string): Neighbourhood | null;
  /** The neighbourhood polygon as lon-first WKT with at most 40 vertices, for signal.location. */
  polygonWkt(metro: MetroId, id: string): string | null;
  /** Point-in-polygon: the neighbourhood containing a point, or null. */
  locate(metro: MetroId, point: LatLon): string | null;
  geohashCentroid(geohash: string): LatLon;
  /** Boundary attribution for exhibit captions. */
  boundarySource(metro: MetroId): string;
  /**
   * The census units an area's ACS figures come from (@ct/geo's crosswalk); null for an area the
   * catalog does not list. Optional: a GeoApi without it has no crosswalk, and area_economics answers
   * unavailable.
   */
  censusUnits?(metro: MetroId, id: string): Promise<CensusUnits | null>;
  /** Every area of a city's units, in catalog order: the city comparator row of area_economics. */
  censusUnitsOfMetro?(metro: MetroId): Promise<CensusUnits[]>;
}

/** A ZIP area's census units: whole ZCTAs. */
export interface ZctaUnits {
  kind: "zcta";
  metro: MetroId;
  areaId: string;
  /** Five-digit ZCTAs, the id's first, then merged ones in alias order. */
  zctas: readonly string[];
  /** The area is part of its ZIP(s) only, so whole-ZIP figures describe more than the area. */
  clipped: boolean;
  /** Percent of the ZCTAs' land inside the city's counties; null when 99% or more is. */
  insidePct: number | null;
}

/** A New York or Austin area's census units: whole 2020 tracts assigned by interior point. */
export interface TractUnits {
  kind: "tract";
  metro: MetroId;
  areaId: string;
  /**
   * 11-digit tract GEOIDs, sorted. When no tract's interior point lies in the area, the one nearest its
   * centre (`nearestOnly`), or none when no tract point is close.
   */
  tracts: readonly string[];
  /** The area holds no tract's interior point: its one tract is the nearest, and reaches beyond the area. */
  nearestOnly: boolean;
  /** The counties the tracts are in: one ACS tract request each (CensusGeo tract). */
  counties: readonly { state: string; county: string }[];
}

export type CensusUnits = ZctaUnits | TractUnits;

// Market localities (implemented by the agent from kv) --------------------------------------------------

/** A market's pinned Qloo locality (kv, never in git, D29); the id stays server-side and never reaches the model. */
export interface MarketLocality {
  entityId: string;
  /** Display name, e.g. "Nashville". */
  label: string;
}

/**
 * The pinned localities behind signal.location and filter.location for metro, city and market
 * contexts (Austin is pinned by hand: its name is ambiguous). `market` resolves null when nothing is
 * pinned for the id and rejects when the lookup itself fails, so a skill can tell the two apart.
 */
export interface LocalityApi {
  /** The pinned locality for a market or gazetteer metro id (every MetroId is a MarketId). */
  market(id: MarketId): Promise<MarketLocality | null>;
}

/** What estimateCalls may use beyond the probe and the registry, so location skills can key their requests. */
export interface EstimateEnv {
  localities: LocalityApi | null;
  geo: GeoApi | null;
}

// Registry (implemented by the agent) ------------------------------------------------------------------

export interface RegisteredEntity {
  ref: EntityRef;
  /** The Qloo entity id; it stays server-side and never reaches the model. */
  entityId: string;
  name: string;
  type: EntityType;
  popularity: number | null;
  disambiguation: string | null;
  tags: readonly { tagId: string; name: string; type: string }[];
  /**
   * Where the entity came from (R3, D49): a name the question gave, an obvious candidate CLERK listed and
   * the gate resolved exactly, or found by the data. Absent = `data`. Skills copy it to row `source`.
   */
  candidate?: CandidateSource;
}

export interface RegisteredTag {
  ref: TagRef;
  /** Public taxonomy URN, e.g. urn:tag:genre:place:restaurant. */
  tagId: string;
  name: string;
  type: string;
  /** Taxonomy tags only (isTaxonomyTag): descriptive tags give no signal (probe G1, G6). */
  signalCapable: boolean;
  /**
   * How the tag matches the question's concept (R2, D48), set by find_tags: `exact`, `category` (a broader
   * category, read as a category-level read) or `proxy` (a look-alike: never a verdict). Absent = not a
   * concept tag, no restriction.
   */
  conceptMatch?: ConceptMatch;
}

/** The strength order of candidate sources: re-registering an entity keeps the strongest (R3). */
export const CANDIDATE_SOURCE_RANK: Readonly<Record<CandidateSource, number>> = { user_named: 2, obvious: 1, data: 0 };

/** The stronger of two candidate sources (absent = `data`). */
export function strongerCandidate(a: CandidateSource | undefined, b: CandidateSource | undefined): CandidateSource {
  const x = a ?? "data";
  const y = b ?? "data";
  return CANDIDATE_SOURCE_RANK[x] >= CANDIDATE_SOURCE_RANK[y] ? x : y;
}

/** The order of concept matches, weakest first: a metric carries the weakest match its call used (R2). */
export const CONCEPT_MATCH_RANK: Readonly<Record<ConceptMatch, number>> = { proxy: 0, category: 1, exact: 2 };

/** The weaker of two concept matches; undefined (no concept tag) is ignored. */
export function weakerConceptMatch(a: ConceptMatch | undefined, b: ConceptMatch | undefined): ConceptMatch | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return CONCEPT_MATCH_RANK[a] <= CONCEPT_MATCH_RANK[b] ? a : b;
}

/** The stronger of two concept matches for one tag; undefined (not a concept tag) is ignored. */
export function strongerConceptMatch(a: ConceptMatch | undefined, b: ConceptMatch | undefined): ConceptMatch | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return CONCEPT_MATCH_RANK[a] >= CONCEPT_MATCH_RANK[b] ? a : b;
}

/**
 * The candidates of a run (R3, D49), built by the gate and handed to every skill: exact-resolved entities,
 * gazetteer neighbourhood ids and market ids, each named by the question or expected by a specialist.
 * Skills put them in the sets they score, candidates first, then data.
 */
export interface RunCandidates {
  /** Exact-resolved entities by source, in question order. */
  entities: readonly { ref: EntityRef; source: "user_named" | "obvious" }[];
  /** Gazetteer neighbourhood ids by source, per metro. */
  areas: readonly { metro: MetroId; id: string; source: "user_named" | "obvious" }[];
  /** Market ids by source. */
  markets: readonly { id: MarketId; source: "user_named" | "obvious" }[];
}

/** A run without candidates (stored runs, scans built outside a run, tests). */
export const NO_RUN_CANDIDATES: RunCandidates = { entities: [], areas: [], markets: [] };

/**
 * Maps run-local refs (R#, T#) to Qloo ids. Registration is idempotent by Qloo id: registering a
 * known entity or tag returns its existing ref. Re-registering an entity keeps the strongest candidate
 * source (user_named > obvious > data, strongerCandidate); re-registering a tag keeps the strongest concept
 * match it was given (strongerConceptMatch): a tag that is the exact tag of one concept part stays exact.
 */
export interface EntityRegistry {
  registerEntity(entity: Omit<RegisteredEntity, "ref">): RegisteredEntity;
  registerTag(tag: Omit<RegisteredTag, "ref">): RegisteredTag;
  entity(ref: EntityRef): RegisteredEntity | null;
  tag(ref: TagRef): RegisteredTag | null;
  byEntityId(entityId: string): RegisteredEntity | null;
  byTagId(tagId: string): RegisteredTag | null;
  entities(): readonly RegisteredEntity[];
  tags(): readonly RegisteredTag[];
}

// Run plumbing --------------------------------------------------------------------------------------------

/** Emits an event; the run manager stamps seq, ts and runId. */
export type Emit = (event: EventInput) => void;

/** A read view of the run's budgets (D24, §4.2). The Qloo client enforces the caps itself. */
export interface RunBudget {
  readonly limits: RunLimits;
  qlooNetworkUsed(): number;
  /** Network calls still allowed now: the run cap, and in the follow-up phase also the follow-up cap. */
  qlooNetworkRemaining(): number;
  canAfford(calls: number): boolean;
  elapsedMs(): number;
  llmUsd(): number;
}

export interface SkillCtx {
  qloo: QlooApi;
  /**
   * SEC EDGAR and US Census data (company_financials, area_economics), scoped to this tool call like
   * `qloo`. Null when the run has no public-data client; those skills then return UNAVAILABLE.
   */
  publicdata: PublicDataApi | null;
  ledger: Ledger;
  geo: GeoApi;
  /** Pinned market localities; null when the run has none (metro, city and market contexts are then unavailable). */
  localities: LocalityApi | null;
  registry: EntityRegistry;
  emit: Emit;
  budget: RunBudget;
  signal: AbortSignal;
  runId: string;
  pillar: Pillar;
  phase: Phase;
  /** The tool call (or opening-scan step) this skill run belongs to; carried on fallback and finding events. */
  toolCallId: string;
  /** The question's concept parts (questionConcepts(intent) in the agent); empty when none (R2). */
  concepts: readonly string[];
  /** The run's user-named and obvious candidates (R3); NO_RUN_CANDIDATES when none. */
  candidates: RunCandidates;
}

export interface SkillResult {
  /** The digest returned to the model, wrapped by wrapToolData (≤1.5k tokens). */
  forModel: ModelDigest;
  evidenceIds: EvidenceId[];
  metricIds: MetricId[];
  datasetIds: DatasetId[];
  findingIds: FindingId[];
  flags: Flag[];
  status: SkillStatus;
}

export interface Skill<I> {
  id: SkillId;
  mnemonic: ToolMnemonic;
  kitWorkflows: readonly KitWorkflow[];
  /** The tool's input schema (ANALYST_TOOLS[id].input). */
  input: z.ZodType<I>;
  /**
   * Network calls this input would cost now, counting cached requests as free. The registry maps refs
   * to entity ids; `env` lets location skills key their requests. Without it, a request that needs a
   * locality or an area counts as one call.
   */
  estimateCalls(input: I, probe: CacheProbe, registry: EntityRegistry, env?: EstimateEnv): Promise<number>;
  run(input: I, ctx: SkillCtx): Promise<SkillResult>;
  /** The skill's fixed method limitations (SKILL_LIMITATIONS); flag sentences come from FLAG_TEXT via buildLimitations. */
  limitations(flags: readonly Flag[]): string[];
}

/** The skill behind a given tool, typed by that tool's input. */
export type SkillFor<Id extends SkillId> = Skill<ToolInput<Id>>;

/** One skill per skill tool. */
export type SkillRegistry = { [Id in SkillId]: SkillFor<Id> };
