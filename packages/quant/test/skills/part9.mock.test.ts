// The Part 9 Qloo skills through the real Qloo client over the mock transport: the frozen allowlist,
// the cache and the budget gates. taste_twins (by size and by concept lift), block_dna's whole-city
// fingerprint against the map-city panel, and concept_vector's open and scoring calls. Invented
// areas, localities and tags only (D29).
import {
  DatasetEnvelope,
  DEFAULT_RUN_LIMITS,
  digestFits,
  Metric,
  MetroId,
  ModelDigest,
  type GeoApi,
  type LocalityApi,
  type Neighbourhood,
  type RunLimits,
  type ToolName,
} from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient, type QlooClient } from "@ct/qloo";
import ngeohash from "ngeohash";
import { describe, expect, it } from "vitest";
import { isFormulaId } from "../../src/formulas";
import { blockDnaSkill } from "../../src/skills/blockDna";
import { conceptVectorSkill } from "../../src/skills/conceptVector";
import { tasteTwinsSkill } from "../../src/skills/tasteTwins";
import { fakeRun, FakeRegistry, registerInvented } from "./support/fakes";

const PINS: LocalityApi = { market: async (id) => ({ entityId: `loc-invented-${id}`, label: id }) };

function square(lon: number, lat: number): string {
  return `POLYGON((${lon} ${lat},${lon + 0.02} ${lat},${lon + 0.02} ${lat + 0.02},${lon} ${lat + 0.02},${lon} ${lat}))`;
}

const nbhd = (id: string, metro: MetroId, lon: number, lat: number, km2: number): Neighbourhood => ({
  id,
  name: id.replace(/_/g, " "),
  metro,
  centroid: { lat: lat + 0.01, lon: lon + 0.01 },
  areaKm2: km2,
});

const AREAS: Neighbourhood[] = [
  nbhd("riverside", "nashville", -86.76, 36.16, 5),
  ...Array.from({ length: 10 }, (_, i) => nbhd(`austin_area_${i}`, "austin", -97.8 + i * 0.03, 30.25, 10 - i * 0.5)),
];

const GEO: GeoApi = {
  metros: () => ["nashville", "austin"],
  neighbourhoods: (m) => AREAS.filter((a) => a.metro === m),
  neighbourhood: (m, id) => AREAS.find((a) => a.metro === m && a.id === id) ?? null,
  matchNeighbourhood: () => null,
  polygonWkt: (m, id) => {
    const a = AREAS.find((x) => x.metro === m && x.id === id);
    return a === undefined ? null : square(a.centroid.lon - 0.01, a.centroid.lat - 0.01);
  },
  // Heatmap cells land in the Austin areas by a stable hash of their position: enough cells per area for a lift.
  locate: (m, p) => {
    const own = AREAS.filter((a) => a.metro === m);
    if (own.length === 0) return null;
    return own[Math.abs(Math.round(p.lat * 997 + p.lon * 991)) % own.length]?.id ?? null;
  },
  geohashCentroid: (g) => {
    const { latitude, longitude } = ngeohash.decode(g);
    return { lat: latitude, lon: longitude };
  },
  boundarySource: () => "Invented test gazetteer",
};

function mockClient(): QlooClient {
  return createQlooClient({
    transport: createMockTransport(),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "quant-part9-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
}

function runOn(client: QlooClient, limits: RunLimits = DEFAULT_RUN_LIMITS, runId = "run-part9-1") {
  const runQloo = client.forRun({ runId, lane: "public", pillar: "location", limits, phase: () => "wave1" });
  const qloo = runQloo.forTool("toolu_part9_1");
  const base = fakeRun(qloo, new FakeRegistry());
  return { ...base, ctx: { ...base.ctx, geo: GEO, localities: PINS, pillar: "location" as const }, runQloo, qloo };
}

function checkLedger(run: ReturnType<typeof runOn>): void {
  for (const m of run.ledger.metrics) {
    Metric.parse(m);
    expect(isFormulaId(m.formulaId), m.formulaId).toBe(true);
  }
  for (const d of run.ledger.datasets) DatasetEnvelope.parse(d);
}

function checkDigest(forModel: unknown, tool: ToolName, step: string, run: ReturnType<typeof runOn>): void {
  const digest = ModelDigest.parse(forModel);
  expect(digestFits(digest, { tool, step: step as `S${number}` })).toBe(true);
  const text = JSON.stringify(digest);
  for (const e of run.registry.entities()) expect(text).not.toContain(e.entityId);
  expect(text).not.toContain("loc-invented");
}

describe("taste_twins over the mock transport", () => {
  const input = (fields: Record<string, unknown> = {}) =>
    tasteTwinsSkill.input.parse({
      source: { kind: "nbhd", ref: "riverside", metro: "nashville" },
      target_metro: "austin",
      target_areas: [],
      concept_tags: [],
      trigger_finding_id: null,
      step_id: "S1",
      ...fields,
    });

  it("checks the 8 largest areas when no concept is given: 1 + 2 + 8 allowlisted calls", async () => {
    const run = runOn(mockClient());
    const result = await tasteTwinsSkill.run(input(), run.ctx);
    expect(["ok", "partial"]).toContain(result.status);
    expect(run.runQloo.networkUsed()).toBe(11);
    expect(run.ledger.metrics.filter((m) => m.key === "twin.rho")).toHaveLength(8);
    expect(result.forModel.notices[0]).toContain("largest");
    checkLedger(run);
    checkDigest(result.forModel, "taste_twins", "S1", run);
  });

  it("picks the areas by concept lift with one concept heatmap beside the pinned baseline", async () => {
    const run = runOn(mockClient());
    const tag = run.registry.registerTag({ tagId: "urn:tag:genre:place:invented_wine_bar", name: "wine bar", type: "urn:tag:genre:place", signalCapable: true });
    const result = await tasteTwinsSkill.run(input({ concept_tags: [tag.ref] }), run.ctx);
    expect(["ok", "partial"]).toContain(result.status);
    const table = run.ledger.datasets.find((d) => d.kind === "Ranked");
    if (table?.kind !== "Ranked") throw new Error("expected the twins table");
    expect(table.payload.columns.map((c) => c.key)).toContain("lift");
    expect(result.forModel.notices[0]).toContain("highest lift");
    checkLedger(run);
  });

  it("stops at the run cap with every unmeasured area explained, never ranked", async () => {
    const run = runOn(mockClient(), { ...DEFAULT_RUN_LIMITS, qlooCalls: 5, qlooWarnAt: 5 });
    const result = await tasteTwinsSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    const missing = run.ledger.metrics.filter((m) => m.key === "twin.rho" && m.value === null);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((m) => m.badge === "UNAVAILABLE")).toBe(true);
    checkLedger(run);
  });
});

describe("block_dna whole-city fingerprint over the mock transport", () => {
  const input = (market: string, brands = false) =>
    blockDnaSkill.input.parse({ area: { kind: "city", market }, include_brands: brands, trigger_finding_id: null, step_id: "S2" });

  it("reads a map city against the other 12 map cities, comparator BASELINE", async () => {
    const run = runOn(mockClient());
    const result = await blockDnaSkill.run(input("austin"), run.ctx);
    expect(result.status).toBe("ok");
    // Own tags and music, and the same pair for each of the 12 other map cities.
    expect(run.runQloo.networkUsed()).toBe(26);
    const bars = run.ledger.datasets.find((d) => d.kind === "Bars");
    if (bars?.kind !== "Bars") throw new Error("expected Bars");
    expect(bars.payload.comparator).toBe("BASELINE");
    expect(bars.payload.method).toBeNull();
    expect(bars.payload.valueLabel).toBe("Tag rank gain vs the other 12 map cities");
    expect(run.ledger.metrics.every((m) => m.comparator === "BASELINE")).toBe(true);
    expect(run.ledger.findings.filter((f) => f.kind === "BLOCK_NEW_TAGS")).toHaveLength(0);
    checkLedger(run);
    checkDigest(result.forModel, "block_dna", "S2", run);
  });

  it("compares a market outside the map cities from the cache: only its own two lists go to the network", async () => {
    const client = mockClient();
    await blockDnaSkill.run(input("austin"), runOn(client).ctx);
    const second = runOn(client, DEFAULT_RUN_LIMITS, "run-part9-2");
    const result = await blockDnaSkill.run(input("portland"), second.ctx);
    expect(result.status).toBe("ok");
    // The panel is all 13 map cities, every list cached by the first run (Austin's own included).
    expect(second.runQloo.networkUsed()).toBe(2);
    expect(result.forModel.notices.join(" ")).toContain("the other 13 map cities");
  });

  it("adds brands pooled the same way when asked", async () => {
    const run = runOn(mockClient());
    const result = await blockDnaSkill.run(input("nashville", true), run.ctx);
    expect(["ok", "partial"]).toContain(result.status);
    expect(run.runQloo.networkUsed()).toBe(39);
    checkLedger(run);
  });
});

describe("concept_vector over the mock transport", () => {
  it("scores analogs beside the anchor in one call and lists what Qloo adds", async () => {
    const run = runOn(mockClient());
    const tag = run.registry.registerTag({ tagId: "urn:tag:genre:brand:invented_hot_sauce", name: "hot sauce", type: "urn:tag:genre:brand", signalCapable: true });
    const analogs = ["ent-mock-analog-1", "ent-mock-analog-2", "ent-mock-analog-3"].map((id, i) =>
      registerInvented(run.registry, { id, name: `Invented Analog ${i + 1}`, category: null }),
    );
    const input = conceptVectorSkill.input.parse({ concept_tags: [tag.ref], type: "brand", analogs: analogs.map((a) => a.ref), trigger_finding_id: null, step_id: "S3" });
    const result = await conceptVectorSkill.run(input, run.ctx);
    expect(["ok", "partial"]).toContain(result.status);
    expect(run.runQloo.networkUsed()).toBe(2);
    const table = run.ledger.datasets.find((d) => d.kind === "Ranked");
    if (table?.kind !== "Ranked") throw new Error("expected the concept table");
    expect(table.payload.groups.map((g) => g.key)).toEqual(["analogs", "adds"]);
    expect(table.payload.groups[1]?.rows.every((r) => r.flags.includes("ADD"))).toBe(true);
    // A not-scored analog never reads as a VETO.
    for (const r of table.payload.groups[0]?.rows ?? []) if (r.sublabel?.startsWith("not scored")) expect(r.flags).toEqual([]);
    checkLedger(run);
    checkDigest(result.forModel, "concept_vector", "S3", run);
  });

  it("returns the ADD list alone from one open call when no analog is given", async () => {
    const run = runOn(mockClient());
    const tag = run.registry.registerTag({ tagId: "urn:tag:genre:media:invented_true_crime", name: "true crime", type: "urn:tag:genre:media", signalCapable: true });
    const input = conceptVectorSkill.input.parse({ concept_tags: [tag.ref], type: "podcast", analogs: [], trigger_finding_id: null, step_id: null });
    const result = await conceptVectorSkill.run(input, run.ctx);
    expect(result.status).toBe("ok");
    expect(run.runQloo.networkUsed()).toBe(1);
    expect(result.forModel.top_rows.every((r) => r.values.verdict === "ADD")).toBe(true);
    expect(run.ledger.metrics).toHaveLength(0);
  });
});
