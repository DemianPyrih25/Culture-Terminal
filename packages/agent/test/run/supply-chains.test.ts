// R6 (D46): OpenStreetMap supply in the opening scan. Which jobs read local_supply and on what, the
// concept-to-type mapping (config/osm_tags.json, verified types only), the not-configured path and the
// LOCAL SUPPLY TYPES block. Areas are the shipped gazetteer's; everything else is invented (D29).
import { PUBLIC_NOT_CONFIGURED_REASON, type DatasetEnvelope, type Intent, type MarketId } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { gazetteer } from "../../src/run/gazetteer";
import { MARKET_CATALOGUE } from "../../src/run/markets";
import { LOCAL_SUPPLY_TYPES, localSupplyTypesFrom, noOsmTagText, supplyTypesForConcepts } from "../../src/run/osmTypes";
import { NOT_CONFIGURED_FLAG, PUBLIC_TOOL_SOURCE, unconfiguredTools } from "../../src/run/publicConfig";
import { planScan, type ChainFeed } from "../../src/run/scan";
import { intentFor } from "./support";

const geo = gazetteer();
const NO_STEP = { trigger_finding_id: null, step_id: null };
const [A, B, C, D, E] = geo.neighbourhoods("nashville");

const located = (job: Intent["job"], concepts: string[], extra: Partial<Intent["geo"]> = {}): Intent =>
  intentFor({
    job,
    pillar: "location",
    geo: { metro: "nashville", area: A!.name, unsupported_place: null, market: null, target_metro: null, cities: [], ...extra },
    constraints: { ...intentFor().constraints, concepts },
  });

const feed = (parts: Partial<ChainFeed> = {}): ChainFeed => ({ tags: [], entities: [], areas: [], ...parts });

describe("the concept's place types", () => {
  it("maps a concept through its curated category or the types it names as whole words, and lists the rest", () => {
    expect(LOCAL_SUPPLY_TYPES.length).toBeGreaterThan(10);
    expect(supplyTypesForConcepts(["cocktail bar with live jazz"]).keys).toEqual(["bar"]);
    expect(supplyTypesForConcepts(["coffee shop"]).keys).toEqual(["cafe"]);
    expect(supplyTypesForConcepts(["ramen counter"])).toEqual({ keys: [], unmapped: ["ramen counter"] });
    // "barbershop" names no bar: whole words only.
    expect(supplyTypesForConcepts(["barbershop"]).keys).not.toContain("bar");
    expect(noOsmTagText("ramen counter")).toBe("No OpenStreetMap tag for 'ramen counter': only overall street activity (shops, food and drink places) was counted for it.");
  });

  it("serves verified types only, at most four", () => {
    const types = localSupplyTypesFrom({
      place_types: [
        { key: "one", label: "One", status: "verified" },
        { key: "two", label: "Two", status: "unverified" },
      ],
    });
    expect(types.map((t) => t.key)).toEqual(["one"]);
    const many = supplyTypesForConcepts(["coffee shop", "bar", "bakery", "bookstore", "florist"]);
    expect(many.keys).toHaveLength(4);
  });
});

describe("local_supply in the opening scan (only with public data and OpenStreetMap configured)", () => {
  it("site_selection: chained after geo_lift on the question's area, the top lift areas and the top popular areas, listing places", () => {
    const plan = planScan("site_selection", { intent: located("site_selection", ["coffee shop"]), primary: null, peers: [], geo, publicData: true });
    const supply = plan.chained.find((c) => c.tool === "local_supply");
    expect(supply).toMatchObject({ after: "geo_lift", estimate: 0 });
    const lift = { kind: "GeoLift", payload: { metro: "nashville", popular: [D!.id, E!.id, A!.id] } } as unknown as DatasetEnvelope;
    const areas = [B, C, A].map((n) => ({ metro: "nashville" as const, id: n!.id }));
    expect(supply!.input(feed({ areas, datasets: [lift] }))).toEqual({
      metro: "nashville",
      areas: [A!.id, B!.id, C!.id, D!.id, E!.id],
      market: null,
      place_types: ["cafe"],
      mix: false,
      list_places: true,
      ...NO_STEP,
    });
    expect(plan.limitations).toEqual([]);
  });

  it("site_selection with a concept no type counts: street activity only, no names, and the limitation says so", () => {
    const plan = planScan("site_selection", { intent: located("site_selection", ["ramen counter"]), primary: null, peers: [], geo, publicData: true });
    const supply = plan.chained.find((c) => c.tool === "local_supply");
    expect(supply!.input(feed())).toMatchObject({ areas: [A!.id], place_types: [], list_places: false });
    expect(plan.limitations).toEqual([{ flag: null, text: noOsmTagText("ramen counter") }]);
  });

  it("tenant_mix and area_profile: the question's area against its city on every storefront type", () => {
    const tenant = planScan("tenant_mix", { intent: located("tenant_mix", []), primary: null, peers: [], geo, publicData: true });
    expect(tenant.steps.find((s) => s.tool === "local_supply")?.input).toEqual({ metro: "nashville", areas: [A!.id], market: null, place_types: [], mix: true, list_places: true, ...NO_STEP });
    const profile = planScan("area_profile", { intent: located("area_profile", []), primary: null, peers: [], geo, publicData: true });
    expect(profile.steps.find((s) => s.tool === "local_supply")?.input).toMatchObject({ mix: true, list_places: false });
  });

  it("taste_twins: the source area in its city, and the top five twins after taste_twins in the target city", () => {
    const intent = located("taste_twins", ["bookstore"], { target_metro: "austin" });
    const plan = planScan("taste_twins", { intent, primary: null, peers: [], geo, publicData: true });
    expect(plan.steps.find((s) => s.tool === "local_supply")?.input).toMatchObject({ metro: "nashville", areas: [A!.id], place_types: ["bookstore"] });
    const twins = plan.chained.find((c) => c.tool === "local_supply");
    expect(twins).toMatchObject({ after: "taste_twins" });
    const austin = geo.neighbourhoods("austin").slice(0, 6).map((n) => ({ metro: "austin" as const, id: n.id }));
    expect(twins!.input(feed({ areas: [{ metro: "nashville", id: A!.id }, ...austin] }))).toMatchObject({ metro: "austin", areas: austin.slice(0, 5).map((a) => a.id) });
  });

  it("city_compare: the concept's places around each compared city's centre, only when the concept maps to a type", () => {
    const markets = MARKET_CATALOGUE.filter((m) => ["nashville", "austin", "denver"].includes(m.id));
    const cities = (concepts: string[]) =>
      intentFor({ job: "city_compare", pillar: "location", geo: { ...intentFor().geo, cities: ["nashville", "denver"] }, constraints: { ...intentFor().constraints, concepts } });
    const plan = planScan("city_compare", { intent: cities(["cocktail bar"]), primary: null, peers: [], geo, markets, publicData: true });
    const steps = plan.steps.filter((s) => s.tool === "local_supply").map((s) => s.input as { market: MarketId; place_types: string[] });
    expect(steps.map((s) => [s.market, s.place_types])).toEqual([
      ["nashville", ["bar"]],
      ["denver", ["bar"]],
    ]);
    const unmapped = planScan("city_compare", { intent: cities(["ramen counter"]), primary: null, peers: [], geo, markets, publicData: true });
    expect(unmapped.steps.some((s) => s.tool === "local_supply")).toBe(false);
  });

  it("is never planned without public data, and is skipped with OpenStreetMap's own reason when it is not configured", () => {
    const none = planScan("tenant_mix", { intent: located("tenant_mix", []), primary: null, peers: [], geo });
    expect(none.steps.some((s) => s.tool === "local_supply")).toBe(false);
    const off = planScan("tenant_mix", { intent: located("tenant_mix", []), primary: null, peers: [], geo, publicData: true, publicConfigured: { sec: true, census: true, osm: false } });
    expect(off.steps.some((s) => s.tool === "local_supply")).toBe(false);
    expect(off.skipped).toContainEqual({ tool: "local_supply", reason: PUBLIC_NOT_CONFIGURED_REASON.osm });
    expect(off.flags).toContain("OSM_NOT_CONFIGURED");
    expect(PUBLIC_TOOL_SOURCE.local_supply).toBe("osm");
    expect(NOT_CONFIGURED_FLAG.osm).toBe("OSM_NOT_CONFIGURED");
    expect(unconfiguredTools({ sec: true, census: true, osm: false })).toEqual(["local_supply"]);
  });

  it("chains no supply read for a job that has none", () => {
    for (const job of ["brand_health", "head_to_head", "sponsorship", "market_selection", "audience_discovery", "brand_collab", "creator_fit", "launch_test"] as const) {
      const plan = planScan(job, { intent: intentFor({ job }), primary: null, peers: [], geo, publicData: true });
      expect([...plan.steps, ...plan.chained].some((s) => s.tool === "local_supply"), job).toBe(false);
    }
  });
});
