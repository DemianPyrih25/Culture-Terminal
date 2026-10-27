import { makeId, type Neighbourhood, type QlooHeatmapCell } from "@ct/contracts";
import ngeohash from "ngeohash";
import { describe, expect, it } from "vitest";
import { isLatentDemand, latentDemandFinding, MAX_NAMES_IN_TEXT } from "../../src/findings";
import {
  cellLift,
  heatCells,
  liftGrid,
  MIN_BUSY_AREA_VENUES,
  MIN_RANKED_AREAS,
  MIN_SUPPLY_VENUES,
  precisionFactor,
  rekey,
  rankableVenues,
  rollUp,
  sharedPrecision,
  supplyLabelHolds,
  supplyPercentiles,
  THIN_SUPPLY_LABEL,
  whiteSpace,
  whiteSpaceQuadrant,
  type AreaLift,
  type AreaSupply,
  type HeatCell,
  type LiftGrid,
} from "../../src/skills/geoLift/lift";
import { addLatentDemand, addLiftMetrics, liftDigestRows, TOP_DETAIL_METRICS, type LiftRun } from "../../src/skills/geoLift/outputs";
import { FORMULAS } from "../../src/formulas";
import { createRng } from "../../src/stats";
import { fakeQloo, fakeRun } from "./support/fakes";

// Synthetic heatmaps on public Austin coordinates: the cells and affinities are invented.
const BOX = { minLat: 30.25, minLon: -97.76, maxLat: 30.27, maxLon: -97.74 };

function grid(precision: number, box = BOX): string[] {
  return ngeohash.bboxes(box.minLat, box.minLon, box.maxLat, box.maxLon, precision).sort();
}

function row(geohash: string, affinity: number): QlooHeatmapCell {
  const { latitude, longitude } = ngeohash.decode(geohash);
  return { location: { latitude, longitude, geohash }, query: { affinity } };
}

const cells = (entries: [string, number][]): HeatCell[] => entries.map(([geohash, affinity]) => ({ geohash, affinity }));

function randomMap(seed: string, geohashes: readonly string[]): HeatCell[] {
  const rng = createRng(seed);
  return geohashes.map((geohash) => ({ geohash, affinity: 0.05 + 0.9 * rng() }));
}

function liftsOf(g: LiftGrid): Map<string, number | null> {
  return new Map(g.cells.map((c) => [c.geohash, c.lift]));
}

describe("geo_lift: reading heatmaps", () => {
  it("excludes zero-affinity cells and skips malformed rows", () => {
    const [a, b] = grid(7);
    const parsed = heatCells([row(a!, 0.4), row(b!, 0), row("not-a-geohash", 0.5), { ...row(a!, 0.2), query: { affinity: Number.NaN } }]);
    expect(parsed.cells).toEqual([{ geohash: a, affinity: 0.4 }]);
    expect(parsed).toMatchObject({ zero: 1, invalid: 2 });
  });

  it("normalises precision to the shortest geohash and averages within each prefix (D18)", () => {
    const parent = grid(6)[0]!;
    const children = grid(7).filter((g) => g.startsWith(parent)).slice(0, 2);
    const concept = cells([[children[0]!, 0.2], [children[1]!, 0.6]]);
    const baseline = cells([[parent, 0.5]]);
    expect(sharedPrecision([concept, baseline])).toBe(6);
    expect(sharedPrecision([])).toBeNull();
    const rekeyed = rekey(concept, 6);
    expect([...rekeyed.keys()]).toEqual([parent]);
    expect(rekeyed.get(parent)).toBeCloseTo(0.4, 12);
    const g = liftGrid(concept, baseline)!;
    expect(g.precision).toBe(6);
    expect(g.cells).toHaveLength(1);
  });

  it("weighs precision gh7 1, gh6 0.8, gh5 0.5 and gh4 or coarser 0", () => {
    expect([8, 7, 6, 5, 4, 3].map(precisionFactor)).toEqual([1, 1, 0.8, 0.5, 0, 0]);
  });
});

describe("geo_lift: cell lift", () => {
  const [c1, c2, c3, c4, onlyConcept, onlyBase] = grid(7);

  it("ranks both maps over the cells they share, gates at u ≥ 0.5 and divides the cushioned percentiles", () => {
    const concept = cells([[c1!, 0.4], [c2!, 0.3], [c3!, 0.2], [c4!, 0.1], [onlyConcept!, 0.9]]);
    const baseline = cells([[c1!, 0.1], [c2!, 0.2], [c3!, 0.3], [c4!, 0.4], [onlyBase!, 0.9]]);
    const g = liftGrid(concept, baseline)!;
    const at = (gh: string) => g.cells.find((c) => c.geohash === gh)!;

    expect(g.shared).toBe(4);
    expect(g.gated).toBe(2);
    expect(at(c1!)).toMatchObject({ u: 1, v: 0, gated: true });
    expect(at(c1!).lift).toBeCloseTo(1.05 / 0.05, 12);
    expect(at(c2!).lift).toBeCloseTo(cellLift(2 / 3, 1 / 3), 12);
    expect(at(c3!)).toMatchObject({ gated: false, lift: null });
    // A cell only one map covers keeps its raw or base value and has no lift: not measured, never low.
    expect(at(onlyConcept!)).toMatchObject({ raw: 0.9, base: null, u: null, gated: false, lift: null });
    expect(at(onlyBase!)).toMatchObject({ raw: null, base: 0.9, v: null, lift: null });
  });

  it("gives tied cells the same averaged percentile", () => {
    const concept = cells([[c1!, 0.5], [c2!, 0.5], [c3!, 0.1]]);
    const baseline = cells([[c1!, 0.3], [c2!, 0.2], [c3!, 0.1]]);
    const g = liftGrid(concept, baseline)!;
    expect(g.cells.find((c) => c.geohash === c1)?.u).toBe(g.cells.find((c) => c.geohash === c2)?.u);
    expect(g.cells.find((c) => c.geohash === c1)?.u).toBeCloseTo(0.75, 12);
  });

  it("holds raw heat only without a baseline, and nothing without a concept cell", () => {
    const g = liftGrid(cells([[c1!, 0.4], [c2!, 0.2]]), null)!;
    expect(g.shared).toBe(0);
    expect(g.cells.every((c) => c.lift === null && !c.gated && c.base === null)).toBe(true);
    expect(liftGrid([], cells([[c1!, 0.4]]))).toBeNull();
  });

  it("gives lift ≡ 1 when the concept is the baseline (property)", () => {
    for (const seed of ["a", "b", "c", "d", "e"]) {
      const map = randomMap(seed, grid(7));
      const g = liftGrid(map, map)!;
      expect(g.gated).toBeGreaterThan(0);
      for (const c of g.cells) if (c.gated) expect(c.lift).toBeCloseTo(1, 12);
    }
  });

  it("is invariant to monotone transforms of raw affinity (property)", () => {
    for (const seed of ["f", "g", "h"]) {
      const geohashes = grid(7);
      const concept = randomMap(`concept-${seed}`, geohashes);
      const baseline = randomMap(`baseline-${seed}`, geohashes);
      const reference = liftsOf(liftGrid(concept, baseline)!);
      const transforms = [(x: number) => x ** 3, (x: number) => Math.exp(4 * x), (x: number) => Math.log(x) + 10];
      for (const f of transforms) {
        const moved = concept.map((c) => ({ ...c, affinity: f(c.affinity) }));
        expect(liftsOf(liftGrid(moved, baseline.map((c) => ({ ...c, affinity: f(c.affinity) })))!)).toEqual(reference);
      }
    }
  });
});

describe("geo_lift: neighbourhood roll-up", () => {
  const geohashes = grid(7);
  const west = geohashes.filter((g) => ngeohash.decode(g).longitude < -97.75);
  const area = (id: string, areaKm2 = 2): Neighbourhood => ({ id, name: id.replace(/_/g, " "), metro: "austin", centroid: { lat: 30.26, lon: -97.75 }, areaKm2 });
  const areaOf = (g: string) => (ngeohash.decode(g).longitude < -97.75 ? "alder_flats" : "birch_hollow");

  function concentratedGrid(): LiftGrid {
    // The concept is hottest in the west; the baseline is flat-ish, so the west lifts.
    const concept = geohashes.map((g, i) => ({ geohash: g, affinity: west.includes(g) ? 0.6 + 0.001 * i : 0.1 + 0.001 * i }));
    const baseline = geohashes.map((g, i) => ({ geohash: g, affinity: 0.3 + 0.001 * ((i * 7) % 31) }));
    return liftGrid(concept, baseline)!;
  }

  it("takes the geometric mean of gated cell lifts with n ≥ 5 and confidence min(1, n/12)·prec", () => {
    const g = concentratedGrid();
    const [alder, birch, empty] = rollUp({ grid: g, areas: [area("alder_flats"), area("birch_hollow"), area("cedar_point")], areaOf, gap: null });
    const westLifts = g.cells.filter((c) => c.lift !== null && areaOf(c.geohash) === "alder_flats").map((c) => c.lift!);
    expect(alder!.n).toBe(westLifts.length);
    expect(alder!.lift).toBeCloseTo(Math.exp(westLifts.reduce((s, l) => s + Math.log(l), 0) / westLifts.length), 12);
    expect(alder!.conf).toBe(Math.min(1, alder!.n / 12) * 1);
    // A lone area with a lift is not ranked: a percentile of one would read as top demand.
    expect(alder!.demandPct).toBeNull();
    // The east holds no gated cell: shared cells but too few to read.
    expect(birch).toMatchObject({ n: 0, lift: null, conf: null, reason: "insufficient_n", demandPct: null });
    expect(birch!.covered).toBeGreaterThan(0);
    expect(empty).toMatchObject({ covered: 0, lift: null, reason: "not_measured" });
  });

  it("makes no neighbourhood claim at gh4 or coarser, and passes a missing baseline through as the reason", () => {
    const coarse = { ...concentratedGrid(), precision: 4 };
    expect(rollUp({ grid: coarse, areas: [area("alder_flats")], areaOf, gap: null })[0]).toMatchObject({ lift: null, reason: "coarse" });
    const raw = liftGrid(geohashes.map((g) => ({ geohash: g, affinity: 0.5 })), null)!;
    expect(rollUp({ grid: raw, areas: [area("alder_flats")], areaOf, gap: "budget_truncated" })[0]).toMatchObject({ lift: null, reason: "budget_truncated" });
  });

  it("scales confidence by precision at gh5", () => {
    const g = { ...concentratedGrid(), precision: 5 };
    const [alder] = rollUp({ grid: g, areas: [area("alder_flats")], areaOf, gap: null });
    expect(alder!.conf).toBe(Math.min(1, alder!.n / 12) * 0.5);
  });

  it("ranks demand only among at least three areas with a lift", () => {
    // Six gated cells per area, each area's cells sharing one lift.
    const liftCells = (prefix: string, lift: number) =>
      Array.from({ length: 6 }, (_, i) => ({ geohash: `${prefix}${i}`, raw: 0.5, base: 0.5, u: 0.9, v: 0.5, gated: true, lift }));
    const gridOf = (lifts: [string, number][]): LiftGrid => {
      const all = lifts.flatMap(([id, l]) => liftCells(id, l));
      return { precision: 7, cells: all, shared: all.length, gated: all.length };
    };
    const byPrefix = (g: string) => g.slice(0, -1);
    const three = rollUp({ grid: gridOf([["a", 2], ["b", 1.5], ["c", 1]]), areas: [area("a"), area("b"), area("c")], areaOf: byPrefix, gap: null });
    expect(three.map((r) => r.demandPct)).toEqual([1, 0.5, 0]);
    const two = rollUp({ grid: gridOf([["a", 2], ["b", 1.5]]), areas: [area("a"), area("b"), area("c")], areaOf: byPrefix, gap: null });
    expect(two.map((r) => r.lift !== null)).toEqual([true, true, false]);
    expect(two.map((r) => r.demandPct)).toEqual([null, null, null]);
    expect(MIN_RANKED_AREAS).toBe(3);
  });
});

describe("geo_lift: supply and white space", () => {
  const lifted = (id: string, demandPct: number | null, areaKm2 = 1): AreaLift => ({
    id,
    name: id,
    areaKm2,
    covered: 10,
    n: demandPct === null ? 2 : 10,
    lift: demandPct === null ? null : 1 + demandPct,
    conf: demandPct === null ? null : 0.8,
    reason: demandPct === null ? "insufficient_n" : null,
    demandPct,
  });
  const areas = [lifted("a", 1), lifted("b", 2 / 3), lifted("c", 1 / 3), lifted("d", 0), lifted("e", null)];

  it("ranks venue density among the areas with a lift and splits quadrants at the medians", () => {
    const counts = new Map([["a", 0], ["b", 9], ["c", 1], ["d", 6], ["e", 40]]);
    const ws = whiteSpace(areas, counts);
    expect(ws.get("a")).toMatchObject({ count: 0, supplyPct: 0, whiteSpace: 1, quadrant: "LATENT_OPEN" });
    expect(ws.get("b")).toMatchObject({ count: 9, supplyPct: 1, quadrant: "PROVEN_CROWDED" });
    expect(ws.get("b")?.whiteSpace).toBeCloseTo(0, 12);
    expect(ws.get("c")?.quadrant).toBe("COLD");
    expect(ws.get("c")?.supplyPct).toBeCloseTo(1 / 3, 12);
    expect(ws.get("d")).toMatchObject({ quadrant: "SATURATED", whiteSpace: 0 });
    expect(ws.get("d")?.supplyPct).toBeCloseTo(2 / 3, 12);
    // An area without a lift keeps its count but gets no percentile, white space or quadrant.
    expect(ws.get("e")).toEqual({ count: 40, supplyPct: null, whiteSpace: null, quadrant: null, thin: false });
  });

  it("uses density, not raw counts", () => {
    const ws = whiteSpace([lifted("big", 1, 10), lifted("mid", 0.5, 2), lifted("small", 0, 1)], new Map([["big", 10], ["mid", 4], ["small", 4]]));
    expect(ws.get("big")?.supplyPct).toBe(0);
    expect(ws.get("mid")?.supplyPct).toBe(0.5);
    expect(ws.get("small")?.supplyPct).toBe(1);
  });

  it("measures nothing without a sample, or with no venue in any area with a lift", () => {
    expect([...whiteSpace(areas, null).values()].every((s) => s.count === null && s.supplyPct === null)).toBe(true);
    const none = whiteSpace(areas, new Map([["e", 3]]));
    expect(none.get("a")).toEqual({ count: 0, supplyPct: null, whiteSpace: null, quadrant: null, thin: true });
    expect(none.get("e")?.count).toBe(3);
  });

  it("ranks no supply among fewer than three areas with a demand percentile, and keeps the counts", () => {
    const one = whiteSpace([lifted("a", 1), lifted("e", null)], new Map([["a", 3], ["e", 1]]));
    expect(one.get("a")).toEqual({ count: 3, supplyPct: null, whiteSpace: null, quadrant: null, thin: true });
    const two = whiteSpace([lifted("a", 1), lifted("b", 0)], new Map([["a", 3], ["b", 1]]));
    expect([...two.values()].every((s) => s.supplyPct === null && s.whiteSpace === null && s.quadrant === null)).toBe(true);
  });

  it("counts a value at the median as high on both axes", () => {
    expect(whiteSpaceQuadrant(0.5, 0.49, 0.5, 0.5)).toBe("LATENT_OPEN");
    expect(whiteSpaceQuadrant(0.5, 0.5, 0.5, 0.5)).toBe("PROVEN_CROWDED");
    expect(whiteSpaceQuadrant(0.49, 0.5, 0.5, 0.5)).toBe("SATURATED");
    expect(whiteSpaceQuadrant(0.49, 0.49, 0.5, 0.5)).toBe("COLD");
  });

  it("never counts the sparsest tie as high supply, even when the median falls on it", () => {
    expect(whiteSpaceQuadrant(0.9, 0, 0.5, 0)).toBe("LATENT_OPEN");
    expect(whiteSpaceQuadrant(0.1, 0, 0.5, 0)).toBe("COLD");
    expect(whiteSpaceQuadrant(0.9, 0.2, 0.5, 0)).toBe("PROVEN_CROWDED");
  });

  it("gives tied densities the bottom of their span, so no sampled venue is 0", () => {
    expect(supplyPercentiles([0, 3, 1, 2])).toEqual([0, 1, 1 / 3, 2 / 3]);
    expect(supplyPercentiles([0, 0, 0, 2, 5])).toEqual([0, 0, 0, 0.75, 1]);
    expect(supplyPercentiles([1, 4, 4])).toEqual([0, 0.5, 0.5]);
    expect(supplyPercentiles([7])).toEqual([null]);
  });

  it("reads high-demand areas with no sampled venue as latent and open when most areas have none", () => {
    // Seven areas, five with no venue in an uncapped sample. Average ranks would put that tie at 1/3, above the
    // 0.3 band and on the median, so the two top-demand areas would read as proven and crowded.
    const seven = [lifted("a", 1), lifted("b", 5 / 6), lifted("c", 4 / 6), lifted("d", 3 / 6), lifted("e", 2 / 6), lifted("f", 1 / 6), lifted("g", 0)];
    const ws = whiteSpace(seven, new Map([["c", 8], ["g", 3]]));
    expect(ws.get("a")).toMatchObject({ count: 0, supplyPct: 0, whiteSpace: 1, quadrant: "LATENT_OPEN" });
    expect(ws.get("b")).toMatchObject({ count: 0, supplyPct: 0, quadrant: "LATENT_OPEN" });
    expect(ws.get("c")).toMatchObject({ count: 8, supplyPct: 1, quadrant: "PROVEN_CROWDED" });
    expect(ws.get("e")).toMatchObject({ supplyPct: 0, quadrant: "COLD" });
    expect(ws.get("g")).toMatchObject({ supplyPct: 5 / 6, quadrant: "SATURATED" });
    expect(isLatentDemand(seven[0]!.demandPct, ws.get("a")!.supplyPct)).toBe(true);
    expect(isLatentDemand(seven[1]!.demandPct, ws.get("b")!.supplyPct)).toBe(true);
    const finding = latentDemandFinding({
      metroLabel: "Austin",
      neighbourhoods: seven.map((a) => ({ name: a.name, demandPct: a.demandPct, supplyPct: ws.get(a.id)?.supplyPct ?? null })),
    });
    expect(finding?.text).toMatch(/^a and b in Austin show high demand/);
    expect(finding?.suggestion).toEqual({ tool: "block_dna", reason: "Profile the Block DNA of a to see what its venue-goers favour." });
  });

  it("never reads an area with no venue in a capped sample as low supply: it ranks only the areas that hold one", () => {
    const seven = [lifted("a", 1), lifted("b", 5 / 6), lifted("c", 4 / 6), lifted("d", 3 / 6), lifted("e", 2 / 6), lifted("f", 1 / 6), lifted("g", 0)];
    const counts = new Map([["b", 1], ["c", 4], ["e", 2], ["g", 6]]);
    const ws = whiteSpace(seven, counts, true);
    // The cap may have cut a's venues: its 0 in the sample stays, with no percentile, white space or quadrant.
    expect(ws.get("a")).toEqual({ count: 0, supplyPct: null, whiteSpace: null, quadrant: null, thin: true });
    expect(ws.get("d")).toEqual({ count: 0, supplyPct: null, whiteSpace: null, quadrant: null, thin: true });
    expect(ws.get("b")).toMatchObject({ count: 1, supplyPct: 0, quadrant: "LATENT_OPEN" });
    expect(ws.get("g")).toMatchObject({ count: 6, supplyPct: 1 });
    // Fewer than three areas holding a sampled venue: nothing is ranked.
    const thin = whiteSpace(seven, new Map([["c", 4], ["g", 1]]), true);
    expect([...thin.values()].every((s) => s.supplyPct === null && s.quadrant === null)).toBe(true);
    expect(thin.get("c")?.count).toBe(4);
  });

  describe("the supply-label rule", () => {
    const six = [lifted("a", 1), lifted("b", 0.8), lifted("c", 0.6), lifted("d", 0.4), lifted("e", 0.2), lifted("f", 0)];

    it("withholds a crowded or saturated reading from fewer than three venues: the area reads Not enough venue data", () => {
      // b is a tiny area: its one sampled venue is the densest of a capped sample, which used to read Proven & crowded.
      const areas6 = six.map((a) => (a.id === "b" ? { ...a, areaKm2: 0.05 } : a));
      const ws = whiteSpace(areas6, new Map([["a", 2], ["b", 1], ["c", 4], ["d", 6], ["e", 2], ["f", 5]]), true);
      expect(ws.get("b")).toEqual({ count: 1, supplyPct: null, whiteSpace: null, quadrant: null, thin: true });
      // The others keep their labels, the busy ones with at least three venues.
      expect(ws.get("d")).toMatchObject({ count: 6, quadrant: "SATURATED", thin: false });
      expect(ws.get("f")).toMatchObject({ count: 5, quadrant: "SATURATED", thin: false });
      expect(ws.get("a")).toMatchObject({ count: 2, quadrant: "LATENT_OPEN", thin: false });
      for (const s of ws.values()) if (s.quadrant === "PROVEN_CROWDED" || s.quadrant === "SATURATED") expect(s.count).toBeGreaterThanOrEqual(MIN_BUSY_AREA_VENUES);
    });

    it("labels nothing when the compared areas hold fewer than ten venues, capped or not", () => {
      const counts = new Map([["a", 1], ["b", 2], ["c", 1], ["d", 3], ["e", 1], ["f", 1]]);
      for (const capped of [false, true]) {
        const ws = whiteSpace(six, counts, capped);
        expect([...ws.values()].every((s) => s.quadrant === null && s.supplyPct === null && s.thin)).toBe(true);
        expect(ws.get("d")?.count).toBe(3);
      }
    });

    it("never reads a capped zero as open, and an uncapped zero still can be", () => {
      const counts = new Map([["b", 3], ["c", 4], ["d", 2], ["e", 3], ["f", 1]]);
      expect(whiteSpace(six, counts, true).get("a")).toMatchObject({ count: 0, quadrant: null, thin: true });
      expect(whiteSpace(six, counts, false).get("a")).toMatchObject({ count: 0, quadrant: "LATENT_OPEN", thin: false });
    });

    it("states each label's floor in one predicate", () => {
      expect(supplyLabelHolds(0, true, "LATENT_OPEN")).toBe(false);
      expect(supplyLabelHolds(0, false, "LATENT_OPEN")).toBe(true);
      expect(supplyLabelHolds(0, false, "COLD")).toBe(true);
      expect(supplyLabelHolds(2, false, "PROVEN_CROWDED")).toBe(false);
      expect(supplyLabelHolds(2, true, "SATURATED")).toBe(false);
      expect(supplyLabelHolds(3, true, "PROVEN_CROWDED")).toBe(true);
      expect(supplyLabelHolds(null, false, "COLD")).toBe(false);
    });

    it("writes the thin label into the digest and the method caveat quotes the floors", () => {
      const areas6 = six.map((a) => (a.id === "b" ? { ...a, areaKm2: 0.05 } : a));
      const ws = whiteSpace(areas6, new Map([["a", 2], ["b", 1], ["c", 4], ["d", 6], ["e", 2], ["f", 5]]), true);
      const empty = { precision: null, areas: new Map(), confidence: new Map(), whiteSpace: new Map(), rank: new Map(), supply: new Map() };
      const rows = liftDigestRows(areas6, ws, empty);
      expect(rows.find((r) => r.name === "b")?.values.quadrant).toBe(THIN_SUPPLY_LABEL);
      expect(rows.find((r) => r.name === "d")?.values.quadrant).toBe("Saturated");
      const caveat = FORMULAS["lift.white_space"].caveats.join(" ");
      expect(caveat).toContain(`at least ${MIN_SUPPLY_VENUES} counted`);
      expect(caveat).toContain(`at least ${MIN_BUSY_AREA_VENUES} in the area`);
      expect(caveat).toContain(THIN_SUPPLY_LABEL);
    });
  });

  it("counts only the sampled venues in areas white space can rank", () => {
    const areas3 = [lifted("a", 1), lifted("b", 0.5), lifted("e", null)];
    expect(rankableVenues(areas3, new Map([["a", 2], ["b", 3], ["e", 40]]))).toBe(5);
  });
});

describe("geo_lift: white-space metrics and LATENT_DEMAND", () => {
  // Twenty-one areas ranked by lift, so Demand_pct = 1 − i/20. The most open area is not latent
  // (supply 0.32 > 0.3), and the third latent area sits outside the top five lifts.
  const SUPPLY_PCT: Readonly<Record<number, number>> = { 0: 0.32, 1: 0.35, 2: 0.25, 3: 0.3, 5: 0.125, 6: 0 };
  const areas: AreaLift[] = Array.from({ length: 21 }, (_, i) => ({
    id: `area_${String(i).padStart(2, "0")}`,
    name: `Area ${String(i).padStart(2, "0")}`,
    areaKm2: 1,
    covered: 20,
    n: 12,
    lift: 3 - 0.1 * i,
    conf: 1,
    reason: null,
    demandPct: 1 - i / 20,
  }));
  const supply = new Map<string, AreaSupply>(
    areas.map((a, i) => {
      const supplyPct = SUPPLY_PCT[i] ?? 0.5 + 0.02 * i;
      return [a.id, { count: 1, supplyPct, whiteSpace: (a.demandPct ?? 0) * (1 - supplyPct), quadrant: "PROVEN_CROWDED", thin: false }];
    }),
  );

  it("gives every area LATENT_DEMAND names a white-space metric it cites", () => {
    const { ctx, ledger } = fakeRun(fakeQloo().api);
    const run: LiftRun = { ctx, metro: "austin", flags: new Set(), evidenceIds: [], metrics: [], findings: [], datasetIds: [], notices: [] };
    const evidence = { maps: [makeId("E", 1), makeId("E", 2)], supply: [makeId("E", 3)] };
    const metrics = addLiftMetrics(run, { grid: null, areas, supply, conceptRefs: ["T1"], evidence, gap: null });
    addLatentDemand(run, areas, supply, metrics);

    expect(TOP_DETAIL_METRICS).toBe(MAX_NAMES_IN_TEXT);
    expect(ledger.metrics.length).toBeLessThanOrEqual(13);
    // Latent areas first by white space (area_06 0.70, area_02 0.675, area_05 0.656), ahead of the non-latent area_00 (0.68).
    expect([...metrics.whiteSpace.keys()]).toEqual(["area_06", "area_02", "area_05"]);
    const finding = ledger.findings.find((f) => f.kind === "LATENT_DEMAND");
    expect(finding?.text).toMatch(/^Area 06, Area 02, Area 05 and 1 more in Austin show high demand/);
    for (const id of ["area_06", "area_02", "area_05"]) expect(finding?.metricIds).toContain(metrics.whiteSpace.get(id)?.id);
    // The fourth latent area cites its lift metric.
    expect(finding?.metricIds).toContain(metrics.areas.get("area_03")?.id);
  });
});
