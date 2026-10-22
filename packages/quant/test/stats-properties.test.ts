// Property tests over seeded synthetic data: every case is reproducible from its seed.
import { describe, expect, it } from "vitest";
import {
  averageRanks,
  bootstrap,
  cosine,
  createRng,
  detectFloor,
  jaccard,
  mannKendall,
  median,
  spearman,
  theilSen,
  withinCallPercentiles,
} from "../src/stats";

const SEEDS = Array.from({ length: 40 }, (_, i) => `prop-${i}`);

/** A call of n scores in (0.2, 1) with `floors` entries planted at the floor value 0.1. */
function syntheticCall(seed: string, n: number, floors: number): (number | null)[] {
  const rng = createRng(seed);
  const scores: (number | null)[] = Array.from({ length: n }, () => 0.2 + 0.8 * rng());
  for (let f = 0; f < floors; f++) scores[Math.floor(rng() * n)] = 0.1;
  if (n > 2) scores[Math.floor(rng() * n)] = null;
  return scores;
}

describe("within-call percentiles: properties", () => {
  it("are invariant to strictly increasing transforms of the scores and the floor", () => {
    const transforms: ((x: number) => number)[] = [(x) => Math.exp(3 * x), (x) => x ** 3 + 2, (x) => Math.log(x) * 10];
    for (const seed of SEEDS) {
      const scores = syntheticCall(seed, 12, 3);
      const base = withinCallPercentiles(scores, 0.1);
      for (const f of transforms) {
        const moved = withinCallPercentiles(
          scores.map((s) => (s === null ? null : f(s))),
          f(0.1),
        );
        expect(moved).toEqual(base);
      }
    }
  });

  it("never rank floor ties: only non-floor scores get a percentile, spanning exactly 0..1", () => {
    for (const seed of SEEDS) {
      const scores = syntheticCall(seed, 10, 4);
      const pooledFloor = detectFloor(scores.filter((s): s is number => s !== null));
      const out = withinCallPercentiles(scores, pooledFloor);
      scores.forEach((s, i) => {
        const isFloor = s === null || s === pooledFloor;
        expect(out.unscored[i]).toBe(isFloor);
        expect(out.pct[i] === null).toBe(isFloor);
      });
      const pct = out.pct.filter((p): p is number => p !== null);
      if (pct.length >= 2) {
        expect(Math.max(...pct)).toBe(1);
        expect(Math.min(...pct)).toBe(0);
      }
    }
  });

  it("is a decreasing function of rank and averages to one half", () => {
    for (const seed of SEEDS) {
      const scores = syntheticCall(seed, 9, 0);
      const out = withinCallPercentiles(scores, null);
      const scored = out.pct.filter((p): p is number => p !== null);
      const meanPct = scored.reduce((a, b) => a + b, 0) / scored.length;
      expect(meanPct).toBeCloseTo(0.5, 12);
      out.rank.forEach((r, i) => {
        if (r !== null) expect(out.pct[i]).toBeCloseTo(1 - (r - 1) / (scored.length - 1), 12);
      });
    }
  });
});

describe("ranks: properties", () => {
  it("average ranks sum to n(n + 1)/2 with or without ties", () => {
    for (const seed of SEEDS) {
      const rng = createRng(seed);
      const values = Array.from({ length: 15 }, () => Math.floor(rng() * 5));
      const total = averageRanks(values).reduce((a, b) => a + b, 0);
      expect(total).toBeCloseTo((15 * 16) / 2, 12);
    }
  });
});

describe("Theil–Sen: robustness", () => {
  it("keeps the true slope when one point is replaced by a gross outlier", () => {
    for (const seed of SEEDS) {
      const rng = createRng(seed);
      const x = Array.from({ length: 20 }, (_, i) => i);
      const y = x.map((xi) => 0.5 + 0.03 * xi + (rng() - 0.5) * 0.01);
      const clean = theilSen(x, y)!;
      const dirty = [...y];
      dirty[Math.floor(rng() * 20)] = 50;
      const fit = theilSen(x, dirty)!;
      expect(Math.abs(fit.slope - clean.slope)).toBeLessThan(0.005);
      expect(Math.abs(fit.slope - 0.03)).toBeLessThan(0.005);
    }
  });
});

describe("Mann–Kendall: monotone vs noise", () => {
  it("detects any strictly monotone series of 30 points", () => {
    for (const seed of SEEDS) {
      const rng = createRng(seed);
      let level = 0;
      const rising = Array.from({ length: 30 }, () => (level += 0.01 + rng()));
      const mk = mannKendall(rising)!;
      expect(mk.tau).toBe(1);
      expect(mk.p).toBeLessThan(1e-6);
      const falling = mannKendall([...rising].reverse())!;
      expect(falling.tau).toBe(-1);
      expect(falling.p).toBe(mk.p);
    }
  });

  it("rarely rejects on independent noise", () => {
    const rejections = SEEDS.filter((seed) => {
      const rng = createRng(seed);
      return mannKendall(Array.from({ length: 30 }, () => rng()))!.p < 0.05;
    });
    expect(rejections.length).toBeLessThanOrEqual(6);
  });

  it("is invariant to strictly increasing transforms", () => {
    for (const seed of SEEDS) {
      const rng = createRng(seed);
      const series = Array.from({ length: 25 }, () => Math.round(rng() * 8));
      expect(mannKendall(series.map((v) => Math.exp(v)))).toEqual(mannKendall(series));
    }
  });
});

describe("Spearman, cosine and Jaccard: properties", () => {
  it("Spearman is symmetric, bounded and invariant to monotone transforms", () => {
    for (const seed of SEEDS) {
      const rng = createRng(seed);
      const x = Array.from({ length: 12 }, () => rng());
      const y = Array.from({ length: 12 }, () => rng());
      const rho = spearman(x, y)!;
      expect(spearman(y, x)).toBeCloseTo(rho, 12);
      expect(Math.abs(rho)).toBeLessThanOrEqual(1);
      expect(spearman(x.map((v) => v ** 5), y.map(Math.exp))).toBeCloseTo(rho, 12);
    }
  });

  it("cosine is scale invariant and bounded", () => {
    for (const seed of SEEDS) {
      const rng = createRng(seed);
      const a = Array.from({ length: 8 }, () => rng() - 0.5);
      const b = Array.from({ length: 8 }, () => rng() - 0.5);
      const c = cosine(a, b)!;
      expect(Math.abs(c)).toBeLessThanOrEqual(1);
      expect(cosine(a.map((v) => v * 7), b)).toBeCloseTo(c, 12);
      expect(cosine(a, a)).toBeCloseTo(1, 12);
    }
  });

  it("Jaccard is symmetric and within 0..1", () => {
    for (const seed of SEEDS) {
      const rng = createRng(seed);
      const a = Array.from({ length: 6 }, () => `tag-${Math.floor(rng() * 10)}`);
      const b = Array.from({ length: 6 }, () => `tag-${Math.floor(rng() * 10)}`);
      const j = jaccard(a, b)!;
      expect(jaccard(b, a)).toBe(j);
      expect(j).toBeGreaterThanOrEqual(0);
      expect(j).toBeLessThanOrEqual(1);
    }
  });
});

describe("bootstrap: determinism", () => {
  it("returns the same interval for the same seed across runs and resample counts", () => {
    for (const seed of SEEDS.slice(0, 10)) {
      const rng = createRng(`data-${seed}`);
      const values = Array.from({ length: 25 }, () => rng());
      const a = bootstrap(values, median, { seed, B: 200 });
      const b = bootstrap(values, median, { seed, B: 200 });
      expect(a).toEqual(b);
      expect(a!.lo).toBeLessThanOrEqual(a!.hi);
    }
  });
});
