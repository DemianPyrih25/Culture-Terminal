// Classical MDS for the Category Taste Map: known configurations recovered exactly, the stress and
// fit of configurations no flat map can hold, the orientation by the first point (no mirroring under
// a near-tie), and taste distances from a similarity matrix with unscored pairs.
import { describe, expect, it } from "vitest";
import { TasteMapPayload } from "@ct/contracts";
import {
  TASTE_MAP_DRAW_MIN_K,
  buildTasteMap,
  classicalMds,
  kruskalStress,
  symmetricEigen,
  tasteDistances,
  tasteMapFromScreen,
  type TasteMapMember,
} from "../src/mds";
import { createRng } from "../src/stats";

type Point = readonly number[];

function distances(points: readonly Point[]): number[][] {
  return points.map((a) => points.map((b) => Math.hypot(...a.map((x, k) => x - (b[k] ?? 0)))));
}

function expectCoords(actual: readonly (readonly number[])[], expected: readonly (readonly number[])[], digits = 10): void {
  expect(actual).toHaveLength(expected.length);
  actual.forEach((row, i) => row.forEach((x, k) => expect(x, `point ${i} axis ${k}`).toBeCloseTo(expected[i]![k]!, digits)));
}

/** Every pairwise distance of the map against the input, to `digits`. */
function expectDistancesKept(d: readonly (readonly number[])[], coords: readonly Point[], digits = 9): void {
  const map = distances(coords);
  d.forEach((row, i) => row.forEach((x, j) => expect(map[i]![j], `${i}-${j}`).toBeCloseTo(x, digits)));
}

describe("classicalMds: configurations a flat map holds exactly", () => {
  it("recovers points on a line as the first axis, centred, with nothing on the second", () => {
    const xs = [0, 1, 3, 6];
    const out = classicalMds(distances(xs.map((x) => [x])));
    // Centred on the mean 2.5; the first point sits left of centre on axis 1.
    expectCoords(out.coords, [
      [-2.5, 0],
      [-1.5, 0],
      [0.5, 0],
      [3.5, 0],
    ]);
    expect(out.eigenvalues[0]).toBeCloseTo(21, 10);
    expect(out.eigenvalues[1]).toBeCloseTo(0, 10);
    expect(out.explained).toBeCloseTo(1, 12);
    expect(out.stress).toBeLessThan(1e-12);
  });

  it("recovers a 3 × 1 rectangle, axes by variance, the first point left of centre and above it", () => {
    const out = classicalMds(distances([[0, 0], [3, 0], [3, 1], [0, 1]]));
    expectCoords(out.coords, [
      [-1.5, 0.5],
      [1.5, 0.5],
      [1.5, -0.5],
      [-1.5, -0.5],
    ]);
    expect(out.eigenvalues.slice(0, 2).map((x) => Number(x.toFixed(10)))).toEqual([9, 1]);
    expect(out.stress).toBeLessThan(1e-12);
  });

  it("keeps every distance of a 14-point plane configuration (k up to 14) and is invariant to rigid motion", () => {
    const rng = createRng("mds-plane-14");
    const points = Array.from({ length: 14 }, () => [rng() * 4 - 2, rng() * 2 - 1]);
    const out = classicalMds(distances(points));
    expectDistancesKept(distances(points), out.coords);
    expect(out.stress).toBeLessThan(1e-10);
    expect(out.explained).toBeCloseTo(1, 10);
    // Rotated by 0.7 rad and moved: the same distances, so the very same map.
    const moved = points.map(([x, y]) => [Math.cos(0.7) * x! - Math.sin(0.7) * y! + 5, Math.sin(0.7) * x! + Math.cos(0.7) * y! - 3]);
    expectCoords(classicalMds(distances(moved)).coords, out.coords, 9);
  });

  it("centres the map on the origin", () => {
    const rng = createRng("mds-centre");
    const points = Array.from({ length: 9 }, () => [rng() * 10, rng() * 3]);
    const { coords } = classicalMds(distances(points));
    for (const k of [0, 1]) expect(coords.reduce((s, p) => s + p[k]!, 0)).toBeCloseTo(0, 10);
  });
});

describe("classicalMds: configurations a flat map cannot hold", () => {
  it("projects a regular tetrahedron with two thirds of its mass and a positive stress", () => {
    const d = [
      [0, 1, 1, 1],
      [1, 0, 1, 1],
      [1, 1, 0, 1],
      [1, 1, 1, 0],
    ];
    const out = classicalMds(d);
    expect(out.eigenvalues.slice(0, 3).every((x) => Math.abs(x - 0.5) < 1e-10)).toBe(true);
    expect(out.eigenvalues[3]).toBeCloseTo(0, 10);
    expect(out.explained).toBeCloseTo(2 / 3, 10);
    expect(out.stress).toBeGreaterThan(0.05);
    expect(out.stress).toBeLessThan(0.5);
    expect(out.stress).toBeCloseTo(kruskalStress(d, out.coords), 12);
  });

  it("reports the stress of a 3D configuration seen flat", () => {
    const cube = [0, 1].flatMap((x) => [0, 1].flatMap((y) => [0, 1].map((z) => [x * 3, y * 2, z])));
    const out = classicalMds(distances(cube));
    expect(out.eigenvalues.slice(0, 3).map((x) => Number(x.toFixed(10)))).toEqual([18, 8, 2]);
    expect(out.explained).toBeCloseTo(26 / 28, 10);
    expect(out.stress).toBeGreaterThan(0);
    expect(out.stress).toBeLessThan(0.2);
  });

  it("drops negative eigenvalues from 1 − similarity distances that break the triangle inequality, and counts them against the fit", () => {
    // 0–1 and 1–2 are close, 0–2 far: no Euclidean configuration has these distances.
    const d = [
      [0, 0.1, 0.9],
      [0.1, 0, 0.1],
      [0.9, 0.1, 0],
    ];
    const out = classicalMds(d);
    expect(out.eigenvalues[0]).toBeCloseTo(0.405, 10);
    expect(out.eigenvalues[1]).toBe(0);
    expect(out.eigenvalues[2]).toBeCloseTo(-0.385 / 3, 10);
    expect(out.coords.flat().every(Number.isFinite)).toBe(true);
    // Mardia: 0.405 / (0.405 + 0.128), not the 100% of the positive mass alone.
    expect(out.explained).toBeCloseTo(0.405 / (0.405 + 0.385 / 3), 10);
    expect(out.explained).toBeLessThan(0.8);
    expect(out.stress).toBeGreaterThan(0.5);
  });
});

describe("classicalMds: a stable, deterministic map", () => {
  const rng = createRng("mds-stable");
  const points = Array.from({ length: 8 }, () => [rng() * 3, rng() * 2, rng() * 0.5]);
  const d = distances(points);

  it("returns the same map for the same matrix", () => {
    expect(classicalMds(d)).toEqual(classicalMds(d.map((row) => [...row])));
  });

  it("follows its entities when the others are reordered: rows permute, signs hold", () => {
    const perm = [0, 3, 7, 5, 1, 6, 2, 4];
    const permuted = perm.map((i) => perm.map((j) => d[i]![j]!));
    const base = classicalMds(d).coords;
    expectCoords(classicalMds(permuted).coords, perm.map((i) => base[i]!), 9);
  });

  it("re-orients, never reshapes, when another point comes first", () => {
    const perm = [3, 0, 7, 5, 1, 6, 2, 4];
    const permuted = perm.map((i) => perm.map((j) => d[i]![j]!));
    const base = classicalMds(d).coords;
    const out = classicalMds(permuted).coords;
    for (const k of [0, 1]) {
      // Each axis is the same or mirrored, as the new first point's side decides.
      const flip = Math.sign(out[0]![k]!) === Math.sign(base[3]![k]!) ? 1 : -1;
      out.forEach((p, i) => expect(p[k]!).toBeCloseTo(flip * base[perm[i]!]![k]!, 9));
    }
    expect(out[0]![0]!).toBeLessThanOrEqual(0);
    expect(out[0]![1]!).toBeGreaterThanOrEqual(0);
  });

  it("moves only slightly under a small perturbation (no axis flips)", () => {
    const nudged = d.map((row, i) => row.map((x, j) => (i === j ? 0 : x + 1e-6 * ((i + j) % 3))));
    const a = classicalMds(d).coords;
    const b = classicalMds(nudged).coords;
    a.forEach((p, i) => p.forEach((x, k) => expect(Math.abs(x - b[i]![k]!)).toBeLessThan(1e-4)));
  });

  it("does not mirror a symmetric map whose two extremes nearly tie (a cache refresh cannot flip it)", () => {
    // The two ends of axis 1 sit almost equally far from the centroid, on opposite sides.
    const a = classicalMds(distances([[-1, 0], [1.0000001, 0], [0, 0.3], [0, -0.3]])).coords;
    const b = classicalMds(distances([[-1.0000001, 0], [1, 0], [0, 0.3], [0, -0.3]])).coords;
    a.forEach((p, i) => p.forEach((x, k) => expect(Math.abs(x - b[i]![k]!), `point ${i} axis ${k}`).toBeLessThan(1e-6)));
    // The first point is on the centre line of axis 2, so the next point off it (the third) orients it.
    expectCoords(a, [[-1, 0], [1, 0], [0, 0.3], [0, -0.3]], 6);
  });

  it("orients each axis by the first point: left of centre on axis 1, above it on axis 2", () => {
    const { coords } = classicalMds(d);
    expect(coords[0]![0]!).toBeLessThan(0);
    expect(coords[0]![1]!).toBeGreaterThan(0);
  });

  it("handles the small cases: no points, one point, two points, all coincident", () => {
    expect(classicalMds([])).toEqual({ coords: [], eigenvalues: [], explained: 1, stress: 0 });
    expect(classicalMds([[0]]).coords).toEqual([[0, 0]]);
    expectCoords(classicalMds([[0, 2], [2, 0]]).coords, [[-1, 0], [1, 0]]);
    const same = classicalMds([[0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(same.coords).toEqual([[0, 0], [0, 0], [0, 0]]);
    expect(same.explained).toBe(1);
    expect(same.stress).toBe(0);
  });

  it("keeps more axes when asked", () => {
    const out = classicalMds(d, 3);
    expect(out.coords.every((p) => p.length === 3)).toBe(true);
    expect(out.stress).toBeLessThan(1e-9);
  });

  it("rejects a matrix that is not a distance matrix", () => {
    expect(() => classicalMds([[0, 1]])).toThrow(RangeError);
    expect(() => classicalMds([[0, 1], [2, 0]])).toThrow(/differ/);
    expect(() => classicalMds([[0, -1], [-1, 0]])).toThrow(/non-negative/);
    expect(() => classicalMds([[1, 1], [1, 0]])).toThrow(/must be 0/);
    expect(() => classicalMds([[0, Number.NaN], [Number.NaN, 0]])).toThrow(RangeError);
    expect(() => classicalMds([[0]], 0)).toThrow(/dims/);
  });
});

describe("symmetricEigen", () => {
  it("rebuilds the matrix from orthonormal eigenvectors, largest eigenvalue first", () => {
    const rng = createRng("mds-eigen");
    const n = 7;
    const m = Array.from({ length: n }, () => Array.from({ length: n }, () => 0));
    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const x = rng() * 2 - 1;
        m[i]![j] = x;
        m[j]![i] = x;
      }
    }
    const { values, vectors } = symmetricEigen(m);
    expect(values).toEqual([...values].sort((a, b) => b - a));
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        const dot = vectors[a]!.reduce((s, x, i) => s + x * vectors[b]![i]!, 0);
        expect(dot).toBeCloseTo(a === b ? 1 : 0, 10);
      }
    }
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        const rebuilt = values.reduce((s, lambda, k) => s + lambda * vectors[k]![i]! * vectors[k]![j]!, 0);
        expect(rebuilt).toBeCloseTo(m[i]![j]!, 10);
      }
    }
  });

  it("returns a diagonal matrix as it is, in descending order", () => {
    const out = symmetricEigen([
      [1, 0, 0],
      [0, 3, 0],
      [0, 0, 2],
    ]);
    expect(out.values).toEqual([3, 2, 1]);
    expect(out.vectors).toEqual([
      [0, 1, 0],
      [0, 0, 1],
      [1, 0, 0],
    ]);
  });
});

describe("tasteDistances", () => {
  it("mirrors either triangle, averages two scores and takes 1 − similarity", () => {
    const { d, imputed } = tasteDistances([
      [null, 0.8, 0.3],
      [0.6, null, null],
      [null, 0.5, null],
    ]);
    expect(imputed).toEqual([]);
    expect(d[0]![1]).toBeCloseTo(0.3, 12);
    expect(d[1]![0]).toBeCloseTo(0.3, 12);
    expect(d[0]![2]).toBeCloseTo(0.7, 12);
    expect(d[1]![2]).toBeCloseTo(0.5, 12);
    expect(d.map((row, i) => row[i])).toEqual([0, 0, 0]);
  });

  it("sets an unscored pair to the largest scored distance, never to a guess", () => {
    const { d, imputed } = tasteDistances([
      [null, 0.9, null],
      [0.9, null, 0.2],
      [null, 0.2, null],
    ]);
    expect(imputed).toEqual([[0, 2]]);
    expect(d[0]![2]).toBeCloseTo(0.8, 12);
    expect(d[2]![0]).toBeCloseTo(0.8, 12);
  });

  it("floors distances at 0, reads non-finite scores as unscored and needs a square matrix", () => {
    const { d, imputed } = tasteDistances([
      [null, 1.2, Number.NaN],
      [1.2, null, null],
      [Number.NaN, null, null],
    ]);
    expect(d[0]![1]).toBe(0);
    // No other scored pair is farther than 0, so the unscored pairs sit at that same 0.
    expect(imputed).toEqual([
      [0, 2],
      [1, 2],
    ]);
    expect(tasteDistances([[null, null], [null, null]]).d).toEqual([
      [0, 1],
      [1, 0],
    ]);
    expect(() => tasteDistances([[null, 1]])).toThrow(RangeError);
  });

  it("feeds classicalMds: the closest pair by similarity is the closest pair on the map", () => {
    const sim = [
      [null, 0.71, 0.2, 0.34],
      [0.71, null, 0.25, 0.3],
      [0.2, 0.25, null, 0.64],
      [0.34, 0.3, 0.64, null],
    ];
    const { coords } = classicalMds(tasteDistances(sim).d);
    const map = distances(coords);
    const pairs = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]] as const;
    const closest = pairs.reduce((best, p) => (map[p[0]]![p[1]]! < map[best[0]]![best[1]]! ? p : best));
    expect(closest).toEqual([0, 1]);
  });
});

describe("kruskalStress: skipped pairs", () => {
  it("leaves skipped pairs out of both sums, in either order", () => {
    const d = [
      [0, 1, 2],
      [1, 0, 1],
      [2, 1, 0],
    ];
    const coords = [[0], [1], [5]];
    expect(kruskalStress(d, coords)).toBeGreaterThan(0.5);
    // Only 0–1 is left once 0–2 and 1–2 are skipped, and the map keeps it exactly.
    expect(kruskalStress(d, coords, [[2, 0], [1, 2]])).toBe(0);
  });
});

describe("buildTasteMap", () => {
  const member = (i: number, target = false): TasteMapMember => ({
    key: `R${i + 1}`,
    label: `Brand ${String.fromCharCode(65 + i)}`,
    ref: `R${i + 1}` as TasteMapMember["ref"],
    hub: target ? null : 0.5,
    target,
  });
  const members = (n: number) => Array.from({ length: n }, (_, i) => member(i, i === 0));
  /** Similarities whose distances 1 − sim are exactly the planar distances of `points` (all ≤ 1). */
  const simOf = (points: readonly Point[]): (number | null)[][] =>
    distances(points).map((row, i) => row.map((x, j) => (i === j ? null : 1 - x)));
  // A unit-free square plus its centre, small enough that every distance stays below 1.
  const square: Point[] = [[0, 0], [0.4, 0], [0.4, 0.4], [0, 0.4], [0.2, 0.2]];

  it("recovers a planar configuration up to rotation and reflection, with stress ~0", () => {
    const built = buildTasteMap({ source: "screener", members: members(5), sim: simOf(square) });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const p = built.payload;
    expect(() => TasteMapPayload.parse(p)).not.toThrow();
    expect(p).toMatchObject({ source: "screener", k: 5, imputedPairs: [], omitted: [] });
    expect(p.stress).toBeLessThan(1e-3);
    expect(p.explained).toBeCloseTo(1, 3);
    expectDistancesKept(distances(square), p.points.map((q) => [q.x, q.y]), 3);
    expect(p.points[0]).toMatchObject({ key: "R1", target: true, hub: null });
    expect(p.points[0]!.x).toBeLessThanOrEqual(0);
    expect(p.method).toContain("over 5 entities");
  });

  it("is deterministic for the same matrix", () => {
    const a = buildTasteMap({ source: "screener", members: members(5), sim: simOf(square) });
    const b = buildTasteMap({ source: "screener", members: members(5), sim: simOf(square) });
    expect(a).toEqual(b);
  });

  it("imputes an unscored pair, lists it by key and keeps it out of the stress", () => {
    const sim = simOf(square);
    sim[1]![3] = null;
    sim[3]![1] = null;
    const built = buildTasteMap({ source: "substitution_map", members: members(5), sim });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.imputedPairs).toEqual([["R2", "R4"]]);
    expect(built.payload.method).toContain("1 unscored pair set to the largest scored distance");
    const { d, imputed } = tasteDistances(sim);
    const coords = built.payload.points.map((q) => [q.x, q.y]);
    expect(built.payload.stress).toBeCloseTo(kruskalStress(d, coords, imputed), 3);
  });

  it("reads one triangle only, as the triangular calls fill it", () => {
    const full = simOf(square);
    const upper = full.map((row, i) => row.map((v, j) => (j > i ? v : null)));
    const a = buildTasteMap({ source: "screener", members: members(5), sim: full });
    const b = buildTasteMap({ source: "screener", members: members(5), sim: upper });
    expect(b).toEqual(a);
  });

  it("omits a member with no scored pair and keeps the caller's omissions", () => {
    const sim = simOf([...square, [0.1, 0.1]]);
    for (let j = 0; j < 6; j++) {
      sim[5]![j] = null;
      sim[j]![5] = null;
    }
    const built = buildTasteMap({
      source: "substitution_map",
      members: members(6),
      sim,
      omitted: [{ label: "Brand Z", ref: null, reason: "dropped" }],
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload.k).toBe(5);
    expect(built.payload.points.map((q) => q.key)).not.toContain("R6");
    expect(built.payload.omitted).toEqual([
      { label: "Brand Z", ref: null, reason: "dropped" },
      { label: "Brand F", ref: "R6", reason: "not_scored" },
    ]);
  });

  it("builds three points (the figure lists them) but never fewer, and says why", () => {
    const three = buildTasteMap({ source: "screener", members: members(3), sim: simOf(square.slice(0, 3)) });
    expect(three.ok && three.payload.k).toBe(3);
    expect(TASTE_MAP_DRAW_MIN_K).toBe(4);
    const two = buildTasteMap({ source: "screener", members: members(2), sim: simOf(square.slice(0, 2)) });
    expect(two).toEqual({ ok: false, reason: "insufficient_n", message: "A taste map needs at least 3 entities with a scored pair; only 2 had one." });
    const none = buildTasteMap({ source: "screener", members: members(4), sim: members(4).map(() => [null, null, null, null]) });
    expect(none).toMatchObject({ ok: false, reason: "insufficient_n", message: expect.stringContaining("none had one") });
  });

  it("builds no map when more than half of the pairs are unscored", () => {
    const sim = simOf(square);
    for (const [i, j] of [[0, 2], [0, 3], [1, 3], [1, 4], [2, 4], [3, 4]] as const) {
      sim[i]![j] = null;
      sim[j]![i] = null;
    }
    expect(buildTasteMap({ source: "screener", members: members(5), sim })).toEqual({
      ok: false,
      reason: "not_scored",
      message: "Qloo scored 4 of 10 pairs; a taste map needs at least half of them measured.",
    });
  });

  it("rejects more than 14 members and a matrix of the wrong size", () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => member(i));
    const sim15 = fifteen.map(() => fifteen.map(() => 0.5));
    expect(() => buildTasteMap({ source: "screener", members: fifteen, sim: sim15 })).toThrow(RangeError);
    expect(() => buildTasteMap({ source: "screener", members: members(4), sim: [[null]] })).toThrow(RangeError);
  });
});

describe("tasteMapFromScreen", () => {
  const sim = [
    [null, 0.7, 0.4, 0.3],
    [null, null, 0.5, 0.2],
    [null, null, null, 0.6],
    [null, null, null, null],
  ];
  const members = ["S1", "S2", "S3", "S4"].map((key, i) => ({ key, label: `Brand ${key}`, target: i === 0, hub: null }));

  it("maps a whole screen from its upper triangle, with no refs (the screener is not a run)", () => {
    const built = tasteMapFromScreen({ members, sim, complete: true });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.payload).toMatchObject({ source: "screener", k: 4 });
    expect(built.payload.points.every((p) => p.ref === null)).toBe(true);
    expect(built.payload.points[0]).toMatchObject({ key: "S1", target: true });
  });

  it("builds no map from a screen that lost a call, and says so", () => {
    expect(tasteMapFromScreen({ members, sim, complete: false })).toMatchObject({ ok: false, reason: "error" });
  });
});
