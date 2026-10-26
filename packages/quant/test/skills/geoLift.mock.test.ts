// find_tags → geo_lift through the real Qloo client over the synthetic transport (QLOO_MOCK): every
// request passes the frozen allowlist and its value rules, cache keys are canonical, the restaurant
// baseline is pinned, and the run cap throws the client's own BudgetError. No network, no database.
import { DatasetEnvelope, DEFAULT_RUN_LIMITS, digestFits, ModelDigest, type GeoApi, type LocalityApi, type MarketId, type SkillCtx } from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient, PROBE_FACTS, type QlooClient, type QlooTool } from "@ct/qloo";
import ngeohash from "ngeohash";
import { describe, expect, it } from "vitest";
import { findTagsSkill } from "../../src/skills/findTags";
import { HEATMAP_BASELINE } from "../../src/skills/findTags/curated";
import { estimateGeoLiftCalls, geoLiftSkill, PLACES_TAKE } from "../../src/skills/geoLift";
import { fakeRun, FakeRegistry } from "./support/fakes";

function mockClient(): QlooClient {
  return createQlooClient({
    transport: createMockTransport(),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "geo-lift-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
}

/** The mock's Austin locality, found by exact name and state as the app pins it. */
async function austinPins(client: QlooClient): Promise<LocalityApi> {
  const { data } = await client.standalone().forTool(null).search({ query: "Austin", types: ["urn:entity:locality"], take: 5 });
  const austin = data.results.find((r) => r.name === "Austin" && (r.disambiguation ?? "").includes("Texas"));
  if (austin === undefined) throw new Error("the mock has no Austin locality");
  return { market: async (id: MarketId) => (id === "austin" ? { entityId: austin.entity_id, label: "Austin" } : null) };
}

// Invented neighbourhoods as boxes around public Austin coordinates.
const AREAS = [
  { id: "juniper_row", name: "Juniper Row", lat: 30.268, lon: -97.743 },
  { id: "kestrel_park", name: "Kestrel Park", lat: 30.262, lon: -97.722 },
  { id: "linden_cross", name: "Linden Cross", lat: 30.248, lon: -97.75 },
  { id: "marten_bluff", name: "Marten Bluff", lat: 30.264, lon: -97.77 },
  { id: "nettle_green", name: "Nettle Green", lat: 30.305, lon: -97.728 },
  { id: "osprey_flats", name: "Osprey Flats", lat: 30.298, lon: -97.705 },
];
const HALF = 0.006;

function boxGeo(): GeoApi {
  const unused = (): never => {
    throw new Error("unused geo call");
  };
  const km2 = (2 * HALF * 111.32) ** 2 * Math.cos((30.27 * Math.PI) / 180);
  return {
    metros: () => ["nashville", "austin"],
    neighbourhoods: (metro) => (metro === "austin" ? AREAS.map((a) => ({ id: a.id, name: a.name, metro, centroid: { lat: a.lat, lon: a.lon }, areaKm2: km2 })) : []),
    neighbourhood: unused,
    matchNeighbourhood: unused,
    polygonWkt: unused,
    locate: (metro, p) =>
      metro === "austin" ? (AREAS.find((a) => Math.abs(p.lat - a.lat) < HALF && Math.abs(p.lon - a.lon) < HALF)?.id ?? null) : null,
    geohashCentroid: (g) => {
      const { latitude, longitude } = ngeohash.decode(g);
      return { lat: latitude, lon: longitude };
    },
    boundarySource: () => "Synthetic test boundaries",
  };
}

function skillCtx(tool: QlooTool, registry: FakeRegistry, pins: LocalityApi): { ctx: SkillCtx; run: ReturnType<typeof fakeRun> } {
  const run = fakeRun(tool, registry);
  const ctx = Object.assign({ ...run.ctx, pillar: "location" as const, geo: boxGeo() }, { localities: pins });
  return { ctx, run };
}

function liftInput(concept_tags: string[], supply: boolean) {
  return geoLiftSkill.input.parse({ metro: "austin", concept_tags, concept_entities: [], supply, trigger_finding_id: null, step_id: null });
}

/** Category tags the mock's places carry (public taxonomy URNs), so a union fills a first page of fifty. */
function registerSupplyCategories(registry: FakeRegistry): string[] {
  return ["urn:tag:category:place:bar", "urn:tag:category:place:live_music_venue"].map(
    (tagId) => registry.registerTag({ tagId, name: tagId.split(":").pop() ?? tagId, type: "urn:tag:category:place", signalCapable: true }).ref,
  );
}

describe("find_tags → geo_lift on the synthetic transport", () => {
  it("pins the same baseline tag as the Qloo client", () => {
    expect(HEATMAP_BASELINE.tagId).toBe(PROBE_FACTS.heatmapBaselineTag);
  });

  it("maps a curated concept end to end, then estimates a warm cache as free", async () => {
    const client = mockClient();
    const pins = await austinPins(client);
    const tool = client.standalone({ pillar: "location" }).forTool("toolu_geo_1");
    const registry = new FakeRegistry();

    const tags = skillCtx(tool, registry, pins);
    const found = await findTagsSkill.run(
      findTagsSkill.input.parse({ concepts: [{ text: "coffee shop", scope: "place" }], trigger_finding_id: null, step_id: null }),
      tags.ctx,
    );
    expect(found.status).toBe("ok");
    expect(found.evidenceIds).toEqual([]);
    const refs = [...found.forModel.top_rows.map((r) => r.ref ?? ""), ...registerSupplyCategories(registry)];

    const input = liftInput(refs, true);
    expect(await estimateGeoLiftCalls(input, tool, registry, pins)).toBe(4);
    const { ctx, run } = skillCtx(tool, registry, pins);
    const result = await geoLiftSkill.run(input, ctx);

    expect(result.status).toBe("ok");
    expect(result.flags).toEqual(["SUPPLY_SAMPLE_ONLY"]);
    expect(run.ledger.evidences.map((e) => e.qlooCallIds.length)).toEqual([1, 1, 2]);
    const d = DatasetEnvelope.parse(run.ledger.datasets[0]);
    if (d.kind !== "GeoLift") throw new Error("expected a GeoLift dataset");
    expect(d.payload).toMatchObject({ precision: 7, precisionFactor: 1, coarse: false });
    expect(d.payload.cells.length).toBeGreaterThan(100);
    expect(d.payload.cells.some((c) => c.lift !== null)).toBe(true);
    expect(d.payload.neighbourhoods.some((n) => n.lift !== null)).toBe(true);
    expect(d.payload.supply?.points.length).toBeGreaterThan(PLACES_TAKE);
    expect(run.ledger.metrics[0]).toMatchObject({ key: "lift.precision", value: 1 });
    expect(run.ledger.metrics.filter((m) => m.key === "lift.area" && m.value !== null).length).toBeGreaterThan(0);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "geo_lift", step: null })).toBe(true);

    // Every request is now cached: the same input costs nothing.
    expect(await estimateGeoLiftCalls(input, tool, registry, pins)).toBe(0);
    // A new concept pays for its own map only: the restaurant baseline is already cached (pinned).
    const bar = registry.registerTag({ tagId: "urn:tag:genre:place:restaurant:bar", name: "Bar", type: "urn:tag:genre:place", signalCapable: true });
    expect(await estimateGeoLiftCalls(liftInput([bar.ref], false), tool, registry, pins)).toBe(1);
  });

  it("turns the client's run cap into a partial result with the first supply page kept", async () => {
    const client = mockClient();
    const pins = await austinPins(client);
    const registry = new FakeRegistry();
    const genre = registry.registerTag({
      tagId: "urn:tag:genre:place:restaurant:coffee_shop",
      name: "Coffee shop",
      type: "urn:tag:genre:place",
      signalCapable: true,
    });
    const input = liftInput([genre.ref, ...registerSupplyCategories(registry)], true);

    // Warm both maps outside the run, so the cap meets the supply pages only.
    const warm = skillCtx(client.standalone({ pillar: "location" }).forTool(null), registry, pins);
    await geoLiftSkill.run(liftInput([genre.ref], false), warm.ctx);

    const scope = client.forRun({
      runId: "run-synthetic-geo",
      lane: "public",
      pillar: "location",
      limits: { ...DEFAULT_RUN_LIMITS, qlooCalls: 1, qlooWarnAt: 1 },
      phase: () => "wave1",
    });
    const { ctx, run } = skillCtx(scope.forTool("toolu_geo_2"), registry, pins);
    const result = await geoLiftSkill.run(input, ctx);

    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    expect(scope.networkUsed()).toBe(1);
    expect(run.ledger.evidences.map((e) => e.status)).toEqual(["ok", "ok", "partial"]);
    expect(result.forModel.notices).toContain("The budget stopped the supply sample after its first page.");
  });
});
