// S1 Substitution Map math on invented entities: hand-computed goldens plus planted structures.
import { describe, expect, it } from "vitest";
import { createRng } from "../src/stats";
import { computeSubstitution, HUB_MIN_ROWS, hubMinRows, type SubsInput } from "../src/subs";

type Cell = number | null;

/** A symmetric k×k matrix from an upper-triangle rule; the diagonal is null. */
function symmetric(k: number, upper: (i: number, j: number) => Cell): Cell[][] {
  const m: Cell[][] = Array.from({ length: k }, () => Array.from({ length: k }, (): Cell => null));
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const v = upper(i, j);
      m[i]![j] = v;
      m[j]![i] = v;
    }
  }
  return m;
}

/** A symmetric matrix from a table of "i-j" keys (i < j); missing pairs are unscored. */
function fromPairs(k: number, pairs: Record<string, number>): Cell[][] {
  return symmetric(k, (i, j) => pairs[`${i}-${j}`] ?? null);
}

function refs(k: number): string[] {
  return Array.from({ length: k }, (_, i) => `ent-peer-${String(i + 1).padStart(2, "0")}`);
}

function input(sim: Cell[][], targetIndex: number): SubsInput {
  return { refs: refs(sim.length), targetIndex, sim };
}

describe("computeSubstitution: hand-computed golden (k = 5)", () => {
  // Target 0 sits apart; 2–4 and 1–3 are tight pairs.
  const sim = fromPairs(5, {
    "0-1": 0.3,
    "0-2": 0.2,
    "0-3": 0.35,
    "0-4": 0.25,
    "1-2": 0.5,
    "1-3": 0.85,
    "1-4": 0.55,
    "2-3": 0.45,
    "2-4": 0.9,
    "3-4": 0.4,
  });
  const out = computeSubstitution(input(sim, 0));

  it("ranks each row and converts ranks to within-row percentiles", () => {
    expect(out.rankInRow).toEqual([
      [null, 2, 4, 1, 3],
      [4, null, 3, 1, 2],
      [4, 2, null, 3, 1],
      [4, 1, 2, null, 3],
      [4, 2, 1, 3, null],
    ]);
    expect(out.pctInRow[0]![1]).toBeCloseTo(2 / 3, 12);
    expect(out.pctInRow[0]![2]).toBe(0);
    expect(out.pctInRow[0]![3]).toBe(1);
    expect(out.pctInRow[3]![3]).toBeNull();
  });

  it("computes hub scores as the mean within-row percentile of each column", () => {
    const expected = [0, 0.75, 0.5, 2 / 3, 7 / 12];
    out.hub.forEach((h, j) => expect(h).toBeCloseTo(expected[j]!, 12));
  });

  it("computes distinctiveness and its competition rank", () => {
    const expected = [0.65, 0.15, 0.1, 0.15, 0.1];
    out.distinctiveness.forEach((d, i) => expect(d).toBeCloseTo(expected[i]!, 12));
    expect(out.distinctivenessRank).toEqual([1, 2, 4, 2, 4]);
  });

  it("finds the near-substitute pair above p90 with mutual rank 1", () => {
    expect(out.p90).toBeCloseTo(0.855, 12);
    expect(out.nearSubstitutes).toEqual([[2, 4]]);
  });

  it("flags the target as a taste island and names its nearest peer", () => {
    expect(out.targetScoredRows).toBe(4);
    expect(out.targetLastInRows).toBe(4);
    expect(out.tasteIsland).toBe(true);
    expect(out.targetNearest).toBe(3);
  });

  it("orders the grid by average-linkage clustering", () => {
    // Merges: (2,4) at 0.1, (1,3) at 0.15, {1,3}+{2,4} at 0.525, then the target.
    expect(out.order).toEqual([0, 1, 3, 2, 4]);
  });
});

describe("computeSubstitution: unscored cells", () => {
  // Entity 4 has no scored pair; 0–2 was not scored.
  const sim = fromPairs(5, { "0-1": 0.6, "0-3": 0.4, "1-2": 0.7, "1-3": 0.5, "2-3": 0.3 });
  const out = computeSubstitution(input(sim, 0));

  it("leaves unscored cells out of ranks, hub and distinctiveness", () => {
    expect(out.rankInRow[0]).toEqual([null, 1, null, 2, null]);
    expect(out.rankInRow[4]).toEqual([null, null, null, null, null]);
    expect(out.hub[4]).toBeNull();
    expect(out.distinctiveness[4]).toBeNull();
    expect(out.distinctivenessRank[4]).toBeNull();
    expect(out.hub[2]).toBeCloseTo(0.5, 12);
  });

  it("counts only rows where the target is scored", () => {
    expect(out.targetScoredRows).toBe(2);
    expect(out.targetLastInRows).toBe(0);
    expect(out.tasteIsland).toBe(false);
    expect(out.targetNearest).toBe(1);
  });

  it("joins unscored pairs last and breaks the 0.6 linkage tie by index", () => {
    expect(out.order).toEqual([0, 3, 1, 2, 4]);
  });

  it("measures no hub for a column scored in fewer than half of the other rows", () => {
    // k = 6. Entity 5 is the target's closest match (first in row 0) and unscored in every other row.
    // Read off that single row, its hub would be 1, the most central entity in the map.
    const pairs = {
      "0-1": 0.3,
      "0-2": 0.25,
      "0-3": 0.2,
      "0-4": 0.15,
      "0-5": 0.5,
      "1-2": 0.6,
      "1-3": 0.55,
      "1-4": 0.4,
      "2-3": 0.45,
      "2-4": 0.35,
      "3-4": 0.5,
    };
    const hub = computeSubstitution(input(fromPairs(6, pairs), 0)).hub;
    expect(hub[5]).toBeNull();
    expect(hub.slice(0, 5).every((h) => h !== null && h < 1)).toBe(true);
    // Scored in a third row it reaches the minimum of 3 and is measured again.
    expect(computeSubstitution(input(fromPairs(6, { ...pairs, "1-5": 0.2, "2-5": 0.2 }), 0)).hub[5]).not.toBeNull();
  });

  it("asks for half of the other rows, and at least two, before it measures a hub", () => {
    expect([3, 4, 5, 6, 7].map(hubMinRows)).toEqual([2, 2, 2, 3, 3]);
    expect(HUB_MIN_ROWS).toBe(2);
  });

  it("accepts either triangle and mirrors it", () => {
    const upperOnly = sim.map((row, i) => row.map((v, j) => (j > i ? v : null)));
    const lowerOnly = sim.map((row, i) => row.map((v, j) => (j < i ? v : null)));
    expect(computeSubstitution(input(upperOnly, 0))).toEqual(out);
    expect(computeSubstitution(input(lowerOnly, 0))).toEqual(out);
  });
});

describe("computeSubstitution: planted structures for k = 4..7", () => {
  for (const k of [4, 5, 6, 7]) {
    it(`finds a planted taste island and near-substitute pair at k = ${k}`, () => {
      const rng = createRng(`subs-island-${k}`);
      const sim = symmetric(k, (i, j) => {
        if (i === 1 && j === 2) return 0.97;
        if (i === 0) return 0.05 + 0.1 * rng();
        return 0.45 + 0.4 * rng();
      });
      const out = computeSubstitution(input(sim, 0));
      expect(out.tasteIsland).toBe(true);
      expect(out.targetScoredRows).toBe(k - 1);
      expect(out.targetLastInRows).toBe(k - 1);
      expect(out.nearSubstitutes).toContainEqual([1, 2]);
      expect(out.distinctivenessRank[0]).toBe(1);
      expect(out.hub[0]).toBe(0);
      // The island joins the dendrogram last and, holding the lowest index, leads the order.
      expect(out.order[0]).toBe(0);
      expect([...out.order].sort((a, b) => a - b)).toEqual(Array.from({ length: k }, (_, i) => i));
      const at1 = out.order.indexOf(1);
      const at2 = out.order.indexOf(2);
      expect(Math.abs(at1 - at2)).toBe(1);
    });

    it(`finds no island when the target is the hub at k = ${k}`, () => {
      const rng = createRng(`subs-hub-${k}`);
      const sim = symmetric(k, (i) => (i === 0 ? 0.9 + 0.05 * rng() : 0.3 + 0.4 * rng()));
      const out = computeSubstitution(input(sim, 0));
      expect(out.tasteIsland).toBe(false);
      expect(out.targetLastInRows).toBe(0);
      expect(out.hub[0]).toBe(1);
    });
  }

  it("groups two planted taste clusters together in the display order", () => {
    const groupOf = (i: number): number => i % 2;
    const rng = createRng("subs-blocks");
    const sim = symmetric(6, (i, j) => (groupOf(i) === groupOf(j) ? 0.8 + 0.1 * rng() : 0.1 + 0.1 * rng()));
    const order = computeSubstitution(input(sim, 0)).order;
    expect(new Set(order.slice(0, 3))).toEqual(new Set([0, 2, 4]));
    expect(new Set(order.slice(3))).toEqual(new Set([1, 3, 5]));
  });
});

describe("computeSubstitution: taste island threshold", () => {
  it("is an island when last in exactly 75% of scored rows", () => {
    const sim = fromPairs(5, {
      "0-1": 0.1,
      "0-2": 0.1,
      "0-3": 0.1,
      "0-4": 0.8,
      "1-2": 0.5,
      "1-3": 0.5,
      "1-4": 0.5,
      "2-3": 0.5,
      "2-4": 0.5,
      "3-4": 0.5,
    });
    const out = computeSubstitution(input(sim, 0));
    expect([out.targetLastInRows, out.targetScoredRows, out.tasteIsland]).toEqual([3, 4, true]);
  });

  it("is not an island when last in two of three rows", () => {
    const sim = fromPairs(4, { "0-1": 0.1, "0-2": 0.1, "0-3": 0.9, "1-2": 0.5, "1-3": 0.5, "2-3": 0.5 });
    const out = computeSubstitution(input(sim, 0));
    expect([out.targetLastInRows, out.targetScoredRows, out.tasteIsland]).toEqual([2, 3, false]);
  });

  it("needs at least three scored rows", () => {
    const sim = fromPairs(3, { "0-1": 0.1, "0-2": 0.1, "1-2": 0.5 });
    const out = computeSubstitution(input(sim, 0));
    expect([out.targetLastInRows, out.targetScoredRows, out.tasteIsland]).toEqual([2, 2, false]);
  });

  it("does not count a row whose only scored cell is the target as last", () => {
    const sim = fromPairs(4, { "0-1": 0.2, "0-2": 0.2, "0-3": 0.2, "1-2": 0.6 });
    const out = computeSubstitution(input(sim, 0));
    expect(out.targetScoredRows).toBe(3);
    expect(out.targetLastInRows).toBe(2);
  });
});

describe("computeSubstitution: edge cases", () => {
  it("handles ties: equal similarities give no mutual rank 1, no island and an index order", () => {
    const out = computeSubstitution(input(symmetric(5, () => 0.5), 2));
    expect(out.nearSubstitutes).toEqual([]);
    expect(out.order).toEqual([0, 1, 2, 3, 4]);
    expect(out.rankInRow[0]).toEqual([null, 2.5, 2.5, 2.5, 2.5]);
    expect(out.targetLastInRows).toBe(0);
    expect(out.tasteIsland).toBe(false);
  });

  it("counts a shared last place as last", () => {
    const sim = fromPairs(4, { "0-1": 0.2, "0-2": 0.2, "0-3": 0.2, "1-2": 0.7, "1-3": 0.2, "2-3": 0.6 });
    const out = computeSubstitution(input(sim, 0));
    // Rows 1 and 3 tie the target for last place; row 2 has it strictly last.
    expect(out.rankInRow[1]).toEqual([2.5, null, 1, 2.5]);
    expect(out.targetLastInRows).toBe(3);
    expect(out.tasteIsland).toBe(true);
  });

  it("handles a single entity", () => {
    const out = computeSubstitution({ refs: ["ent-solo-01"], targetIndex: 0, sim: [[null]] });
    expect(out).toMatchObject({
      order: [0],
      hub: [null],
      distinctiveness: [null],
      p90: null,
      nearSubstitutes: [],
      tasteIsland: false,
      targetNearest: null,
    });
  });

  it("ignores the diagonal", () => {
    const sim = fromPairs(3, { "0-1": 0.4, "0-2": 0.6, "1-2": 0.5 });
    const withDiagonal = sim.map((row, i) => row.map((v, j) => (i === j ? 1 : v)));
    expect(computeSubstitution(input(withDiagonal, 0))).toEqual(computeSubstitution(input(sim, 0)));
  });

  it("rejects a bad target index or a matrix that does not match refs", () => {
    const sim = fromPairs(3, { "0-1": 0.4 });
    expect(() => computeSubstitution(input(sim, 3))).toThrow(RangeError);
    expect(() => computeSubstitution(input(sim, -1))).toThrow(RangeError);
    expect(() => computeSubstitution({ refs: refs(4), targetIndex: 0, sim })).toThrow(RangeError);
    expect(() => computeSubstitution({ refs: refs(3), targetIndex: 0, sim: [[null, 1], [1, null], [null, null]] })).toThrow(
      RangeError,
    );
  });
});
