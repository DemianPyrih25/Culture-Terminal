import { describe, expect, it } from "vitest";
import type { QlooTagInsightRow } from "@ct/contracts";
import { isNoiseTag, normaliseTagName } from "../src/tagNoise";
import { rankTagRows } from "../src/skills/blockDna/fingerprint";

// Invented tag ids in Qloo's id shape; no real Qloo values.
const MUSIC = "urn:tag:genre:music";

describe("isNoiseTag (ANSWER_QUALITY §10)", () => {
  it("drops country, state and city names in any family", () => {
    expect(isNoiseTag({ name: "Usa", tagId: `${MUSIC}:usa`, type: MUSIC })).toBe(true);
    expect(isNoiseTag({ name: "austin", tagId: `${MUSIC}:austin`, type: MUSIC })).toBe(true);
    expect(isNoiseTag({ name: "New York", tagId: "urn:tag:genre:place:new_york", type: "urn:tag:genre:place" })).toBe(true);
    expect(isNoiseTag({ name: "Texas", tagId: null, type: null })).toBe(true);
  });

  it("drops nationalities and generic words among music tags only", () => {
    expect(isNoiseTag({ name: "american", tagId: `${MUSIC}:american`, type: MUSIC })).toBe(true);
    expect(isNoiseTag({ name: "Seen-Live", tagId: `${MUSIC}:seen_live`, type: MUSIC })).toBe(true);
    expect(isNoiseTag({ name: "funny", tagId: `${MUSIC}:funny`, type: MUSIC })).toBe(true);
    // The same words are real tags outside music: a cuisine and an ambience.
    expect(isNoiseTag({ name: "American", tagId: "urn:tag:genre:place:restaurant:american", type: "urn:tag:genre:place:restaurant" })).toBe(false);
    expect(isNoiseTag({ name: "Fun", tagId: "urn:tag:ambience:qloo:fun", type: "urn:tag:ambience" })).toBe(false);
  });

  it("keeps genres and names that only contain a place", () => {
    for (const name of ["country", "indie", "Garage Rock", "Stand-up-Comedy", "Latin"]) {
      expect(isNoiseTag({ name, tagId: `${MUSIC}:${normaliseTagName(name).replace(/ /gu, "_")}`, type: MUSIC })).toBe(false);
    }
    expect(isNoiseTag({ name: "New York Style Pizza", tagId: "urn:tag:specialty_dish:place:new_york_style_pizza", type: "urn:tag:specialty_dish:place" })).toBe(false);
  });
});

describe("rankTagRows drops noise tags before ranking", () => {
  const row = (leaf: string, name: string, affinity: number): QlooTagInsightRow =>
    ({ tag_id: `${MUSIC}:${leaf}`, name, subtype: MUSIC, query: { affinity } }) as QlooTagInsightRow;

  it("ranks the remaining tags as if the noise tag were absent", () => {
    const list = rankTagRows([row("usa", "Usa", 0.9), row("indie", "indie", 0.8), row("rock", "rock", 0.7), row("dream_pop", "dream pop", 0.1)], ["SOUND"]);
    expect([...list.items.keys()]).not.toContain(`${MUSIC}:usa`);
    expect(list.ranks.get(`${MUSIC}:indie`)).toBe(1);
    expect(list.ranks.get(`${MUSIC}:rock`)).toBe(2);
    expect(list.rows).toBe(4);
  });
});
