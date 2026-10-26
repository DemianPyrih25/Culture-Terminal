// destination_affinity through the real @ct/qloo client over the synthetic mock transport and the
// memory store: the allowlist validator, canonical cache keys and the mock's destination answers.
// No network, no key, invented entities only (D29).
import { DEFAULT_RUN_LIMITS, ModelDigest, QuadrantPayload, digestFits } from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient, type QlooTool } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { destinationAffinitySkill } from "../../src/skills/destinationAffinity";
import { fakeRun, FakeRegistry } from "./support/fakes";

function mockClient() {
  return createQlooClient({
    transport: createMockTransport(),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "quant-trvl-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
}

/** Resolves an invented artist through the mock /search and registers it as R1. */
async function seeded(tool: QlooTool) {
  const registry = new FakeRegistry();
  const found = await tool.search({ query: "Artist Nova", types: ["urn:entity:artist"], take: 5 });
  const hit = found.data.results[0]!;
  registry.registerEntity({ entityId: hit.entity_id, name: hit.name, type: "artist", popularity: hit.popularity ?? null, disambiguation: null, tags: [] });
  return registry;
}

const input = () => destinationAffinitySkill.input.parse({ seeds: ["R1"], trigger_finding_id: null, step_id: "S1" });

describe("destination_affinity over the mock transport", () => {
  it("makes one allowlisted call, places the US destinations and is free once cached", async () => {
    const tool = mockClient().standalone({ pillar: "marketing" }).forTool(null);
    const registry = await seeded(tool);

    expect(await destinationAffinitySkill.estimateCalls(input(), tool, registry)).toBe(1);
    const run = fakeRun(tool, registry);
    const result = await destinationAffinitySkill.run(input(), run.ctx);

    expect(result.status).toBe("ok");
    expect(run.ledger.evidences).toHaveLength(1);
    const d = run.ledger.datasets[0];
    if (d?.kind !== "Quadrant") throw new Error("expected a Quadrant dataset");
    QuadrantPayload.parse(d.payload);
    expect(d.payload.points.length).toBeGreaterThan(10);
    expect(d.payload.points.every((p) => p.geo !== null)).toBe(true);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "destination_affinity", step: "S1" })).toBe(true);
    for (const m of run.ledger.metrics) expect(["trvl.quadrant", "trvl.hidden_pocket"]).toContain(m.formulaId);

    // The same request again is served from the cache, so the estimate counts it as free.
    expect(await destinationAffinitySkill.estimateCalls(input(), tool, registry)).toBe(0);
  });

  it("turns the client's run cap into BUDGET_TRUNCATED", async () => {
    const client = mockClient();
    const registry = await seeded(client.standalone().forTool(null));
    const scope = client.forRun({
      runId: "run-trvl-cap",
      lane: "public",
      pillar: "marketing",
      limits: { ...DEFAULT_RUN_LIMITS, qlooCalls: 1, qlooWarnAt: 1 },
      phase: () => "wave1",
    });
    const tool = scope.forTool("toolu_trvl");
    // Spend the one network call this run may make on another request.
    await tool.search({ query: "Brand Alpha", types: ["urn:entity:brand"], take: 5 });
    const run = fakeRun(tool, registry);
    const result = await destinationAffinitySkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    expect(run.ledger.evidences).toHaveLength(0);
  });
});
