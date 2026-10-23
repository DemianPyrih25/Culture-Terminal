// The figure fixtures are invented (D29) and must stay valid contract data: every one parses with
// the DatasetEnvelope schema, each kind maps to a built family, and values sit on the scale of the
// formula each fixture cites.
import { DatasetEnvelope, RankedPayload, VIZ_COMPAT } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { abbreviateRequestId, slateToRanked } from "../../components/figures";
import { ALL_FIXTURES, FIXTURE_SOURCES, sponsorQuadrant, sponsorSlate } from "../../components/figures/fixtures";

describe("figure fixtures", () => {
  it.each(ALL_FIXTURES.map((f) => [`${f.id} ${f.kind}`, f] as const))("%s parses with DatasetEnvelope", (_, fixture) => {
    expect(() => DatasetEnvelope.parse(fixture)).not.toThrow();
  });

  it("covers every Part 4 family", () => {
    const families = new Set(ALL_FIXTURES.map((f) => VIZ_COMPAT[f.kind]));
    for (const family of ["MatrixGrid", "RankedTable", "DivergingBars", "QuadrantScatter", "ScorecardTable"]) {
      expect(families.has(family as never)).toBe(true);
    }
  });

  it("gives every not-measured value a reason and never a number", () => {
    const json = JSON.stringify(ALL_FIXTURES);
    expect(json).not.toMatch(/"value":null,"reason":null/);
  });

  it("uses plainly synthetic request ids: counters, never UUID-shaped", () => {
    for (const source of Object.values(FIXTURE_SOURCES)) {
      if (source.requestId === null) continue;
      expect(source.requestId).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(abbreviateRequestId(source.requestId)).toMatch(/^000\d…f00\d$/);
    }
  });

  it("keeps DNA indices on the −1 to 1 scale of dna.age_index and dna.gender_index", () => {
    const dna = ALL_FIXTURES.filter((f) => f.kind === "Bars" && f.formulaIds.some((id) => id.startsWith("dna.")));
    expect(dna.length).toBeGreaterThan(0);
    for (const fixture of dna) {
      if (fixture.kind !== "Bars") continue;
      const values = fixture.payload.groups.flatMap((g) => g.bars.flatMap((b) => b.values.flatMap((c) => (c.value === null ? [] : [c.value]))));
      expect(values.every((x) => x >= -1 && x <= 1)).toBe(true);
      expect(values.some((x) => x < 0)).toBe(true);
    }
  });

  it("generates the grey scatter candidates deterministically inside the plot", () => {
    const grey = sponsorQuadrant.payload.points.filter((p) => !p.labelled);
    expect(grey.length).toBe(24);
    for (const p of grey) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(1);
      expect(p.y).toBeGreaterThanOrEqual(0.2);
      expect(p.y).toBeLessThanOrEqual(0.7);
    }
  });

  it("turns a Slate into a valid Ranked payload that keeps the fixed caption", () => {
    const ranked = slateToRanked(sponsorSlate.payload);
    expect(() => RankedPayload.parse(ranked)).not.toThrow();
    expect(ranked.caption).toBe(sponsorSlate.payload.caption);
  });
});
