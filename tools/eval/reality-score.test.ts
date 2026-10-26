// The Reality Check's arithmetic on invented values: percentiles with ties, deterministic
// popularity matching and its exclusions, and the chance of a comedian GHOST hit.
import { describe, expect, it } from "vitest";
import { caseDraw, DISTRACTORS, hitChance, percentileAmong, popularityMatched, rankAmong } from "./reality-score";

describe("percentileAmong", () => {
  it("is the share of the other scored candidates the choice beats, a tie counting half", () => {
    expect(percentileAmong(9, [1, 2, 3])).toBe(1);
    expect(percentileAmong(0, [1, 2, 3])).toBe(0);
    expect(percentileAmong(2, [1, 2, 3])).toBe(0.5);
    expect(percentileAmong(5, [5, 5, 1, 9])).toBe(0.5);
    expect(percentileAmong(5, [5, 5, 5, 5])).toBe(0.5);
    expect(percentileAmong(4, [1, 4, 6, 2])).toBeCloseTo(2.5 / 4, 12);
  });

  it("is null with no other scored candidate", () => {
    expect(percentileAmong(3, [])).toBeNull();
  });
});

describe("rankAmong", () => {
  it("counts the candidates scored strictly higher, so ties share the better rank", () => {
    expect(rankAmong(9, [1, 2, 3])).toBe(1);
    expect(rankAmong(2, [1, 2, 3])).toBe(2);
    expect(rankAmong(2, [2, 2, 3])).toBe(2);
    expect(rankAmong(0, [1, 2, 3])).toBe(4);
  });
});

const pool = (entries: readonly [string, number | null][]) => entries.map(([key, popularity]) => ({ key, popularity }));

describe("popularityMatched", () => {
  const entries = pool([
    ["far-low", 0.1],
    ["near-a", 0.52],
    ["near-b", 0.47],
    ["near-c", 0.55],
    ["near-d", 0.41],
    ["near-e", 0.6],
    ["far-high", 0.95],
    ["unknown", null],
  ]);

  it("takes the five whose popularity is nearest the choice's, nearest first", () => {
    const picked = popularityMatched("rc01", 0.5, entries, new Set());
    expect(picked.map((e) => e.key)).toEqual(["near-a", "near-b", "near-c", "near-d", "near-e"]);
    expect(picked).toHaveLength(DISTRACTORS);
  });

  it("never takes an excluded entry (the choice, GHOST's picks, the seed) and moves the next one up", () => {
    const picked = popularityMatched("rc01", 0.5, entries, new Set(["near-a", "near-c"]));
    expect(picked.map((e) => e.key)).toEqual(["near-b", "near-d", "near-e", "far-low", "far-high"]);
  });

  it("leaves out entries with no popularity, and an entry listed twice counts once", () => {
    const twice = [...entries, { key: "near-a", popularity: 0.52 }];
    const picked = popularityMatched("rc01", 0.5, twice, new Set(), 10);
    expect(picked.map((e) => e.key)).not.toContain("unknown");
    expect(picked.filter((e) => e.key === "near-a")).toHaveLength(1);
    expect(picked).toHaveLength(7);
  });

  it("orders equal distances by the case's draw: the same case always picks the same, another case may not", () => {
    const tied = pool(Array.from({ length: 12 }, (_, i) => [`tie-${String.fromCharCode(97 + i)}`, 0.5] as [string, number]));
    const picks = (caseId: string) => popularityMatched(caseId, 0.5, tied, new Set()).map((e) => e.key);
    for (const caseId of ["rc01", "rc02", "rc03"]) expect(picks(caseId)).toEqual(picks(caseId));
    const distinct = new Set(["rc01", "rc02", "rc03", "rc04", "rc05", "rc06"].map((c) => picks(c).join(",")));
    expect(distinct.size).toBeGreaterThan(1);
    // The order is the draw's, not the pool's.
    const order = picks("rc01");
    const draws = order.map((key) => caseDraw("rc01", key));
    expect([...draws].sort((a, b) => a - b)).toEqual(draws);
  });

  it("draws from the whole pool, still by case, when the choice has no popularity", () => {
    const picked = popularityMatched("rc02", null, entries, new Set(["far-high"]));
    expect(picked).toHaveLength(DISTRACTORS);
    expect(picked.map((e) => e.key)).not.toContain("far-high");
    expect(popularityMatched("rc02", null, entries, new Set(["far-high"]))).toEqual(picked);
  });

  it("returns what there is when the pool is short", () => {
    expect(popularityMatched("rc01", 0.5, pool([["only", 0.4]]), new Set())).toHaveLength(1);
    expect(popularityMatched("rc01", 0.5, [], new Set())).toEqual([]);
  });
});

describe("hitChance", () => {
  it("is the chance that five random markets include at least one booked one", () => {
    // 1 − C(8,5)/C(22,5): 14 of 22 booked.
    expect(hitChance(22, 14, 5)).toBeCloseTo(1 - 56 / 26_334, 12);
    // 1 − C(12,5)/C(22,5): 10 of 22 booked.
    expect(hitChance(22, 10, 5)).toBeCloseTo(1 - 792 / 26_334, 12);
    expect(hitChance(10, 1, 1)).toBeCloseTo(0.1, 12);
  });

  it("is 0 with nothing booked, 1 when five picks cannot all miss, and null for an empty universe", () => {
    expect(hitChance(22, 0, 5)).toBe(0);
    expect(hitChance(6, 3, 5)).toBe(1);
    expect(hitChance(0, 0, 5)).toBeNull();
  });
});
