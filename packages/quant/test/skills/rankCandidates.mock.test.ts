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

    // A family on no desk's list is refused too, but it is not a sensitive segment: a notice, no flag.
    const offDesk = mockRun("brand", "location");
    const refused = await rankCandidatesSkill.run(raw({ contexts: contexts("urn:audience:unknown_family:invented_habit") }), offDesk.ctx);
    expect(refused.status).toBe("partial");
    expect(refused.flags).not.toContain("SENSITIVE_SEGMENT_BLOCKED");
    expect(refused.forModel.notices).toContain("unknown family: invented habit: not on this desk's AUDIENCES list, so the context was not called.");
    expect(offDesk.ledger.evidences[0]?.qlooCallIds).toHaveLength(1);
  });

  it("ranks podcasts, TV shows and movies as named lists, from a seed or by age (C3), TV shows also by audience (C5)", async () => {
    for (const type of ["podcast", "tv_show", "movie"] as const) {
      const seeded = mockRun(type);
      const named = await rankCandidatesSkill.run(raw({ type, signal_entities: ["R6"] }), seeded.ctx);
      expect(named.status, type).not.toBe("error");
      expect(seeded.ledger.evidences[0]?.qlooCallIds, type).toHaveLength(1);
      const aged = mockRun(type);
      const byAge = await rankCandidatesSkill.run(raw({ type, contexts: [{ kind: "age", age: "25_to_29" }] }), aged.ctx);
      expect(byAge.status, type).not.toBe("error");
      // A seed next to an age context is not verified for media: refused with no call.
      const mixed = mockRun(type);
      const refused = await rankCandidatesSkill.run(raw({ type, signal_entities: ["R6"], contexts: [{ kind: "age", age: "25_to_29" }] }), mixed.ctx);
      expect(refused.status, type).toBe("error");
      expect(mixed.ledger.evidences, type).toHaveLength(0);
    }
    const shows = mockRun("tv_show", "marketing");
    const byAudience = await rankCandidatesSkill.run(raw({ type: "tv_show", contexts: [{ kind: "audience", audience: "urn:audience:life_stage:invented_stage" }] }), shows.ctx);
    expect(byAudience.status).not.toBe("error");
  });

  it("ranks brands and persons by audience gender (C4)", async () => {
    for (const type of ["brand", "person"] as const) {
      const run = mockRun(type);
      const result = await rankCandidatesSkill.run(raw({ type, contexts: [{ kind: "gender", gender: "female" }, { kind: "gender", gender: "male" }] }), run.ctx);
      expect(result.status, type).not.toBe("error");
      expect(run.ledger.evidences[0]?.qlooCallIds, type).toHaveLength(2);
    }
    const artists = mockRun("artist");
    const refused = await rankCandidatesSkill.run(raw({ type: "artist", signal_entities: ["R6"], contexts: [{ kind: "gender", gender: "male" }] }), artists.ctx);
    expect(refused.status).toBe("error");
  });
});
