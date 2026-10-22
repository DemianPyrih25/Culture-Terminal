// Hand-computed goldens for the shared statistics (SPEC §5.2).
import { describe, expect, it } from "vitest";
import {
  NORMAL_UPPER_QUARTILE,
  QUALITY_GATE_MIN_POPULARITY,
  averageRanks,
  bootstrap,
  clamp,
  competitionRanks,
  cosine,
  createRng,
  detectFloor,
  geometricMean,
  isoWeekKey,
  jaccard,
  mad,
  madZ,
  mannKendall,
  mean,
  median,
  normalCdf,
  pearson,
  qualityGate,
  quantile,
  spearman,
  stdev,
  theilSen,
  winsorize,
  withinCallPercentiles,
} from "../src/stats";

describe("withinCallPercentiles", () => {
  it("ranks scored values and leaves nulls and floor ties unscored", () => {
    const out = withinCallPercentiles([0.9, 0.5, 0.7, null, 0.1, 0.1], 0.1);
    expect(out.unscored).toEqual([false, false, false, true, true, true]);
    expect(out.rank).toEqual([1, 3, 2, null, null, null]);
    expect(out.pct).toEqual([1, 0, 0.5, null, null, null]);
  });

  it("averages ranks for ties among scored values", () => {
    const out = withinCallPercentiles([0.8, 0.8, 0.5, 0.2], null);
    expect(out.rank).toEqual([1.5, 1.5, 3, 4]);
    expect(out.pct[0]).toBeCloseTo(1 - 0.5 / 3, 12);
    expect(out.pct[1]).toBeCloseTo(1 - 0.5 / 3, 12);
    expect(out.pct[2]).toBeCloseTo(1 / 3, 12);
    expect(out.pct[3]).toBe(0);
  });

  it("gives a single scored value pct 1 and rank 1", () => {
    expect(withinCallPercentiles([null, 0.4, 0.2], 0.2)).toEqual({
      pct: [null, 1, null],
      rank: [null, 1, null],
      unscored: [true, false, true],
    });
  });

  it("treats a floor value as unscored even when it occurs once in this call", () => {
    const out = withinCallPercentiles([0.3, 0.6, 0.45], 0.3);
    expect(out.unscored).toEqual([true, false, false]);
    expect(out.pct).toEqual([null, 1, 0]);
  });

  it("handles all-unscored and empty calls", () => {
    expect(withinCallPercentiles([0.2, 0.2], 0.2).pct).toEqual([null, null]);
    expect(withinCallPercentiles([], null)).toEqual({ pct: [], rank: [], unscored: [] });
  });
});

describe("detectFloor", () => {
  it("returns the minimum when it occurs at least twice", () => {
    expect(detectFloor([0.4, 0.2, 0.9, 0.2])).toBe(0.2);
    expect(detectFloor([0.5, 0.5])).toBe(0.5);
  });

  it("returns null for a unique minimum, a tie above the minimum, or no data", () => {
    expect(detectFloor([0.4, 0.2, 0.3])).toBeNull();
    expect(detectFloor([0.1, 0.5, 0.5])).toBeNull();
    expect(detectFloor([])).toBeNull();
  });
});

describe("location and spread", () => {
  it("mean, median and type 7 quantiles", () => {
    expect(mean([1, 2, 3, 6])).toBe(3);
    expect(mean([])).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
    expect(quantile([1, 2, 3, 4], 0.9)).toBeCloseTo(3.7, 12);
    expect(quantile([1, 2, 3, 4, 10], 0.9)).toBeCloseTo(7.6, 12);
    expect(quantile([7], 0.3)).toBe(7);
    expect(quantile([5, 1, 9], 0)).toBe(1);
    expect(quantile([5, 1, 9], 1)).toBe(9);
    expect(() => quantile([1, 2], 1.5)).toThrow(RangeError);
    expect(() => quantile([1, 2], Number.NaN)).toThrow(RangeError);
  });

  it("does not reorder its input", () => {
    const values = [3, 1, 2];
    quantile(values, 0.5);
    expect(values).toEqual([3, 1, 2]);
  });

  it("sample standard deviation", () => {
    expect(stdev([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(Math.sqrt(32 / 7), 12);
    expect(stdev([1])).toBeNull();
  });

  it("MAD and MAD-z", () => {
    const values = [1, 1, 2, 2, 4, 6, 9];
    expect(mad(values)).toBe(1);
    const z = madZ(values);
    expect(z[2]).toBe(0);
    expect(z[6]).toBeCloseTo(NORMAL_UPPER_QUARTILE * 7, 12);
    expect(z[0]).toBeCloseTo(-NORMAL_UPPER_QUARTILE, 12);
    expect(mad([])).toBeNull();
    expect(madZ([])).toEqual([]);
  });

  it("falls back to the scaled mean absolute deviation when MAD is 0", () => {
    const z = madZ([5, 5, 5, 5, 9]);
    expect(z.slice(0, 4)).toEqual([0, 0, 0, 0]);
    expect(z[4]).toBeCloseTo(4 / (Math.sqrt(Math.PI / 2) * 0.8), 12);
    expect(madZ([3, 3, 3])).toEqual([0, 0, 0]);
  });

  it("winsorises at p5 and p95 and marks clipped points", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    const w = winsorize(values);
    expect(w.lo).toBeCloseTo(1.95, 12);
    expect(w.hi).toBeCloseTo(19.05, 12);
    expect(w.values[0]).toBeCloseTo(1.95, 12);
    expect(w.values[19]).toBeCloseTo(19.05, 12);
    expect(w.values.slice(1, 19)).toEqual(values.slice(1, 19));
    expect(w.clipped.filter(Boolean)).toHaveLength(2);
    expect(w.clipped[0]).toBe(true);
    expect(w.clipped[19]).toBe(true);
    expect(winsorize([])).toEqual({ values: [], lo: null, hi: null, clipped: [] });
    expect(() => winsorize(values, 0.9, 0.1)).toThrow(RangeError);
  });

  it("geometric mean and clamp", () => {
    expect(geometricMean([1, 4, 16])).toBeCloseTo(4, 12);
    expect(geometricMean([])).toBeNull();
    expect(() => geometricMean([1, 0])).toThrow(RangeError);
    expect(clamp(1.4, 0, 1)).toBe(1);
    expect(clamp(-0.2, 0, 1)).toBe(0);
    expect(clamp(0.3, 0, 1)).toBe(0.3);
    expect(() => clamp(0.5, 1, 0)).toThrow(RangeError);
  });
});

describe("ranks", () => {
  it("average ranks in both directions", () => {
    expect(averageRanks([10, 20, 20, 5])).toEqual([2, 3.5, 3.5, 1]);
    expect(averageRanks([10, 20, 20, 5], "desc")).toEqual([3, 1.5, 1.5, 4]);
    expect(averageRanks([])).toEqual([]);
  });

  it("competition ranks share the best position", () => {
    expect(competitionRanks([10, 20, 20, 5], "desc")).toEqual([3, 1, 1, 4]);
    expect(competitionRanks([7, 7, 7])).toEqual([1, 1, 1]);
  });
});

describe("Theil–Sen", () => {
  it("recovers an exact line", () => {
    expect(theilSen([0, 1, 2, 3], [1, 3, 5, 7])).toEqual({ slope: 2, intercept: 1 });
  });

  it("ignores a gross outlier that would wreck least squares", () => {
    const fit = theilSen([0, 1, 2, 3, 4], [1, 3, 5, 7, 100]);
    expect(fit).toEqual({ slope: 2, intercept: 1 });
  });

  it("skips equal-x pairs and returns null without two distinct x values", () => {
    expect(theilSen([1, 1, 2], [0, 2, 3])?.slope).toBe(2);
    expect(theilSen([2, 2], [1, 5])).toBeNull();
    expect(theilSen([1], [1])).toBeNull();
    expect(() => theilSen([1, 2], [1])).toThrow(RangeError);
  });
});

describe("Mann–Kendall", () => {
  it("matches the textbook values for a strictly rising series", () => {
    const mk = mannKendall([1, 2, 3, 4, 5])!;
    expect(mk.s).toBe(10);
    expect(mk.tau).toBe(1);
    expect(mk.variance).toBeCloseTo(50 / 3, 12);
    expect(mk.z).toBeCloseTo(9 / Math.sqrt(50 / 3), 12);
    expect(mk.p).toBeCloseTo(0.0275, 4);
  });

  it("applies the tie correction to the variance", () => {
    const mk = mannKendall([1, 2, 2, 3])!;
    expect(mk.s).toBe(5);
    expect(mk.tau).toBeCloseTo(5 / 6, 12);
    expect(mk.variance).toBeCloseTo((4 * 3 * 13 - 2 * 1 * 9) / 18, 12);
    expect(mk.z).toBeCloseTo(4 / Math.sqrt(mk.variance), 12);
  });

  it("is mirrored for a falling series and neutral when S is 0", () => {
    const down = mannKendall([5, 4, 3, 2, 1])!;
    expect(down.s).toBe(-10);
    expect(down.z).toBeCloseTo(-9 / Math.sqrt(50 / 3), 12);
    const balanced = mannKendall([1, 2, 1])!;
    expect(balanced).toMatchObject({ s: 0, tau: 0, z: 0, p: 1 });
    expect(balanced.variance).toBeCloseTo((3 * 2 * 11 - 2 * 1 * 9) / 18, 12);
  });

  it("returns null below two points and for a constant series, where Var(S) is 0", () => {
    expect(mannKendall([1])).toBeNull();
    expect(mannKendall([4, 4, 4, 4])).toBeNull();
  });
});

describe("association and similarity", () => {
  it("Spearman with ties matches the reference value", () => {
    expect(spearman([1, 2, 3, 4, 5], [5, 6, 7, 8, 7])).toBeCloseTo(8 / Math.sqrt(95), 12);
  });

  it("Spearman edge cases", () => {
    expect(spearman([1, 2, 3, 4], [1, 8, 27, 64])).toBeCloseTo(1, 12);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 12);
    expect(spearman([1, 2, 3], [5, 5, 5])).toBeNull();
    expect(spearman([1], [2])).toBeNull();
    expect(spearman([], [])).toBeNull();
    expect(() => spearman([1, 2], [1])).toThrow(RangeError);
  });

  it("Pearson basics", () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(pearson([1, 2, 3], [1, 1, 1])).toBeNull();
  });

  it("Jaccard over distinct members", () => {
    expect(jaccard(["a", "b", "c"], ["b", "c", "d"])).toBe(0.5);
    expect(jaccard(["a", "a", "b"], ["b", "a"])).toBe(1);
    expect(jaccard(["a"], ["b"])).toBe(0);
    expect(jaccard([], ["b"])).toBe(0);
    expect(jaccard([], [])).toBeNull();
  });

  it("cosine edge cases", () => {
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 12);
    expect(cosine([1, 2], [-1, -2])).toBeCloseTo(-1, 12);
    expect(cosine([0, 0], [1, 2])).toBeNull();
    expect(cosine([], [])).toBeNull();
    expect(() => cosine([1, 2], [1])).toThrow(RangeError);
  });
});

describe("normalCdf", () => {
  it("matches reference values", () => {
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(1)).toBeCloseTo(0.8413447460685429, 13);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 13);
    expect(normalCdf(-3)).toBeCloseTo(0.0013498980316301, 13);
    expect(normalCdf(-1.5) + normalCdf(1.5)).toBeCloseTo(1, 14);
    expect(normalCdf(40)).toBe(1);
    expect(normalCdf(-40)).toBe(0);
  });
});

describe("seeded randomness and the bootstrap", () => {
  it("createRng is deterministic per seed and uniform on [0, 1)", () => {
    const a = createRng("seed-a");
    const b = createRng("seed-a");
    const c = createRng("seed-b");
    const seqA = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(seqA);
    expect(Array.from({ length: 5 }, () => c())).not.toEqual(seqA.slice(0, 5));
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(mean(seqA)!).toBeGreaterThan(0.45);
    expect(mean(seqA)!).toBeLessThan(0.55);
  });

  it("bootstrap is deterministic per seed, brackets the estimate and runs B resamples", () => {
    const values = [3, 5, 4, 6, 8, 5, 7, 4, 6, 5];
    let calls = 0;
    const counted = (s: readonly number[]): number | null => {
      calls += 1;
      return mean(s);
    };
    const first = bootstrap(values, counted, { seed: "boot-1" })!;
    expect(calls).toBe(501);
    expect(first.estimate).toBe(5.3);
    expect(first.lo).toBeLessThan(first.estimate);
    expect(first.hi).toBeGreaterThan(first.estimate);
    expect(bootstrap(values, mean, { seed: "boot-1" })).toEqual(first);
    expect(bootstrap(values, mean, { seed: "boot-2" })).not.toEqual(first);
  });

  it("bootstrap handles empty input and rejects bad options", () => {
    expect(bootstrap([], mean, { seed: "s" })).toBeNull();
    expect(() => bootstrap([1], mean, { seed: "s", B: 0 })).toThrow(RangeError);
    expect(() => bootstrap([1], mean, { seed: "s", alpha: 1 })).toThrow(RangeError);
    expect(bootstrap([2, 2, 2], median, { seed: "s", B: 20 })).toEqual({ estimate: 2, lo: 2, hi: 2 });
  });
});

describe("quality gate", () => {
  it("drops popularity below 0.01 and keeps missing values", () => {
    const items = [
      { name: "Brand Alpha", popularity: 0.5 },
      { name: "Brand Beta", popularity: 0.009 },
      { name: "Brand Gamma", popularity: QUALITY_GATE_MIN_POPULARITY },
      { name: "Brand Delta", popularity: null },
    ];
    const out = qualityGate(items, (i) => i.popularity);
    expect(out.kept.map((i) => i.name)).toEqual(["Brand Alpha", "Brand Gamma", "Brand Delta"]);
    expect(out.dropped.map((i) => i.name)).toEqual(["Brand Beta"]);
  });
});

describe("isoWeekKey", () => {
  it("follows the ISO 8601 Thursday rule across year boundaries", () => {
    expect(isoWeekKey("2025-04-01")).toBe("2025-W14");
    expect(isoWeekKey("2021-01-03")).toBe("2020-W53");
    expect(isoWeekKey("2024-12-30")).toBe("2025-W01");
    expect(isoWeekKey("2026-01-01")).toBe("2026-W01");
    expect(isoWeekKey(new Date(Date.UTC(2025, 8, 30, 23, 59)))).toBe("2025-W40");
  });

  it("reads a zone-less date-time as UTC, whatever the host timezone", () => {
    // Either side of the Sunday-to-Monday boundary: a local-time parse breaks one of them on any non-UTC host.
    expect(isoWeekKey("2025-04-07T00:30:00")).toBe(isoWeekKey("2025-04-07"));
    expect(isoWeekKey("2025-04-07T00:30:00")).toBe("2025-W15");
    expect(isoWeekKey("2025-04-06T23:30:00")).toBe("2025-W14");
    expect(isoWeekKey("2025-04-07 00:30:00.250")).toBe("2025-W15");
    expect(isoWeekKey("2025-04-07T00:30")).toBe("2025-W15");
  });

  it("honours an explicit zone designator", () => {
    expect(isoWeekKey("2025-04-07T00:30:00Z")).toBe("2025-W15");
    expect(isoWeekKey("2025-04-07T00:30:00+02:00")).toBe("2025-W14");
  });

  it("rejects an invalid date", () => {
    expect(() => isoWeekKey("not a date")).toThrow(RangeError);
  });
});
