import { CONFIDENCE_PENALTY, Confidence, ConfidenceRule } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { CONFIDENCE_RULE_LABEL, computeConfidence, type ConfidenceInput } from "../src/confidence";

/** One occurrence of each rule, as a single input field. */
const ONE: Readonly<Record<ConfidenceRule, ConfidenceInput>> = {
  dropped_entity: { droppedEntities: 1 },
  code_fallback: { codeFallbacks: 1 },
  coarse_geohash: { coarseGeohash: true },
  stale_momentum: { staleMomentumCited: true },
  thin_result: { thinResults: 1 },
  quality_gate_drop: { qualityGateDrops: 1 },
  checker_warning: { checkerWarnings: 1 },
  insufficient_evidence: { insufficientEvidence: true },
  read_as_nearest_job: { readAsNearestJob: true },
  concept_partly_tagged: { conceptPartlyTagged: true },
};

describe("computeConfidence", () => {
  it("starts at 100 HIGH with an empty breakdown", () => {
    const c = computeConfidence({});
    expect(c).toEqual({ score: 100, band: "HIGH", breakdown: [] });
    expect(Confidence.parse(c)).toEqual(c);
  });

  it.each(ConfidenceRule.options)("subtracts the %s penalty with its label", (rule) => {
    const c = computeConfidence(ONE[rule]);
    expect(c.score).toBe(100 - CONFIDENCE_PENALTY[rule]);
    expect(c.breakdown).toEqual([
      { rule, label: CONFIDENCE_RULE_LABEL[rule], count: 1, points: -CONFIDENCE_PENALTY[rule] },
    ]);
    expect(Confidence.parse(c)).toEqual(c);
  });

  it("multiplies per-occurrence penalties by their count", () => {
    const c = computeConfidence({ droppedEntities: 2, thinResults: 3, qualityGateDrops: 2 });
    expect(c.breakdown.map((l) => [l.rule, l.count, l.points])).toEqual([
      ["dropped_entity", 2, -30],
      ["thin_result", 3, -30],
      ["quality_gate_drop", 2, -10],
    ]);
    expect(c.score).toBe(30);
    expect(c.band).toBe("LOW");
  });

  it("puts a note with fewer than three ok bundles (V7) in the LOW band on its own", () => {
    expect(computeConfidence({ insufficientEvidence: true })).toMatchObject({ score: 40, band: "LOW" });
  });

  it("caps a partly tested concept at MED on its own and counts it once (D2)", () => {
    const c = computeConfidence({ conceptPartlyTagged: true });
    expect(c).toMatchObject({ score: 70, band: "MED" });
    expect(c.breakdown).toEqual([
      { rule: "concept_partly_tagged", label: CONFIDENCE_RULE_LABEL.concept_partly_tagged, count: 1, points: -30 },
    ]);
  });

  it("counts coarse geohash and stale momentum once", () => {
    const c = computeConfidence({ coarseGeohash: true, staleMomentumCited: true });
    expect(c.breakdown.map((l) => l.count)).toEqual([1, 1]);
    expect(c.score).toBe(70);
  });

  it("puts the bands at 75 and 50", () => {
    expect(computeConfidence({ droppedEntities: 1, codeFallbacks: 1 })).toMatchObject({ score: 75, band: "HIGH" });
    expect(computeConfidence({ droppedEntities: 1, codeFallbacks: 1, checkerWarnings: 1 })).toMatchObject({
      score: 70,
      band: "MED",
    });
    expect(computeConfidence({ staleMomentumCited: true, thinResults: 3 })).toMatchObject({ score: 50, band: "MED" });
    expect(computeConfidence({ staleMomentumCited: true, thinResults: 3, checkerWarnings: 1 })).toMatchObject({
      score: 45,
      band: "LOW",
    });
  });

  it("floors the score at 0 but keeps the full points in the breakdown", () => {
    const c = computeConfidence({ droppedEntities: 10 });
    expect(c.score).toBe(0);
    expect(c.band).toBe("LOW");
    expect(c.breakdown[0]?.points).toBe(-150);
    expect(Confidence.parse(c)).toEqual(c);
  });

  it("lists breakdown lines in ConfidenceRule order", () => {
    const all = computeConfidence(Object.assign({}, ...Object.values(ONE)) as ConfidenceInput);
    expect(all.breakdown.map((l) => l.rule)).toEqual(ConfidenceRule.options);
    expect(all.score).toBe(Math.max(0, 100 - Object.values(CONFIDENCE_PENALTY).reduce((a, b) => a + b, 0)));
  });

  it("rejects negative or fractional counts", () => {
    expect(() => computeConfidence({ checkerWarnings: -1 })).toThrow(RangeError);
    expect(() => computeConfidence({ thinResults: 1.5 })).toThrow(/thinResults/);
  });
});

describe("CONFIDENCE_RULE_LABEL", () => {
  it("labels every rule", () => {
    expect(Object.keys(CONFIDENCE_RULE_LABEL).sort()).toEqual([...ConfidenceRule.options].sort());
    for (const label of Object.values(CONFIDENCE_RULE_LABEL)) {
      expect(label.length).toBeGreaterThan(0);
      // Plain business English (Q1): no internal codes such as V7, D41, CODE FALLBACK or EMPTY_RESULT.
      expect(label).not.toMatch(/\b[A-Z]{2,}_[A-Z_]+\b|\b[VD]\d+\b|CODE FALLBACK|CHECKER/);
    }
  });
});
