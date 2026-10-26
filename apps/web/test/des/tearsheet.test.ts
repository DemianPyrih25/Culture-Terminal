// The tearsheet builder on its own: sections that failed, came back empty or were cut by the budget say
// so in a sentence; an entity Qloo gives no popularity shows "not measured", never 0.
import { describe, expect, it, vi } from "vitest";
import type { ModelDigest, SkillResult } from "@ct/contracts";
import type { SheetInput } from "../../server/des/tearsheet";

vi.mock("server-only", () => ({}));

const { buildTearsheet } = await import("../../server/des/tearsheet");
const { curatedEntitiesOf } = await import("../../server/des/curated");

function result(over: Partial<SkillResult> = {}): SkillResult {
  return { forModel: {} as ModelDigest, evidenceIds: [], metricIds: [], datasetIds: [], findingIds: [], flags: [], status: "ok", ...over };
}

function input(over: Partial<SheetInput> = {}): SheetInput {
  return {
    query: { name: "juniper cola", type: "brand" },
    picked: false,
    entity: { name: "Juniper Cola", type: "brand", disambiguation: null },
    computedAt: "2026-10-23T09:00:00.000Z",
    snapshot: { evidence: [], metrics: [], datasets: [], findings: [] },
    calls: [],
    sections: {
      dna: { kind: "failed", skill: "audience_dna", message: "boom" },
      neighbours: { kind: "ran", skill: "cross_domain", result: result({ status: "empty" }) },
      travel: { kind: "ran", skill: "destination_affinity", result: result({ status: "partial", flags: ["BUDGET_TRUNCATED"] }) },
    },
    popularity: null,
    ...over,
  };
}

describe("buildTearsheet", () => {
  it("words a failed, an empty and a budget-cut section, and keeps their method notes", () => {
    const sheet = buildTearsheet(input());
    expect(sheet.sections.dna).toMatchObject({ status: "failed", figures: [], gap: expect.stringMatching(/could not be computed/) });
    expect(sheet.sections.dna.notes[0]).toMatch(/relative affinity indices/);
    expect(sheet.sections.neighbours).toMatchObject({ status: "empty", gap: expect.stringMatching(/no cultural neighbours/) });
    expect(sheet.sections.travel).toMatchObject({ status: "empty", gap: "This part was not requested: the lookup reached its Qloo call budget." });
    expect(sheet.sections.travel.notes[0]).toMatch(/call budget/);
    expect(sheet.keyFigures).toEqual([]);
    expect(sheet.traced).toEqual({ traced: 0, total: 0 });
    expect(sheet.mnemonic).toBe("JUNIPER COLA <BRAND> DES");
  });

  it("prints an unmeasured popularity as not measured", () => {
    const sheet = buildTearsheet(
      input({
        popularity: {
          id: "M1",
          key: "popularity",
          label: "popularity Juniper Cola",
          subjectRefs: ["R1"],
          value: null,
          reason: "not_measured",
          display: "not measured",
          unit: "popularity",
          badge: "UNAVAILABLE",
          formulaId: "popularity",
          evidenceIds: [],
          n: null,
          conf: null,
          comparator: null,
          window: null,
        },
      }),
    );
    expect(sheet.keyFigures).toEqual([
      { key: "M1", label: "Popularity", value: "not measured", kind: "number", detail: expect.stringMatching(/reach score/), badge: "UNAVAILABLE", receipt: null },
    ]);
  });
});

describe("curatedEntitiesOf", () => {
  it("lists the tearsheet types a showcases config names, once each, and skips places", () => {
    const config = {
      showcases: [
        {
          expected: {
            mentions: [
              { text: "Juniper Cola", entity_type: "brand" },
              { text: "East Side", entity_type: "place" },
            ],
          },
          extra_pins: [{ text: "Comedian Vega", entity_type: "person" }],
        },
        { expected: { mentions: [{ text: "juniper cola", entity_type: "brand" }] } },
      ],
    };
    expect(curatedEntitiesOf(config)).toEqual([
      { name: "Juniper Cola", type: "brand" },
      { name: "Comedian Vega", type: "person" },
    ]);
  });
});
