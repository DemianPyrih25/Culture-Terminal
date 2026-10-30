import { digestFits, ModelDigest, type DatasetOf, type QlooApi, type QlooParams } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { SKILL_LIMITATIONS } from "../../src/limitations";
import { NAME_MAX } from "../../src/skills/format";
import { estimatePeerLandscapeCalls, peerLandscapeSkill } from "../../src/skills/peerLandscape";
import { addOutsideFinding, type MapMembers, type SubsRun } from "../../src/skills/subsOutputs";
import { categoryTagOf } from "../../src/skills/peerSelection";
import { triangularCalls } from "../../src/skills/substitutionMap";
import { CAT_BEVERAGE, CAT_SNACK, fakeProbe, fakeQloo, fakeRun, FakeRegistry, registerInvented, type Invented } from "./support/fakes";
import {
  ALPHA,
  ARTIST_NOVA,
  BETA,
  DELTA,
  EPSILON,
  GAMMA,
  ISLAND_WORLD,
  JUNK,
  OMEGA,
  sims,
  UNTAGGED,
  worldInsights,
  ZETA,
  type World,
} from "./support/world";

// The seams are replaced by small reference doubles so these tests cover the skill's own wiring.
vi.mock("../../src/stats", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/stats")>()),
  detectFloor: (await import("./support/seamDoubles")).detectFloor,
}));
vi.mock("../../src/subs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/subs")>()),
  computeSubstitution: (await import("./support/seamDoubles")).computeSubstitution,
}));
vi.mock("../../src/badges", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/badges")>()),
  metricConfidence: (await import("./support/seamDoubles")).metricConfidence,
}));
vi.mock("../../src/findings", async (importOriginal) => {
  const d = await import("./support/seamDoubles");
  return {
    ...(await importOriginal<typeof import("../../src/findings")>()),
    tasteIslandFinding: d.tasteIslandFinding,
    nearSubstitutesFinding: d.nearSubstitutesFinding,
    outsideCategoryNeighbourFinding: d.outsideCategoryNeighbourFinding,
    droppedCandidatesFinding: d.droppedCandidatesFinding,
    emptyResultFinding: d.emptyResultFinding,
    isOutsideCategoryNeighbour: d.isOutsideCategoryNeighbour,
  };
});

function input(raw: Partial<{ target: string; peers: string[]; discover: boolean; k: number; step_id: string | null }>) {
  return peerLandscapeSkill.input.parse({
    target: "R1",
    peers: [],
    discover: true,
    k: 5,
    trigger_finding_id: null,
    step_id: "S2",
    ...raw,
  });
}

function setup(world: World, options: { budget?: number; registered?: Invented[] } = {}) {
  const registry = new FakeRegistry();
  for (const e of options.registered ?? [ALPHA]) registerInvented(registry, e, e === ARTIST_NOVA ? "artist" : "brand");
  const qloo = fakeQloo({ insights: worldInsights(world), budget: options.budget });
  return { ...fakeRun(qloo.api, registry), calls: qloo.calls };
}

const ids = (v: QlooParams[string] | undefined) => (typeof v === "object" ? [...v] : v === undefined ? [] : [String(v)]);

function matrixDataset(run: ReturnType<typeof setup>): DatasetOf<"Matrix"> {
  const d = run.ledger.datasets[0];
  if (d?.kind !== "Matrix") throw new Error("expected a Matrix dataset");
  return d;
}

/** The matrix cell for two brands, looked up by key so it is independent of the display order. */
function cell(d: DatasetOf<"Matrix">, rowRef: string, colRef: string) {
  const r = d.payload.rows.findIndex((x) => x.key === rowRef);
  const c = d.payload.cols.findIndex((x) => x.key === colRef);
  return d.payload.cells[r]?.[c];
}

describe("categoryTagOf", () => {
  const tag = (tagId: string) => ({ tagId, name: tagId.split(":").pop() ?? "", type: "urn:tag:genre:brand" });

  it("takes the genre:brand leaf, the deepest of the listed path levels, whatever the order", () => {
    const tags = [tag("urn:tag:genre:brand:beverage"), tag("urn:tag:genre:brand:beverage:water:sparkling"), tag("urn:tag:genre:brand:beverage:water")];
    expect(categoryTagOf({ tags })?.tagId).toBe("urn:tag:genre:brand:beverage:water:sparkling");
  });

  it("keeps the first of equally deep leaves, ignores other namespaces and answers null without a category", () => {
    const tags = [tag("urn:tag:lifestyle:qloo:a:b:c:d"), tag("urn:tag:genre:brand:snack:jerky"), tag("urn:tag:genre:brand:beverage:water")];
    expect(categoryTagOf({ tags })?.tagId).toBe("urn:tag:genre:brand:snack:jerky");
    expect(categoryTagOf({ tags: [tag("urn:tag:lifestyle:qloo:outdoors")] })).toBeNull();
  });
});

describe("peer_landscape: discovery and the peer rule", () => {
  it("runs D1 then D2 from the target, fills from D1 past the quality gate and keeps the last slot for the outside neighbour", async () => {
    const run = setup(ISLAND_WORLD);
    const result = await peerLandscapeSkill.run(input({ k: 5 }), run.ctx);

    const [d1, d2] = run.calls;
    expect(d1?.filterType).toBe("urn:entity:brand");
    expect(d1?.params).toEqual({
      "signal.interests.entities": [ALPHA.id],
      "filter.tags": [ALPHA.category],
      "filter.exclude.entities": [ALPHA.id],
      take: 20,
    });
    expect(d2?.params).toEqual({
      "signal.interests.entities": [ALPHA.id],
      "filter.exclude.entities": [ALPHA.id],
      take: 20,
    });

    expect(run.registry.entities().map((e) => e.name)).toEqual([
      "Brand Alpha",
      "Brand Beta",
      "Brand Gamma",
      "Brand Delta",
      "Snack Omega",
    ]);
    expect(result.flags).toContain("QUALITY_GATE_DROPPED");
    expect(run.registry.byEntityId(JUNK.id)).toBeNull();
    expect(result.forModel.registered.map((r) => r.name)).toEqual(["Brand Beta", "Brand Gamma", "Brand Delta", "Snack Omega"]);
    expect(run.ledger.evidences[0]).toMatchObject({ purpose: expect.stringContaining("discovery"), status: "ok" });
    expect(run.ledger.evidences[0]?.qlooCallIds).toHaveLength(2);
  });

  it("puts named peers first and discovers only the rest", async () => {
    const run = setup(ISLAND_WORLD, { registered: [ALPHA, DELTA] });
    await peerLandscapeSkill.run(input({ peers: ["R2"], k: 4 }), run.ctx);
    const matrixSignals = run.calls.slice(2).map((c) => ids(c.params["signal.interests.entities"])[0]);
    // Alpha, then Delta (named), then Beta (D1), then Omega (outside slot).
    expect(matrixSignals).toEqual([ALPHA.id, DELTA.id, BETA.id]);
    expect(ids(run.calls[2]?.params["filter.results.entities"])).toEqual([DELTA.id, BETA.id, OMEGA.id]);
  });

  it("leaves out named peers that are not brands, with a notice", async () => {
    const run = setup(ISLAND_WORLD, { registered: [ALPHA, ARTIST_NOVA, BETA, GAMMA] });
    const result = await peerLandscapeSkill.run(input({ peers: ["R2", "R3", "R4"], discover: false, k: 4 }), run.ctx);
    expect(result.status).toBe("ok");
    expect(result.forModel.notices[0]).toContain("not a brand");
    expect(run.calls).toHaveLength(2);
  });

  it("fills from cross-category discovery when the target has no category tag", async () => {
    const world: World = { ...ISLAND_WORLD, sims: { ...ISLAND_WORLD.sims, ...sims([[UNTAGGED, BETA, 0.3], [UNTAGGED, GAMMA, 0.2], [UNTAGGED, OMEGA, 0.25]]) } };
    const run = setup(world, { registered: [UNTAGGED] });
    const result = await peerLandscapeSkill.run(input({ k: 4 }), run.ctx);
    expect(run.calls[0]?.params["filter.tags"]).toBeUndefined();
    expect(run.calls.filter((c) => c.params["filter.exclude.entities"] !== undefined)).toHaveLength(1);
    expect(result.forModel.notices.some((n) => n.includes("no genre:brand tag"))).toBe(true);
    expect(run.ledger.findings.some((f) => f.kind === "OUTSIDE_CATEGORY_NEIGHBOUR")).toBe(false);
  });

  it("reports EMPTY_RESULT when discovery finds nothing usable", async () => {
    const run = setup({ sims: {}, sameCategory: [JUNK], crossCategory: [] });
    const result = await peerLandscapeSkill.run(input({}), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["EMPTY_RESULT"]);
    expect(run.ledger.findings[0]?.suggestion?.tool).toBe("peer_landscape");
    expect(run.calls).toHaveLength(2);
    expect(run.ledger.evidences[0]?.status).toBe("empty");
    expect(result.flags).toEqual(["QUALITY_GATE_DROPPED", "THIN_RESULT"]);
  });

  it("raises no EMPTY_RESULT when discovery returned usable results, just too few for a map", async () => {
    const run = setup({ sims: ISLAND_WORLD.sims, sameCategory: [], crossCategory: [OMEGA] });
    const result = await peerLandscapeSkill.run(input({ k: 5 }), run.ctx);
    expect(result.status).toBe("empty");
    expect(run.calls).toHaveLength(2);
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["OUTSIDE_CATEGORY_NEIGHBOUR"]);
    expect(run.ledger.evidences[0]).toMatchObject({ status: "ok", summary: expect.stringContaining("0 same-category and 1 cross-category") });
    expect(result.forModel.notices).toContain("A Substitution Map needs the target and at least 2 peers; name more peers to build it.");
  });

  it("tops up from same-category D2 results when D1 comes back empty", async () => {
    const run = setup({ sims: ISLAND_WORLD.sims, sameCategory: [], crossCategory: [OMEGA, BETA, GAMMA] });
    const result = await peerLandscapeSkill.run(input({ k: 4 }), run.ctx);
    expect(result.status).toBe("ok");
    expect(run.registry.entities().map((e) => e.name)).toEqual(["Brand Alpha", "Brand Beta", "Brand Gamma", "Snack Omega"]);
    expect(run.calls.slice(2).map((c) => ids(c.params["signal.interests.entities"])[0])).toEqual([ALPHA.id, BETA.id, GAMMA.id]);
    expect(run.ledger.findings.some((f) => f.kind === "EMPTY_RESULT")).toBe(false);
  });

  it("names an outside-category neighbour left out of the map, with its own row and the add-to-map pivot", async () => {
    // Named peers fill every slot, so Snack Omega qualifies on discovery evidence alone (0.30 vs 0.22).
    const run = setup(ISLAND_WORLD, { registered: [ALPHA, BETA, GAMMA, DELTA] });
    const result = await peerLandscapeSkill.run(input({ peers: ["R2", "R3", "R4"], k: 4 }), run.ctx);
    expect(result.status).toBe("ok");
    expect(run.calls).toHaveLength(2 + 3);
    expect(ids(run.calls[2]?.params["filter.results.entities"])).toEqual([BETA.id, GAMMA.id, DELTA.id]);

    expect(result.forModel.registered).toEqual([{ ref: "R5", name: "Snack Omega", type: "brand" }]);
    const outside = run.ledger.findings.find((f) => f.kind === "OUTSIDE_CATEGORY_NEIGHBOUR");
    expect(outside?.metricIds).toEqual([]);
    expect(outside?.suggestion).toEqual({ tool: "peer_landscape", reason: "Add Snack Omega to the Substitution Map as a cross-category peer." });
    expect(result.forModel.top_rows.at(-1)).toEqual({
      ref: "R5",
      name: "Snack Omega",
      values: { role: "outside_category_neighbour", in_map: "no", in_category: "no" },
    });
    expect(matrixDataset(run).payload.rows.map((r) => r.key)).not.toContain("R5");
  });
});

describe("peer_landscape: the triangular matrix", () => {
  it("makes k−1 triangular calls and fills both halves symmetrically", async () => {
    const run = setup(ISLAND_WORLD);
    await peerLandscapeSkill.run(input({ k: 5 }), run.ctx);
    const scoring = run.calls.slice(2);
    expect(scoring).toHaveLength(4);
    const order = [ALPHA, BETA, GAMMA, DELTA, OMEGA].map((e) => e.id);
    scoring.forEach((call, i) => {
      expect(ids(call.params["signal.interests.entities"])).toEqual([order[i]]);
      expect(ids(call.params["filter.results.entities"])).toEqual(order.slice(i + 1));
      expect(call.params.take).toBe(5);
    });

    const d = matrixDataset(run);
    expect(d.title).toBe("Substitution Map · Brand Alpha");
    expect(d.payload.rows.map((r) => r.label)).toEqual(["Snack Omega", "Brand Delta", "Brand Gamma", "Brand Beta", "Brand Alpha"]);
    const refs = d.payload.rows.map((r) => r.key);
    for (const a of refs) {
      for (const b of refs) {
        const x = cell(d, a, b);
        const y = cell(d, b, a);
        expect(x?.value).toBe(y?.value);
        if (a === b) expect(x).toEqual({ value: null, reason: "self", rank: null });
      }
    }
    expect(cell(d, "R2", "R3")?.value).toBe(0.9);
    expect(cell(d, "R2", "R3")?.rank).toBe(1);
    expect(d.payload.targetKey).toBe("R1");
    expect(d.payload.margin?.values).toHaveLength(5);
    expect(d.formulaIds).toContain("subs.similarity");
    expect(d.evidenceIds).toEqual(["E1", "E2"]);
  });

  it("leaves floor ties unscored and dropped candidates unscored, never ranked", async () => {
    const world: World = {
      sims: sims([
        [ALPHA, BETA, 0.4],
        [ALPHA, GAMMA, 0.3],
        [ALPHA, DELTA, 0.05],
        [ALPHA, EPSILON, 0.35],
        [BETA, GAMMA, 0.6],
        [BETA, DELTA, 0.5],
        [BETA, EPSILON, 0.45],
        [GAMMA, DELTA, 0.55],
        [GAMMA, EPSILON, 0.05],
        [DELTA, EPSILON, 0.25],
      ]),
      sameCategory: [],
      crossCategory: [],
      drops: { [BETA.id]: [EPSILON.id] },
    };
    const run = setup(world, { registered: [ALPHA, BETA, GAMMA, DELTA, EPSILON] });
    const result = await peerLandscapeSkill.run(input({ peers: ["R2", "R3", "R4", "R5"], discover: false, k: 5 }), run.ctx);

    const d = matrixDataset(run);
    expect(cell(d, "R1", "R4")).toEqual({ value: null, reason: "not_scored", rank: null });
    expect(cell(d, "R4", "R1")).toEqual({ value: null, reason: "not_scored", rank: null });
    expect(cell(d, "R3", "R5")).toEqual({ value: null, reason: "not_scored", rank: null });
    expect(cell(d, "R2", "R5")).toEqual({ value: null, reason: "dropped", rank: null });
    expect(cell(d, "R5", "R2")).toEqual({ value: null, reason: "dropped", rank: null });

    expect(result.flags).toEqual(["CANDIDATES_UNSCORED", "DROPPED_CANDIDATES", "NOT_SCORED"]);
    const dropped = run.ledger.findings.find((f) => f.kind === "DROPPED_CANDIDATES");
    expect(dropped?.text).toBe("Brand Epsilon not scored in the Substitution Map scoring calls.");
    expect(run.ledger.evidences).toHaveLength(1);
    expect(run.ledger.evidences[0]?.summary).toContain("7 of 10 pairs scored");
    // Flag sentences come from FLAG_TEXT via buildLimitations; the skill returns its method bullets only.
    expect(peerLandscapeSkill.limitations(result.flags)).toEqual([...SKILL_LIMITATIONS.peer_landscape]);
  });

  it("returns a partial map when the budget runs out mid-matrix", async () => {
    const run = setup(ISLAND_WORLD, { budget: 3 });
    const result = await peerLandscapeSkill.run(input({ k: 5 }), run.ctx);
    expect(run.calls).toHaveLength(3);
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    const d = matrixDataset(run);
    expect(cell(d, "R2", "R3")).toEqual({ value: null, reason: "budget_truncated", rank: null });
    expect(cell(d, "R1", "R3")?.value).toBe(0.22);
    expect(run.ledger.evidences[1]?.status).toBe("partial");
    expect(peerLandscapeSkill.limitations(result.flags)).toEqual(peerLandscapeSkill.limitations([]));
  });

  it("reports nothing that compares rows on a map the budget cut short", async () => {
    // Only the target's row is scored: every other row has one cell, which would rank first and last.
    const run = setup(ISLAND_WORLD, { budget: 3 });
    const result = await peerLandscapeSkill.run(input({ k: 5 }), run.ctx);

    expect(run.ledger.metrics.filter((m) => m.badge === "DERIVED")).toEqual([]);
    const byKey = (key: string) => run.ledger.metrics.filter((m) => m.key === key);
    expect(byKey("subs.hub")).toHaveLength(1);
    for (const m of [...byKey("subs.hub"), ...byKey("subs.distinctiveness"), ...byKey("subs.taste_island")]) {
      expect(m).toMatchObject({ value: null, reason: "budget_truncated", badge: "UNAVAILABLE", display: "not measured", conf: null });
    }
    const [nearest] = byKey("subs.similarity");
    expect(nearest).toMatchObject({ badge: "MEASURED", value: 0.3, subjectRefs: ["R1", "R5"] });
    // The target's own row came from one call, so every peer's similarity to it stays citable.
    expect(byKey("subs.similarity").map((m) => m.subjectRefs[1])).toEqual(["R5", "R3", "R2", "R4"]);
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["OUTSIDE_CATEGORY_NEIGHBOUR"]);

    const d = matrixDataset(run);
    expect(d.payload.margin?.values.every((v) => v.value === null && v.reason === "budget_truncated")).toBe(true);
    expect(d.payload.annotations).toEqual([]);
    for (const row of result.forModel.top_rows) {
      expect(row.values).not.toHaveProperty("hub_metric");
    }
    expect(result.forModel.top_rows[1]).toMatchObject({ ref: "R5", values: { rank_to_target: 1, similarity_metric: nearest?.id } });
    expect(result.forModel.notices.some((n) => n.includes("cut the map short (6 of 10 pairs not called)"))).toBe(true);
  });

  it("gives tied cells the best rank as their glyph, so a three-way tie for first shows 1, 1, 1", async () => {
    const world: World = {
      sims: sims([
        [ALPHA, BETA, 0.5],
        [ALPHA, GAMMA, 0.5],
        [ALPHA, DELTA, 0.5],
        [ALPHA, EPSILON, 0.2],
        [BETA, GAMMA, 0.6],
        [BETA, DELTA, 0.4],
        [BETA, EPSILON, 0.3],
        [GAMMA, DELTA, 0.35],
        [GAMMA, EPSILON, 0.25],
        [DELTA, EPSILON, 0.45],
      ]),
      sameCategory: [],
      crossCategory: [],
    };
    const run = setup(world, { registered: [ALPHA, BETA, GAMMA, DELTA, EPSILON] });
    const result = await peerLandscapeSkill.run(input({ peers: ["R2", "R3", "R4", "R5"], discover: false, k: 5 }), run.ctx);
    const d = matrixDataset(run);
    expect(["R2", "R3", "R4", "R5"].map((c) => cell(d, "R1", c)?.rank)).toEqual([1, 1, 1, 4]);
    expect(["R1", "R3", "R4", "R5"].map((c) => cell(d, "R2", c)?.rank)).toEqual([2, 1, 3, 4]);
    // The digest reads the same ranks as the grid.
    expect(result.forModel.top_rows.slice(1).map((r) => [r.ref, r.values.rank_to_target])).toEqual([
      ["R2", 1],
      ["R3", 1],
      ["R4", 1],
      ["R5", 4],
    ]);
  });

  it("returns a partial result with no map when the budget runs out before scoring", async () => {
    const run = setup(ISLAND_WORLD, { budget: 1 });
    const result = await peerLandscapeSkill.run(input({ k: 5 }), run.ctx);
    expect(result.status).toBe("partial");
    expect(result.flags).toContain("BUDGET_TRUNCATED");
    expect(run.ledger.datasets).toHaveLength(0);
    expect(run.ledger.findings.some((f) => f.kind === "EMPTY_RESULT")).toBe(false);
  });
});

describe("peer_landscape: metrics, findings and digest", () => {
  it("finds the taste island, the near-substitutes and the outside-category neighbour", async () => {
    const run = setup(ISLAND_WORLD);
    const result = await peerLandscapeSkill.run(input({ k: 5 }), run.ctx);
    expect(result.status).toBe("ok");

    const kinds = run.ledger.findings.map((f) => f.kind);
    expect(kinds).toEqual(["TASTE_ISLAND", "NEAR_SUBSTITUTES", "OUTSIDE_CATEGORY_NEIGHBOUR"]);
    const [island, near, outside] = run.ledger.findings;
    expect(island?.text).toBe("Brand Alpha last in 4 of 4 rows.");
    expect(near?.text).toBe("Brand Beta and Brand Gamma are near-substitutes.");
    // Omega holds the reserved slot, so the pivot is a map of its own rather than "add it to the map".
    expect(outside?.suggestion).toEqual({
      tool: "peer_landscape",
      reason: "Map Snack Omega's own peers, with Snack Omega as the target.",
    });

    const byKey = (key: string) => run.ledger.metrics.filter((m) => m.key === key);
    const [distinct] = byKey("subs.distinctiveness");
    expect(distinct).toMatchObject({ badge: "DERIVED", formulaId: "subs.distinctiveness", display: "1 of 5", n: 5, conf: 0.5 });
    expect(distinct?.value).toBeCloseTo(0.7);
    const [nearest] = byKey("subs.similarity");
    expect(nearest).toMatchObject({ badge: "MEASURED", value: 0.3, display: "0.30", subjectRefs: ["R1", "R5"] });
    expect(byKey("subs.taste_island")[0]).toMatchObject({ value: 1, display: "last in 4 of 4 rows · taste island" });
    expect(byKey("subs.near_substitutes")[0]).toMatchObject({ value: 0.9, subjectRefs: ["R2", "R3"], badge: "MEASURED" });
    expect(byKey("subs.hub").length).toBeGreaterThanOrEqual(1);
    // Target distinctiveness, hub and taste island, two pairs at most, then a similarity and a hub per peer.
    expect(run.ledger.metrics.length).toBeLessThanOrEqual(3 + 2 + 2 * 4);
    expect(run.ledger.metrics.every((m) => m.evidenceIds.length === 1 && m.evidenceIds[0] === "E2")).toBe(true);

    expect(island?.metricIds).toEqual([byKey("subs.taste_island")[0]?.id, distinct?.id]);
    expect(near?.metricIds).toEqual([byKey("subs.near_substitutes")[0]?.id]);
    expect(outside?.metricIds).toEqual([nearest?.id]);

    const d = matrixDataset(run);
    expect(d.payload.annotations.map((a) => a.text)).toEqual([
      "Taste island: last in 4/4 rows",
      "Near-substitutes: Brand Beta and Brand Gamma",
    ]);
  });

  it("builds a digest that fits, names refs, and never shows Qloo ids", async () => {
    const run = setup(ISLAND_WORLD);
    const result = await peerLandscapeSkill.run(input({ k: 5 }), run.ctx);
    const digest = ModelDigest.parse(result.forModel);
    expect(digestFits(digest, { tool: "peer_landscape", step: "S2" })).toBe(true);
    expect(digest.top_rows.length).toBeLessThanOrEqual(12);
    expect(digest.top_rows[0]).toMatchObject({ ref: "R1", name: "Brand Alpha", values: { role: "target" } });
    const nearest = run.ledger.metrics.find((m) => m.key === "subs.similarity");
    expect(digest.top_rows[1]).toMatchObject({
      ref: "R5",
      name: "Snack Omega",
      values: { role: "outside_category", rank_to_target: 1, similarity_metric: nearest?.id, in_category: "no" },
    });
    expect(digest.evidence_ids).toEqual(["E1", "E2"]);
    // The Substitution Map, then the Category Taste Map drawn from the same calls.
    expect(digest.dataset_ids).toEqual(["D1", "D2"]);
    expect(run.ledger.datasets.map((d) => d.kind)).toEqual(["Matrix", "TasteMap"]);
    expect(digest.metrics.map((m) => m.id)).toEqual(result.metricIds);
    expect(digest.findings.map((f) => f.id)).toEqual(result.findingIds);
    const text = JSON.stringify(digest);
    expect(text).not.toContain("ent-");
    expect(text).not.toMatch(/poach|switch|steal/i);
  });

  it("gives every map member a citable similarity and hub score, and points its row at them", async () => {
    // Brand Delta is named, last in the target's row, and neither its nearest peer nor the top hub.
    const run = setup(ISLAND_WORLD, { registered: [ALPHA, DELTA] });
    const result = await peerLandscapeSkill.run(input({ peers: ["R2"], k: 4 }), run.ctx);
    const metric = (id: unknown) => run.ledger.metrics.find((m) => m.id === id);

    const delta = result.forModel.top_rows.find((r) => r.ref === "R2");
    expect(delta?.values).toMatchObject({ role: "named", rank_to_target: 3 });
    expect(metric(delta?.values.similarity_metric)).toMatchObject({
      key: "subs.similarity",
      label: "similarity Brand Alpha–Brand Delta",
      subjectRefs: ["R1", "R2"],
      value: 0.18,
      display: "0.18",
      badge: "MEASURED",
    });
    expect(metric(delta?.values.hub_metric)).toMatchObject({
      key: "subs.hub",
      label: "hub score of Brand Delta",
      subjectRefs: ["R2"],
      display: "0.50 · rank 3 of 4",
      badge: "DERIVED",
    });

    // Every row names metrics the digest carries, and no row repeats a decimal the model cannot cite.
    const inDigest = new Set<unknown>(result.forModel.metrics.map((m) => m.id));
    for (const row of result.forModel.top_rows) {
      const named = row.ref === "R1" ? [row.values.hub_metric] : [row.values.similarity_metric, row.values.hub_metric];
      for (const id of named) expect(inDigest.has(id), `${row.ref}: ${String(id)}`).toBe(true);
      for (const v of Object.values(row.values)) if (typeof v === "number") expect(Number.isInteger(v)).toBe(true);
    }
    expect(metric(result.forModel.top_rows[0]?.values.hub_metric)?.label).toContain("hub score of Brand Alpha");
    expect(run.ledger.metrics.filter((m) => m.label.includes("most central")).map((m) => m.subjectRefs)).toEqual([["R3"]]);
    // The first similarity in the ledger stays the nearest peer: the brand_health KPI strip reads it.
    expect(run.ledger.metrics.find((m) => m.key === "subs.similarity")?.label).toContain("(nearest peer)");
  });

  it("measures no hub for a member scored in too few rows, so it cannot read as the most central brand", async () => {
    // Snack Omega is the target's closest match but ties at the floor with every other peer. Read off
    // that one row, its hub would be 1.00 and rank first.
    const world: World = {
      sims: sims([
        [ALPHA, BETA, 0.3],
        [ALPHA, GAMMA, 0.25],
        [ALPHA, DELTA, 0.2],
        [ALPHA, EPSILON, 0.15],
        [ALPHA, OMEGA, 0.5],
        [BETA, GAMMA, 0.6],
        [BETA, DELTA, 0.55],
        [BETA, EPSILON, 0.4],
        [GAMMA, DELTA, 0.45],
        [GAMMA, EPSILON, 0.35],
        [DELTA, EPSILON, 0.5],
        [BETA, OMEGA, 0.05],
        [GAMMA, OMEGA, 0.05],
        [DELTA, OMEGA, 0.05],
        [EPSILON, OMEGA, 0.05],
      ]),
      sameCategory: [],
      crossCategory: [],
    };
    const run = setup(world, { registered: [ALPHA, BETA, GAMMA, DELTA, EPSILON, OMEGA] });
    const result = await peerLandscapeSkill.run(input({ peers: ["R2", "R3", "R4", "R5", "R6"], discover: false, k: 6 }), run.ctx);
    expect(result.status).toBe("ok");

    const hubs = run.ledger.metrics.filter((m) => m.key === "subs.hub");
    expect(hubs.some((m) => m.subjectRefs.includes("R6"))).toBe(false);
    expect(hubs.filter((m) => m.label.includes("most central")).map((m) => m.subjectRefs)).toEqual([["R2"]]);
    expect(result.forModel.top_rows.find((r) => r.ref === "R6")?.values).toMatchObject({ rank_to_target: 1, hub_metric: null });
    const d = matrixDataset(run);
    const omega = d.payload.rows.findIndex((r) => r.key === "R6");
    expect(d.payload.margin?.values[omega]).toEqual({ value: null, reason: "insufficient_n" });
  });

  it("strips hidden and reordering characters from Qloo names in labels, rows, findings and the grid", async () => {
    const spoofed: Invented = { ...BETA, name: "Brand\u202e Beta\u200b\u2066" };
    const run = setup(ISLAND_WORLD, { registered: [ALPHA, spoofed, GAMMA, DELTA] });
    const result = await peerLandscapeSkill.run(input({ peers: ["R2", "R3", "R4"], discover: false, k: 4 }), run.ctx);
    const hidden = /[\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/;

    expect(JSON.stringify(result.forModel)).not.toMatch(hidden);
    for (const m of run.ledger.metrics) expect(m.label).not.toMatch(hidden);
    for (const f of run.ledger.findings) expect(f.text).not.toMatch(hidden);
    expect(run.ledger.metrics.some((m) => m.label === "similarity Brand Alpha–Brand Beta")).toBe(true);
    expect(matrixDataset(run).payload.rows.find((r) => r.key === "R2")?.label).toBe("Brand Beta");
  });

  it("keeps a large map with long names within the digest budget", async () => {
    const long = (e: Invented): Invented => ({ ...e, name: `${e.name} ${"Extended Heritage Trading ".repeat(4)}`.trim() });
    const brands = [ALPHA, BETA, GAMMA, DELTA, EPSILON, ZETA, OMEGA].map(long);
    const entries: [Invented, Invented, number][] = [];
    brands.forEach((a, i) => brands.slice(i + 1).forEach((b, j) => entries.push([a, b, 0.1 + 0.01 * (i * 7 + j)])));
    const world: World = { sims: sims(entries), sameCategory: brands.slice(1, 6), crossCategory: [brands[6]!] };
    const registry = new FakeRegistry();
    registerInvented(registry, brands[0]!);
    const qloo = fakeQloo({ insights: worldInsights(world) });
    const run = fakeRun(qloo.api, registry);
    const result = await peerLandscapeSkill.run(input({ k: 7 }), run.ctx);
    expect(qloo.calls).toHaveLength(2 + 6);
    expect(digestFits(result.forModel, { tool: "peer_landscape", step: "S2" })).toBe(true);
    // Names are cut for the model; the dataset keeps them whole.
    expect(result.forModel.top_rows.every((r) => r.name.length <= NAME_MAX)).toBe(true);
    expect(run.ledger.datasets[0]?.kind === "Matrix" && run.ledger.datasets[0].payload.rows[0]!.label.length > NAME_MAX).toBe(true);
    const kept = result.forModel.top_rows.length;
    expect(kept).toBeGreaterThanOrEqual(5);
    if (kept < 7) expect(result.forModel.notices[0]).toBe(`${7 - kept} of 7 rows left out to fit this result; the full table is in D1.`);
  });

  it("passes the neighbour's category name through the untrusted-text filter", () => {
    const run = fakeRun(fakeQloo().api);
    const members: MapMembers = { entities: [registerInvented(run.registry, ALPHA)], sources: [null], categoryTagId: CAT_BEVERAGE };
    const subsRun: SubsRun = { ctx: run.ctx, flags: new Set(), evidenceIds: [], metrics: [], findings: [], datasetIds: [], registered: [], notices: [] };
    const neighbour = registerInvented(run.registry, OMEGA);
    const tagged = { ...neighbour, tags: [{ tagId: CAT_SNACK, name: "snack\u0007 see https://example.test/x", type: "urn:tag:genre" }] };
    addOutsideFinding(subsRun, members, { entity: tagged, index: null }, []);
    expect(run.ledger.findings[0]?.text).toBe("Snack Omega (snack see [link]) is outside Brand Alpha's category.");
  });

  it("answers a non-brand target with an error and no calls", async () => {
    const run = setup(ISLAND_WORLD, { registered: [ARTIST_NOVA] });
    const result = await peerLandscapeSkill.run(input({}), run.ctx);
    expect(result.status).toBe("error");
    expect(result.forModel.notices[0]).toContain("brands only");
    expect(run.calls).toHaveLength(0);
    expect(run.ledger.evidences).toHaveLength(0);
  });

  it("answers an unknown target with an error and no calls", async () => {
    const run = setup(ISLAND_WORLD);
    const result = await peerLandscapeSkill.run(input({ target: "R9" }), run.ctx);
    expect(result.status).toBe("error");
    expect(run.calls).toHaveLength(0);
  });
});

describe("peer_landscape: failed scoring calls", () => {
  /** What the Qloo client throws once its own retries are spent. */
  const unavailable = () => Object.assign(new Error("Qloo answered HTTP 503 after 3 attempts"), { code: "qloo_unavailable" });

  /** The world's Qloo, except that scoring calls signalled by the `failing` entities reject with `error`. */
  function failingSetup(world: World, failing: Invented[], options: { registered?: Invented[]; error?: () => unknown } = {}) {
    const registry = new FakeRegistry();
    for (const e of options.registered ?? [ALPHA]) registerInvented(registry, e);
    const qloo = fakeQloo({ insights: worldInsights(world) });
    const failingIds = failing.map((e) => e.id);
    const api: QlooApi = {
      ...qloo.api,
      insights: (filterType, params) => {
        const scoring = params["filter.results.entities"] !== undefined;
        const signal = ids(params["signal.interests.entities"])[0] ?? "";
        return scoring && failingIds.includes(signal) ? Promise.reject((options.error ?? unavailable)()) : qloo.api.insights(filterType, params);
      },
    };
    return { ...fakeRun(api, registry), calls: qloo.calls };
  }

  it("keeps the discovery evidence and returns a partial map when one scoring call fails", async () => {
    const run = failingSetup(ISLAND_WORLD, [GAMMA]);
    const result = await peerLandscapeSkill.run(input({ k: 5 }), run.ctx);

    expect(result.status).toBe("partial");
    expect(result.evidenceIds).toEqual(["E1", "E2"]);
    expect(run.ledger.evidences.map((e) => e.status)).toEqual(["ok", "partial"]);
    expect(run.ledger.evidences[1]?.summary).toContain("8 of 10 pairs scored (2 lost to failed calls)");
    expect(result.flags).toContain("CANDIDATES_UNSCORED");
    expect(result.flags).not.toContain("BUDGET_TRUNCATED");
    expect(result.forModel.notices).toContain("1 of 4 scoring calls failed (qloo_unavailable); the pairs they score are not measured.");
    expect(result.forModel.notices.some((n) => n.startsWith("Failed calls cut the map short (2 of 10 pairs lost to failed calls)"))).toBe(true);

    const d = matrixDataset(run);
    expect(cell(d, "R3", "R4")).toEqual({ value: null, reason: "error", rank: null });
    expect(cell(d, "R5", "R3")).toEqual({ value: null, reason: "error", rank: null });
    expect(d.payload.margin?.values.every((v) => v.value === null && v.reason === "error")).toBe(true);
    // Results that compare rows are not measured, with the failure as the reason.
    expect(run.ledger.metrics.filter((m) => m.badge === "DERIVED")).toEqual([]);
    for (const key of ["subs.distinctiveness", "subs.hub", "subs.taste_island"]) {
      expect(run.ledger.metrics.find((m) => m.key === key)).toMatchObject({ value: null, reason: "error", badge: "UNAVAILABLE" });
    }
    expect(run.ledger.findings.map((f) => f.kind)).toEqual(["OUTSIDE_CATEGORY_NEIGHBOUR"]);
  });

  it("returns the discovery evidence without a map when every scoring call fails", async () => {
    const run = failingSetup(ISLAND_WORLD, [ALPHA, BETA, GAMMA, DELTA]);
    const result = await peerLandscapeSkill.run(input({ k: 5 }), run.ctx);

    expect(result.status).toBe("partial");
    expect(result.evidenceIds).toEqual(["E1"]);
    expect(run.ledger.evidences.map((e) => e.status)).toEqual(["ok"]);
    expect(run.ledger.datasets).toHaveLength(0);
    expect(result.forModel.notices).toContain("4 of 4 scoring calls failed (qloo_unavailable); the pairs they score are not measured.");
    expect(result.forModel.registered.map((r) => r.ref)).toEqual(["R2", "R3", "R4", "R5"]);
    expect(run.ledger.findings.some((f) => f.kind === "EMPTY_RESULT")).toBe(false);
  });

  it("still fails when it has recorded nothing, for an error that is not Qloo's, and once the run has stopped", async () => {
    const named = { registered: [ALPHA, BETA, GAMMA, DELTA] };
    const noDiscovery = failingSetup(ISLAND_WORLD, [ALPHA, BETA, GAMMA], named);
    await expect(peerLandscapeSkill.run(input({ peers: ["R2", "R3", "R4"], discover: false, k: 4 }), noDiscovery.ctx)).rejects.toThrow(
      "HTTP 503",
    );
    expect(noDiscovery.ledger.evidences).toHaveLength(0);

    const bug = failingSetup(ISLAND_WORLD, [GAMMA], { error: () => new TypeError("cannot read the response") });
    await expect(peerLandscapeSkill.run(input({ k: 5 }), bug.ctx)).rejects.toThrow(TypeError);

    const stopped = failingSetup(ISLAND_WORLD, [GAMMA]);
    const controller = new AbortController();
    controller.abort();
    await expect(peerLandscapeSkill.run(input({ k: 5 }), { ...stopped.ctx, signal: controller.signal })).rejects.toThrow("HTTP 503");
  });
});

describe("peer_landscape: estimateCalls", () => {
  it("is the upper bound without the registry", async () => {
    const probe = fakeProbe(() => true);
    expect(await estimatePeerLandscapeCalls(input({ k: 6 }), probe, null)).toBe(7);
    expect(await estimatePeerLandscapeCalls(input({ peers: ["R2", "R3", "R4"], discover: false, k: 6 }), probe, null)).toBe(3);
    expect(probe.asked).toHaveLength(0);
  });

  it("counts cached discovery calls as free and the unknown matrix at k−1", async () => {
    const registry = new FakeRegistry();
    registerInvented(registry, ALPHA);
    const probe = fakeProbe((path, params) => path === "/v2/insights" && params["filter.tags"] === undefined);
    expect(await estimatePeerLandscapeCalls(input({ k: 6 }), probe, registry)).toBe(1 + 5);
    expect(probe.asked.every((a) => a.params["filter.type"] === "urn:entity:brand")).toBe(true);
  });

  it("probes a matrix it already knows", async () => {
    const registry = new FakeRegistry();
    for (const e of [ALPHA, BETA, GAMMA, DELTA]) registerInvented(registry, e);
    const firstRow = triangularCalls([ALPHA.id, BETA.id, GAMMA.id, DELTA.id])[0]!.params;
    const probe = fakeProbe((_, params) => JSON.stringify(params["filter.results.entities"]) === JSON.stringify(firstRow["filter.results.entities"]));
    const known = input({ peers: ["R2", "R3", "R4"], discover: false, k: 4 });
    expect(await estimatePeerLandscapeCalls(known, probe, registry)).toBe(2);
    expect(await peerLandscapeSkill.estimateCalls(known, probe, registry)).toBe(2);
    expect(await estimatePeerLandscapeCalls(known, probe, null)).toBe(3);
  });

  it("costs nothing for a target the run cannot map", async () => {
    const registry = new FakeRegistry();
    registerInvented(registry, ARTIST_NOVA, "artist");
    expect(await estimatePeerLandscapeCalls(input({}), fakeProbe(() => false), registry)).toBe(0);
  });
});
