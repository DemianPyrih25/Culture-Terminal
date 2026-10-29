// The map-city panel a whole-city fingerprint is read against (FORMULAS block.panel_rank).
import type { QlooTagInsightRow } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { compareLists, crossCityRank, isInstitution, panelList, rankBrandRows, rankTagRows } from "../../src/skills/blockDna/fingerprint";
import { panelMetros } from "../../src/skills/blockDna/city";

const tag = (i: number) => `urn:tag:genre:place:invented_${i}`;
const list = (ids: number[]) =>
  rankTagRows(
    ids.map((i, k): QlooTagInsightRow => ({ tag_id: tag(i), name: `t${i}`, subtype: "urn:tag:genre:place", query: { affinity: 0.9 - k * 0.01 } })),
    ["WHAT"],
  );

describe("panelList", () => {
  it("places tags by average rank, a missing rank counting take + 1, and ranks only the top `take`", () => {
    const panel = panelList([list([1, 2, 3]), list([2, 1, 4]), list([2, 3, 1])], 2);
    // Means with take 2 (missing = 3): t2 = 4/3, t1 = 2, t3 = 8/3, t4 = 3.
    expect(panel.ranks.get(tag(2))).toBe(1);
    expect(panel.ranks.get(tag(1))).toBe(2);
    expect(panel.ranks.has(tag(3))).toBe(false);
    expect(panel.unscored.has(tag(3))).toBe(true);
    expect(panel.items.size).toBe(4);
  });

  it("calls a city tag NEW only when no panel city lists it", () => {
    const panel = panelList([list([1, 2]), list([2, 3])], 50);
    const city = list([9, 3, 1]);
    const compared = compareLists(city, panel, 51, 20);
    expect(compared.find((c) => c.item.id === tag(9))?.isNew).toBe(true);
    expect(compared.find((c) => c.item.id === tag(3))?.isNew).toBe(false);
  });

  it("places a city among the panel cities by each city's own rank of a concept tag (CR 5)", () => {
    const own = list([5, 1, 2]);
    const panel = [list([1, 2]), list([2, 1, 5]), list([3, 4]), rankTagRows([], ["WHAT"])];
    // t1: own rank 2; the panel ranks it 1, 2 and missing (3 counts as 51), the empty list is left out.
    expect(crossCityRank(tag(1), own, panel, 50)).toEqual({ position: 2, cities: 4, ownRank: 2, tied: true });
    expect(crossCityRank(tag(5), own, panel, 50)).toEqual({ position: 1, cities: 4, ownRank: 1, tied: false });
    // Not in the city's list: it counts 51 and ranks after every city that holds the tag.
    expect(crossCityRank(tag(3), own, panel, 50)).toEqual({ position: 2, cities: 4, ownRank: null, tied: true });
    // In no list at all: no place.
    expect(crossCityRank(tag(9), own, panel, 50)).toBeNull();
  });

  it("leaves universities and colleges out of brand rankings (Q5)", () => {
    const brand = (id: string, name: string, tagId = "urn:tag:genre:brand:invented_retail") => ({
      entity_id: id,
      name,
      type: "urn:entity:brand",
      popularity: 0.5,
      tags: [{ id: tagId, name: "Tag", type: "urn:tag:genre:brand" }],
      query: { affinity: 0.5 },
    });
    expect(isInstitution(brand("a", "Invented State University"))).toBe(true);
    expect(isInstitution(brand("b", "Lakeside Community College"))).toBe(true);
    expect(isInstitution(brand("c", "Invented Institute", "urn:tag:genre:brand:education"))).toBe(true);
    expect(isInstitution(brand("d", "Corner Roast"))).toBe(false);
    const ranked = rankBrandRows([brand("a", "Invented State University"), brand("d", "Corner Roast")]);
    expect([...ranked.items.keys()]).toEqual(["d"]);
    expect(ranked.institutions).toBe(1);
    expect(ranked.gateDropped).toBe(0);
  });

  it("compares a map city with the 12 others and any other market with all 13", () => {
    expect(panelMetros("austin")).toHaveLength(12);
    expect(panelMetros("austin")).not.toContain("austin");
    expect(panelMetros("portland")).toHaveLength(13);
  });
});
