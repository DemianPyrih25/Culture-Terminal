// rank_candidates end to end through the real Qloo client over the synthetic transport, one test per
// type the allowlist can rank: every request must pass the frozen allowlist and value rules (the
// client throws otherwise), and the ledger output parses with the contract schemas. Invented ids.
import { DatasetEnvelope, DEFAULT_RUN_LIMITS, type EntityType, type GeoApi, type LocalityApi, type SkillCtx, type ToolInput } from "@ct/contracts";
import { createMemoryQlooStore, createMockTransport, createQlooClient } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { estimateRankCandidatesCalls, rankCandidatesSkill } from "../../src/skills/rankCandidates";
import { fakeRun, FakeRegistry, registerInvented } from "./support/fakes";
import { ALPHA, ARTIST_NOVA, BETA, DELTA, EPSILON, GAMMA } from "./support/world";

type RankInput = ToolInput<"rank_candidates">;

const GEO: GeoApi = {
  metros: () => ["nashville", "austin"],
  neighbourhoods: () => [],
  neighbourhood: (metro, id) => (id === "east_side" ? { id, name: "East Side", metro, centroid: { lat: 36.18, lon: -86.75 }, areaKm2: 4 } : null),
  matchNeighbourhood: () => null,
  polygonWkt: (_, id) => (id === "east_side" ? "POLYGON((-86.76 36.17, -86.74 36.17, -86.74 36.19, -86.76 36.17))" : null),
  locate: () => null,
  geohashCentroid: () => ({ lat: 0, lon: 0 }),
  boundarySource: () => "invented",
};

const LOCALITIES: LocalityApi = { market: async (m) => ({ entityId: `mock-loc-${m}`, label: m }) };

function mockRun(type: EntityType, pillar: "investment" | "location" | "marketing" = "location") {
  const client = createQlooClient({
    transport: createMockTransport(),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "quant-rank-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
  const qloo = client
    .forRun({ runId: "run-synthetic-1", lane: "public", pillar, limits: DEFAULT_RUN_LIMITS, phase: () => "wave1" })
    .forTool("toolu_synthetic_1");
  const registry = new FakeRegistry();
  for (const e of [ALPHA, BETA, GAMMA, DELTA, EPSILON]) registerInvented(registry, e, type);
  registerInvented(registry, ARTIST_NOVA, "artist");
  registry.registerTag({ tagId: "urn:tag:genre:music:folk", name: "folk", type: "urn:tag:genre:music", signalCapable: true });
  const run = fakeRun(qloo, registry);
  const ctx: SkillCtx = Object.assign(run.ctx, { geo: GEO, localities: LOCALITIES });
  return { ...run, ctx, qloo };
}

/** Inputs straight into the skill, without the tool schema, so the skill's own refusals are exercised too. */
function raw(fields: Partial<RankInput>): RankInput {
  return {
    type: "brand",
    candidates: ["R1", "R2", "R3", "R4", "R5"],
    signal_entities: [],
    signal_tags: [],
    contexts: [{ kind: "none" }],
    trigger_finding_id: null,
    step_id: "S5",
    ...fields,
  } as RankInput;
}

const TENANT: RankInput["contexts"] = [
  { kind: "site", area: { kind: "nbhd", ref: "east_side", metro: "nashville" } },
  { kind: "city", metro: "nashville" },
];

async function rankOk(type: EntityType, fields: Partial<RankInput>, pillar?: "investment" | "location" | "marketing") {
  const run = mockRun(type, pillar);
  const input = raw({ type, ...fields });
  const cold = await estimateRankCandidatesCalls(input, run.qloo, run.registry, { geo: GEO, localities: LOCALITIES });
  const result = await rankCandidatesSkill.run(input, run.ctx);
  expect(result.forModel.notices.filter((n) => /failed/.test(n))).toEqual([]);
  expect(result.status).toBe("ok");
  expect(run.ledger.evidences[0]?.qlooCallIds).toHaveLength(cold);
  for (const d of run.ledger.datasets) DatasetEnvelope.parse(d);
  expect(await estimateRankCandidatesCalls(input, run.qloo, run.registry, { geo: GEO, localities: LOCALITIES })).toBe(0);
  return { run, result };
}

describe("rank_candidates over the mock transport", () => {
  it("brands: tenant fit with a polygon site and the city locality", async () => {
    const { run } = await rankOk("brand", { contexts: TENANT });
    expect(run.ledger.datasets[0]?.kind).toBe("Slope");
    expect(run.ledger.metrics.some((m) => m.formulaId === "tenant.fit")).toBe(true);
  });

  it("brands: a seed with age, audience and metro contexts", async () => {
    const { run } = await rankOk(
      "brand",
      {
        signal_entities: ["R6"],
        signal_tags: ["T1"],
        contexts: [
          { kind: "age", age: "25_to_29" },
          { kind: "audience", audience: "urn:audience:leisure:board_games" },
          { kind: "metro", market: "austin" },
        ],
      },
      "investment",
    );
    expect(run.ledger.datasets[0]?.kind).toBe("Slope");
  });

  it("places: site vs city by location only (P5)", async () => {
    await rankOk("place", { contexts: TENANT });
  });

  it("places, artists and destinations: a none context from a seed", async () => {
    await rankOk("place", { signal_entities: ["R6"] });
    await rankOk("artist", { signal_entities: ["R6"], signal_tags: ["T1"] });
    await rankOk("destination", { signal_entities: ["R6"] });
  });

  it("persons: by point site and by age (P5)", async () => {
    await rankOk("person", { contexts: [{ kind: "site", area: { kind: "point", ref: "-86.75,36.18", metro: "nashville" } }, { kind: "age", age: "55_and_older" }] });
  });

  it("raises SENSITIVE_SEGMENT_BLOCKED only for the segments the client denies on every desk (D21)", async () => {
    const contexts = (audience: string): RankInput["contexts"] => [
      { kind: "age", age: "25_to_29" },
      { kind: "audience", audience },
    ];
    const denied = mockRun("brand", "location");
    const blocked = await rankCandidatesSkill.run(raw({ contexts: contexts("urn:audience:communities:invented_group") }), denied.ctx);
    expect(blocked.status).toBe("partial");
    expect(blocked.flags).toContain("SENSITIVE_SEGMENT_BLOCKED");
    expect(blocked.forModel.notices).toContain("communities: invented group: a sensitive segment, refused on every desk (D21), so the context was not called.");

    // spending_habits is allowed on other desks but not on the location desk: a notice, not a blocked segment.
    const offDesk = mockRun("brand", "location");
    const refused = await rankCandidatesSkill.run(raw({ contexts: contexts("urn:audience:spending_habits:invented_habit") }), offDesk.ctx);
    expect(refused.status).toBe("partial");
    expect(refused.flags).not.toContain("SENSITIVE_SEGMENT_BLOCKED");
    expect(refused.forModel.notices).toContain("spending habits: invented habit: not on this desk's AUDIENCES list, so the context was not called.");
    expect(offDesk.ledger.evidences[0]?.qlooCallIds).toHaveLength(1);
  });

  it("makes no call for a type with no candidate list", async () => {
    const run = mockRun("tv_show");
    const result = await rankCandidatesSkill.run(raw({ type: "tv_show", signal_entities: ["R6"] }), run.ctx);
    expect(result.status).toBe("error");
    expect(run.ledger.evidences).toHaveLength(0);
  });
});
