// S4 momentum through the real Qloo client over the synthetic mock transport (no key, no network):
// every request passes the frozen allowlist and the validator, the cache and the run budget behave as
// live, and the step-shaped mock series include flat placeholders. Invented ids only (D29).
import { DEFAULT_RUN_LIMITS, digestFits, ModelDigest, type QlooParams, type RunLimits } from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient, PROBE_FACTS, type QlooClient } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { momentumSkill, trendingParams, TRENDING_TAKE } from "../../src/skills/momentum";
import { analyseSeries, TRENDING_WINDOW } from "../../src/skills/momentum/series";
import { fakeRun, FakeRegistry, type FakeLedger } from "./support/fakes";

/** The real ledger's rule, which the fake does not enforce: valued metrics and datasets cite evidence that exists. */
function expectEvidenceChain(ledger: FakeLedger): void {
  const evidence = new Set<string>(ledger.evidences.map((e) => e.id));
  for (const m of ledger.metrics) {
    if (m.value !== null) expect(m.evidenceIds.length, `${m.id} ${m.key} has a value but no evidence`).toBeGreaterThan(0);
    for (const id of m.evidenceIds) expect(evidence.has(id), `${m.id} cites missing ${id}`).toBe(true);
  }
  for (const d of ledger.datasets) {
    expect(d.evidenceIds.length, `${d.id} cites no evidence`).toBeGreaterThan(0);
    for (const id of d.evidenceIds) expect(evidence.has(id), `${d.id} cites missing ${id}`).toBe(true);
  }
}

function mockClient(): QlooClient {
  return createQlooClient({
    transport: createMockTransport(),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "quant-momentum-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
}

function runTool(client: QlooClient, limits: Partial<RunLimits> = {}) {
  return client
    .forRun({ runId: "run-synthetic-mom", lane: "public", pillar: "investment", limits: { ...DEFAULT_RUN_LIMITS, ...limits }, phase: () => "wave1" })
    .forTool("toolu_synthetic_mom");
}

const ids = Array.from({ length: 40 }, (_, i) => `ent-mom-${String(i).padStart(2, "0")}`);

/** Mock ids whose brand series is a flat placeholder, and ids with a real series (found by asking a separate client). */
async function scan(): Promise<{ flat: string[]; moving: string[] }> {
  const tool = mockClient().standalone().forTool(null);
  const flat: string[] = [];
  const moving: string[] = [];
  for (const id of ids) {
    const { data } = await tool.trending(trendingParams({ entityId: id, type: "brand" }));
    (analyseSeries(data.results.trending).noSignal === "flatline" ? flat : moving).push(id);
  }
  return { flat, moving };
}

function registryWith(entries: [string, "brand" | "tv_show" | "artist"][]): FakeRegistry {
  const registry = new FakeRegistry();
  entries.forEach(([id, type], i) =>
    registry.registerEntity({ entityId: id, name: `Mock Entity ${i + 1}`, type, popularity: 0.6, disambiguation: null, tags: [] }),
  );
  return registry;
}

const input = (entities: string[]) => momentumSkill.input.parse({ entities, type: "brand", trigger_finding_id: null, step_id: null });

describe("momentum over the mock transport", () => {
  it("uses the probe-frozen window and take", () => {
    expect(TRENDING_WINDOW).toEqual(PROBE_FACTS.trendingWindow);
    expect(PROBE_FACTS.trendingTypes).toEqual(["urn:entity:brand", "urn:entity:tv_show"]);
    expect(TRENDING_TAKE).toBeLessThanOrEqual(50);
  });

  it("trends brands and TV shows through the allowlisted client and catches the flat placeholders", async () => {
    const { flat, moving } = await scan();
    expect(flat.length).toBeGreaterThan(0);
    expect(moving.length).toBeGreaterThan(2);
    const registry = registryWith([
      [moving[0]!, "brand"],
      [moving[1]!, "tv_show"],
      [flat[0]!, "brand"],
      ["ent-mom-artist", "artist"],
    ]);
    const client = mockClient();
    const run = fakeRun(runTool(client), registry);
    const result = await momentumSkill.run(input(["R1", "R2", "R3", "R4"]), run.ctx);

    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["TRENDING_HISTORICAL_WINDOW", "NO_TREND_SIGNAL"]);
    expect(run.ledger.evidences).toHaveLength(3);
    for (const m of run.ledger.metrics) {
      expect(["STALE", "UNAVAILABLE"]).toContain(m.badge);
      expect(m.window).toEqual(TRENDING_WINDOW);
    }
    const d = run.ledger.datasets[0];
    if (d?.kind !== "Momentum") throw new Error("expected a Momentum dataset");
    expect(d.payload.series.map((s) => [s.ref, s.state])).toEqual([
      ["R1", "ok"],
      ["R2", "ok"],
      ["R3", "no_signal"],
      ["R4", "unavailable"],
    ]);
    // The mock's live-like series: about two points a week, newest first, resampled to ISO weeks.
    expect(d.payload.series[0]?.points.length).toBeGreaterThanOrEqual(26);
    expect(d.payload.series[0]?.points.every((p) => p.pct > 0 && p.pct < 1)).toBe(true);
    expect(run.ledger.findings.map((f) => [f.kind, f.text.startsWith("Mock Entity 3 has no usable trend")])).toEqual([["NO_TREND_SIGNAL", true]]);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "momentum", step: null })).toBe(true);
    expect(JSON.stringify(result.forModel)).not.toContain("ent-mom");
    expectEvidenceChain(run.ledger);
  });

  it("counts cached requests as free once the window is in the cache", async () => {
    const { moving } = await scan();
    const registry = registryWith([
      [moving[0]!, "brand"],
      [moving[1]!, "brand"],
      ["ent-mom-artist", "artist"],
    ]);
    const client = mockClient();
    const tool = runTool(client);
    expect(await momentumSkill.estimateCalls(input(["R1", "R2", "R3"]), tool, registry)).toBe(2);
    const run = fakeRun(tool, registry);
    await momentumSkill.run(input(["R1", "R2", "R3"]), run.ctx);
    expectEvidenceChain(run.ledger);
    expect(await momentumSkill.estimateCalls(input(["R1", "R2", "R3"]), runTool(client), registry)).toBe(0);
  });

  it("turns the run cap into BUDGET_TRUNCATED and keeps the series it got", async () => {
    const { moving } = await scan();
    const registry = registryWith([
      [moving[0]!, "brand"],
      [moving[1]!, "brand"],
    ]);
    const tool = runTool(mockClient(), { qlooCalls: 1, qlooWarnAt: 1 });
    const run = fakeRun(tool, registry);
    const result = await momentumSkill.run(input(["R1", "R2"]), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    expect(run.ledger.evidences).toHaveLength(1);
    expect(run.ledger.metrics.filter((m) => m.reason === "budget_truncated")).toHaveLength(1);
    expectEvidenceChain(run.ledger);
  });

  it("never sends a parameter outside the allowlist", async () => {
    const tool = runTool(mockClient());
    const params: QlooParams = trendingParams({ entityId: "ent-mom-00", type: "tv_show" });
    await expect(tool.trending(params)).resolves.toBeDefined();
    await expect(tool.trending({ ...params, "bias.trends": "high" })).rejects.toThrow(/forbidden/);
  });
});
