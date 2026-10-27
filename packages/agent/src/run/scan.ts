import {
  ANALYST_TOOLS,
  Domain,
  SponsorCategory,
  type AgeBucket,
  type GeoApi,
  type Intent,
  type Job,
  type MarketId,
  type RegisteredEntity,
  type RegisteredTag,
  type SkillId,
  type ToolInput,
} from "@ct/contracts";
import { AREA_ALSO_NAMED } from "./areaMentions";
import { isSkillAvailable, toolLabel } from "./catalogue";
import { gazetteer } from "./gazetteer";
import { askedTier, isGazetteerMetro, MARKET_CATALOGUE, marketTier, namedMarkets, type RunMarket } from "./markets";

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
}

/** What a builder reads: the scan context with its gazetteer and markets settled. */
type ScanInputs = ScanContext & { geo: GeoApi; markets: readonly RunMarket[] };

/** A chained step's input from the tags its `after` step returned, or null when none fits. */
interface ChainBuild<Id extends SkillId> {
  /** The scan skill whose refs it needs. */
  after: SkillId;
  /** Its typical cold cost in network calls: the input, and so the exact estimate, exists only later. */
  estimate: number;
  /** How the run context describes it, after the tool label. */
  describe: string;
  input: (tags: readonly RegisteredTag[]) => ToolInput<Id> | null;
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
 * A scan skill and how to build its default input. `build` runs it in parallel with the others;
 * `chain` runs it after them, from the tags one of them returned (geo_lift needs find_tags' refs), or
 * returns null when the question cannot feed it. Neither means the build cannot run it yet. `defer`
 * takes over when `build` finds no peer to compare: the step waits for the peers the ANALYST's wave-1
 * resolve_entities registers (director.md §5: the implied peers of "other comedians") and runs as
 * part of the scan once wave 1 returns, before turn 1 closes, so its findings can still be followed
 * in turn 2 and its calls stay out of turn 2's allowance.
 */
type ScanEntry = {
  [Id in SkillId]: {
    tool: Id;
    build?: (ctx: ScanInputs) => ToolInput<Id> | null;
    chain?: (ctx: ScanInputs) => ChainBuild<Id> | null;
    defer?: (ctx: ScanInputs) => DeferBuild<Id> | null;
    why?: string;
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
  return { type: ctx.primary.type, candidates: pair, signal_entities: [], signal_tags: [], contexts: [{ kind: "metro", market: metro }], ...NO_STEP };
}

/**
 * The markets the question names, then the run's MARKETS of the tier the CLERK notes ask for
 * ("secondary-market dates" reads secondary markets, not the majors the catalogue lists first), then
 * the rest, at most `max`. Past the named ones each group takes one market per state before a
 * second, in catalogue order, so a grid of eight is not three Texas cities among the first majors.
 */
function scanMarkets({ intent, markets }: ScanInputs, max: number): MarketId[] {
  const named = namedMarkets(intent, markets);
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
function slate({ intent, primary, peers, markets }: ScanInputs): ToolInput<"sponsor_slate"> | null {
  if (primary === null || (primary.type !== "artist" && primary.type !== "person")) return null;
  const categories = intent.constraints.sponsor_categories.length > 0 ? intent.constraints.sponsor_categories : SCAN_SPONSOR_CATEGORIES;
  const shortlist = distinctRefs(peers.filter((p) => p.type === "brand")).slice(0, 10);
  const named = namedMarkets(intent, markets);
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
function liftFromTags({ intent, geo }: ScanInputs): ChainBuild<"geo_lift"> | null {
  const metro = intent.geo.metro;
  if (metro === null || intent.constraints.concepts.length === 0) return null;
  const focus = namedAreaIds(intent, geo);
  return {
    after: "find_tags",
    estimate: SCAN_LIFT_ESTIMATE,
    describe:
      `in ${metro} on the place tags find_tags returns, with supply` +
      (focus.length > 0 ? `, and the question's ${focus.length === 1 ? "area" : "areas"} ${focus.join(", ")} first` : ""),
    input: (tags) => {
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
 * turn-2 steps they would spend the follow-up allowance, and nothing they found could be followed. director.md §5 describes
 * these scans, so wave 1 does not repeat them.
 */
export const SCAN_TABLE: Readonly<Record<Job, readonly ScanEntry[]>> = {
  brand_health: [
    { tool: "peer_landscape", build: peerMap(true), why: PEER_MAP_WHY },
    { tool: "audience_dna", build: dnaSet(false), why: PRIMARY_WHY },
    { tool: "destination_affinity", build: travelTaste, why: PRIMARY_WHY },
  ],
  head_to_head: [
    { tool: "peer_landscape", build: peerMap(false), why: PEER_MAP_WHY },
    { tool: "rank_candidates", build: pairRank, why: "needs a metro in the question and a peer of the primary's type" },
    { tool: "share_of_taste", build: shareSet(SCAN_AGES, SCAN_DUEL_MARKETS), why: SET_WHY },
    { tool: "audience_dna", build: dnaSet(true), why: PRIMARY_WHY },
  ],
  site_selection: [
    { tool: "find_tags", build: conceptTags, why: "needs a concept in the question" },
    { tool: "geo_lift", chain: liftFromTags, why: LIFT_WHY },
  ],
  area_profile: [{ tool: "block_dna", build: blockArea, why: "needs a neighbourhood from the AREAS list in a gazetteer metro" }],
  tenant_mix: [{ tool: "block_dna", build: blockArea, why: "needs a neighbourhood from the AREAS list in a gazetteer metro" }],
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
};

export interface ScanStep {
  /** Code-made tool call id: scan-1, scan-2, … */
  toolCallId: string;
  tool: SkillId;
  /** Parsed by the tool's own schema. */
  input: unknown;
}

/** A scan step that runs once the parallel steps are done, from the tags its `after` step returned. */
export interface ChainedScanStep {
  toolCallId: string;
  tool: SkillId;
  after: SkillId;
  /** Typical cold cost in network calls, for budgets and previews; the exact one is estimated once it runs. */
  estimate: number;
  /** How the run context describes the step, after the tool label. */
  describe: string;
  /** The input parsed by the tool's own schema, or null when those tags cannot feed it. */
  input: (tags: readonly RegisteredTag[]) => unknown;
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
}

/** The plan of a run that scans nothing (Qloo disabled). */
export const emptyScan = (): ScanPlan => ({ steps: [], chained: [], deferred: [], unavailable: [], skipped: [] });

export function planScan(job: Job, ctx: ScanContext): ScanPlan {
  const plan = emptyScan();
  const geo = ctx.geo ?? gazetteer();
  const metros: readonly string[] = geo.metros();
  const markets = ctx.markets ?? MARKET_CATALOGUE.filter((m) => metros.includes(m.id));
  const inputs: ScanInputs = { ...ctx, geo, markets };
  const why = (entry: ScanEntry) => entry.why ?? "its default arguments do not fit this question";
  const nextId = () => `scan-${plan.steps.length + plan.chained.length + plan.deferred.length + 1}`;
  for (const entry of SCAN_TABLE[job]) {
    if (!isSkillAvailable(entry.tool) || (entry.build === undefined && entry.chain === undefined)) {
      plan.unavailable.push(entry.tool);
      continue;
    }
    if (entry.chain !== undefined) {
      const chain = (entry.chain as (c: ScanInputs) => ChainBuild<SkillId> | null)(inputs);
      if (chain === null || !plan.steps.some((s) => s.tool === chain.after)) {
        plan.skipped.push({ tool: entry.tool, reason: why(entry) });
        continue;
      }
      const schema = ANALYST_TOOLS[entry.tool].input;
      plan.chained.push({
        toolCallId: nextId(),
        tool: entry.tool,
        after: chain.after,
        estimate: chain.estimate,
        describe: chain.describe,
        input: (tags) => {
          const raw = chain.input(tags);
          const parsed = raw === null ? null : schema.safeParse(raw);
          return parsed?.success ? parsed.data : null;
        },
      });
      continue;
    }
    const raw = (entry.build as (c: ScanInputs) => unknown)(inputs);
    const parsed = raw === null ? null : ANALYST_TOOLS[entry.tool].input.safeParse(raw);
    if (parsed !== null && parsed.success) {
      plan.steps.push({ toolCallId: nextId(), tool: entry.tool, input: parsed.data });
      continue;
    }
    const defer = entry.defer === undefined ? null : (entry.defer as (c: ScanInputs) => DeferBuild<SkillId> | null)(inputs);
    if (defer === null) {
      plan.skipped.push({ tool: entry.tool, reason: why(entry) });
      continue;
    }
    const schema = ANALYST_TOOLS[entry.tool].input;
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
  return plan;
}

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
      return `${label} for ${i.area.ref} (${i.area.metro})${i.include_brands ? " with local brands" : ""}`;
    }
    case "find_tags":
      return `${label} for ${(step.input as ToolInput<"find_tags">).concepts.length} concept(s)`;
    default:
      return label;
  }
}
