// S3 audience_dna through the real Qloo client over the synthetic mock transport (no key, no
// network): the demographics batch and the /entities describe pass the frozen allowlist and the G12
// batch rule, the mock's coverage gap (about one entity in fifteen has no block) shows as "not
// measured", and the cache and run budget behave as live. Invented ids only (D29).
import { DEFAULT_RUN_LIMITS, digestFits, ModelDigest, type RunLimits } from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient, PROBE_FACTS, type QlooClient } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { audienceDnaSkill, demographicsBatches, DNA_BATCH_MAX } from "../../src/skills/audienceDna";
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
    tag: "quant-dna-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
}

function runTool(client: QlooClient, limits: Partial<RunLimits> = {}) {
  return client
    .forRun({ runId: "run-synthetic-dna", lane: "public", pillar: "investment", limits: { ...DEFAULT_RUN_LIMITS, ...limits }, phase: () => "wave1" })
    .forTool("toolu_synthetic_dna");
}

const ids = Array.from({ length: 60 }, (_, i) => `ent-dna-${String(i).padStart(2, "0")}`);

/** Mock ids with and without a demographics block (asked of a separate client, so the run's cache stays cold). */
async function scan(): Promise<{ measured: string[]; missing: string[] }> {
  const tool = mockClient().standalone().forTool(null);
  const seen = new Set<string>();
  for (const params of demographicsBatches(ids)) {
    const { data } = await tool.insights("urn:demographics", params);
    for (const b of data.results.demographics) seen.add(b.entity_id);
  }
  return { measured: ids.filter((id) => seen.has(id)), missing: ids.filter((id) => !seen.has(id)) };
}

function registryWith(entries: [string, "brand" | "tv_show" | "artist" | "person"][]): FakeRegistry {
  const registry = new FakeRegistry();
  entries.forEach(([id, type], i) =>
    registry.registerEntity({
      entityId: id,
      name: `Mock Entity ${i + 1}`,
      type,
      popularity: 0.6,
      disambiguation: null,
      // Facet tags come from /entities, never from the registry.
      tags: [],
    }),
  );
  return registry;
}

const input = (set: string[], compare_with: string | null = null) =>
  audienceDnaSkill.input.parse({ set, compare_with, trigger_finding_id: null, step_id: null });

describe("audience_dna over the mock transport", () => {
  it("uses the probe-frozen batch size", () => {
    expect(DNA_BATCH_MAX).toBe(PROBE_FACTS.demographicsBatchMax);
  });

  it("reads a mixed-type batch through the allowlisted client, with the coverage gap not measured", async () => {
    const { measured, missing } = await scan();
    expect(missing.length).toBeGreaterThan(0);
    const registry = registryWith([
      [measured[0]!, "brand"],
      [measured[1]!, "brand"],
      [measured[2]!, "tv_show"],
      [measured[3]!, "artist"],
      [missing[0]!, "person"],
      [measured[4]!, "brand"],
    ]);
    const run = fakeRun(runTool(mockClient()), registry);
    const result = await audienceDnaSkill.run(input(["R1", "R2", "R3", "R4", "R5"], "R6"), run.ctx);

    expect(result.status).toBe("ok");
    expect(result.flags).toEqual(["CANDIDATES_UNSCORED", "DEMOGRAPHICS_ARE_INDICES", "DROPPED_CANDIDATES"]);
    expect(run.ledger.evidences.map((e) => e.status)).toEqual(["ok", "ok"]);
    expect(run.ledger.evidences[0]?.summary).toContain("5 of 6 entities have a demographics block");
    expect(run.ledger.evidences[1]?.summary).toBe("6 of 6 entities carry tags, grouped by namespace.");
    expect(run.ledger.metrics.find((m) => m.key === "dna.distinctive_tags")?.evidenceIds).toEqual(["E2"]);
    for (const m of run.ledger.metrics.filter((x) => x.formulaId === "dna.age_index" || x.formulaId === "dna.gender_index")) {
      expect(m.value).toBeGreaterThanOrEqual(-1);
      expect(m.value).toBeLessThanOrEqual(1);
    }
    expect(run.ledger.metrics.find((m) => m.subjectRefs.join() === "R5")).toMatchObject({ reason: "not_measured", badge: "UNAVAILABLE" });
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["DROPPED_CANDIDATES"]);
    expect(run.ledger.datasets.map((d) => d.kind)).toEqual(["Bars", "Ranked", "Ranked", "Ranked"]);
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "audience_dna", step: null })).toBe(true);
    expect(JSON.stringify(result.forModel)).not.toContain("ent-dna");
    expectEvidenceChain(run.ledger);
  });

  it("spends the run's last network call on the indices, never on the facet tags", async () => {
    const { measured } = await scan();
    const registry = registryWith([
      [measured[0]!, "brand"],
      [measured[1]!, "brand"],
    ]);
    const run = fakeRun(runTool(mockClient(), { qlooCalls: 1, qlooWarnAt: 1 }), registry);
    const result = await audienceDnaSkill.run(input(["R1", "R2"]), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["DEMOGRAPHICS_ARE_INDICES", "BUDGET_TRUNCATED"]);
    expect(run.ledger.evidences.map((e) => e.purpose)).toEqual(["Age and gender affinity indices (urn:demographics) for 2 entities"]);
    expect(run.ledger.metrics.filter((m) => m.badge === "MEASURED")).toHaveLength(16);
    expect(run.ledger.metrics.find((m) => m.key === "dna.distinctive_tags")).toMatchObject({ value: null, reason: "budget_truncated" });
    expectEvidenceChain(run.ledger);
  });

  it("counts the batch as free once it is cached", async () => {
    const { measured } = await scan();
    const registry = registryWith([
      [measured[0]!, "brand"],
      [measured[1]!, "brand"],
    ]);
    const client = mockClient();
    const tool = runTool(client);
    expect(await audienceDnaSkill.estimateCalls(input(["R1", "R2"]), tool, registry)).toBe(2);
    const run = fakeRun(tool, registry);
    await audienceDnaSkill.run(input(["R1", "R2"]), run.ctx);
    expectEvidenceChain(run.ledger);
    expect(await audienceDnaSkill.estimateCalls(input(["R1", "R2"]), runTool(client), registry)).toBe(0);
  });

  it("turns the run cap into BUDGET_TRUNCATED with every index explained", async () => {
    const { measured } = await scan();
    const registry = registryWith([
      [measured[0]!, "brand"],
      [measured[1]!, "brand"],
    ]);
    const tool = runTool(mockClient(), { qlooCalls: 1, qlooWarnAt: 1 });
    // Spend the run's one network call on another request first.
    await tool.insights("urn:demographics", { "signal.interests.entities": [measured[2]!], take: 50 });
    const run = fakeRun(tool, registry);
    const result = await audienceDnaSkill.run(input(["R1", "R2"]), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toEqual(["BUDGET_TRUNCATED"]);
    expect(run.ledger.evidences).toHaveLength(0);
    expect(run.ledger.metrics.filter((m) => m.key === "dna.youth_index").map((m) => m.reason)).toEqual(["budget_truncated", "budget_truncated"]);
    expectEvidenceChain(run.ledger);
  });
});
