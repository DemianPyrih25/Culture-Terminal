// The opening scan table: which skills each job runs in this build, with what default arguments.
import { Job, type EntityRef, type GeoApi, type Intent, type RegisteredEntity, type RegisteredTag, type TagRef } from "@ct/contracts";
import { createGeo } from "@ct/geo";
import { describe, expect, it } from "vitest";
import { isSkillAvailable } from "../../src/run/catalogue";
import { askedTier, MARKET_CATALOGUE, marketTier, namedMarkets } from "../../src/run/markets";
import {
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
    expect(plan.skipped).toEqual([]);
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
    expect(plan.skipped).toEqual([{ tool: "rank_candidates", reason: "needs a metro in the question and a peer of the primary's type" }]);
    expect(describeScanStep(plan.steps[1]!)).toBe(`share_of_taste (SHARE) for R1, R2 by ages ${SCAN_AGES.join(", ")} and markets ${BY_STATE.slice(0, 4).join(", ")}`);

    const metro = scanOf("head_to_head", {
      intent: intentFor({ job: "head_to_head", geo: { metro: "nashville", area: null, unsupported_place: null, market: null } }),
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
    expect(plan.skipped).toEqual([{ tool: "geo_lift", reason: "needs a concept and a gazetteer metro (one of the 13 map cities) in the question" }]);
    expect(scanOf("site_selection").skipped.map((s) => s.reason)).toEqual([
      "needs a concept in the question",
      "needs a concept and a gazetteer metro (one of the 13 map cities) in the question",
    ]);
  });

  it("site_selection chains geo_lift after find_tags on the place taxonomy tags it registers", () => {
    const intent = intentFor({
      job: "site_selection",
      geo: { metro: "austin", area: null, unsupported_place: null, market: null },
      constraints: { ...intentFor().constraints, concepts: ["listening bar"] },
    });
    const plan = scanOf("site_selection", { intent });
    expect(plan.steps.map((s) => s.toolCallId)).toEqual(["scan-1"]);
    const [lift] = plan.chained;
    expect(lift).toMatchObject({ toolCallId: "scan-2", tool: "geo_lift", after: "find_tags", estimate: SCAN_LIFT_ESTIMATE });
    expect(describeChainedStep(lift!)).toBe("geo_lift (LIFT) in austin on the place tags find_tags returns, with supply");
    const tag = (n: number, tagId: string): RegisteredTag => ({ ref: `T${n}` as TagRef, tagId, name: tagId, type: "taxonomy", signalCapable: true });
    const tags = [
      tag(1, "urn:tag:category:place:wine_bar"),
      tag(2, "urn:tag:genre:place:restaurant:bar"),
      tag(3, "urn:tag:keyword:qloo:cozy"),
    ];
    expect(lift?.input(tags)).toEqual({ metro: "austin", concept_tags: ["T2", "T1"], concept_entities: [], supply: true, ...NO_STEP });
    // Supply is always asked for: without a verified category tag geo_lift says the competitor count is unknown, and why.
    expect(lift?.input([tags[1]!])).toMatchObject({ concept_tags: ["T2"], supply: true });
    expect(lift?.input([tags[2]!])).toBeNull();
  });

  it("site_selection passes the areas the question names to geo_lift, so each gets its own numbers", () => {
    const intent = intentFor({
      job: "site_selection",
      geo: { metro: "nashville", area: "Riverbend", unsupported_place: null, market: null },
      constraints: { ...intentFor().constraints, concepts: ["listening bar"], notes: ["area also named: Riverbend", "area also named: Nowhere Flats", "budget is tight"] },
    });
    const [lift] = scanOf("site_selection", { intent, geo: AREA_GEO }).chained;
    expect(describeChainedStep(lift!)).toBe("geo_lift (LIFT) in nashville on the place tags find_tags returns, with supply, and the question's area riverbend first");
    const genre: RegisteredTag = { ref: "T1" as TagRef, tagId: "urn:tag:genre:place:restaurant:bar", name: "Bar", type: "taxonomy", signalCapable: true };
    // A repeat and a name the gazetteer does not hold are left out.
    expect(lift?.input([genre])).toEqual({ metro: "nashville", concept_tags: ["T1"], concept_entities: [], supply: true, focus_areas: ["riverbend"], ...NO_STEP });
    expect(namedAreaIds(intent, AREA_GEO)).toEqual(["riverbend"]);
    expect(namedAreaIds({ ...intent, geo: { ...intent.geo, metro: null } }, AREA_GEO)).toEqual([]);
    // Without an area in the gazetteer, no focus_areas at all.
    expect(scanOf("site_selection", { intent }).chained[0]?.input([genre])).not.toHaveProperty("focus_areas");
  });

  it("area_profile and tenant_mix read the question's neighbourhood with local brands", () => {
    const intent = (job: Job) => intentFor({ job, geo: { metro: "nashville", area: "Riverbend", unsupported_place: null, market: null } });
    for (const job of ["area_profile", "tenant_mix"] as const) {
      const plan = scanOf(job, { intent: intent(job), geo: AREA_GEO });
      expect(plan.steps).toEqual([
        { toolCallId: "scan-1", tool: "block_dna", input: { area: { kind: "nbhd", ref: "riverbend", metro: "nashville" }, include_brands: true, ...NO_STEP } },
      ]);
      expect(describeScanStep(plan.steps[0]!)).toBe("block_dna (BLOCK) for riverbend (nashville) with local brands");
      expect(scanOf(job, { intent: intent(job) }).skipped).toEqual([
        { tool: "block_dna", reason: "needs a neighbourhood from the AREAS list in a gazetteer metro" },
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
      intentFor({ job, geo: { metro: "austin", area: null, unsupported_place: null, market: null }, constraints: { ...intentFor().constraints, notes: ["markets: Boise, New York"] } });
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
        if (isSkillAvailable(entry.tool)) expect(entry.build ?? entry.chain, `${job}: ${entry.tool}`).toBeDefined();
      }
    }
  });
});
