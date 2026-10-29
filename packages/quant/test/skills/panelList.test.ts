// The map-city panel a whole-city fingerprint is read against (FORMULAS block.panel_rank).
import type { QlooTagInsightRow } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { compareLists, panelList, rankTagRows } from "../../src/skills/blockDna/fingerprint";
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

  it("compares a map city with the 12 others and any other market with all 13", () => {
    expect(panelMetros("austin")).toHaveLength(12);
    expect(panelMetros("austin")).not.toContain("austin");
    expect(panelMetros("portland")).toHaveLength(13);
  });
});
