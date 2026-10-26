// The pair split (share.pair_split) and the generic rank shift between contexts (rank.shift), end to
// end through share_of_taste and rank_candidates. Invented entities and locality ids only (D29).
import { BarsPayload, digestFits, type LocalityApi, type QlooEntity, type QlooParams, type SkillCtx } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { rankCandidatesSkill } from "../../src/skills/rankCandidates";
import { shareOfTasteSkill } from "../../src/skills/shareOfTaste";
import { fakeQloo, fakeRun, FakeRegistry, insightEntity, registerInvented, type Invented } from "./support/fakes";
import { ALPHA, BETA, DELTA, GAMMA } from "./support/world";

const list = (v: QlooParams[string] | undefined): string[] => (v === undefined ? [] : typeof v === "object" ? [...v] : [String(v)]);

/**
 * Alpha's share of the pair: 0.6 at ≤24, 0.4 at 55+, about 0.51 in Nashville; Gamma rides along in
 * RANK only, and Delta is a fourth candidate that 35–44 drops.
 */
const SCORES: Record<string, Record<string, number>> = {
  "24_and_younger": { [ALPHA.id]: 0.6, [BETA.id]: 0.4, [GAMMA.id]: 0.3, [DELTA.id]: 0.65 },
  "55_and_older": { [ALPHA.id]: 0.34, [BETA.id]: 0.51, [GAMMA.id]: 0.7, [DELTA.id]: 0.2 },
  "35_to_44": { [ALPHA.id]: 0.5, [BETA.id]: 0.45, [GAMMA.id]: 0.4 },
  "loc-nashville": { [ALPHA.id]: 0.52, [BETA.id]: 0.5, [GAMMA.id]: 0.45, [DELTA.id]: 0.44 },
};

function insights(params: QlooParams): QlooEntity[] {
  const key = String(params["signal.demographics.age"] ?? params["signal.location"] ?? "");
  const row = SCORES[key] ?? {};
  const known = [ALPHA, BETA, GAMMA, DELTA];
  return list(params["filter.results.entities"])
    .filter((id) => row[id] !== undefined)
    .map((id) => insightEntity(known.find((e) => e.id === id)!, row[id]));
}

const LOCALITIES: LocalityApi = { market: async (m) => (m === "nashville" ? { entityId: "loc-nashville", label: "Nashville" } : null) };

function setup() {
  const registry = new FakeRegistry();
  for (const e of [ALPHA, BETA, GAMMA, DELTA]) registerInvented(registry, e);
  const run = fakeRun(fakeQloo({ insights }).api, registry);
  const ctx: SkillCtx = Object.assign(run.ctx, { localities: LOCALITIES });
  return { ...run, ctx };
}

describe("pair split and rank shift", () => {
  it("publishes the who-wins-where split for a pair as split Bars", async () => {
    const run = setup();
    const input = shareOfTasteSkill.input.parse({
      type: "brand",
      set: ["R1", "R2"],
      ages: ["24_and_younger", "55_and_older"],
      audiences: [],
      metros: ["nashville"],
      trigger_finding_id: null,
      step_id: null,
    });
    const result = await shareOfTasteSkill.run(input, run.ctx);
    expect(result.datasetIds).toEqual(["D1", "D2"]);
    const bars = run.ledger.datasets[1];
    if (bars?.kind !== "Bars") throw new Error("expected a Bars dataset");
    expect(bars.title).toBe("Who wins where · Brand Alpha vs Brand Beta");
    expect(bars.formulaIds).toEqual(["share.pair_split", "share.pct"]);
    expect(bars.evidenceIds).toEqual(["E1", "E2"]);
    expect(BarsPayload.parse(bars.payload)).toMatchObject({ display: "split", baseline: 0.5, evenBand: 0.02 });
    expect(bars.payload.series.map((s) => s.label)).toEqual(["Brand Alpha", "Brand Beta"]);
    const values = bars.payload.groups.flatMap((g) => g.bars.map((b) => [b.label, b.values[0]?.value, b.values[1]?.value]));
    expect(values).toEqual([
      ["≤24", expect.closeTo(0.6), expect.closeTo(0.4)],
      ["55+", expect.closeTo(0.34 / 0.85), expect.closeTo(0.51 / 0.85)],
      ["Nashville", expect.closeTo(0.52 / 1.02), expect.closeTo(0.5 / 1.02)],
    ]);
  });

  it("records the rank shift between the last and first contexts of a slope", async () => {
    const run = setup();
    const input = rankCandidatesSkill.input.parse({
      type: "brand",
      candidates: ["R1", "R2", "R3"],
      signal_entities: [],
      signal_tags: [],
      contexts: [
        { kind: "age", age: "24_and_younger" },
        { kind: "age", age: "55_and_older" },
      ],
      trigger_finding_id: null,
      step_id: null,
    });
    const result = await rankCandidatesSkill.run(input, run.ctx);
    const shifts = run.ledger.metrics.filter((m) => m.formulaId === "rank.shift");
    expect(shifts.map((m) => [m.subjectRefs[0], m.value, m.display])).toEqual([
      ["R1", -1, "-1.00 · 1 of 3 → 3 of 3, among the 3 ranked in every context"],
      ["R3", 1, "+1.00 · 3 of 3 → 1 of 3, among the 3 ranked in every context"],
      ["R2", 0, "0.00 · 2 of 3 → 2 of 3, among the 3 ranked in every context"],
    ]);
    expect(shifts[0]).toMatchObject({ key: "rank.shift", label: "rank shift of Brand Alpha, 55+ vs ≤24", unit: "delta", badge: "DERIVED" });
    expect(run.ledger.datasets[0]?.formulaIds).toEqual(["pct.within_call", "rank.shift"]);
    expect(result.forModel.top_rows[0]?.values.shift_metric).toBe(shifts[0]?.id);
  });

  it("takes the rank shift among the candidates both ends ranked, and none for one an end dropped", async () => {
    const run = setup();
    const input = rankCandidatesSkill.input.parse({
      type: "brand",
      candidates: ["R1", "R2", "R3", "R4"],
      signal_entities: [],
      signal_tags: [],
      contexts: [
        { kind: "age", age: "35_to_44" },
        { kind: "age", age: "24_and_younger" },
      ],
      trigger_finding_id: null,
      step_id: null,
    });
    await rankCandidatesSkill.run(input, run.ctx);
    const shifts = run.ledger.metrics.filter((m) => m.formulaId === "rank.shift");
    // Alpha > Beta > Gamma in both; Delta, first at ≤24, has no 35–44 rank and so no shift.
    expect(shifts.map((m) => [m.subjectRefs[0], m.value, m.reason])).toEqual([
      ["R1", 0, null],
      ["R4", null, "dropped"],
      ["R2", 0, null],
      ["R3", 0, null],
    ]);
    expect(shifts[0]?.display).toBe("0.00 · 1 of 3 → 1 of 3, among the 3 ranked in every context");
    const slope = run.ledger.datasets[0];
    if (slope?.kind !== "Slope") throw new Error("expected a Slope dataset");
    expect(slope.payload.lines.map((l) => l.delta)).toEqual([0, 0, 0, null]);
  });

  it("keeps fifty candidates over three contexts within the digest budget with the shifts published", async () => {
    const many: Invented[] = Array.from({ length: 50 }, (_, i) => ({
      id: `ent-cand-${String(i).padStart(2, "0")}`,
      name: `Brand Candidate ${i} Heritage Trading Company Limited Extended`,
      category: null,
    }));
    const ages = ["24_and_younger", "35_to_44", "55_and_older"] as const;
    const registry = new FakeRegistry();
    for (const e of many) registerInvented(registry, e);
    const score = (id: string, k: number) => 0.05 + ((Number(id.slice(-2)) * 7 + k * 13) % 50) / 60;
    const qloo = fakeQloo({
      insights: (params) =>
        list(params["filter.results.entities"]).map((id) =>
          insightEntity(many.find((e) => e.id === id)!, score(id, ages.indexOf(String(params["signal.demographics.age"]) as (typeof ages)[number]))),
        ),
    });
    const run = fakeRun(qloo.api, registry);
    const input = rankCandidatesSkill.input.parse({
      type: "brand",
      candidates: many.map((_, i) => `R${i + 1}`),
      signal_entities: [],
      signal_tags: [],
      contexts: ages.map((age) => ({ kind: "age", age })),
      trigger_finding_id: null,
      step_id: "S4",
    });
    const result = await rankCandidatesSkill.run(input, run.ctx);
    expect(run.ledger.metrics.filter((m) => m.formulaId === "rank.shift")).toHaveLength(6);
    expect(digestFits(result.forModel, { tool: "rank_candidates", step: "S4" })).toBe(true);
    expect(result.forModel.metrics.map((m) => m.id)).toEqual(run.ledger.metrics.map((m) => m.id));
  });
});
