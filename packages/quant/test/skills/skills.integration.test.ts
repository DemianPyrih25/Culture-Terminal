// The S0/S1 skills against the real QUANT seams (stats, subs, badges, findings), with the same fake
// Qloo world as the unit tests. It needs no database. While a seam still throws "not implemented
// yet" the suite is skipped with a warning, and it runs by itself once the seam lands.
import { digestFits, Metric, ModelDigest } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { metricConfidence } from "../../src/badges";
import {
  droppedCandidatesFinding,
  emptyResultFinding,
  isOutsideCategoryNeighbour,
  nearSubstitutesFinding,
  outsideCategoryNeighbourFinding,
  tasteIslandFinding,
} from "../../src/findings";
import { SKILLS } from "../../src/skills/index";
import { detectFloor } from "../../src/stats";
import { computeSubstitution } from "../../src/subs";
import { fakeQloo, fakeRun, FakeRegistry, registerInvented, searchResult, type Invented } from "./support/fakes";
import { ALPHA, BETA, DELTA, EPSILON, GAMMA, ISLAND_WORLD, OMEGA, sims, worldInsights, ZETA, type World } from "./support/world";

function pendingSeams(): string[] {
  const probes: [string, () => unknown][] = [
    ["detectFloor", () => detectFloor([1, 1])],
    ["computeSubstitution", () => computeSubstitution({ refs: ["R1", "R2"], targetIndex: 0, sim: [[null, 0.5], [0.5, null]] })],
    ["metricConfidence", () => metricConfidence("MEASURED", 4)],
    ["tasteIslandFinding", () => tasteIslandFinding({ targetName: "A", lastInRows: 3, scoredRows: 3, nearestName: null })],
    ["nearSubstitutesFinding", () => nearSubstitutesFinding({ aName: "A", bName: "B" })],
    ["outsideCategoryNeighbourFinding", () => outsideCategoryNeighbourFinding({ targetName: "A", neighbourName: "B", neighbourCategory: null, neighbourInMap: false })],
    ["droppedCandidatesFinding", () => droppedCandidatesFinding({ names: ["A"], context: "x" })],
    ["emptyResultFinding", () => emptyResultFinding({ what: "x", suggestion: null })],
    ["isOutsideCategoryNeighbour", () => isOutsideCategoryNeighbour({ neighbourInCategory: false, neighbourScore: 1, bestInCategoryScore: 0 })],
  ];
  return probes.flatMap(([name, probe]) => {
    try {
      probe();
      return [];
    } catch (err) {
      if (err instanceof Error && /not implemented yet/.test(err.message)) return [name];
      throw err;
    }
  });
}

const pending = pendingSeams();
if (pending.length > 0) console.warn(`[@ct/quant] skipping skills integration tests: seams not implemented yet: ${pending.join(", ")}`);

function mapRun(world: World, registered = [ALPHA], budget?: number) {
  const registry = new FakeRegistry();
  for (const e of registered) registerInvented(registry, e);
  const qloo = fakeQloo({ insights: worldInsights(world), budget });
  return { ...fakeRun(qloo.api, registry), calls: qloo.calls };
}

function mapInput(raw: { peers?: string[]; discover?: boolean; k?: number } = {}) {
  return SKILLS.peer_landscape.input.parse({
    target: "R1",
    peers: [],
    discover: true,
    k: 5,
    trigger_finding_id: null,
    step_id: "S2",
    ...raw,
  });
}

describe.skipIf(pending.length > 0)("skills against the real QUANT seams", () => {
  it("maps the island market end to end", async () => {
    const run = mapRun(ISLAND_WORLD);
    const result = await SKILLS.peer_landscape.run(mapInput(), run.ctx);

    expect(result.status).toBe("ok");
    expect(run.calls).toHaveLength(2 + 4);
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["TASTE_ISLAND", "NEAR_SUBSTITUTES", "OUTSIDE_CATEGORY_NEIGHBOUR"]);
    const [island, near, outside] = run.ledger.findings;
    expect(island?.text).toContain("Brand Alpha ranks last in 4 of 4 peer rows");
    expect(island?.suggestion?.tool).toBe("cross_domain");
    expect(near?.text).toContain("Brand Beta and Brand Gamma");
    expect(near?.suggestion?.tool).toBe("share_of_taste");
    expect(outside?.text).toContain("Snack Omega");
    expect(outside?.suggestion).toEqual({
      tool: "peer_landscape",
      reason: "Map Snack Omega's own peers, with Snack Omega as the target.",
    });

    const distinct = run.ledger.metrics.find((m) => m.key === "subs.distinctiveness");
    expect(distinct?.display).toBe("1 of 5");
    for (const m of run.ledger.metrics) {
      Metric.parse(m);
      if (m.conf !== null) expect(m.conf).toBeGreaterThan(0);
    }

    const d = run.ledger.datasets[0];
    expect(d?.kind).toBe("Matrix");
    if (d?.kind === "Matrix") {
      expect(new Set(d.payload.rows.map((r) => r.key))).toEqual(new Set(["R1", "R2", "R3", "R4", "R5"]));
      expect(d.payload.annotations).toHaveLength(2);
    }

    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "peer_landscape", step: "S2" })).toBe(true);
    expect(JSON.stringify(digest)).not.toContain("ent-");
  });

  it("fits a full k = 7 map with long names, a citable similarity and hub per member and the real finding texts", async () => {
    const long = (e: Invented): Invented => ({ ...e, name: `${e.name} Heritage Trading Company Limited`.slice(0, 40) });
    const brands = [ALPHA, BETA, GAMMA, DELTA, EPSILON, ZETA, OMEGA].map(long);
    const entries: [Invented, Invented, number][] = [];
    brands.forEach((a, i) => brands.slice(i + 1).forEach((b, j) => entries.push([a, b, 0.1 + 0.01 * (i * 7 + j)])));
    const run = mapRun({ sims: sims(entries), sameCategory: brands.slice(1, 6), crossCategory: [brands[6]!] }, [brands[0]!]);
    const result = await SKILLS.peer_landscape.run(mapInput({ k: 7 }), run.ctx);

    expect(result.status).toBe("ok");
    expect(digestFits(ModelDigest.parse(result.forModel), { tool: "peer_landscape", step: "S2" })).toBe(true);
    const byKey = (key: string) => run.ledger.metrics.filter((m) => m.key === key);
    expect(new Set(byKey("subs.similarity").map((m) => m.subjectRefs[1]))).toEqual(new Set(["R2", "R3", "R4", "R5", "R6", "R7"]));
    expect(new Set(byKey("subs.hub").map((m) => m.subjectRefs[0]))).toEqual(new Set(["R1", "R2", "R3", "R4", "R5", "R6", "R7"]));
    expect(run.ledger.metrics.length).toBeLessThanOrEqual(3 + 2 + 2 * 6);
    // Rows may be cut to fit, never metrics: every member's numbers stay citable.
    expect(result.forModel.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
    const kept = result.forModel.top_rows.length;
    if (kept < 7) expect(result.forModel.notices[0]).toBe(`${7 - kept} of 7 rows left out to fit this result; the full table is in D1.`);
  });

  it("suggests adding an outside-category neighbour that has no slot in the map", async () => {
    const run = mapRun(ISLAND_WORLD, [ALPHA, BETA, GAMMA, DELTA]);
    const result = await SKILLS.peer_landscape.run(mapInput({ peers: ["R2", "R3", "R4"], k: 4 }), run.ctx);
    expect(result.status).toBe("ok");
    const outside = run.ledger.findings.find((f) => f.kind === "OUTSIDE_CATEGORY_NEIGHBOUR");
    expect(outside?.suggestion).toEqual({ tool: "peer_landscape", reason: "Add Snack Omega to the Substitution Map as a cross-category peer." });
    expect(result.forModel.top_rows.at(-1)).toMatchObject({ ref: "R5", values: { in_map: "no" } });
  });

  it("raises no EMPTY_RESULT when discovery found peers, only too few for a map", async () => {
    const run = mapRun({ sims: ISLAND_WORLD.sims, sameCategory: [], crossCategory: [OMEGA] });
    const result = await SKILLS.peer_landscape.run(mapInput(), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["OUTSIDE_CATEGORY_NEIGHBOUR"]);
  });

  it("publishes no hub or distinctiveness rank from a map the budget cut short", async () => {
    const run = mapRun(ISLAND_WORLD, [ALPHA], 3);
    const result = await SKILLS.peer_landscape.run(mapInput(), run.ctx);
    expect(result.status).toBe("partial");
    expect(run.ledger.metrics.some((m) => m.badge === "DERIVED")).toBe(false);
    const hub = run.ledger.metrics.filter((m) => m.key === "subs.hub");
    expect(hub).toHaveLength(1);
    expect(hub[0]).toMatchObject({ value: null, reason: "budget_truncated", badge: "UNAVAILABLE" });
    expect(run.ledger.metrics.find((m) => m.key === "subs.distinctiveness")).toMatchObject({ value: null, reason: "budget_truncated" });
    expect(result.forModel.top_rows.every((r) => !("hub" in r.values))).toBe(true);
  });

  it("treats floor ties as not scored with the real floor detector", async () => {
    const world: World = {
      sims: sims([
        [ALPHA, BETA, 0.4],
        [ALPHA, GAMMA, 0.3],
        [ALPHA, DELTA, 0.05],
        [BETA, GAMMA, 0.6],
        [BETA, DELTA, 0.05],
        [GAMMA, DELTA, 0.5],
      ]),
      sameCategory: [],
      crossCategory: [],
    };
    const run = mapRun(world, [ALPHA, BETA, GAMMA, DELTA]);
    const result = await SKILLS.peer_landscape.run(mapInput({ peers: ["R2", "R3", "R4"], discover: false, k: 4 }), run.ctx);
    expect(result.flags).toEqual(["CANDIDATES_UNSCORED", "NOT_SCORED"]);
    const d = run.ledger.datasets[0];
    if (d?.kind !== "Matrix") throw new Error("expected a Matrix dataset");
    const unscored = d.payload.cells.flat().filter((c) => c.reason === "not_scored");
    expect(unscored).toHaveLength(4);
    expect(unscored.every((c) => c.value === null && c.rank === null)).toBe(true);
  });

  it("resolves names with real confidence and badge rules", async () => {
    const { api } = fakeQloo({ search: (p) => (p.query === "Brand Epsilon" ? [searchResult(EPSILON)] : []) });
    const run = fakeRun(api);
    const input = SKILLS.resolve_entities.input.parse({
      mentions: [
        { text: "Brand Epsilon", type: "brand", metro: null },
        { text: "Brand Nowhere", type: "brand", metro: null },
      ],
      trigger_finding_id: null,
      step_id: null,
    });
    const result = await SKILLS.resolve_entities.run(input, run.ctx);
    expect(result.status).toBe("partial");
    expect(run.ledger.metrics[0]).toMatchObject({ badge: "MEASURED", formulaId: "popularity", conf: null });
    expect(run.ledger.evidences.map((e) => e.status)).toEqual(["ok", "empty"]);
  });
});
