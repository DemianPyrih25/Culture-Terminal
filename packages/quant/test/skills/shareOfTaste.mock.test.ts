// share_of_taste end to end through the real Qloo client over the synthetic transport: every request
// passes the frozen allowlist and value rules (the client throws otherwise), the cache answers the
// cost estimate, and the ledger output parses with the contract schemas. No network, invented ids.
import { DatasetEnvelope, DEFAULT_RUN_LIMITS, digestFits, Flag, ModelDigest, type LocalityApi, type RunLimits, type SkillCtx } from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { estimateShareCalls, shareOfTasteSkill } from "../../src/skills/shareOfTaste";
import { fakeRun, FakeRegistry, registerInvented, type Invented } from "./support/fakes";
import { ALPHA, BETA, DELTA, GAMMA } from "./support/world";

const LOCALITIES: LocalityApi = {
  market: async (m) => (m === "nashville" || m === "austin" ? { entityId: `mock-loc-${m}`, label: m === "austin" ? "Austin" : "Nashville" } : null),
};

function mockRun(options: { limits?: Partial<RunLimits>; members?: Invented[]; type?: "brand" | "person" } = {}) {
  const client = createQlooClient({
    transport: createMockTransport(),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "quant-share-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
  const qloo = client
    .forRun({ runId: "run-synthetic-1", lane: "public", pillar: "investment", limits: { ...DEFAULT_RUN_LIMITS, ...options.limits }, phase: () => "wave1" })
    .forTool("toolu_synthetic_1");
  const registry = new FakeRegistry();
  for (const e of options.members ?? [ALPHA, BETA, GAMMA, DELTA]) registerInvented(registry, e, options.type ?? "brand");
  const run = fakeRun(qloo, registry);
  const ctx: SkillCtx = Object.assign(run.ctx, { localities: LOCALITIES });
  return { ...run, ctx, qloo };
}

function input(raw: Record<string, unknown> = {}) {
  return shareOfTasteSkill.input.parse({
    type: "brand",
    set: ["R1", "R2", "R3", "R4"],
    ages: ["24_and_younger", "25_to_29", "45_to_54", "55_and_older"],
    audiences: ["urn:audience:leisure:board_games"],
    metros: ["nashville", "austin"],
    trigger_finding_id: null,
    step_id: "S2",
    ...raw,
  });
}

describe("share_of_taste over the mock transport", () => {
  it("sends only allowlisted requests, parses every output and leaves the cache warm for the estimate", async () => {
    const run = mockRun();
    const raw = input();
    expect(await estimateShareCalls(raw, run.qloo, run.registry, { localities: LOCALITIES, geo: null })).toBe(7);
    const result = await shareOfTasteSkill.run(raw, run.ctx);

    expect(result.status).toBe("ok");
    expect(result.forModel.notices.some((n) => /failed|refused/.test(n))).toBe(false);
    expect(run.ledger.evidences.map((e) => e.qlooCallIds.length)).toEqual([4, 1, 2]);
    expect(run.ledger.evidences.every((e) => e.requestIds.every((id) => id.startsWith("mock-")))).toBe(true);
    for (const d of run.ledger.datasets) DatasetEnvelope.parse(d);
    expect(run.ledger.datasets[0]?.kind).toBe("Matrix");
    expect(run.ledger.metrics.every((m) => ["share.pct", "share.youth_tilt", "share.metros_won"].includes(m.formulaId))).toBe(true);
    for (const f of result.flags) expect(Flag.options).toContain(f);
    expect(result.flags).not.toContain("BUDGET_TRUNCATED");
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "share_of_taste", step: "S2" })).toBe(true);
    expect(JSON.stringify(digest)).not.toMatch(/mock-ent|mock-loc/);

    expect(await estimateShareCalls(raw, run.qloo, run.registry, { localities: LOCALITIES, geo: null })).toBe(0);
  });

  it("turns the client's run cap into BUDGET_TRUNCATED and a partial grid", async () => {
    const run = mockRun({ limits: { qlooCalls: 3, qlooWarnAt: 2 } });
    const result = await shareOfTasteSkill.run(input(), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    expect(run.ledger.evidences.flatMap((e) => e.qlooCallIds)).toHaveLength(3);
    const matrix = run.ledger.datasets.find((d) => d.kind === "Matrix");
    expect(matrix?.kind === "Matrix" && matrix.payload.cells.flat().filter((c) => c.reason === "budget_truncated")).toHaveLength(4 * 4);
  });

  it("shares a person set by metro and by age, the person forms P5 verified", async () => {
    const run = mockRun({ type: "person" });
    const raw = { ...input({ audiences: [] }), type: "person" as const };
    const result = await shareOfTasteSkill.run(raw, run.ctx);
    expect(result.status).toBe("ok");
    expect(run.ledger.evidences.flatMap((e) => e.qlooCallIds)).toHaveLength(6);
  });
});
