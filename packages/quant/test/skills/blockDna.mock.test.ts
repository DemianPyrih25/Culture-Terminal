// block_dna through the real Qloo client over the mock transport: the allowlist, the cache, the budget
// gates and the synthetic urn:tag and brand answers. No network, no database; an invented Austin
// neighbourhood stands in for the gazetteer (D29).
import {
  DatasetEnvelope,
  DEFAULT_RUN_LIMITS,
  digestFits,
  Metric,
  ModelDigest,
  type GeoApi,
  type LatLon,
  type LocalityApi,
  type RunLimits,
} from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient, type MockFault, type QlooClient } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { isFormulaId } from "../../src/formulas";
import { blockDnaSkill, estimateBlockDnaCalls } from "../../src/skills/blockDna";
import { fakeRun, FakeRegistry } from "./support/fakes";

// An invented Austin locality pin: the city side goes out as this id.
const PINS: LocalityApi = { market: async (id) => (id === "austin" ? { entityId: "loc-invented-austin", label: "Austin" } : null) };

const RIVERBEND = { id: "riverbend", name: "Riverbend", metro: "austin" as const, centroid: { lat: 30.26, lon: -97.73 }, areaKm2: 4.2 };
const RIVERBEND_WKT = "POLYGON((-97.74 30.25,-97.72 30.25,-97.72 30.27,-97.74 30.27,-97.74 30.25))";

const geo: GeoApi = {
  metros: () => ["nashville", "austin"],
  neighbourhoods: (metro) => (metro === "austin" ? [RIVERBEND] : []),
  neighbourhood: (metro, id) => (metro === "austin" && id === RIVERBEND.id ? RIVERBEND : null),
  matchNeighbourhood: () => null,
  polygonWkt: (metro, id) => (metro === "austin" && id === RIVERBEND.id ? RIVERBEND_WKT : null),
  locate: (metro, p: LatLon) => (metro === "austin" && p.lon >= -97.74 && p.lon <= -97.72 && p.lat >= 30.25 && p.lat <= 30.27 ? RIVERBEND.id : null),
  geohashCentroid: () => ({ lat: 0, lon: 0 }),
  boundarySource: () => "Invented test gazetteer",
};

function mockClient(faults: readonly MockFault[] = []): QlooClient {
  return createQlooClient({
    transport: createMockTransport({ faults }),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "block-dna-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
}

function runOn(client: QlooClient, limits: RunLimits = DEFAULT_RUN_LIMITS, runId = "run-block-1") {
  const runQloo = client.forRun({ runId, lane: "public", pillar: "location", limits, phase: () => "wave1" });
  const qloo = runQloo.forTool("toolu_block_1");
  const base = fakeRun(qloo, new FakeRegistry());
  return { ...base, ctx: { ...base.ctx, geo, pillar: "location" as const, localities: PINS }, runQloo, qloo };
}

const NBHD = { kind: "nbhd", ref: "riverbend", metro: "austin" } as const;
const POINT = { kind: "point", ref: "-97.725,30.265", metro: "austin" } as const;

function input(area: unknown = NBHD, includeBrands = true) {
  return blockDnaSkill.input.parse({ area, include_brands: includeBrands, trigger_finding_id: null, step_id: "S2" });
}

describe("block_dna over the mock transport", () => {
  it("profiles a polygon end to end: six allowlisted calls, valid ledger output and a digest that fits", async () => {
    const run = runOn(mockClient());
    const result = await blockDnaSkill.run(input(), run.ctx);

    expect(result.status).toBe("ok");
    expect(run.runQloo.networkUsed()).toBe(6);
    expect(run.ledger.evidences.map((e) => e.status)).toEqual(["ok", "ok", "ok"]);
    for (const m of run.ledger.metrics) {
      Metric.parse(m);
      expect(isFormulaId(m.formulaId)).toBe(true);
      expect(["DERIVED", "UNAVAILABLE"]).toContain(m.badge);
    }
    for (const d of run.ledger.datasets) DatasetEnvelope.parse(d);

    // The city side went out on the pinned locality id, never as a name search.
    const queryOf = (id: string) => run.runQloo.call(id)?.query ?? {};
    const queries = run.ledger.evidences.flatMap((e) => e.qlooCallIds.map(queryOf));
    const cityBundle = run.ledger.evidences.find((e) => e.purpose.startsWith("City tag fingerprint"));
    expect(cityBundle?.qlooCallIds.map((id) => queryOf(id)["signal.location"])).toEqual(["loc-invented-austin", "loc-invented-austin"]);
    expect(queries).toHaveLength(6);
    expect(queries.some((q) => "signal.location.query" in q)).toBe(false);

    const bars = run.ledger.datasets.find((d) => d.kind === "Bars");
    if (bars?.kind !== "Bars") throw new Error("expected a Bars dataset");
    expect(bars.payload.method).toBe("POLYGON");
    expect(bars.payload.groups.map((g) => g.family)).toEqual(["WHO", "VIBE", "WHAT", "SOUND"]);
    const values = bars.payload.groups.flatMap((g) => g.bars.map((b) => b.values[0]));
    // Compared families show gains and losses only: a value is never 0 and never missing here.
    expect(values.every((v) => v?.value !== null && v?.value !== 0)).toBe(true);

    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "block_dna", step: "S2" })).toBe(true);
    const text = JSON.stringify(digest);
    for (const e of run.registry.entities()) expect(text).not.toContain(e.entityId);
    expect(text).not.toContain("urn:tag");
  });

  it("estimates six cold calls for a point, then none once the run has cached them", async () => {
    const client = mockClient();
    const run = runOn(client);
    expect(await estimateBlockDnaCalls(input(POINT), run.qloo, PINS)).toBe(6);
    const result = await blockDnaSkill.run(input(POINT), run.ctx);
    expect(result.status).toBe("ok");
    expect(await estimateBlockDnaCalls(input(POINT), run.qloo, PINS)).toBe(0);
    // A neighbourhood's area calls need the gazetteer, so they count; the cached city side is free.
    expect(await estimateBlockDnaCalls(input(NBHD), run.qloo, PINS)).toBe(3);
    // Without the pins the city side cannot be keyed and counts as uncached.
    expect(await blockDnaSkill.estimateCalls(input(POINT), run.qloo, run.registry)).toBe(3);
  });

  it("reuses the cached city side in a later run: only the area's calls go to the network", async () => {
    const client = mockClient();
    await blockDnaSkill.run(input(POINT), runOn(client).ctx);
    const second = runOn(client, DEFAULT_RUN_LIMITS, "run-block-2");
    const result = await blockDnaSkill.run(input(), second.ctx);
    expect(result.status).toBe("ok");
    expect(second.runQloo.networkUsed()).toBe(3);
  });

  it("falls back to the centre point when Qloo rejects the polygon", async () => {
    const run = runOn(mockClient([{ match: "signal.location=POLYGON", status: 400 }]));
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("ok");
    expect(result.flags).toContain("LOCATION_FALLBACK");
    const fallback = run.events.find((e) => e.type === "fallback");
    expect(fallback).toMatchObject({ from: "POLYGON", to: "POINT", reason: "the POLYGON call failed (qloo_bad_request)" });
    const bars = run.ledger.datasets.find((d) => d.kind === "Bars");
    expect(bars?.kind === "Bars" ? bars.payload.method : null).toBe("POINT");
    expect(run.ledger.findings.map((f) => f.kind)).toContain("LOCATION_FALLBACK");
  });

  it("returns a partial fingerprint with not-measured comparisons when the run cap cuts it", async () => {
    const run = runOn(mockClient(), { ...DEFAULT_RUN_LIMITS, qlooCalls: 3, qlooWarnAt: 3 });
    const result = await blockDnaSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    expect(run.runQloo.networkUsed()).toBe(3);
    const missing = run.ledger.metrics.filter((m) => m.value === null);
    expect(missing.length).toBeGreaterThan(0);
    expect(missing.every((m) => m.badge === "UNAVAILABLE" && m.reason === "budget_truncated" && m.display === "not measured")).toBe(true);
    for (const d of run.ledger.datasets) DatasetEnvelope.parse(d);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "block_dna", step: "S2" })).toBe(true);
  });
});
