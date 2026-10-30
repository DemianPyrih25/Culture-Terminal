// The opening scan table: which skills each job runs in this build, with what default arguments.
import { DATA_NOTICE, Job, PUBLIC_NOT_CONFIGURED_REASON, type DigestRow, type EntityRef, type GeoApi, type Intent, type ModelDigest, type RegisteredEntity, type RegisteredTag, type TagRef } from "@ct/contracts";
import { createGeo } from "@ct/geo";
import { describe, expect, it } from "vitest";
import listedConfig from "../../../../config/listed_companies.json";
import { createEntityRegistry } from "../../src/registry";
import { isSkillAvailable } from "../../src/run/catalogue";
import { askedTier, compareCities, MARKET_CATALOGUE, marketTier, namedMarkets } from "../../src/run/markets";
import {
  chainFeed,
  describeChainedStep,
  describeDeferredStep,
  describeScanStep,
  namedAreaIds,
  planScan,
  SCAN_AGES,
  SCAN_DOMAINS,
  SCAN_LIFT_ESTIMATE,
  SCAN_PEER_K,
  SCAN_SPONSOR_CATEGORIES,
  SCAN_TABLE,
  type ChainFeed,
  type ScanContext,
} from "../../src/run/scan";
import { intentFor } from "./support";

const entity = (n: number, type: RegisteredEntity["type"] = "brand"): RegisteredEntity => ({
  ref: `R${n}` as EntityRef,
  entityId: `synthetic-${n}`,
  name: `Brand ${n}`,
  type,
  popularity: null,
  disambiguation: null,
  tags: [],
});

/** The 13 gazetteer metros with no polygons: MARKETS defaults to them, and no neighbourhood matches. */
const GEO = createGeo({ gazetteers: {} });
const MARKETS = GEO.metros();
/** The first of the default MARKETS, one per state: the share grids' markets (four for a pair, eight for a market grid). */
const BY_STATE = ["nashville", "austin", "nyc", "los_angeles", "chicago", "atlanta", "denver", "seattle"];
const NO_STEP = { trigger_finding_id: null, step_id: null };
/** The public-data steps a run without a public-data client (or a question that cannot feed them) skips. */
const FIN_SKIP = { tool: "company_financials", reason: "needs a brand primary that maps to a US-listed company, and public data on this server" };
const ECON_SKIP = { tool: "area_economics", reason: "needs an area of a map city in the question, and public data on this server" };
const SUPPLY_SKIP = { tool: "local_supply", reason: "needs an area of a map city in the question, and OpenStreetMap on this server" };
const SUPPLY_LIFT_SKIP = { tool: "local_supply", reason: "needs a concept and a map city in the question, and OpenStreetMap on this server" };

/** What a chained step reads, with the given parts and nothing else. */
const feed = (parts: Partial<ChainFeed> = {}): ChainFeed => ({ tags: [], entities: [], areas: [], ...parts });

/** One invented neighbourhood in Nashville, matched by name. */
const AREA_GEO: GeoApi = {
  ...GEO,
  matchNeighbourhood: (metro, text) =>
    metro === "nashville" && text.toLowerCase() === "riverbend"
      ? { id: "riverbend", name: "Riverbend", metro, centroid: { lat: 36.17, lon: -86.75 }, areaKm2: 4 }
      : null,
};

const scanOf = (job: Job, ctx: Partial<ScanContext> & { intent?: Intent } = {}) =>
  planScan(job, { intent: intentFor({ job }), primary: entity(1), peers: [], geo: GEO, ...ctx });

describe("planScan", () => {
  it("brand_health maps the target with discovery, then its Audience DNA and travel taste", () => {
    const plan = scanOf("brand_health", { intent: intentFor(), peers: [entity(2)] });
    expect(plan.steps).toEqual([
      {
        toolCallId: "scan-1",
        tool: "peer_landscape",
        input: { target: "R1", peers: ["R2"], discover: true, k: SCAN_PEER_K, ...NO_STEP },
      },
      { toolCallId: "scan-2", tool: "audience_dna", input: { set: ["R1", "R2"], compare_with: null, ...NO_STEP } },
      { toolCallId: "scan-3", tool: "destination_affinity", input: { seeds: ["R1"], ...NO_STEP } },
    ]);
    expect(plan.unavailable).toEqual([]);
    expect(plan.skipped).toEqual([FIN_SKIP]);
    expect(describeScanStep(plan.steps[0]!)).toBe("peer_landscape (SUBS) for R1 with peers R2, discovery on, k 6");
    expect(describeScanStep(plan.steps[1]!)).toBe("audience_dna (DNA) for R1, R2");
    expect(describeScanStep(plan.steps[2]!)).toBe("destination_affinity (TRVL) from R1");
  });

  it("head_to_head discovers peers unless three or more were named", () => {
    const two = scanOf("head_to_head", { peers: [entity(2), entity(3)] });
    expect(two.steps[0]?.input).toMatchObject({ peers: ["R2", "R3"], discover: true });
    const three = scanOf("head_to_head", { peers: [entity(2), entity(3), entity(4)] });
    expect(three.steps[0]?.input).toMatchObject({ peers: ["R2", "R3", "R4"], discover: false });
    expect(three.unavailable).toEqual([]);
  });

  it("head_to_head reads the set by age and across MARKETS and mirrors the first peer, ranking the pair only in a named metro", () => {
    const plan = scanOf("head_to_head", { peers: [entity(2), entity(3, "artist")] });
    expect(plan.steps.map((s) => s.tool)).toEqual(["peer_landscape", "share_of_taste", "audience_dna"]);
    expect(plan.steps[1]?.input).toEqual({ type: "brand", set: ["R1", "R2"], ages: [...SCAN_AGES], audiences: [], genders: [], metros: BY_STATE.slice(0, 4), ...NO_STEP });
    expect(plan.steps[2]?.input).toEqual({ set: ["R1", "R2", "R3"], compare_with: "R2", ...NO_STEP });
    expect(plan.skipped).toEqual([{ tool: "rank_candidates", reason: "needs a metro in the question and a peer of the primary's type" }, FIN_SKIP]);
    expect(describeScanStep(plan.steps[1]!)).toBe(`share_of_taste (SHARE) for R1, R2 by ages ${SCAN_AGES.join(", ")} and markets ${BY_STATE.slice(0, 4).join(", ")}`);

    const metro = scanOf("head_to_head", {
      intent: intentFor({ job: "head_to_head", geo: { metro: "nashville", area: null, unsupported_place: null, market: null, target_metro: null, cities: [] } }),
      peers: [entity(2)],
    });
    const pair = metro.steps.find((s) => s.tool === "rank_candidates");
    expect(pair?.input).toEqual({
      type: "brand",
      candidates: ["R1", "R2"],
      signal_entities: [],
      signal_tags: [],
      contexts: [{ kind: "metro", market: "nashville" }],
      ...NO_STEP,
    });
  });

  it("caps named peers at k − 1 and leaves out peers that are not brands", () => {
    const peers = [entity(2), entity(3, "artist"), entity(4), entity(5), entity(6), entity(7), entity(8)];
    const plan = scanOf("brand_health", { intent: intentFor(), peers });
    expect(plan.steps[0]?.input).toMatchObject({ peers: ["R2", "R4", "R5", "R6", "R7"] });
  });

  it("skips what needs a target, and maps only a brand target", () => {
    expect(scanOf("brand_health", { intent: intentFor(), primary: null }).skipped).toEqual([
      { tool: "peer_landscape", reason: "needs a brand as the primary target" },
      { tool: "audience_dna", reason: "needs a resolved primary target" },
      { tool: "destination_affinity", reason: "needs a resolved primary target" },
      FIN_SKIP,
    ]);
    const artist = scanOf("brand_health", { intent: intentFor(), primary: entity(1, "artist") });
    expect(artist.steps.map((s) => s.tool)).toEqual(["audience_dna", "destination_affinity"]);
  });

  it("site_selection looks up the question's concepts as place concepts, and nothing without one", () => {
    const intent = intentFor({ job: "site_selection", constraints: { ...intentFor().constraints, concepts: ["listening bar", " listening bar "] } });
    const plan = scanOf("site_selection", { intent });
    expect(plan.steps).toEqual([
      { toolCallId: "scan-1", tool: "find_tags", input: { concepts: [{ text: "listening bar", scope: "place" }], ...NO_STEP } },
    ]);
    expect(describeScanStep(plan.steps[0]!)).toBe("find_tags (TAGS) for 1 concept(s)");
    // No metro in the question: the concept heatmap has nowhere to go.
    expect(plan.chained).toEqual([]);
    expect(plan.skipped).toEqual([{ tool: "geo_lift", reason: "needs a concept and a gazetteer metro (one of the 13 map cities) in the question" }, ECON_SKIP, SUPPLY_LIFT_SKIP]);
    expect(scanOf("site_selection").skipped.map((s) => s.reason)).toEqual([
      "needs a concept in the question",
      "needs a concept and a gazetteer metro (one of the 13 map cities) in the question",
      ECON_SKIP.reason,
      SUPPLY_LIFT_SKIP.reason,
    ]);
  });

  it("site_selection chains geo_lift after find_tags on the place taxonomy tags it registers", () => {
    const intent = intentFor({
      job: "site_selection",
      geo: { metro: "austin", area: null, unsupported_place: null, market: null, target_metro: null, cities: [] },
      constraints: { ...intentFor().constraints, concepts: ["listening bar"] },
    });
    const plan = scanOf("site_selection", { intent });
    expect(plan.steps.map((s) => s.toolCallId)).toEqual(["scan-1"]);
    // The category retry comes first, quietly (it runs only when the concept's own search keeps no tag).
    const [retry, lift] = plan.chained;
    expect(retry).toMatchObject({ toolCallId: "scan-2", tool: "find_tags", after: "find_tags", estimate: 0, quiet: true });
    expect(lift).toMatchObject({ toolCallId: "scan-3", tool: "geo_lift", after: "find_tags", estimate: SCAN_LIFT_ESTIMATE });
    expect(describeChainedStep(lift!)).toBe("geo_lift (LIFT) in austin on the place tags find_tags returns, with supply");
    const tag = (n: number, tagId: string): RegisteredTag => ({ ref: `T${n}` as TagRef, tagId, name: tagId, type: "taxonomy", signalCapable: true });
    const tags = [
      tag(1, "urn:tag:category:place:wine_bar"),
      tag(2, "urn:tag:genre:place:restaurant:bar"),
      tag(3, "urn:tag:keyword:qloo:cozy"),
    ];
    expect(lift?.input(feed({ tags }))).toEqual({ metro: "austin", concept_tags: ["T2", "T1"], concept_entities: [], supply: true, ...NO_STEP });
    // Supply is always asked for: without a verified category tag geo_lift says the competitor count is unknown, and why.
    expect(lift?.input(feed({ tags: [tags[1]!] }))).toMatchObject({ concept_tags: ["T2"], supply: true });
    expect(lift?.input(feed({ tags: [tags[2]!] }))).toBeNull();
  });

  it("site_selection passes the areas the question names to geo_lift, so each gets its own numbers", () => {
    const intent = intentFor({
      job: "site_selection",
      geo: { metro: "nashville", area: "Riverbend", unsupported_place: null, market: null, target_metro: null, cities: [] },
      constraints: { ...intentFor().constraints, concepts: ["listening bar"], notes: ["area also named: Riverbend", "area also named: Nowhere Flats", "budget is tight"] },
    });
    const [, lift] = scanOf("site_selection", { intent, geo: AREA_GEO }).chained;
    expect(describeChainedStep(lift!)).toBe("geo_lift (LIFT) in nashville on the place tags find_tags returns, with supply, and the question's area riverbend first");
    const genre: RegisteredTag = { ref: "T1" as TagRef, tagId: "urn:tag:genre:place:restaurant:bar", name: "Bar", type: "taxonomy", signalCapable: true };
    // A repeat and a name the gazetteer does not hold are left out.
    expect(lift?.input(feed({ tags: [genre] }))).toEqual({ metro: "nashville", concept_tags: ["T1"], concept_entities: [], supply: true, focus_areas: ["riverbend"], ...NO_STEP });
    expect(namedAreaIds(intent, AREA_GEO)).toEqual(["riverbend"]);
    expect(namedAreaIds({ ...intent, geo: { ...intent.geo, metro: null } }, AREA_GEO)).toEqual([]);
    // Without an area in the gazetteer, no focus_areas at all.
    expect(scanOf("site_selection", { intent }).chained[1]?.input(feed({ tags: [genre] }))).not.toHaveProperty("focus_areas");
  });

  it("area_profile and tenant_mix read the question's neighbourhood with local brands", () => {
    const intent = (job: Job) => intentFor({ job, geo: { metro: "nashville", area: "Riverbend", unsupported_place: null, market: null, target_metro: null, cities: [] } });
    for (const job of ["area_profile", "tenant_mix"] as const) {
      const plan = scanOf(job, { intent: intent(job), geo: AREA_GEO });
      expect(plan.steps).toEqual([
        { toolCallId: "scan-1", tool: "block_dna", input: { area: { kind: "nbhd", ref: "riverbend", metro: "nashville" }, include_brands: true, ...NO_STEP } },
      ]);
      expect(describeScanStep(plan.steps[0]!)).toBe("block_dna (BLOCK) for riverbend (nashville) with local brands");
      expect(scanOf(job, { intent: intent(job) }).skipped).toEqual([
        { tool: "block_dna", reason: "needs a neighbourhood from the AREAS list in a gazetteer metro" },
        ECON_SKIP,
        SUPPLY_SKIP,
      ]);
    }
  });

  it("sponsorship builds the slate for an artist with the question's brands, and its brand neighbourhood", () => {
    const intent = intentFor({ job: "sponsorship", pillar: "marketing" });
    const plan = scanOf("sponsorship", { intent, primary: entity(1, "artist"), peers: [entity(2), entity(3, "artist")] });
    // No market named: the slate checks the gazetteer metros, so its alignment can point to a block.
    expect(plan.steps.map((s) => s.input)).toEqual([
      { seed: "R1", categories: [...SCAN_SPONSOR_CATEGORIES], shortlist: ["R2"], markets: MARKETS.slice(0, 4), ...NO_STEP },
      { seeds: ["R1"], seed_tags: [], domains: ["brand"], popularity_max: 1, ...NO_STEP },
    ]);
    const tour = intentFor({ job: "sponsorship", constraints: { ...intentFor().constraints, notes: ["markets: Denver, Chicago"] } });
    const toured = scanOf("sponsorship", { intent: tour, primary: entity(1, "artist"), markets: MARKET_CATALOGUE });
    expect(toured.steps[0]?.input).toMatchObject({ markets: ["denver", "chicago"] });
    const named = intentFor({ job: "sponsorship", constraints: { ...intentFor().constraints, sponsor_categories: ["beer"], domains: ["podcast"] } });
    const asked = scanOf("sponsorship", { intent: named, primary: entity(1, "person") });
    expect(asked.steps.map((s) => s.input)).toMatchObject([{ categories: ["beer"] }, { domains: ["brand", "podcast"] }]);
    expect(scanOf("sponsorship", { intent }).skipped).toEqual([{ tool: "sponsor_slate", reason: "needs an artist or person as the primary target" }]);
  });

  it("market_selection reads travel taste, and the set across MARKETS once a peer is known", () => {
    const intent = intentFor({ job: "market_selection" });
    const plan = scanOf("market_selection", { intent, peers: [entity(2)] });
    expect(plan.steps.map((s) => s.input)).toEqual([
      { seeds: ["R1"], ...NO_STEP },
      { type: "brand", set: ["R1", "R2"], ages: [], audiences: [], genders: [], metros: BY_STATE, ...NO_STEP },
    ]);
    expect(plan.deferred).toEqual([]);
  });

  it("market_selection waits for the peers wave 1 resolves when the question names none", () => {
    const intent = intentFor({ job: "market_selection" });
    const plan = scanOf("market_selection", { intent, primary: entity(1, "person") });
    expect(plan.steps.map((s) => s.tool)).toEqual(["destination_affinity"]);
    expect(plan.skipped).toEqual([]);
    const [grid] = plan.deferred;
    expect(grid).toMatchObject({ toolCallId: "scan-2", tool: "share_of_taste", estimate: BY_STATE.length });
    expect(describeDeferredStep(grid!)).toBe(
      `share_of_taste (SHARE) for R1 and the person peers your wave-1 resolve_entities registers, by markets ${BY_STATE.join(", ")}`,
    );
    // Peers of another type do not count, so nothing runs; a person peer joins the set.
    expect(grid!.input([entity(3, "brand")])).toBeNull();
    expect(grid!.input([entity(3, "brand"), entity(4, "person"), entity(1, "person")])).toEqual({
      type: "person",
      set: ["R1", "R4"],
      ages: [],
      audiences: [],
      genders: [],
      metros: BY_STATE,
      ...NO_STEP,
    });
    // An artist cannot be shared: no deferred grid, the step is skipped as before.
    const artist = scanOf("market_selection", { intent, primary: entity(1, "artist") });
    expect(artist.deferred).toEqual([]);
    expect(artist.skipped).toEqual([{ tool: "share_of_taste", reason: "needs a brand or person primary with a peer of the same type" }]);
  });

  it("audience_discovery reads the named domains (else three) plus the target's own type, and its Audience DNA", () => {
    const plan = scanOf("audience_discovery", { intent: intentFor({ job: "audience_discovery" }) });
    expect(plan.steps.map((s) => s.input)).toEqual([
      { seeds: ["R1"], seed_tags: [], domains: [...SCAN_DOMAINS], popularity_max: 1, ...NO_STEP },
      { set: ["R1"], compare_with: null, ...NO_STEP },
    ]);
    const named = intentFor({ job: "audience_discovery", constraints: { ...intentFor().constraints, domains: ["movie", "tv_show"] } });
    // The brand target's own domain is read too: its neighbours of that type are the age read's fallback peers.
    expect(scanOf("audience_discovery", { intent: named }).steps[0]?.input).toMatchObject({ domains: ["movie", "tv_show", "brand"] });
    const artist = scanOf("audience_discovery", { intent: named, primary: entity(1, "artist") });
    expect(artist.steps[0]?.input).toMatchObject({ domains: ["movie", "tv_show", "artist"] });
  });

  it("audience_discovery reads the set by three ages: in the scan with a named peer, else once wave 1 resolves one", () => {
    const intent = intentFor({ job: "audience_discovery" });
    const byAge = { type: "brand", ages: [...SCAN_AGES], audiences: [], genders: [], metros: [], ...NO_STEP };
    const withPeer = scanOf("audience_discovery", { intent, peers: [entity(2)] });
    expect(withPeer.steps.map((s) => s.input).at(-1)).toEqual({ ...byAge, set: ["R1", "R2"] });
    expect(withPeer.deferred).toEqual([]);
    const [ages] = scanOf("audience_discovery", { intent }).deferred;
    expect(ages).toMatchObject({ toolCallId: "scan-3", tool: "share_of_taste", estimate: SCAN_AGES.length });
    expect(describeDeferredStep(ages!)).toBe(
      `share_of_taste (SHARE) for R1 and the brand peers your wave-1 resolve_entities registers, by ages ${SCAN_AGES.join(", ")}`,
    );
    expect(ages!.input([])).toBeNull();
    expect(ages!.input([entity(5), entity(6)])).toEqual({ ...byAge, set: ["R1", "R5", "R6"] });
  });

  it("reads 'Washington' after a city as the state, and as Washington DC otherwise", () => {
    const named = (...notes: string[]) => namedMarkets(intentFor({ job: "market_selection", constraints: { ...intentFor().constraints, notes } }), MARKET_CATALOGUE);
    expect(named("markets: Spokane, Washington")).toEqual(["spokane"]);
    expect(named("markets: Walla Walla, Washington")).toEqual([]);
    expect(named("markets: Seattle, Washington, Portland")).toEqual(["seattle", "portland"]);
    expect(named("markets: Boston, Washington, Chicago")).toEqual(["boston", "washington_dc", "chicago"]);
    expect(named("markets: Baltimore, Washington, DC")).toEqual(["baltimore", "washington_dc"]);
    expect(named("markets: Washington, Denver")).toEqual(["washington_dc", "denver"]);
    // A name that is its own state's name still counts after a comma.
    expect(named("markets: Boise, New York")).toEqual(["boise", "nyc"]);
  });

  it("market_selection and head_to_head read the markets the question names first", () => {
    const intent = (job: Job) =>
      intentFor({ job, geo: { metro: "austin", area: null, unsupported_place: null, market: null, target_metro: null, cities: [] }, constraints: { ...intentFor().constraints, notes: ["markets: Boise, New York"] } });
    const share = (job: Job) =>
      scanOf(job, { intent: intent(job), peers: [entity(2)], markets: MARKET_CATALOGUE }).steps.find((s) => s.tool === "share_of_taste")?.input;
    // Past the named ones, one market per state first: Houston and Dallas wait behind Atlanta and Denver.
    expect(share("market_selection")).toMatchObject({ metros: ["austin", "boise", "nyc", "nashville", "los_angeles", "chicago", "atlanta", "denver"] });
    expect(share("head_to_head")).toMatchObject({ metros: ["austin", "boise", "nyc", "nashville"] });
  });

  it("market_selection reads the market tier the CLERK notes ask for, one market per state first", () => {
    const notes = (...n: string[]) => intentFor({ job: "market_selection", constraints: { ...intentFor().constraints, notes: n } });
    const grid = (intent: Intent) =>
      scanOf("market_selection", { intent, primary: entity(1, "person"), markets: MARKET_CATALOGUE }).deferred[0]!.input([entity(2, "person")]);
    // Ohio and North Carolina each give one market before a second, so the grid reaches Alabama and Tennessee.
    const secondary = ["louisville", "kansas_city", "indianapolis", "columbus", "charlotte", "richmond", "birmingham", "knoxville"];
    expect(grid(notes("eight secondary-market dates"))).toMatchObject({ metros: secondary });
    expect(secondary.map((id) => marketTier(id))).toEqual(Array(8).fill("secondary"));
    // A named market still comes first; a note naming both tiers, or neither, asks for no tier.
    expect(grid(notes("secondary markets", "markets: Boise"))).toMatchObject({ metros: ["boise", ...secondary.slice(0, 7)] });
    const majors = ["nashville", "austin", "nyc", "los_angeles", "chicago", "atlanta", "denver", "seattle"];
    expect(grid(notes("major and secondary markets"))).toMatchObject({ metros: majors });
    expect(grid(notes())).toMatchObject({ metros: majors });
    expect(askedTier(notes("eight secondary-market dates"))).toBe("secondary");
    expect(askedTier(notes("major cities only"))).toBe("major");
    expect(askedTier(notes("a secondaryschool tour"))).toBeNull();
  });

  it("gives every available scan skill a default-input builder or a chain", () => {
    for (const job of Job.options) {
      for (const entry of SCAN_TABLE[job]) {
        if (isSkillAvailable(entry.tool)) expect(entry.build ?? entry.chain ?? entry.each, `${job}: ${entry.tool}`).toBeDefined();
      }
    }
  });
});

// Part 9: the five new jobs, the public-data joins and the chain feed ---------------------------------------

/** The first brand on the listed-company list, read from the config itself so no name is written here. */
const LISTED_NAME = Object.keys((listedConfig as { brands: Record<string, unknown> }).brands)[0]!;

const tagOf = (n: number, tagId: string, signalCapable = true): RegisteredTag => ({ ref: `T${n}` as TagRef, tagId, name: tagId, type: "taxonomy", signalCapable });

describe("planScan: the Part 9 jobs", () => {
  const twinIntent = (concepts: string[] = []) =>
    intentFor({
      job: "taste_twins",
      pillar: "location",
      geo: { metro: "nashville", area: "Riverbend", unsupported_place: null, market: null, target_metro: "austin", cities: [] },
      constraints: { ...intentFor().constraints, concepts },
    });

  it("taste_twins reads the source area into the target city, code picking the areas without a concept", () => {
    const plan = scanOf("taste_twins", { intent: twinIntent(), geo: AREA_GEO, publicData: true });
    expect(plan.steps).toEqual([
      {
        toolCallId: "scan-1",
        tool: "taste_twins",
        input: { source: { kind: "nbhd", ref: "riverbend", metro: "nashville" }, target_metro: "austin", target_areas: [], concept_tags: [], ...NO_STEP },
      },
      { toolCallId: "scan-2", tool: "area_economics", input: { metro: "nashville", areas: ["riverbend"], ...NO_STEP } },
      // R6: the source area's street activity in its own city (no concept, so no place type).
      {
        toolCallId: "scan-4",
        tool: "local_supply",
        input: { metro: "nashville", areas: ["riverbend"], market: null, place_types: [], mix: false, list_places: false, ...NO_STEP },
      },
    ]);
    expect(describeScanStep(plan.steps[2]!)).toBe(
      "local_supply (SUPP) in riverbend (nashville): street activity only (no OpenStreetMap tag for the concept) (OpenStreetMap, 0 Qloo calls)",
    );
    expect(describeScanStep(plan.steps[0]!)).toBe("taste_twins (TWIN) from riverbend (nashville) into austin, checking the 8 largest areas");
    expect(describeScanStep(plan.steps[1]!)).toBe("area_economics (ECON) for riverbend (nashville; US Census, 0 Qloo calls)");
    expect(plan.skipped).toEqual([{ tool: "find_tags", reason: "runs only when the question names a concept" }]);
    // The twins' economics follow taste_twins, on the target city's best twins only.
    const [econ] = plan.chained;
    expect(econ).toMatchObject({ toolCallId: "scan-3", tool: "area_economics", after: "taste_twins", estimate: 0 });
    const areas = [
      { metro: "nashville" as const, id: "riverbend" },
      { metro: "austin" as const, id: "a_one" },
      { metro: "austin" as const, id: "a_two" },
      { metro: "austin" as const, id: "a_three" },
      { metro: "austin" as const, id: "a_four" },
    ];
    expect(econ!.input(feed({ areas }))).toEqual({ metro: "austin", areas: ["a_one", "a_two", "a_three"], ...NO_STEP });
    expect(econ!.input(feed())).toBeNull();
  });

  it("taste_twins with a concept chains the twins after find_tags, the concept's place tags picking the areas", () => {
    const plan = scanOf("taste_twins", { intent: twinIntent(["listening bar"]), geo: AREA_GEO });
    expect(plan.steps.map((s) => s.tool)).toEqual(["find_tags"]);
    const [, twins] = plan.chained;
    expect(twins).toMatchObject({ tool: "taste_twins", after: "find_tags" });
    const tags = [tagOf(1, "urn:tag:category:place:wine_bar"), tagOf(2, "urn:tag:genre:place:restaurant:bar"), tagOf(3, "urn:tag:genre:brand:soda")];
    expect(twins!.input(feed({ tags }))).toMatchObject({ concept_tags: ["T2", "T1"], target_areas: [] });
    // No place tag: the twins still run, code picking the areas by size.
    expect(twins!.input(feed())).toMatchObject({ concept_tags: [] });
    // Without public data the economics steps are skipped, never run to answer UNAVAILABLE.
    expect(plan.skipped.map((s) => s.tool)).toEqual(["area_economics", "area_economics", "local_supply", "local_supply"]);
  });

  it("taste_twins skips without a source area or another map city", () => {
    const sameCity = twinIntent();
    sameCity.geo.target_metro = "nashville";
    for (const intent of [sameCity, intentFor({ job: "taste_twins" })]) {
      expect(scanOf("taste_twins", { intent, geo: AREA_GEO }).skipped).toContainEqual({
        tool: "taste_twins",
        reason: "needs a source area from the AREAS list and another map city to look in",
      });
    }
  });

  it("brand_collab discovers brands, scores them on one scale from the subject, then mirrors the best partner and reads the pair's shared music", () => {
    const intent = intentFor({ job: "brand_collab", pillar: "marketing" });
    const plan = scanOf("brand_collab", { intent, peers: [entity(9)] });
    expect(plan.steps).toEqual([
      { toolCallId: "scan-1", tool: "cross_domain", input: { seeds: ["R1"], seed_tags: [], domains: ["brand"], popularity_max: 1, ...NO_STEP } },
    ]);
    const [score, dna, shared] = plan.chained;
    expect(score).toMatchObject({ tool: "rank_candidates", after: "cross_domain" });
    expect(dna).toMatchObject({ tool: "audience_dna", after: "rank_candidates" });
    expect(shared).toMatchObject({ tool: "cross_domain", after: "rank_candidates", estimate: 1 });
    const found = [entity(1), entity(2), entity(3, "artist"), entity(4)];
    // The named partner first, then the discovered brands; the subject is the signal, never a candidate.
    expect(score!.input(feed({ entities: found }))).toEqual({
      type: "brand",
      candidates: ["R9", "R2", "R4"],
      signal_entities: ["R1"],
      signal_tags: [],
      contexts: [{ kind: "none" }],
      ...NO_STEP,
    });
    expect(dna!.input(feed({ entities: [entity(4), entity(1), entity(2), entity(5), entity(6)] }))).toEqual({
      set: ["R1", "R4", "R2", "R5"],
      compare_with: "R4",
      ...NO_STEP,
    });
    expect(dna!.input(feed({ entities: [entity(1)] }))).toBeNull();
    // The pair's shared music neighbourhood: the subject and its best-scored partner as joint seeds, uncapped.
    expect(shared!.input(feed({ entities: [entity(1), entity(3, "artist"), entity(4), entity(2)] }))).toEqual({
      seeds: ["R1", "R4"],
      seed_tags: [],
      domains: ["artist"],
      popularity_max: 1,
      ...NO_STEP,
    });
    expect(shared!.input(feed({ entities: [entity(1), entity(3, "artist")] }))).toBeNull();
    // Without a named partner, one discovered brand is not enough to score.
    expect(scanOf("brand_collab", { intent }).chained[0]!.input(feed({ entities: [entity(2)] }))).toBeNull();
  });

  it("creator_fit discovers artists and podcasts and scores each kind on its own scale", () => {
    const intent = intentFor({ job: "creator_fit", pillar: "marketing" });
    const plan = scanOf("creator_fit", { intent });
    expect(plan.steps[0]?.input).toEqual({ seeds: ["R1"], seed_tags: [], domains: ["artist", "podcast"], popularity_max: 1, ...NO_STEP });
    const [artists, podcasts] = plan.chained;
    const found = [entity(2, "artist"), entity(3, "podcast"), entity(4, "artist"), entity(5, "podcast"), entity(6, "brand")];
    expect(artists!.input(feed({ entities: found }))).toMatchObject({ type: "artist", candidates: ["R2", "R4"], contexts: [{ kind: "none" }] });
    expect(podcasts!.input(feed({ entities: found }))).toMatchObject({ type: "podcast", candidates: ["R3", "R5"], signal_entities: ["R1"] });
  });

  it("launch_test looks up the concept as brand tags, then reads the concept vector with no analogs", () => {
    const described = intentFor({
      job: "launch_test",
      mentions: [],
      constraints: { ...intentFor().constraints, concept_description: "a small premium hot-sauce brand for home cooks who like heat" },
    });
    const plan = scanOf("launch_test", { intent: described, primary: null });
    expect(plan.steps).toEqual([
      { toolCallId: "scan-1", tool: "find_tags", input: { concepts: [{ text: described.constraints.concept_description!.slice(0, 60).trim(), scope: "brand" }], ...NO_STEP } },
    ]);
    const [retry, vector] = plan.chained;
    expect(retry).toMatchObject({ tool: "find_tags", after: "find_tags", quiet: true });
    expect(vector).toMatchObject({ tool: "concept_vector", after: "find_tags" });
    const tags = [tagOf(1, "urn:tag:genre:brand:hot_sauce"), tagOf(2, "urn:tag:keyword:qloo:spicy", false)];
    expect(vector!.input(feed({ tags }))).toEqual({ concept_tags: ["T1"], type: "brand", analogs: [], ...NO_STEP });
    expect(vector!.input(feed({ tags: [tags[1]!] }))).toBeNull();
    expect(plan.skipped).toEqual([FIN_SKIP]);
  });

  it("launch_test retries a concept with no tag of its own on the first nearest category (the owner's o03 decision)", () => {
    const intent = intentFor({ job: "launch_test", mentions: [], constraints: { ...intentFor().constraints, concepts: ["fizzy kelp tonic", "hot sauce"] } });
    const [retry, vector] = scanOf("launch_test", { intent, primary: null }).chained;
    const none = (concept: string, nearest: string | null): DigestRow => ({
      ref: null,
      name: concept,
      values: { concept, scope: "brand", match: "none", ...(nearest === null ? {} : { nearest }) },
    });
    const kept: DigestRow = { ref: "T1" as TagRef, name: "Hot Sauce", values: { concept: "hot sauce", scope: "brand", use: "taste_signal", source: "search", status: "live" } };
    // Only the concept that kept nothing is retried, on the first listed category that is not already searched.
    expect(retry!.input(feed({ rows: [none("Fizzy kelp tonic", "Hot sauce | Sea Snacks | Soft Drinks"), kept] }))).toEqual({
      concepts: [{ text: "Sea Snacks", scope: "brand" }],
      ...NO_STEP,
    });
    // Every concept kept a tag, a search failed, or no category was listed: nothing to retry.
    expect(retry!.input(feed({ rows: [kept] }))).toBeNull();
    expect(retry!.input(feed({ rows: [{ ...none("fizzy kelp tonic", "Sea Snacks"), values: { concept: "fizzy kelp tonic", match: "error", nearest: "Sea Snacks" } }] }))).toBeNull();
    expect(retry!.input(feed({ rows: [none("fizzy kelp tonic", null)] }))).toBeNull();
    // The concept test reads the retry's tags with the first search's: chainFeed merges both.
    expect(vector).toMatchObject({ tool: "concept_vector", after: "find_tags" });
    // A site_selection concept with no map city has no concept test to feed, so no retry is planned.
    const noCity = intentFor({ job: "site_selection", constraints: { ...intentFor().constraints, concepts: ["listening bar"] } });
    expect(scanOf("site_selection", { intent: noCity }).chained).toEqual([]);
  });

  it("launch_test keeps or vetoes the analogs the question names in the scan, the gate's stand-in primary among them", () => {
    const peers = { text: "Brand Two", entity_type: "brand" as const, role: "peer" as const, public_figure: false };
    const analogsOnly = intentFor({
      job: "launch_test",
      mentions: [{ ...peers, text: "Brand One" }, peers],
      constraints: { ...intentFor().constraints, concepts: ["hot sauce"] },
    });
    const listed = { ...entity(1), name: LISTED_NAME };
    // No mention is the subject: the gate's first mention is an analog, never the company whose filings are read.
    const plan = scanOf("launch_test", { intent: analogsOnly, primary: listed, peers: [entity(2), entity(3, "artist")], publicData: true });
    expect(plan.chained[1]?.input(feed({ tags: [tagOf(1, "urn:tag:genre:brand:hot_sauce")] }))).toMatchObject({ analogs: ["R1", "R2"] });
    expect(describeChainedStep(plan.chained[1]!)).toBe(
      "concept_vector (CNPT) on the taxonomy tags find_tags returns, type brand, the question's analogs R1, R2 kept or vetoed",
    );
    expect(plan.steps.map((s) => s.tool)).toEqual(["find_tags"]);
    // A marked subject is the company: it is no analog, and its filings join the scan when it is listed.
    const company = intentFor({ job: "launch_test", constraints: { ...intentFor().constraints, concepts: ["hot sauce"] } });
    const own = scanOf("launch_test", { intent: company, primary: listed, peers: [entity(2)], publicData: true });
    expect(own.chained[1]?.input(feed({ tags: [tagOf(1, "urn:tag:genre:brand:hot_sauce")] }))).toMatchObject({ analogs: ["R2"] });
    expect(own.steps.map((s) => s.tool)).toEqual(["find_tags", "company_financials"]);
  });

  it("city_compare fingerprints each city and shares the named entity across them", () => {
    const intent = intentFor({
      job: "city_compare",
      pillar: "location",
      geo: { metro: "austin", area: null, unsupported_place: null, market: null, target_metro: null, cities: ["austin", "Nashville", "denver", "nowhere_city", "austin"] },
    });
    const plan = scanOf("city_compare", { intent, peers: [entity(2)], markets: MARKET_CATALOGUE });
    expect(plan.steps.map((s) => s.input)).toEqual([
      { area: { kind: "city", market: "austin" }, include_brands: false, ...NO_STEP },
      { area: { kind: "city", market: "nashville" }, include_brands: false, ...NO_STEP },
      { area: { kind: "city", market: "denver" }, include_brands: false, ...NO_STEP },
      { type: "brand", set: ["R1", "R2"], ages: [], audiences: [], genders: [], metros: ["austin", "nashville", "denver"], ...NO_STEP },
    ]);
    expect(describeScanStep(plan.steps[0]!)).toBe("block_dna (BLOCK) city fingerprint of austin against the other map cities");
    // No concept: no find_tags and no lift maps.
    expect(plan.chained).toEqual([]);
    // No peer named: the share grid waits for wave 1's peers.
    const alone = scanOf("city_compare", { intent, markets: MARKET_CATALOGUE });
    expect(alone.deferred.map((d) => d.tool)).toEqual(["share_of_taste"]);
    // One known city is no comparison: nothing runs, and the reason says what is missing.
    const one = intentFor({ job: "city_compare", geo: { ...intent.geo, cities: ["austin", "nowhere_city"] } });
    expect(scanOf("city_compare", { intent: one, markets: MARKET_CATALOGUE }).skipped).toContainEqual({
      tool: "block_dna",
      reason: "needs two to four cities from the MARKETS list in the question",
    });
  });

  it("city_compare with a concept maps its lift, with supply, in each compared map city after find_tags", () => {
    const intent = intentFor({
      job: "city_compare",
      pillar: "location",
      geo: { metro: "austin", area: null, unsupported_place: null, market: null, target_metro: null, cities: ["austin", "las_vegas", "denver"] },
      constraints: { ...intentFor().constraints, concepts: ["natural-wine bar"] },
    });
    const plan = scanOf("city_compare", { intent, markets: MARKET_CATALOGUE });
    expect(plan.steps.map((s) => s.tool)).toEqual(["find_tags"]);
    // CR 5: each city's fingerprint chains after find_tags and carries the concept's tags. A market
    // without a gazetteer (las_vegas) has no lift map; the map cities each get one.
    expect(plan.chained.map((c) => [c.tool, c.after])).toEqual([
      ["find_tags", "find_tags"],
      ["block_dna", "find_tags"],
      ["block_dna", "find_tags"],
      ["block_dna", "find_tags"],
      ["geo_lift", "find_tags"],
      ["geo_lift", "find_tags"],
    ]);
    // The unused fourth city slot is no gap: nothing says block_dna was skipped.
    expect(plan.skipped.filter((s) => s.tool === "block_dna")).toEqual([]);
    const genre = tagOf(1, "urn:tag:genre:place:wine_bar");
    const keyword = tagOf(2, "urn:tag:keyword:qloo:natural_wine", false);
    expect(plan.chained.map((c) => c.input(feed({ tags: [genre, keyword] })))).toEqual([
      null,
      { area: { kind: "city", market: "austin" }, include_brands: false, concept_tags: ["T1"], ...NO_STEP },
      { area: { kind: "city", market: "las_vegas" }, include_brands: false, concept_tags: ["T1"], ...NO_STEP },
      { area: { kind: "city", market: "denver" }, include_brands: false, concept_tags: ["T1"], ...NO_STEP },
      { metro: "austin", concept_tags: ["T1"], concept_entities: [], supply: true, ...NO_STEP },
      { metro: "denver", concept_tags: ["T1"], concept_entities: [], supply: true, ...NO_STEP },
    ]);
    expect(describeChainedStep(plan.chained[1]!)).toContain("city fingerprint of austin against the other map cities");
    // No tag a Block DNA family reads: the fingerprint still runs, without concept tags; no place tag, no lift map.
    expect(plan.chained[1]!.input(feed({ tags: [keyword] }))).toEqual({
      area: { kind: "city", market: "austin" },
      include_brands: false,
      concept_tags: [],
      ...NO_STEP,
    });
    expect(plan.chained[4]!.input(feed({ tags: [keyword] }))).toBeNull();
  });

  it("compareCities keeps the config's market ids, by id or by name, at most four", () => {
    const cities = (...c: string[]) => compareCities({ geo: { ...intentFor().geo, cities: c } });
    expect(cities("New York", "st. louis", "St Louis", "atlantis")).toEqual(["nyc", "st_louis"]);
    expect(cities("austin", "denver", "boise", "chicago", "seattle")).toEqual(["austin", "denver", "boise", "chicago"]);
    expect(cities()).toEqual([]);
  });

  it("joins company_financials for a listed brand primary and area_economics for named areas, only with public data", () => {
    const listed = { ...entity(1), name: LISTED_NAME };
    expect(scanOf("brand_health", { intent: intentFor(), primary: listed, publicData: true }).steps.at(-1)).toEqual({
      toolCallId: "scan-4",
      tool: "company_financials",
      input: { brand: "R1", ...NO_STEP },
    });
    expect(scanOf("brand_health", { intent: intentFor(), primary: listed }).skipped).toEqual([FIN_SKIP]);
    // A brand not on the list never gets a step that could only answer UNAVAILABLE.
    expect(scanOf("head_to_head", { primary: entity(1), publicData: true }).skipped).toContainEqual(FIN_SKIP);
    const area = intentFor({ job: "area_profile", pillar: "location", geo: { ...intentFor().geo, metro: "nashville", area: "Riverbend" } });
    expect(scanOf("area_profile", { intent: area, geo: AREA_GEO, publicData: true }).steps.map((s) => s.tool)).toEqual(["block_dna", "area_economics", "local_supply"]);
    const site = intentFor({
      job: "site_selection",
      pillar: "location",
      geo: { ...intentFor().geo, metro: "nashville", area: "Riverbend" },
      constraints: { ...intentFor().constraints, concepts: ["listening bar"] },
    });
    const [, , econ] = scanOf("site_selection", { intent: site, geo: AREA_GEO, publicData: true }).chained;
    expect(econ).toMatchObject({ tool: "area_economics", after: "geo_lift" });
    const lifted = [{ metro: "nashville" as const, id: "a_one" }, { metro: "nashville" as const, id: "riverbend" }, { metro: "austin" as const, id: "elsewhere" }];
    expect(econ!.input(feed({ areas: lifted }))).toEqual({ metro: "nashville", areas: ["riverbend", "a_one"], ...NO_STEP });
  });

  it("never plans a public-data step whose source is not configured, and flags it only when the question needed it (D7)", () => {
    const listed = { ...entity(1), name: LISTED_NAME };
    const noSec = scanOf("brand_health", { intent: intentFor(), primary: listed, publicData: true, publicConfigured: { sec: false, census: true } });
    expect(noSec.steps.map((s) => s.tool)).not.toContain("company_financials");
    expect(noSec.skipped).toContainEqual({ tool: "company_financials", reason: PUBLIC_NOT_CONFIGURED_REASON.sec });
    expect(noSec.flags).toEqual(["SEC_NOT_CONFIGURED"]);
    // An unlisted brand would not have read filings: the usual reason, and no limitation.
    const unlisted = scanOf("brand_health", { intent: intentFor(), primary: entity(1), publicData: true, publicConfigured: { sec: false, census: false } });
    expect(unlisted.skipped).toContainEqual(FIN_SKIP);
    expect(unlisted.flags).toEqual([]);
    const area = intentFor({ job: "area_profile", pillar: "location", geo: { ...intentFor().geo, metro: "nashville", area: "Riverbend" } });
    const noCensus = scanOf("area_profile", { intent: area, geo: AREA_GEO, publicData: true, publicConfigured: { sec: true, census: false, osm: false } });
    expect(noCensus.steps.map((s) => s.tool)).toEqual(["block_dna"]);
    expect(noCensus.skipped).toEqual([
      { tool: "area_economics", reason: PUBLIC_NOT_CONFIGURED_REASON.census },
      { tool: "local_supply", reason: PUBLIC_NOT_CONFIGURED_REASON.osm },
    ]);
    expect(noCensus.flags).toEqual(["CENSUS_NOT_CONFIGURED", "OSM_NOT_CONFIGURED"]);
    // All configured: planned as before, no flag.
    const both = scanOf("area_profile", { intent: area, geo: AREA_GEO, publicData: true, publicConfigured: { sec: true, census: true, osm: true } });
    expect(both.steps.map((s) => s.tool)).toEqual(["block_dna", "area_economics", "local_supply"]);
    expect(both.flags).toEqual([]);
  });
});

describe("chainFeed", () => {
  it("reads tags, entities and areas from the step's digests in row order", () => {
    const registry = createEntityRegistry();
    const r1 = registry.registerEntity({ entityId: "synthetic-1", name: "Brand One", type: "brand", popularity: null, disambiguation: null, tags: [] });
    const r2 = registry.registerEntity({ entityId: "synthetic-2", name: "Brand Two", type: "brand", popularity: null, disambiguation: null, tags: [] });
    const t1 = registry.registerTag({ tagId: "urn:tag:genre:place:bar", name: "Bar", type: "urn:tag:genre:place", signalCapable: true });
    const place = (id: string, name: string) => ({ id, name, metro: "austin" as const, centroid: { lat: 0, lon: 0 }, areaKm2: 1 });
    const geo = {
      neighbourhood: (metro: string, id: string) => (metro === "austin" && id === "a_two" ? place(id, "Area Two") : null),
      matchNeighbourhood: (metro: string, text: string) => (metro === "austin" && text === "Area One" ? place("a_one", "Area One") : null),
    };
    const metrics = new Map<string, { subjectRefs: string[] }>([["M7", { subjectRefs: ["riverbend", "a_two"] }]]);
    const digest = (rows: ModelDigest["top_rows"], registered: ModelDigest["registered"] = []): ModelDigest => ({
      _data_notice: DATA_NOTICE,
      status: "ok",
      evidence_ids: [],
      dataset_ids: [],
      metrics: [],
      top_rows: rows,
      findings: [],
      flags: [],
      registered,
      notices: [],
    });
    const out = chainFeed(
      [
        digest([
          { ref: null, name: "Area One", values: {} },
          { ref: null, name: "Renamed area", values: { rho_metric: "M7" } },
          { ref: t1.ref, name: "Bar", values: {} },
          { ref: r2.ref, name: "Brand Two", values: {} },
        ]),
        digest([], [{ ref: r1.ref, name: "Brand One", type: "brand" }]),
      ],
      { registry, ledger: { metric: (id) => metrics.get(id) }, geo, metros: ["nashville", "austin"] },
    );
    expect(out.tags.map((t) => t.ref)).toEqual([t1.ref]);
    expect(out.entities.map((e) => e.ref)).toEqual([r2.ref, r1.ref]);
    // By name first; else the area among the row's metric subjects in one of the run's cities.
    expect(out.areas).toEqual([
      { metro: "austin", id: "a_one" },
      { metro: "austin", id: "a_two" },
    ]);
  });
});
