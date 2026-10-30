import {
  ANALYST_TOOLS,
  Domain,
  isId,
  PUBLIC_NOT_CONFIGURED_REASON,
  SponsorCategory,
  type AgeBucket,
  type DatasetEnvelope,
  type DigestRow,
  type EntityRegistry,
  type Flag,
  type GeoApi,
  type Intent,
  type Job,
  type MarketId,
  type Metric,
  type MetricId,
  type MetroId,
  type ModelDigest,
  type RegisteredEntity,
  type RegisteredTag,
  type RunCandidates,
  type SkillId,
  type ToolInput,
} from "@ct/contracts";
import { listedCompanyOf, NEAREST_SEPARATOR } from "@ct/quant";
import { AREA_ALSO_NAMED } from "./areaMentions";
import { isSkillAvailable, toolLabel } from "./catalogue";
import { questionConcepts } from "./conceptCoverage";
import { gazetteer } from "./gazetteer";
import { listedRelationOf, notSeparatelyReported } from "./listedBrands";
import { noOsmTagText, supplyTypesForConcepts } from "./osmTypes";
import { NOT_CONFIGURED_FLAG, unconfiguredSource, type PublicConfigured } from "./publicConfig";
import { askedTier, compareCities, isGazetteerMetro, MARKET_CATALOGUE, marketTier, namedMarkets, type RunMarket } from "./markets";

/**
 * The opening scan (PLAN §4.1 step C, SPEC §4.1): code runs the job's scan skills with default
 * arguments, in parallel with ANALYST turn 1, so the first charts appear early; its digests reach the
 * model with the wave-1 results and its evidence is cited like any other. SCAN_TABLE is the one place
 * a job's scan is defined: every scan skill has its default-input builder here.
 */

export interface ScanContext {
  intent: Intent;
  /** The resolved primary target, or null when the question has none. */
  primary: RegisteredEntity | null;
  /** Resolved peer mentions, in question order. */
  peers: readonly RegisteredEntity[];
  /** The gazetteer behind areas; defaults to the shared one. */
  geo?: GeoApi;
  /** The run's MARKETS (runMarkets); defaults to the gazetteer metros. */
  markets?: readonly RunMarket[];
  /**
   * True when the run has a public-data client (SEC EDGAR, US Census): company_financials and
   * area_economics join the scan only then. Defaults to false.
   */
  publicData?: boolean;
  /**
   * Which public sources the client can read (PublicDataClient.configured). A public-data step whose
   * source is not configured is never planned (D7): it is skipped with PUBLIC_NOT_CONFIGURED_REASON, and
   * when it would have run, the plan carries the source's not-configured flag. Absent: every source.
   */
  publicConfigured?: PublicConfigured;
  /**
   * The run's candidates (R3, D49): the entities the question names besides the primary and the obvious
   * ones the gate resolved exactly (registered records, user-named first), and the candidate areas and
   * markets. One-scale scoring sets, area sets and market sets take them first. Absent: none.
   */
  candidates?: ScanCandidates;
}

/** The run's candidates as the scan reads them: registered entities, and RunCandidates' areas and markets. */
export interface ScanCandidates {
  entities: readonly RegisteredEntity[];
  areas: RunCandidates["areas"];
  markets: RunCandidates["markets"];
}

const NO_SCAN_CANDIDATES: ScanCandidates = { entities: [], areas: [], markets: [] };

/** What a builder reads: the scan context with its gazetteer, markets and candidates settled. */
type ScanInputs = ScanContext & { geo: GeoApi; markets: readonly RunMarket[]; candidates: ScanCandidates };

/** A gazetteer area a scan step's rows name, in row order. */
export interface ScanArea {
  metro: MetroId;
  id: string;
}

/**
 * What a chained step reads from the step it follows: the tags (T#) and entities (R#) its rows and
 * registrations name, and the gazetteer areas its rows name, each in row order; and its digest rows
 * themselves (`rows`), which the category retry reads for concepts that kept no tag.
 */
export interface ChainFeed {
  tags: readonly RegisteredTag[];
  entities: readonly RegisteredEntity[];
  areas: readonly ScanArea[];
  rows?: readonly DigestRow[];
  /** The datasets the step made (the run adds them): local_supply reads a lift map's popular areas (R7). */
  datasets?: readonly DatasetEnvelope[];
}

/** What chainFeed needs to read a step's digests back into registry records and gazetteer areas. */
export interface ChainFeedSources {
  registry: Pick<EntityRegistry, "entity" | "tag">;
  ledger: { metric(id: MetricId): Pick<Metric, "subjectRefs"> | undefined };
  geo: Pick<GeoApi, "neighbourhood" | "matchNeighbourhood">;
  /** The map cities whose areas the run reads (runAreaMetros), primary first. */
  metros: readonly MetroId[];
}

/**
 * What a chained step reads from the digests of the step it follows, in row order: the tags (T#) its
 * rows name; the entities (R#) its rows name, then those it registered; and the gazetteer areas its
 * rows name, by the row's name in one of the run's map cities, else by a metric the row cites whose
 * subject is an area id. A row matched by name keeps its own area, never a source area its metric also names.
 */
export function chainFeed(digests: readonly ModelDigest[], sources: ChainFeedSources): ChainFeed {
  const tags: RegisteredTag[] = [];
  const entities: RegisteredEntity[] = [];
  const areas: ScanArea[] = [];
  const rows: DigestRow[] = [];
  const addArea = (area: ScanArea | null) => {
    if (area !== null && !areas.some((a) => a.metro === area.metro && a.id === area.id)) areas.push(area);
  };
  for (const digest of digests) {
    rows.push(...digest.top_rows);
    for (const row of digest.top_rows) {
      const tag = row.ref !== null && isId("T", row.ref) ? sources.registry.tag(row.ref) : null;
      if (tag !== null && !tags.includes(tag)) tags.push(tag);
      if (row.ref === null) addArea(rowArea(row, sources));
    }
    for (const ref of [...digest.top_rows.map((r) => r.ref), ...digest.registered.map((r) => r.ref)]) {
      const entity = ref !== null && isId("R", ref) ? sources.registry.entity(ref) : null;
      if (entity !== null && !entities.includes(entity)) entities.push(entity);
    }
  }
  return { tags, entities, areas, rows };
}

/** The gazetteer area a digest row names: by its name, else by an area id among its metrics' subjects. */
function rowArea(row: ModelDigest["top_rows"][number], sources: ChainFeedSources): ScanArea | null {
  for (const metro of sources.metros) {
    const named = sources.geo.matchNeighbourhood(metro, row.name);
    if (named !== null) return { metro, id: named.id };
  }
  const subjects = Object.values(row.values).flatMap((v) =>
    typeof v === "string" && isId("M", v) ? (sources.ledger.metric(v)?.subjectRefs ?? []) : [],
  );
  for (const metro of sources.metros) {
    const id = subjects.find((ref) => sources.geo.neighbourhood(metro, ref) !== null);
    if (id !== undefined) return { metro, id };
  }
  return null;
}

/** A chained step's input from what its `after` step returned, or null when none fits. */
interface ChainBuild<Id extends SkillId> {
  /** The scan skill whose refs it needs: a parallel step, or a chained step earlier in the table. */
  after: SkillId;
  /** Its typical cold cost in network calls: the input, and so the exact estimate, exists only later. */
  estimate: number;
  /** How the run context describes it, after the tool label. */
  describe: string;
  input: (feed: ChainFeed) => ToolInput<Id> | null;
  /** True when not running is the usual case (the category retry): no SCAN NOTE then. */
  quiet?: boolean;
}

/** A deferred step's input from the peers wave 1 resolved, or null when none fits. */
interface DeferBuild<Id extends SkillId> {
  /** Its typical cold cost in network calls: whether it runs, and on which set, is known only later. */
  estimate: number;
  /** How the run context describes it, after the tool label. */
  describe: string;
  input: (peers: readonly RegisteredEntity[]) => ToolInput<Id> | null;
}

/**
 * A scan skill and how to build its default input. `build` runs it in parallel with the others, and
 * `each` runs one parallel step per input it returns (city_compare's fingerprint per city); `chain`
 * runs it after them, from what one of them returned (geo_lift needs find_tags' refs), and when it
 * returns null or its step does not run, `build` stands in if there is one. None of them means the
 * build cannot run it yet. `defer`
 * takes over when `build` finds no peer to compare: the step waits for the peers the ANALYST's wave-1
 * resolve_entities registers (director.md §6: the implied peers of "other comedians") and runs as
 * part of the scan once wave 1 returns, before turn 1 closes, so its findings can still be followed
 * in turn 2 and its calls stay out of turn 2's allowance.
 */
type ScanEntry = {
  [Id in SkillId]: {
    tool: Id;
    build?: (ctx: ScanInputs) => ToolInput<Id> | null;
    each?: (ctx: ScanInputs) => ToolInput<Id>[];
    chain?: (ctx: ScanInputs) => ChainBuild<Id> | null;
    defer?: (ctx: ScanInputs) => DeferBuild<Id> | null;
    why?: string;
    /** True when this entry is a per-item slot the question does not use (a fourth city of three): no skip line. */
    unused?: (ctx: ScanInputs) => boolean;
  };
}[SkillId];

const NO_STEP = { trigger_finding_id: null, step_id: null } as const;

/** Substitution Map size for the scan: the target plus five peers. */
export const SCAN_PEER_K = 6;
/** Audience DNA set size cap (the tool's maximum). */
const DNA_SET_MAX = 12;
/** Share-of-Taste set size cap (the tool's maximum). */
const SHARE_SET_MAX = 8;
/** Markets the market_selection scan's share_of_taste reads (the tool's maximum). */
const SHARE_MARKETS_MAX = 8;
/** Markets the head_to_head scan reads beside its three ages: the "who wins where" columns. */
export const SCAN_DUEL_MARKETS = 4;
/** Markets a sponsor slate checks alignment in (the tool's maximum). */
const SLATE_MARKETS_MAX = 4;
/** geo_lift concept tags (the tool's maximum). */
const LIFT_TAGS_MAX = 4;
/** A chained geo_lift's cold cost: the concept map, the pinned baseline once per metro, a supply page. */
export const SCAN_LIFT_ESTIMATE = 3;
/** The three age buckets of the head_to_head scan: one young, one middle, one old, so youth tilt is measured. */
export const SCAN_AGES: readonly AgeBucket[] = ["24_and_younger", "35_to_44", "55_and_older"];
/** cross_domain domains of the audience_discovery scan when the question names none (SPEC §9 S7). */
export const SCAN_DOMAINS: readonly Domain[] = ["artist", "podcast", "brand"];
/** Sponsor categories the sponsorship scan discovers when the question names none: the first six of the enum. */
export const SCAN_SPONSOR_CATEGORIES: readonly SponsorCategory[] = SponsorCategory.options.slice(0, 6);
/** No popularity cap on the scan's cultural neighbourhood: POPULARITY_DOMINANCE then suggests one. */
const SCAN_POPULARITY_MAX = 1;

const distinctRefs = (entities: readonly RegisteredEntity[]) => [...new Set(entities.map((e) => e.ref))];

/** A one-scale scoring set's largest size (rank_candidates' maximum). */
const SCORING_SET_MAX = 50;

/**
 * `set` with every candidate entity of `type` it lacks appended (R3): a scored set always holds what the
 * question names and what a specialist would check first, whatever the data found. `except` (the subject)
 * is never added; at most SCORING_SET_MAX.
 */
function withCandidates(
  set: readonly RegisteredEntity["ref"][],
  { candidates }: Pick<ScanInputs, "candidates">,
  type: RegisteredEntity["type"],
  except: RegisteredEntity["ref"] | null,
  max = SCORING_SET_MAX,
): RegisteredEntity["ref"][] {
  const extra = candidates.entities.filter((e) => e.type === type && e.ref !== except).map((e) => e.ref);
  return [...new Set([...set, ...extra])].slice(0, max);
}

/** The candidate area ids of one map city, user-named first (R3). */
const candidateAreaIds = ({ candidates }: Pick<ScanInputs, "candidates">, metro: MetroId): string[] => [
  ...candidates.areas.filter((a) => a.metro === metro && a.source === "user_named").map((a) => a.id),
  ...candidates.areas.filter((a) => a.metro === metro && a.source === "obvious").map((a) => a.id),
];

/** The primary first, then the peers of the same type: a set to rank against one another. */
function sameTypeSet({ primary, peers }: ScanInputs, max: number): RegisteredEntity["ref"][] {
  if (primary === null) return [];
  return distinctRefs([primary, ...peers.filter((p) => p.type === primary.type)]).slice(0, max);
}

/**
 * brand_health maps the target with discovery; head_to_head maps the primary against the named
 * brands, with discovery filling the matrix unless three or more were named.
 */
function peerMap(alwaysDiscover: boolean): (ctx: ScanInputs) => ToolInput<"peer_landscape"> | null {
  return ({ primary, peers }) => {
    if (primary === null || primary.type !== "brand") return null;
    const named = [...new Set(peers.filter((p) => p.type === "brand" && p.ref !== primary.ref).map((p) => p.ref))].slice(0, SCAN_PEER_K - 1);
    return {
      target: primary.ref,
      peers: named,
      discover: alwaysDiscover || named.length < 3,
      k: SCAN_PEER_K,
      ...NO_STEP,
    };
  };
}

const PEER_MAP_WHY = "needs a brand as the primary target";
const PRIMARY_WHY = "needs a resolved primary target";
const SET_WHY = "needs a brand or person primary with a peer of the same type";

/**
 * audience_dna for the primary and its resolved peers (any type, P5: distinctive tags count only
 * same-type peers), at most twelve. head_to_head mirrors the first peer as compare_with.
 */
function dnaSet(compare: boolean): (ctx: ScanInputs) => ToolInput<"audience_dna"> | null {
  return ({ primary, peers }) => {
    if (primary === null) return null;
    const rest = distinctRefs(peers).filter((ref) => ref !== primary.ref);
    return { set: [primary.ref, ...rest].slice(0, DNA_SET_MAX), compare_with: compare ? (rest[0] ?? null) : null, ...NO_STEP };
  };
}

/** destination_affinity from the primary alone: where its audience's travel taste points. */
function travelTaste({ primary }: ScanInputs): ToolInput<"destination_affinity"> | null {
  return primary === null ? null : { seeds: [primary.ref], ...NO_STEP };
}

/** The pair on one scale in the metro the question names (one call); share_of_taste covers ages and markets. */
function pairRank(ctx: ScanInputs): ToolInput<"rank_candidates"> | null {
  const pair = sameTypeSet(ctx, 2);
  const metro = ctx.intent.geo.metro;
  if (ctx.primary === null || pair.length < 2 || metro === null) return null;
  // The pair, then the expected rivals of its type (R3), so the metro scale is not a set of two.
  const set = withCandidates(pair, ctx, ctx.primary.type, null);
  return { type: ctx.primary.type, candidates: set, signal_entities: [], signal_tags: [], contexts: [{ kind: "metro", market: metro }], ...NO_STEP };
}

/**
 * The markets the question names, then the run's MARKETS of the tier the CLERK notes ask for
 * ("secondary-market dates" reads secondary markets, not the majors the catalogue lists first), then
 * the rest, at most `max`. Past the named ones each group takes one market per state before a
 * second, in catalogue order, so a grid of eight is not three Texas cities among the first majors.
 */
function scanMarkets({ intent, markets, candidates }: ScanInputs, max: number): MarketId[] {
  // The markets the question names, then its candidate markets (named first, then obvious; R3).
  const named = [...new Set([...namedMarkets(intent, markets), ...candidates.markets.map((m) => m.id)])].filter((id) =>
    markets.some((m) => m.id === id),
  );
  const rest = markets.filter((m) => !named.includes(m.id));
  const tier = askedTier(intent);
  const asked = rest.filter((m) => tier !== null && marketTier(m.id) === tier);
  const seen = new Set(named.flatMap((id) => markets.find((m) => m.id === id)?.state ?? []));
  return [...named, ...byState(asked, seen), ...byState(rest.filter((m) => !asked.includes(m)), seen)].slice(0, max);
}

/** Market ids in order, one per state not yet `seen` first, then the others in order; adds their states to `seen`. */
function byState(markets: readonly RunMarket[], seen: Set<string>): MarketId[] {
  const first: MarketId[] = [];
  const later: MarketId[] = [];
  for (const m of markets) {
    (seen.has(m.state) ? later : first).push(m.id);
    seen.add(m.state);
  }
  return [...first, ...later];
}

/** share_of_taste for the primary and its same-type peers: by age and across markets (head_to_head), or across markets alone. */
function shareSet(ages: readonly AgeBucket[], marketsMax: number): (ctx: ScanInputs) => ToolInput<"share_of_taste"> | null {
  return (ctx) => {
    const set = sameTypeSet(ctx, SHARE_SET_MAX);
    if (ctx.primary === null || set.length < 2) return null;
    return { type: ctx.primary.type, set, ages: [...ages], audiences: [], genders: [], metros: scanMarkets(ctx, marketsMax), ...NO_STEP };
  };
}

/** Entity types share_of_taste ranks (contracts ShareOfTasteInput). */
const SHAREABLE: readonly RegisteredEntity["type"][] = ["brand", "person"];

/**
 * shareSet deferred to the peers wave 1 resolves, when the question named none of the primary's type:
 * the same contexts, read for the primary and those peers, one call per context.
 */
function shareAfterWave1(ages: readonly AgeBucket[], marketsMax: number): (ctx: ScanInputs) => DeferBuild<"share_of_taste"> | null {
  return (ctx) => {
    const { primary } = ctx;
    if (primary === null || !SHAREABLE.includes(primary.type)) return null;
    const metros = scanMarkets(ctx, marketsMax);
    if (ages.length + metros.length === 0) return null;
    const contexts = [ages.length > 0 ? `ages ${ages.join(", ")}` : "", metros.length > 0 ? `markets ${metros.join(", ")}` : ""];
    return {
      estimate: ages.length + metros.length,
      describe: `for ${primary.ref} and the ${primary.type} peers your wave-1 resolve_entities registers, by ${contexts.filter((c) => c !== "").join(" and ")}`,
      input: (peers) => shareSet(ages, marketsMax)({ ...ctx, peers: [...ctx.peers, ...peers] }),
    };
  };
}

/** find_tags for the question's concepts as place concepts: the curated map answers at no cost, others search live. */
function conceptTags({ intent }: ScanInputs): ToolInput<"find_tags"> | null {
  const concepts = [...new Set(intent.constraints.concepts.map((c) => c.trim().slice(0, 60)).filter((c) => c.length > 0))].slice(0, 4);
  return concepts.length === 0 ? null : { concepts: concepts.map((text) => ({ text, scope: "place" as const })), ...NO_STEP };
}

/** block_dna for the question's neighbourhood in its gazetteer metro, with local brands for tenant fit. */
function blockArea({ intent, geo }: ScanInputs): ToolInput<"block_dna"> | null {
  const { metro, area } = intent.geo;
  if (metro === null || area === null) return null;
  const nbhd = geo.matchNeighbourhood(metro, area);
  return nbhd === null ? null : { area: { kind: "nbhd", ref: nbhd.id, metro }, include_brands: true, ...NO_STEP };
}

/**
 * sponsor_slate for an artist or person: the question's categories (else the first six), its brands
 * as the shortlist, and the tour or launch markets it names (else the gazetteer metros among MARKETS),
 * so the slate's market alignment points the way to a block.
 */
function slate(ctx: ScanInputs): ToolInput<"sponsor_slate"> | null {
  const { intent, primary, peers, markets, candidates } = ctx;
  if (primary === null || (primary.type !== "artist" && primary.type !== "person")) return null;
  const categories = intent.constraints.sponsor_categories.length > 0 ? intent.constraints.sponsor_categories : SCAN_SPONSOR_CATEGORIES;
  // The brands the question names, then the expected sponsors (R3), scored with the discovered ones.
  const shortlist = withCandidates(distinctRefs(peers.filter((p) => p.type === "brand")), ctx, "brand", primary.ref, 10);
  const named = [...new Set([...namedMarkets(intent, markets), ...candidates.markets.map((m) => m.id)])];
  const tour = (named.length > 0 ? named : markets.map((m) => m.id).filter(isGazetteerMetro)).slice(0, SLATE_MARKETS_MAX);
  return { seed: primary.ref, categories: [...new Set(categories)].slice(0, 6), shortlist, markets: tour, ...NO_STEP };
}

/** Place taxonomy tags: genre:place shapes a heatmap, category:place filters the supply sample (P5). */
const GENRE_PLACE = "urn:tag:genre:place:";
const CATEGORY_PLACE = "urn:tag:category:place:";
/** geo_lift focus_areas (the tool's maximum). */
const FOCUS_AREAS_MAX = 3;

/**
 * The gazetteer ids of the areas the question names in its metro: geo.area first, then any other
 * area CLERK's reading kept in constraints.notes (areaMentionsToGeo), at most FOCUS_AREAS_MAX. A name
 * the gazetteer does not hold is left out.
 */
export function namedAreaIds(intent: Intent, geo: Pick<GeoApi, "matchNeighbourhood">): string[] {
  const metro = intent.geo.metro;
  if (metro === null) return [];
  const texts = [
    intent.geo.area,
    ...intent.constraints.notes.flatMap((n) => (n.startsWith(AREA_ALSO_NAMED) ? [n.slice(AREA_ALSO_NAMED.length)] : [])),
  ];
  const ids = texts.flatMap((t) => (t === null || t.trim() === "" ? [] : [geo.matchNeighbourhood(metro, t)?.id ?? null])).filter((id) => id !== null);
  return [...new Set(ids)].slice(0, FOCUS_AREAS_MAX);
}

/**
 * geo_lift chained after find_tags in the question's gazetteer metro (PLAN §4.1: curated tags plus
 * the concept heatmap, baseline pinned): the place taxonomy tags find_tags returned, genre tags
 * first, so white space and LATENT_DEMAND reach turn 2. Supply is always asked for: a site question
 * is about competition, and without a verified category tag geo_lift says the competitor count is
 * unknown and why, rather than nothing. The areas the question names get their own numbers.
 */
function liftFromTags(ctx: ScanInputs): ChainBuild<"geo_lift"> | null {
  const { intent, geo } = ctx;
  const metro = intent.geo.metro;
  if (metro === null || intent.constraints.concepts.length === 0) return null;
  // The question's areas, then the candidate areas a local would check first (R3).
  const focus = [...new Set([...namedAreaIds(intent, geo), ...candidateAreaIds(ctx, metro)])].slice(0, FOCUS_AREAS_MAX);
  return {
    after: "find_tags",
    estimate: SCAN_LIFT_ESTIMATE,
    describe:
      `in ${metro} on the place tags find_tags returns, with supply` +
      (focus.length > 0 ? `, and the question's ${focus.length === 1 ? "area" : "areas"} ${focus.join(", ")} first` : ""),
    input: ({ tags }) => {
      const refs = (prefix: string) => tags.filter((t) => t.tagId.startsWith(prefix)).map((t) => t.ref);
      const genre = refs(GENRE_PLACE);
      const category = refs(CATEGORY_PLACE);
      if (genre.length + category.length === 0) return null;
      return {
        metro,
        concept_tags: [...genre, ...category].slice(0, LIFT_TAGS_MAX),
        concept_entities: [],
        supply: true,
        ...(focus.length > 0 ? { focus_areas: focus } : {}),
        ...NO_STEP,
      };
    },
  };
}

/** cross_domain from the primary over the given domains plus any the question names, at most five. */
function neighbourhood(
  base: readonly Domain[],
  replaceWithNamed: boolean,
  withOwnType = false,
): (ctx: ScanInputs) => ToolInput<"cross_domain"> | null {
  return ({ intent, primary }) => {
    if (primary === null) return null;
    const named = intent.constraints.domains;
    const domains = replaceWithNamed && named.length > 0 ? named : [...base, ...named];
    const own = withOwnType ? Domain.options.find((d) => d === primary.type) : undefined;
    const all = own === undefined ? domains : [...domains, own];
    return { seeds: [primary.ref], seed_tags: [], domains: [...new Set(all)].slice(0, 5), popularity_max: SCAN_POPULARITY_MAX, ...NO_STEP };
  };
}

// The Part 9 jobs and the public-data joins ------------------------------------------------------------

/** Twins area_economics reads after taste_twins: the best few, as the Twins exhibit ranks them. */
const ECON_TWINS_MAX = 3;
/** Areas site_selection's area_economics reads after geo_lift: the question's own, then the top lift areas. */
const ECON_LIFT_MAX = 5;
/** taste_twins concept tags (the tool's maximum). */
const TWIN_TAGS_MAX = 3;
/** A taste_twins call's cold cost: the source area's tags, at most 8 target areas, one concept call. */
export const SCAN_TWINS_ESTIMATE = 10;
/** concept_vector concept tags (the tool's maximum). */
const CNPT_TAGS_MAX = 4;
/** Candidates a chained one-scale scoring reads: the named ones of its type, then the discovered rows. */
const SCORE_CANDIDATES_MAX = 12;
/** Partners brand_collab's audience_dna reads beside the subject, best scored first. */
const COLLAB_DNA_PARTNERS = 3;
/** Cities city_compare reads (the job's maximum). */
const CITIES_MAX = 4;
/** cross_domain domains of the brand_collab scan: brands of any category (no category filter). */
export const SCAN_COLLAB_DOMAINS: readonly Domain[] = ["brand"];
/**
 * cross_domain domains of the creator_fit scan: artists and podcasts. A person is no cross_domain
 * domain (contracts Domain), so public figures other than artists are scored only when the question names them.
 */
export const SCAN_CREATOR_DOMAINS: readonly Domain[] = ["artist", "podcast"];

/** Place genre and category tags among `tags`, genre first: what a concept heatmap ranks areas by. */
function placeTagRefs(tags: readonly RegisteredTag[]): RegisteredTag["ref"][] {
  const refs = (prefix: string) => tags.filter((t) => t.tagId.startsWith(prefix)).map((t) => t.ref);
  return [...new Set([...refs(GENRE_PLACE), ...refs(CATEGORY_PLACE)])];
}

interface TwinSides {
  source: { kind: "nbhd"; ref: string; metro: MetroId };
  target: MetroId;
}

/** The source area of a taste_twins question (geo.area in geo.metro) and its target map city, when both hold. */
function twinSides({ intent, geo }: ScanInputs): TwinSides | null {
  const { metro, area, target_metro: target } = intent.geo;
  if (metro === null || area === null || target === null || target === metro) return null;
  const nbhd = geo.matchNeighbourhood(metro, area);
  return nbhd === null ? null : { source: { kind: "nbhd", ref: nbhd.id, metro }, target };
}

/** taste_twins with code picking the target areas (the largest, labelled so), when the question names no concept. */
function twinsByArea(ctx: ScanInputs): ToolInput<"taste_twins"> | null {
  const sides = twinSides(ctx);
  if (sides === null || ctx.intent.constraints.concepts.length > 0) return null;
  return { source: sides.source, target_metro: sides.target, target_areas: [], concept_tags: [], ...NO_STEP };
}

/** taste_twins chained after find_tags: the concept's place tags pick the target areas by lift. */
function twinsFromTags(ctx: ScanInputs): ChainBuild<"taste_twins"> | null {
  const sides = twinSides(ctx);
  if (sides === null || ctx.intent.constraints.concepts.length === 0) return null;
  return {
    after: "find_tags",
    estimate: SCAN_TWINS_ESTIMATE,
    describe: `from ${sides.source.ref} (${sides.source.metro}) into ${sides.target}, the target areas picked by the place tags find_tags returns`,
    input: ({ tags }) => {
      const concept = placeTagRefs(tags).slice(0, TWIN_TAGS_MAX);
      return { source: sides.source, target_metro: sides.target, target_areas: [], concept_tags: concept, ...NO_STEP };
    },
  };
}

/** area_economics for the question's own areas in its map city (area_profile, tenant_mix, the twins' source). */
function econNamed(ctx: ScanInputs): ToolInput<"area_economics"> | null {
  const metro = ctx.intent.geo.metro;
  if (ctx.publicData !== true || metro === null) return null;
  const areas = namedAreaIds(ctx.intent, ctx.geo);
  return areas.length === 0 ? null : { metro, areas, ...NO_STEP };
}

/** area_economics chained after taste_twins: the best twins in the target city. */
function econTwins(ctx: ScanInputs): ChainBuild<"area_economics"> | null {
  const sides = twinSides(ctx);
  if (ctx.publicData !== true || sides === null) return null;
  return {
    after: "taste_twins",
    estimate: 0,
    describe: `for the top ${ECON_TWINS_MAX} twins taste_twins returns in ${sides.target} (US Census, 0 Qloo calls)`,
    input: ({ areas }) => {
      const twins = [...new Set(areas.filter((a) => a.metro === sides.target).map((a) => a.id))].slice(0, ECON_TWINS_MAX);
      return twins.length === 0 ? null : { metro: sides.target, areas: twins, ...NO_STEP };
    },
  };
}

/** area_economics chained after site_selection's geo_lift: the question's areas, then the top lift areas. */
function econLift(ctx: ScanInputs): ChainBuild<"area_economics"> | null {
  const metro = ctx.intent.geo.metro;
  if (ctx.publicData !== true || metro === null || ctx.intent.constraints.concepts.length === 0) return null;
  const named = namedAreaIds(ctx.intent, ctx.geo);
  return {
    after: "geo_lift",
    estimate: 0,
    describe: `in ${metro} for the question's areas and the top areas geo_lift returns (US Census, 0 Qloo calls)`,
    input: ({ areas }) => {
      const ids = [...new Set([...named, ...areas.filter((a) => a.metro === metro).map((a) => a.id)])].slice(0, ECON_LIFT_MAX);
      return ids.length === 0 ? null : { metro, areas: ids, ...NO_STEP };
    },
  };
}

/**
 * company_financials for a primary brand config/listed_companies.json maps to a US-listed company (0 Qloo
 * calls), by the skill's own lookup, so a private brand costs no step that could only answer UNAVAILABLE.
 */
function financials({ intent, primary, publicData }: ScanInputs): ToolInput<"company_financials"> | null {
  if (publicData !== true || primary === null || primary.type !== "brand" || !namesPrimary(intent)) return null;
  // A brand inside a larger company has no figures of its own (financialsNote says so instead).
  if (listedRelationOf(primary.name).kind !== "self") return null;
  return listedCompanyOf(primary.name) === null ? null : { brand: primary.ref, ...NO_STEP };
}

/** The jobs whose scan reads company_financials. */
const FINANCIALS_JOBS: ReadonlySet<Job> = new Set(["brand_health", "head_to_head", "launch_test"]);

/**
 * Why a primary brand's financials are not read, so it is never silent (Part 9 open issue 6): a brand inside
 * a larger listed company gets NOT_SEPARATELY_REPORTED naming the parent; a brand with no entry at all gets
 * NOT_A_LISTED_COMPANY. Null when its financials are read, or the job, data or primary does not call for
 * them (no public data, SEC not configured, no brand subject).
 */
export function financialsNote(job: Job, ctx: Pick<ScanContext, "intent" | "primary" | "publicData" | "publicConfigured">): { flag: Flag; text: string | null } | null {
  const { intent, primary } = ctx;
  if (!FINANCIALS_JOBS.has(job) || ctx.publicData !== true || ctx.publicConfigured?.sec === false) return null;
  if (primary === null || primary.type !== "brand" || !namesPrimary(intent)) return null;
  const relation = listedRelationOf(primary.name);
  if (relation.kind === "parent") return { flag: "NOT_SEPARATELY_REPORTED", text: notSeparatelyReported(primary.name, relation.parent) };
  if (relation.kind === "unlisted" || listedCompanyOf(primary.name) === null) return { flag: "NOT_A_LISTED_COMPANY", text: null };
  return null;
}

/**
 * True when CLERK marked a mention as the question's subject. Without one the gate stands in its first
 * mention, which in a launch_test question is an analog the concept is compared with, not the company.
 */
const namesPrimary = (intent: Intent): boolean => intent.mentions.some((m) => m.role === "primary");

const FIN_WHY = "needs a brand primary that maps to a US-listed company, and public data on this server";
const ECON_WHY = "needs an area of a map city in the question, and public data on this server";

/**
 * One-scale scoring of what cross_domain discovered of one type, with the question's named entities
 * of that type first, from the primary's taste (a none context with the primary as the signal).
 * Scores compare within the type only.
 */
function scoreDiscovered(type: "brand" | "artist" | "podcast"): (ctx: ScanInputs) => ChainBuild<"rank_candidates"> | null {
  return (ctx) => {
    const { primary, peers } = ctx;
    if (primary === null) return null;
    const named = peers.filter((p) => p.type === type && p.ref !== primary.ref);
    const also = named.length > 0 ? ` with ${distinctRefs(named).join(", ")}` : "";
    return {
      after: "cross_domain",
      estimate: 1,
      describe: `on one scale from ${primary.ref}'s taste: the ${type} rows cross_domain returns${also}`,
      input: ({ entities }) => {
        const found = entities.filter((e) => e.type === type && e.ref !== primary.ref);
        // The expected partners or creators of this type join whatever the data discovered (R3).
        const candidates = withCandidates(distinctRefs([...named, ...found]).slice(0, SCORE_CANDIDATES_MAX), ctx, type, primary.ref);
        if (candidates.length < 2) return null;
        return { type, candidates, signal_entities: [primary.ref], signal_tags: [], contexts: [{ kind: "none" }], ...NO_STEP };
      },
    };
  };
}

/** audience_dna chained after brand_collab's scoring: the subject beside its best-scored partners, mirrored against the first. */
function collabDna({ primary }: ScanInputs): ChainBuild<"audience_dna"> | null {
  if (primary === null) return null;
  return {
    after: "rank_candidates",
    estimate: 1,
    describe: `for ${primary.ref} and the top ${COLLAB_DNA_PARTNERS} partners rank_candidates scores, compare_with the first (shared and one-side tags)`,
    input: ({ entities }) => {
      const partners = distinctRefs(entities.filter((e) => e.type === "brand" && e.ref !== primary.ref)).slice(0, COLLAB_DNA_PARTNERS);
      const first = partners[0];
      return first === undefined ? null : { set: [primary.ref, ...partners], compare_with: first, ...NO_STEP };
    },
  };
}

/** cross_domain domains of brand_collab's shared neighbourhood: music, the cultural neighbourhood a pair's campaign can borrow from. */
export const SCAN_COLLAB_SHARED_DOMAINS: readonly Domain[] = ["artist"];

/**
 * cross_domain chained after brand_collab's scoring (PLAN §4.1's fourth scan call): the subject and
 * its best-scored partner as joint seeds, so the list is the cultural neighbourhood the pair shares.
 * With no popularity cap, a list of mainstream names raises POPULARITY_DOMINANCE, the job's usual
 * turn-2 lead (a capped re-run for less obvious partners or shared picks).
 */
function collabShared({ primary }: ScanInputs): ChainBuild<"cross_domain"> | null {
  if (primary === null) return null;
  return {
    after: "rank_candidates",
    estimate: SCAN_COLLAB_SHARED_DOMAINS.length,
    describe: `for ${primary.ref} and the best partner rank_candidates scores as joint seeds over music: the cultural neighbourhood the pair shares`,
    input: ({ entities }) => {
      const [partner] = distinctRefs(entities.filter((e) => e.type === "brand" && e.ref !== primary.ref));
      if (partner === undefined) return null;
      return { seeds: [primary.ref, partner], seed_tags: [], domains: [...SCAN_COLLAB_SHARED_DOMAINS], popularity_max: SCAN_POPULARITY_MAX, ...NO_STEP };
    },
  };
}

/** find_tags for a product concept (launch_test): its concepts, else its one-sentence description, as brand tags. */
function productTags({ intent }: ScanInputs): ToolInput<"find_tags"> | null {
  const described = intent.constraints.concept_description?.trim() ?? "";
  const texts = intent.constraints.concepts.length > 0 ? intent.constraints.concepts : described === "" ? [] : [described];
  const concepts = [...new Set(texts.map((c) => c.trim().slice(0, 60).trim()).filter((c) => c.length > 0))].slice(0, 4);
  return concepts.length === 0 ? null : { concepts: concepts.map((text) => ({ text, scope: "brand" as const })), ...NO_STEP };
}

/** The key two concept names are compared by: case, punctuation and spacing do not count. */
const nameKey = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The category retry (the owner's o03 decision): chained after a scan's find_tags, it searches, for
 * each concept whose own search answered and kept no usable tag, the first nearest category that search
 * returned (find_tags' `nearest`, those sharing a word with the concept first), so the chained concept
 * test (concept_vector, block_dna, geo_lift, taste_twins) runs on the category instead of not at all.
 * The concept then reads as tested at category level: code opens the thesis with that, lists it first
 * among the limitations and applies the partly-tested confidence penalty (D2). A concept with a tag of
 * its own, a failed search or no nearest category is not retried; with none to retry the step does not
 * run, quietly. One search per retried concept, so it costs one call each unless cached.
 */
function categoryRetry(base: (ctx: ScanInputs) => ToolInput<"find_tags"> | null): (ctx: ScanInputs) => ChainBuild<"find_tags"> | null {
  return (ctx) => {
    const first = base(ctx);
    if (first === null) return null;
    return {
      after: "find_tags",
      estimate: 0,
      quiet: true,
      describe: "on the nearest category, only for a concept whose own tag search keeps no tag (the concept is then tested at category level)",
      input: ({ rows = [] }) => {
        const concepts: ToolInput<"find_tags">["concepts"] = [];
        const searched = new Set(first.concepts.map((c) => nameKey(c.text)));
        for (const concept of first.concepts) {
          const own = rows.filter((r) => typeof r.values.concept === "string" && nameKey(r.values.concept) === nameKey(concept.text));
          const kept = own.some((r) => r.ref !== null && isId("T", r.ref) && r.values.use !== "label_only");
          const empty = own.some((r) => r.values.match === "none" || r.values.use === "label_only");
          if (kept || !empty) continue;
          const nearest = own.flatMap((r) => (typeof r.values.nearest === "string" ? r.values.nearest.split(NEAREST_SEPARATOR) : []));
          const pick = nearest.map((n) => n.trim().slice(0, 60).trim()).find((n) => n !== "" && !searched.has(nameKey(n)));
          if (pick === undefined) continue;
          searched.add(nameKey(pick));
          concepts.push({ text: pick, scope: concept.scope });
        }
        return concepts.length === 0 ? null : { concepts, ...NO_STEP };
      },
    };
  };
}

const CATEGORY_RETRY_WHY = "runs only when a concept's own tag search keeps no tag";
/** The retry never earns a skip line: it is a fallback inside the concept test, not a reading of its own. */
const retryUnused = (): boolean => true;

/** concept_vector analogs (the tool's maximum). */
const CNPT_ANALOGS_MAX = 8;

/**
 * concept_vector chained after launch_test's find_tags. With the brands the question names as
 * analogs ("like Brand Gamma"), each is kept or vetoed in the scan, so ANALOG_VETOED can be followed
 * in turn 2; with none, it is the open call alone (the ADD list), and the analogs your priors expect
 * are scored as a turn-2 step, since the concept's tags exist only once this scan returns.
 */
function conceptVector(ctx: ScanInputs): ChainBuild<"concept_vector"> {
  const { intent, primary, peers } = ctx;
  // With no subject marked, the gate's stand-in primary is the first analog the question names.
  const mentioned = namesPrimary(intent) || primary === null ? peers : [primary, ...peers];
  // The analogs the question names, then the real analogs a specialist expects (R3).
  const subject = namesPrimary(intent) ? (primary?.ref ?? null) : null;
  const analogs = withCandidates(distinctRefs(mentioned.filter((p) => p.type === "brand")), ctx, "brand", subject, CNPT_ANALOGS_MAX);
  const named = analogs.length > 0 ? `, the question's analogs ${analogs.join(", ")} kept or vetoed` : ", no analogs: the ADD list";
  return {
    after: "find_tags",
    estimate: analogs.length > 0 ? 2 : 1,
    describe: `on the taxonomy tags find_tags returns, type brand${named}`,
    input: ({ tags }) => {
      const concept = [...new Set(tags.filter((t) => t.signalCapable).map((t) => t.ref))].slice(0, CNPT_TAGS_MAX);
      return concept.length === 0 ? null : { concept_tags: concept, type: "brand", analogs, ...NO_STEP };
    },
  };
}

/** The cities city_compare reads: CLERK's geo.cities checked against config (compareCities), among the run's MARKETS. */
export function scanCities({ intent, markets }: Pick<ScanInputs, "intent" | "markets">): MarketId[] {
  const usable = new Set<string>(markets.map((m) => m.id));
  return compareCities(intent).filter((id) => usable.has(id)).slice(0, CITIES_MAX);
}

/** block_dna concept tags (the tool's maximum). */
const BLOCK_CONCEPT_TAGS_MAX = 4;
/** Tag types the four Block DNA families read (quant blockDna/fingerprint.ts): a concept tag of another type has no rank there. */
const BLOCK_FAMILY_PREFIXES = [
  "urn:tag:customer_identity:",
  "urn:tag:ambience:",
  GENRE_PLACE,
  CATEGORY_PLACE,
  "urn:tag:specialty_dish:",
  "urn:tag:genre:music:",
] as const;
/** A city fingerprint's typical cold cost: the city's tag list and its music list (pinned and warm for map cities). */
const SCAN_FINGERPRINT_ESTIMATE = 2;

/** The concept's find_tags refs that a Block DNA family reads, at most four (CR 5). */
function blockConceptRefs(tags: readonly RegisteredTag[]): RegisteredTag["ref"][] {
  const read = tags.filter((t) => BLOCK_FAMILY_PREFIXES.some((p) => t.tagId.startsWith(p)));
  return [...new Set(read.map((t) => t.ref))].slice(0, BLOCK_CONCEPT_TAGS_MAX);
}

/**
 * block_dna's city fingerprint (against the other map cities pooled) for the `index`-th compared
 * city, when two or more can be read. Without a concept it runs in parallel (`build`).
 */
function fingerprintOfCity(index: number): (ctx: ScanInputs) => ToolInput<"block_dna"> | null {
  return (ctx) => {
    const cities = scanCities(ctx);
    const market = cities[index];
    if (cities.length < 2 || market === undefined) return null;
    return { area: { kind: "city", market }, include_brands: false, ...NO_STEP };
  };
}

/**
 * With a concept, the same fingerprint chained after find_tags, carrying the concept's tags (CR 5),
 * so each city's rank for the concept against the other map cities is a citable metric. The tags cost
 * no extra call. When find_tags finds no tag a family reads, the fingerprint still runs, without them.
 */
function fingerprintInCity(index: number): (ctx: ScanInputs) => ChainBuild<"block_dna"> | null {
  return (ctx) => {
    const plain = fingerprintOfCity(index)(ctx);
    if (plain === null || plain.area.kind !== "city" || conceptTags(ctx) === null) return null;
    return {
      after: "find_tags",
      estimate: SCAN_FINGERPRINT_ESTIMATE,
      describe: `city fingerprint of ${plain.area.market} against the other map cities, with the concept's taxonomy tags find_tags returns (no extra call)`,
      input: ({ tags }) => ({ ...plain, concept_tags: blockConceptRefs(tags) }),
    };
  };
}

/** A fingerprint slot past the cities the question compares is no gap, so it is not listed as skipped. */
function citySlotUnused(index: number): (ctx: ScanInputs) => boolean {
  return (ctx) => {
    const cities = scanCities(ctx);
    return cities.length >= 2 && index >= cities.length;
  };
}

/** share_of_taste of the named entity and its same-type peers across the compared cities. */
function shareAcrossCities(ctx: ScanInputs): ToolInput<"share_of_taste"> | null {
  const set = sameTypeSet(ctx, SHARE_SET_MAX);
  const cities = scanCities(ctx);
  if (ctx.primary === null || set.length < 2 || cities.length < 2) return null;
  return { type: ctx.primary.type, set, ages: [], audiences: [], genders: [], metros: cities, ...NO_STEP };
}

/** shareAcrossCities deferred to the peers wave 1 resolves, when the question named none of the primary's type. */
function shareCitiesAfterWave1(ctx: ScanInputs): DeferBuild<"share_of_taste"> | null {
  const { primary } = ctx;
  const cities = scanCities(ctx);
  if (primary === null || !SHAREABLE.includes(primary.type) || cities.length < 2) return null;
  return {
    estimate: cities.length,
    describe: `for ${primary.ref} and the ${primary.type} peers your wave-1 resolve_entities registers, across ${cities.join(", ")}`,
    input: (peers) => shareAcrossCities({ ...ctx, peers: [...ctx.peers, ...peers] }),
  };
}

/**
 * geo_lift for the question's concept in the `index`-th compared city, chained after find_tags, when
 * that city is a map city (a market without a gazetteer has no neighbourhood map). Like site_selection's
 * scan lift, it runs with supply, so its LATENT_DEMAND findings reach turn 2 and a pivot can profile the
 * pocket; as a turn-2 planned step per city it would spend the follow-up allowance before any pivot.
 * Lift is relative within each city: the cities are compared on their fingerprints, never on lift.
 */
function liftInCity(index: number): (ctx: ScanInputs) => ChainBuild<"geo_lift"> | null {
  return (ctx) => {
    const cities = scanCities(ctx);
    const city = cities[index];
    if (cities.length < 2 || city === undefined || !isGazetteerMetro(city) || ctx.intent.constraints.concepts.length === 0) return null;
    return {
      after: "find_tags",
      estimate: SCAN_LIFT_ESTIMATE,
      describe: `in ${city} (compared city ${index + 1}) on the place tags find_tags returns, with supply`,
      input: ({ tags }) => {
        const concept = placeTagRefs(tags).slice(0, LIFT_TAGS_MAX);
        return concept.length === 0 ? null : { metro: city, concept_tags: concept, concept_entities: [], supply: true, ...NO_STEP };
      },
    };
  };
}

// OpenStreetMap supply (R6, D46, PLAN §5.2): real places of the concept's type and street activity -----------

/** local_supply's area maximum. */
const SUPPLY_AREAS_MAX = 8;
/** site_selection's supply read: the top lift areas and the top popular areas beside the question's own. */
const SUPPLY_LIFT_TOP = 3;
const SUPPLY_POPULAR_TOP = 2;
/** Twins taste_twins' supply read counts in the target city. */
const SUPPLY_TWINS = 5;

/** The place types the question's concept maps to (config/osm_tags.json), at most four. */
const conceptSupplyTypes = (intent: Intent): string[] => supplyTypesForConcepts(questionConcepts(intent)).keys;

/** What a supply step counts, for the run context. */
const supplyWhat = (keys: readonly string[]): string => (keys.length > 0 ? `${keys.join(", ")} places and street activity` : "street activity only (no OpenStreetMap tag for the concept)");

/**
 * site_selection: local_supply chained after geo_lift (PLAN §5.2, D46): the concept's place types in the
 * question's and candidate areas, the top lift areas and the top popular areas (R7), at most eight, so
 * the reader sees real competitors beside each area's lift. The first area is the question's, else the
 * top lift area, and it lists the named places. Without a mapped type it counts street activity only.
 */
function supplyAfterLift(ctx: ScanInputs): ChainBuild<"local_supply"> | null {
  const metro = ctx.intent.geo.metro;
  if (ctx.publicData !== true || metro === null || ctx.intent.constraints.concepts.length === 0) return null;
  const keys = conceptSupplyTypes(ctx.intent);
  const user = ctx.candidates.areas.filter((a) => a.metro === metro && a.source === "user_named").map((a) => a.id);
  const named = [...new Set([...namedAreaIds(ctx.intent, ctx.geo), ...user])];
  const obvious = ctx.candidates.areas.filter((a) => a.metro === metro && a.source === "obvious").map((a) => a.id);
  return {
    after: "geo_lift",
    estimate: 0,
    describe: `in ${metro}: ${supplyWhat(keys)} in the question's and candidate areas, the top lift areas and the top popular areas (OpenStreetMap, 0 Qloo calls)`,
    input: ({ areas, datasets = [] }) => {
      const lift = areas.filter((a) => a.metro === metro).map((a) => a.id).slice(0, SUPPLY_LIFT_TOP);
      const popular = datasets.flatMap((d) => (d.kind === "GeoLift" && d.payload.metro === metro ? (d.payload.popular ?? []) : [])).slice(0, SUPPLY_POPULAR_TOP);
      const ids = [...new Set([...named, ...lift, ...obvious, ...popular])].slice(0, SUPPLY_AREAS_MAX);
      if (ids.length === 0) return null;
      return { metro, areas: ids, market: null, place_types: keys, mix: false, list_places: keys.length > 0, ...NO_STEP };
    },
  };
}

/**
 * tenant_mix and area_profile: the question's area against its city on every storefront type (`mix`), so
 * "what does the block already have too much of" is answered from counts; tenant_mix also lists the named
 * places.
 */
function supplyMix(listPlaces: boolean): (ctx: ScanInputs) => ToolInput<"local_supply"> | null {
  return (ctx) => {
    const metro = ctx.intent.geo.metro;
    if (ctx.publicData !== true || metro === null) return null;
    const [area] = namedAreaIds(ctx.intent, ctx.geo);
    if (area === undefined) return null;
    return { metro, areas: [area], market: null, place_types: [], mix: true, list_places: listPlaces, ...NO_STEP };
  };
}

/** taste_twins: the source area's supply in its own city (the twins' is read in the target city after taste_twins). */
function supplyTwinSource(ctx: ScanInputs): ToolInput<"local_supply"> | null {
  const sides = twinSides(ctx);
  if (ctx.publicData !== true || sides === null) return null;
  return { metro: sides.source.metro, areas: [sides.source.ref], market: null, place_types: conceptSupplyTypes(ctx.intent), mix: false, list_places: false, ...NO_STEP };
}

/** taste_twins: local_supply chained after taste_twins, for the top twins in the target city. */
function supplyTwins(ctx: ScanInputs): ChainBuild<"local_supply"> | null {
  const sides = twinSides(ctx);
  if (ctx.publicData !== true || sides === null) return null;
  const keys = conceptSupplyTypes(ctx.intent);
  return {
    after: "taste_twins",
    estimate: 0,
    describe: `in ${sides.target}: ${supplyWhat(keys)} in the top ${SUPPLY_TWINS} twins taste_twins returns (OpenStreetMap, 0 Qloo calls)`,
    input: ({ areas }) => {
      const twins = [...new Set(areas.filter((a) => a.metro === sides.target).map((a) => a.id))].slice(0, SUPPLY_TWINS);
      return twins.length === 0 ? null : { metro: sides.target, areas: twins, market: null, place_types: keys, mix: false, list_places: false, ...NO_STEP };
    },
  };
}

/** city_compare: the concept's places around the `index`-th compared city's centre, when the concept maps to a type. */
function supplyInCity(index: number): (ctx: ScanInputs) => ToolInput<"local_supply"> | null {
  return (ctx) => {
    const cities = scanCities(ctx);
    const city = cities[index];
    if (ctx.publicData !== true || cities.length < 2 || city === undefined) return null;
    const keys = conceptSupplyTypes(ctx.intent);
    if (keys.length === 0) return null;
    return { metro: null, areas: [], market: city, place_types: keys, mix: false, list_places: false, ...NO_STEP };
  };
}

const SUPPLY_WHY = "needs an area of a map city in the question, and OpenStreetMap on this server";
const SUPPLY_LIFT_WHY = "needs a concept and a map city in the question, and OpenStreetMap on this server";
const SUPPLY_CITY_WHY = "needs two cities from MARKETS and a concept OpenStreetMap has a place type for";

const CITIES_WHY = "needs two to four cities from the MARKETS list in the question";
const CITY_LIFT_WHY = "needs a concept in the question and a compared city that is one of the 13 map cities";
const TWINS_WHY = "needs a source area from the AREAS list and another map city to look in";

const LIFT_WHY = "needs a concept and a gazetteer metro (one of the 13 map cities) in the question";

/**
 * The scan skills per job, in PLAN §4.1 order. Where it differs from the SPEC §4.1 scan table, on
 * purpose (D33): brand_health maps the target with peer_landscape (k 6, discovery on) rather than
 * discovery alone, and head_to_head adds the primary's peer_landscape, so both open with a
 * Substitution Map (up to 2 + (k - 1) = 7 cold calls each); head_to_head reads its share_of_taste
 * across up to four markets (the question's first) as well as by age and mirrors the first peer in
 * audience_dna, so wave 1 need not repeat either; the pair is ranked only in a metro the question
 * names; site_selection chains geo_lift after find_tags (PLAN §4.1's concept heatmap), so its lift
 * findings reach turn 2, where a pivot can profile the top pocket; sponsorship checks its slate in
 * the markets the question names, else the gazetteer metros; sponsorship and audience_discovery add
 * the domains the question names to cross_domain, and audience_discovery always reads the primary's
 * own type there too; market_selection's market grid and audience_discovery's read by age wait for
 * the peers wave 1 resolves when the question names none (`defer`), else take the scan's own
 * neighbours of the primary's type, since those questions rarely name the comparison set: run as
 * turn-2 steps they would spend the follow-up allowance, and nothing they found could be followed. director.md §6 describes
 * these scans, so wave 1 does not repeat them.
 *
 * Part 9 (PLAN §4.1, D40): taste_twins reads the question's area into the target city (code picks the
 * areas, or the concept's place tags from find_tags do); brand_collab discovers partners, scores them
 * on one scale from the subject, mirrors the best in audience_dna and reads the pair's shared music
 * neighbourhood with cross_domain (chains after a chain);
 * creator_fit discovers artists and podcasts and scores each kind on its own scale (a person is no
 * cross_domain domain); launch_test reads the concept's open call, keeping or vetoing the analogs the
 * question names; city_compare reads each city's fingerprint (one entry per city) and the named
 * entity's share across them, and with a concept chains each fingerprint after find_tags with the
 * concept's tags (CR 5: the concept's rank per city is a citable metric) and geo_lift (with supply) in
 * each compared map city, as site_selection does, so a LATENT_DEMAND pocket can be profiled in turn 2. company_financials (brand_health, head_to_head, launch_test) and area_economics (the
 * location jobs with an area set) cost 0 Qloo calls and join only with a public-data client, for a
 * listed brand or a known area, so no step runs that could only answer UNAVAILABLE.
 */
export const SCAN_TABLE: Readonly<Record<Job, readonly ScanEntry[]>> = {
  brand_health: [
    { tool: "peer_landscape", build: peerMap(true), why: PEER_MAP_WHY },
    { tool: "audience_dna", build: dnaSet(false), why: PRIMARY_WHY },
    { tool: "destination_affinity", build: travelTaste, why: PRIMARY_WHY },
    { tool: "company_financials", build: financials, why: FIN_WHY },
  ],
  head_to_head: [
    { tool: "peer_landscape", build: peerMap(false), why: PEER_MAP_WHY },
    { tool: "rank_candidates", build: pairRank, why: "needs a metro in the question and a peer of the primary's type" },
    { tool: "share_of_taste", build: shareSet(SCAN_AGES, SCAN_DUEL_MARKETS), why: SET_WHY },
    { tool: "audience_dna", build: dnaSet(true), why: PRIMARY_WHY },
    { tool: "company_financials", build: financials, why: FIN_WHY },
  ],
  site_selection: [
    { tool: "find_tags", build: conceptTags, why: "needs a concept in the question" },
    { tool: "find_tags", chain: categoryRetry(conceptTags), why: CATEGORY_RETRY_WHY, unused: retryUnused },
    { tool: "geo_lift", chain: liftFromTags, why: LIFT_WHY },
    { tool: "area_economics", chain: econLift, why: ECON_WHY },
    { tool: "local_supply", chain: supplyAfterLift, why: SUPPLY_LIFT_WHY },
  ],
  area_profile: [
    { tool: "block_dna", build: blockArea, why: "needs a neighbourhood from the AREAS list in a gazetteer metro" },
    { tool: "area_economics", build: econNamed, why: ECON_WHY },
    { tool: "local_supply", build: supplyMix(false), why: SUPPLY_WHY },
  ],
  tenant_mix: [
    { tool: "block_dna", build: blockArea, why: "needs a neighbourhood from the AREAS list in a gazetteer metro" },
    { tool: "area_economics", build: econNamed, why: ECON_WHY },
    { tool: "local_supply", build: supplyMix(true), why: SUPPLY_WHY },
  ],
  sponsorship: [
    { tool: "sponsor_slate", build: slate, why: "needs an artist or person as the primary target" },
    { tool: "cross_domain", build: neighbourhood(["brand"], false), why: PRIMARY_WHY },
  ],
  market_selection: [
    { tool: "destination_affinity", build: travelTaste, why: PRIMARY_WHY },
    { tool: "share_of_taste", build: shareSet([], SHARE_MARKETS_MAX), defer: shareAfterWave1([], SHARE_MARKETS_MAX), why: SET_WHY },
  ],
  audience_discovery: [
    { tool: "cross_domain", build: neighbourhood(SCAN_DOMAINS, true, true), why: PRIMARY_WHY },
    { tool: "audience_dna", build: dnaSet(false), why: PRIMARY_WHY },
    { tool: "share_of_taste", build: shareSet(SCAN_AGES, 0), defer: shareAfterWave1(SCAN_AGES, 0), why: SET_WHY },
  ],
  taste_twins: [
    { tool: "find_tags", build: conceptTags, why: "runs only when the question names a concept" },
    { tool: "find_tags", chain: categoryRetry(conceptTags), why: CATEGORY_RETRY_WHY, unused: retryUnused },
    { tool: "taste_twins", build: twinsByArea, chain: twinsFromTags, why: TWINS_WHY },
    { tool: "area_economics", build: econNamed, why: ECON_WHY },
    { tool: "area_economics", chain: econTwins, why: "needs twins from taste_twins, and public data on this server" },
    { tool: "local_supply", build: supplyTwinSource, why: SUPPLY_WHY },
    { tool: "local_supply", chain: supplyTwins, why: "needs twins from taste_twins, and OpenStreetMap on this server" },
  ],
  brand_collab: [
    { tool: "cross_domain", build: neighbourhood(SCAN_COLLAB_DOMAINS, false), why: PRIMARY_WHY },
    { tool: "rank_candidates", chain: scoreDiscovered("brand"), why: "needs a primary and two brands from cross_domain to score" },
    { tool: "audience_dna", chain: collabDna, why: "needs a primary and a partner rank_candidates scored" },
    { tool: "cross_domain", chain: collabShared, why: "needs a primary and a partner rank_candidates scored" },
  ],
  creator_fit: [
    { tool: "cross_domain", build: neighbourhood(SCAN_CREATOR_DOMAINS, false), why: PRIMARY_WHY },
    { tool: "rank_candidates", chain: scoreDiscovered("artist"), why: "needs a primary and two artists from cross_domain to score" },
    { tool: "rank_candidates", chain: scoreDiscovered("podcast"), why: "needs a primary and two podcasts from cross_domain to score" },
  ],
  launch_test: [
    { tool: "find_tags", build: productTags, why: "needs a concept or concept description in the question" },
    { tool: "find_tags", chain: categoryRetry(productTags), why: CATEGORY_RETRY_WHY, unused: retryUnused },
    { tool: "concept_vector", chain: conceptVector, why: "needs taxonomy tags from find_tags" },
    { tool: "company_financials", build: financials, why: FIN_WHY },
  ],
  city_compare: [
    // find_tags first, so each city's fingerprint can chain after it and carry the concept's tags (CR 5).
    { tool: "find_tags", build: conceptTags, why: "runs only when the question names a concept" },
    { tool: "find_tags", chain: categoryRetry(conceptTags), why: CATEGORY_RETRY_WHY, unused: retryUnused },
    ...Array.from(
      { length: CITIES_MAX },
      (_, i): ScanEntry => ({ tool: "block_dna", chain: fingerprintInCity(i), build: fingerprintOfCity(i), unused: citySlotUnused(i), why: CITIES_WHY }),
    ),
    ...Array.from({ length: CITIES_MAX }, (_, i): ScanEntry => ({ tool: "geo_lift", chain: liftInCity(i), why: CITY_LIFT_WHY })),
    { tool: "share_of_taste", build: shareAcrossCities, defer: shareCitiesAfterWave1, why: "needs a brand or person primary and two cities from MARKETS" },
    ...Array.from({ length: CITIES_MAX }, (_, i): ScanEntry => ({ tool: "local_supply", build: supplyInCity(i), unused: citySlotUnused(i), why: SUPPLY_CITY_WHY })),
  ],
};

export interface ScanStep {
  /** Code-made tool call id: scan-1, scan-2, … */
  toolCallId: string;
  tool: SkillId;
  /** Parsed by the tool's own schema. */
  input: unknown;
}

/**
 * A scan step that runs once the parallel steps are done, in table order, from what its `after` step
 * returned (a parallel step, or a chained step before it).
 */
export interface ChainedScanStep {
  toolCallId: string;
  tool: SkillId;
  after: SkillId;
  /** Typical cold cost in network calls, for budgets and previews; the exact one is estimated once it runs. */
  estimate: number;
  /** How the run context describes the step, after the tool label. */
  describe: string;
  /** The input parsed by the tool's own schema, or null when what the step returned cannot feed it. */
  input: (feed: ChainFeed) => unknown;
  /** True when not running is the usual case (the category retry): no SCAN NOTE then. */
  quiet?: boolean;
}

/**
 * A scan step that waits for the peers the ANALYST's wave-1 resolve_entities registers: it runs once
 * wave 1 returns, before turn 1 closes, on those peers, else on the scan's own neighbours of the
 * primary's type, or not at all when neither holds a peer it can use.
 */
export interface DeferredScanStep {
  toolCallId: string;
  tool: SkillId;
  /** Typical cold cost in network calls, for budgets and previews; the exact one is estimated once it runs. */
  estimate: number;
  /** How the run context describes the step, after the tool label. */
  describe: string;
  /** The input parsed by the tool's own schema from wave 1's resolved peers, or null when none fits. */
  input: (peers: readonly RegisteredEntity[]) => unknown;
}

export interface ScanPlan {
  steps: ScanStep[];
  /** Steps that wait for the parallel ones, in table order. */
  chained: ChainedScanStep[];
  /** Steps that wait for the peers wave 1 resolves, in table order. */
  deferred: DeferredScanStep[];
  /** Scan skills this build cannot run yet. */
  unavailable: SkillId[];
  /** Scan skills that could run but not for this question, with the reason. */
  skipped: { tool: SkillId; reason: string }[];
  /**
   * Run-level limitation flags the plan raises: SEC_NOT_CONFIGURED / CENSUS_NOT_CONFIGURED when a
   * public-data step would have run for this question but its source is not configured (D7), and
   * NOT_A_LISTED_COMPANY for a primary brand with no listed company (financialsNote).
   */
  flags: Flag[];
  /**
   * Limitations with their own text that the plan raises: NOT_SEPARATELY_REPORTED naming the parent of a
   * primary sub-brand (flag set), and "No OpenStreetMap tag" for a concept the supply read cannot count
   * (no flag: a plain line).
   */
  limitations: { flag: Flag | null; text: string }[];
}

/** The plan of a run that scans nothing (Qloo disabled). */
export const emptyScan = (): ScanPlan => ({ steps: [], chained: [], deferred: [], unavailable: [], skipped: [], flags: [], limitations: [] });

/**
 * True when a scan entry would make a step for this question: its build parses, its chain follows a
 * step already planned, or `each` returns an input. Used for a public-data entry whose source is not
 * configured, so its limitation shows only on a question that would have read it.
 */
function wouldPlan(entry: ScanEntry, inputs: ScanInputs, planned: readonly SkillId[]): boolean {
  const schema = ANALYST_TOOLS[entry.tool].input;
  if (entry.chain !== undefined) {
    const chain = (entry.chain as (c: ScanInputs) => ChainBuild<SkillId> | null)(inputs);
    if (chain !== null && planned.includes(chain.after)) return true;
  }
  if (entry.build !== undefined) {
    const raw = (entry.build as (c: ScanInputs) => unknown)(inputs);
    if (raw !== null && schema.safeParse(raw).success) return true;
  }
  if (entry.each !== undefined) return (entry.each as (c: ScanInputs) => unknown[])(inputs).some((raw) => schema.safeParse(raw).success);
  return false;
}

export function planScan(job: Job, ctx: ScanContext): ScanPlan {
  const plan = emptyScan();
  const geo = ctx.geo ?? gazetteer();
  const metros: readonly string[] = geo.metros();
  const markets = ctx.markets ?? MARKET_CATALOGUE.filter((m) => metros.includes(m.id));
  const inputs: ScanInputs = { ...ctx, geo, markets, candidates: ctx.candidates ?? NO_SCAN_CANDIDATES };
  const why = (entry: ScanEntry) => entry.why ?? "its default arguments do not fit this question";
  // One line per tool and reason: per-item slots (a fingerprint or lift map per city) share theirs.
  const skip = (entry: ScanEntry, reason = why(entry)) => {
    if (entry.unused?.(inputs) === true) return;
    if (!plan.skipped.some((s) => s.tool === entry.tool && s.reason === reason)) plan.skipped.push({ tool: entry.tool, reason });
  };
  const nextId = () => `scan-${plan.steps.length + plan.chained.length + plan.deferred.length + 1}`;
  for (const entry of SCAN_TABLE[job]) {
    if (!isSkillAvailable(entry.tool) || (entry.build === undefined && entry.chain === undefined && entry.each === undefined)) {
      plan.unavailable.push(entry.tool);
      continue;
    }
    const unconfigured = ctx.publicData === true ? unconfiguredSource(entry.tool, ctx.publicConfigured) : null;
    if (unconfigured !== null) {
      // D7: never planned. The limitation is the source's own, shown only when the question would have read it.
      const planned = [...plan.steps, ...plan.chained].map((s) => s.tool);
      const wanted = wouldPlan(entry, inputs, planned);
      skip(entry, wanted ? PUBLIC_NOT_CONFIGURED_REASON[unconfigured] : why(entry));
      const flag = NOT_CONFIGURED_FLAG[unconfigured];
      if (wanted && !plan.flags.includes(flag)) plan.flags.push(flag);
      continue;
    }
    const schema = ANALYST_TOOLS[entry.tool].input;
    if (entry.chain !== undefined) {
      // A chain follows a parallel step or a chained step earlier in the table; when it cannot, `build` stands in.
      const chain = (entry.chain as (c: ScanInputs) => ChainBuild<SkillId> | null)(inputs);
      const follows = chain !== null && [...plan.steps, ...plan.chained].some((s) => s.tool === chain.after);
      if (chain !== null && follows) {
        plan.chained.push({
          toolCallId: nextId(),
          tool: entry.tool,
          after: chain.after,
          estimate: chain.estimate,
          describe: chain.describe,
          ...(chain.quiet === true ? { quiet: true } : {}),
          input: (feed) => {
            const raw = chain.input(feed);
            const parsed = raw === null ? null : schema.safeParse(raw);
            return parsed?.success ? parsed.data : null;
          },
        });
        continue;
      }
      if (entry.build === undefined) {
        skip(entry);
        continue;
      }
    }
    if (entry.each !== undefined) {
      const built = (entry.each as (c: ScanInputs) => unknown[])(inputs).flatMap((raw) => {
        const parsed = schema.safeParse(raw);
        return parsed.success ? [parsed.data] : [];
      });
      if (built.length === 0) skip(entry);
      for (const input of built) plan.steps.push({ toolCallId: nextId(), tool: entry.tool, input });
      continue;
    }
    const raw = (entry.build as (c: ScanInputs) => unknown)(inputs);
    const parsed = raw === null ? null : schema.safeParse(raw);
    if (parsed !== null && parsed.success) {
      plan.steps.push({ toolCallId: nextId(), tool: entry.tool, input: parsed.data });
      continue;
    }
    const defer = entry.defer === undefined ? null : (entry.defer as (c: ScanInputs) => DeferBuild<SkillId> | null)(inputs);
    if (defer === null) {
      skip(entry);
      continue;
    }
    plan.deferred.push({
      toolCallId: nextId(),
      tool: entry.tool,
      estimate: defer.estimate,
      describe: defer.describe,
      input: (peers) => {
        const late = defer.input(peers);
        const checked = late === null ? null : schema.safeParse(late);
        return checked?.success ? checked.data : null;
      },
    });
  }
  // Never silent about financials (Part 9 open issue 6), nor about a concept the supply read cannot count.
  const fin = financialsNote(job, ctx);
  if (fin !== null && fin.text === null && !plan.flags.includes(fin.flag)) plan.flags.push(fin.flag);
  if (fin !== null && fin.text !== null) plan.limitations.push({ flag: fin.flag, text: fin.text });
  if ([...plan.steps, ...plan.chained].some((s) => s.tool === "local_supply")) {
    for (const concept of supplyTypesForConcepts(questionConcepts(ctx.intent)).unmapped) plan.limitations.push({ flag: null, text: noOsmTagText(concept) });
  }
  return dropIdleRetries(plan);
}

/**
 * A quiet chained step (the category retry) feeds the steps chained after it on the same step; with
 * none planned for this question (a site_selection concept but no map city), it would test nothing,
 * so it is dropped and the code-made ids are numbered again in the order they were given.
 */
function dropIdleRetries(plan: ScanPlan): ScanPlan {
  const idle = plan.chained.filter((c, i) => c.quiet === true && !plan.chained.slice(i + 1).some((n) => n.after === c.after && n.quiet !== true));
  if (idle.length === 0) return plan;
  const chained = plan.chained.filter((c) => !idle.includes(c));
  const all = [...plan.steps, ...chained, ...plan.deferred].sort((a, b) => idNumber(a.toolCallId) - idNumber(b.toolCallId));
  const ids = new Map(all.map((s, i) => [s.toolCallId, `scan-${i + 1}`]));
  const renumber = <T extends { toolCallId: string }>(s: T): T => ({ ...s, toolCallId: ids.get(s.toolCallId) ?? s.toolCallId });
  return { ...plan, steps: plan.steps.map(renumber), chained: chained.map(renumber), deferred: plan.deferred.map(renumber) };
}

const idNumber = (id: string): number => Number(id.slice("scan-".length));

/** How the run context describes a chained step, e.g. "geo_lift (LIFT) in nashville on the place tags …". */
export function describeChainedStep(step: ChainedScanStep): string {
  return `${toolLabel(step.tool)} ${step.describe}`;
}

/** How the run context describes a deferred step, e.g. "share_of_taste (SHARE) for R1 and the person peers …". */
export function describeDeferredStep(step: DeferredScanStep): string {
  return `${toolLabel(step.tool)} ${step.describe}`;
}

/** How the run context describes one scan step, e.g. "peer_landscape (SUBS) for R1, discovery on, k 6". */
export function describeScanStep(step: ScanStep): string {
  const label = toolLabel(step.tool);
  switch (step.tool) {
    case "peer_landscape": {
      const i = step.input as ToolInput<"peer_landscape">;
      const peers = i.peers.length > 0 ? ` with peers ${i.peers.join(", ")}` : "";
      return `${label} for ${i.target}${peers}, discovery ${i.discover ? "on" : "off"}, k ${i.k}`;
    }
    case "share_of_taste": {
      const i = step.input as ToolInput<"share_of_taste">;
      const contexts = [i.ages.length > 0 ? `ages ${i.ages.join(", ")}` : "", i.metros.length > 0 ? `markets ${i.metros.join(", ")}` : ""];
      return `${label} for ${i.set.join(", ")} by ${contexts.filter((c) => c !== "").join(" and ")}`;
    }
    case "audience_dna": {
      const i = step.input as ToolInput<"audience_dna">;
      return `${label} for ${i.set.join(", ")}${i.compare_with === null ? "" : `, compare_with ${i.compare_with}`}`;
    }
    case "rank_candidates": {
      const i = step.input as ToolInput<"rank_candidates">;
      return `${label} for ${i.candidates.join(", ")} under ${i.contexts.map((c) => c.kind).join(", ")}`;
    }
    case "destination_affinity":
      return `${label} from ${(step.input as ToolInput<"destination_affinity">).seeds.join(", ")}`;
    case "cross_domain": {
      const i = step.input as ToolInput<"cross_domain">;
      return `${label} from ${i.seeds.join(", ")} on ${i.domains.join(", ")}`;
    }
    case "sponsor_slate": {
      const i = step.input as ToolInput<"sponsor_slate">;
      const shortlist = i.shortlist.length > 0 ? `, shortlist ${i.shortlist.join(", ")}` : "";
      return `${label} for ${i.seed}, categories ${i.categories.join(", ")}${shortlist}`;
    }
    case "block_dna": {
      const i = step.input as ToolInput<"block_dna">;
      if (i.area.kind === "city") return `${label} city fingerprint of ${i.area.market} against the other map cities`;
      return `${label} for ${i.area.ref} (${i.area.metro})${i.include_brands ? " with local brands" : ""}`;
    }
    case "find_tags":
      return `${label} for ${(step.input as ToolInput<"find_tags">).concepts.length} concept(s)`;
    case "taste_twins": {
      const i = step.input as ToolInput<"taste_twins">;
      const picked = i.target_areas.length > 0 ? `areas ${i.target_areas.join(", ")}` : "the 8 largest areas";
      return `${label} from ${i.source.ref} (${i.source.metro}) into ${i.target_metro}, checking ${picked}`;
    }
    case "concept_vector": {
      const i = step.input as ToolInput<"concept_vector">;
      return `${label} on ${i.concept_tags.join(", ")} (${i.type})${i.analogs.length > 0 ? `, analogs ${i.analogs.join(", ")}` : ", no analogs"}`;
    }
    case "company_financials":
      return `${label} for ${(step.input as ToolInput<"company_financials">).brand} (SEC EDGAR, 0 Qloo calls)`;
    case "area_economics": {
      const i = step.input as ToolInput<"area_economics">;
      return `${label} for ${i.areas.join(", ")} (${i.metro}; US Census, 0 Qloo calls)`;
    }
    case "local_supply": {
      const i = step.input as ToolInput<"local_supply">;
      const where = i.market !== null ? `around ${i.market}` : `in ${i.areas.join(", ")} (${i.metro ?? ""})`;
      const what = i.mix ? "every storefront type against the city (mix)" : supplyWhat(i.place_types);
      return `${label} ${where}: ${what}${i.list_places ? ", with named places" : ""} (OpenStreetMap, 0 Qloo calls)`;
    }
    default:
      return label;
  }
}
