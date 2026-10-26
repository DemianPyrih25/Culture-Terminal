// LiftMap scales: geohash arithmetic, the log2 lift ramp with confidence as alpha, the RAW/BASE
// percentile ramp, the labelled neighbourhoods, chip placement and the precision badge.
import type { GeoLiftCell, GeoLiftPayload } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import {
  LIFT_CLAMP,
  cellFills,
  encodeGeohash,
  formatLift,
  geohashBounds,
  geohashCentre,
  heatPercentiles,
  liftLabels,
  liftRadius,
  liftRgb,
  liftT,
  placeChips,
  precisionBadge,
  unionBounds,
} from "../../components/figures";
import { austinLiftMap, coarseLiftMap } from "../../components/figures/fixtures";
import { COARSE_CONF_FLOOR, cellAlpha, focusBounds, heatRgb } from "../../components/figures/lift-scale";

const cell = (geohash: string, extra: Partial<GeoLiftCell> = {}): GeoLiftCell => ({
  geohash,
  raw: 0.5,
  base: 0.5,
  lift: 1,
  gated: true,
  conf: 0.8,
  neighbourhood: null,
  ...extra,
});

describe("geohash", () => {
  it("decodes a cell to its bounds and centre, and encodes a point back to it", () => {
    const b = geohashBounds("9v6k")!;
    expect(b[0]).toBeLessThan(b[2]);
    expect(b[1]).toBeLessThan(b[3]);
    const c = geohashCentre("9v6kp1")!;
    expect(encodeGeohash(c.lat, c.lon, 6)).toBe("9v6kp1");
    expect(encodeGeohash(c.lat, c.lon, 4)).toBe("9v6k");
    // Public geography: a geohash-4 cell over central Austin.
    expect(c.lat).toBeGreaterThan(30);
    expect(c.lat).toBeLessThan(30.5);
    expect(c.lon).toBeGreaterThan(-98);
    expect(c.lon).toBeLessThan(-97.5);
  });

  it("refuses strings that are not geohashes", () => {
    expect(geohashBounds("")).toBeNull();
    expect(geohashBounds("9v6a")).toBeNull();
    expect(geohashBounds("0123456789bcd")).toBeNull();
  });

  it("boxes several cells and skips non-geohashes", () => {
    const box = unionBounds(["9v6k", "9v6m", "nope!"])!;
    const k = geohashBounds("9v6k")!;
    const m = geohashBounds("9v6m")!;
    expect(box).toEqual([Math.min(k[0], m[0]), Math.min(k[1], m[1]), Math.max(k[2], m[2]), Math.max(k[3], m[3])]);
    expect(unionBounds([])).toBeNull();
  });
});

describe("lift ramp", () => {
  it("is log2-symmetric around 1.00× and clamped to 0.6–1.6×", () => {
    expect(liftT(1)).toBe(0);
    expect(liftT(LIFT_CLAMP.max)).toBeCloseTo(1);
    expect(liftT(LIFT_CLAMP.min)).toBeCloseTo(-1);
    expect(liftT(3)).toBe(1);
    expect(liftT(0.2)).toBe(-1);
    expect(liftT(0)).toBe(-1);
    expect(liftT(1.25)).toBeGreaterThan(0);
    expect(liftT(0.8)).toBeLessThan(0);
  });

  it("runs negative → neutral → data colour", () => {
    expect(liftRgb(1)).toEqual([238, 240, 242]);
    expect(liftRgb(1.6)).toEqual([28, 61, 110]);
    expect(liftRgb(0.6)).toEqual([142, 47, 47]);
    expect(heatRgb(1)).toEqual([28, 61, 110]);
  });

  it("uses confidence as alpha, fades cells at the baseline and below the gate", () => {
    const strong = cellAlpha(cell("9v6k", { lift: 1.6, conf: 0.8 }), "LIFT");
    const weakConf = cellAlpha(cell("9v6k", { lift: 1.6, conf: 0.4 }), "LIFT");
    const atBaseline = cellAlpha(cell("9v6k", { lift: 1, conf: 0.8 }), "LIFT");
    const ungated = cellAlpha(cell("9v6k", { lift: 1.6, conf: 0.8, gated: false }), "LIFT");
    expect(weakConf).toBeCloseTo(strong / 2);
    expect(atBaseline).toBeLessThan(strong);
    expect(ungated).toBeLessThan(strong);
    expect(cellAlpha(cell("9v6k", { conf: 0 }), "LIFT")).toBe(0);
  });

  it("formats lifts with the × sign and sizes markers by lift", () => {
    expect(formatLift(1.4812)).toBe("1.48×");
    expect(formatLift(0.8)).toBe("0.80×");
    expect(liftRadius(1.5)).toBeGreaterThan(liftRadius(1.1));
    expect(liftRadius(0.1)).toBe(3);
    expect(liftRadius(9)).toBe(16);
  });
});

describe("RAW and BASE ramps", () => {
  it("rank each cell by its value with average ranks for ties, skipping absent cells", () => {
    const cells = [cell("a", { raw: 3 }), cell("b", { raw: 1 }), cell("c", { raw: 3 }), cell("d", { raw: null })];
    const pct = heatPercentiles(cells, "RAW");
    expect(pct.get("b")).toBe(0);
    expect(pct.get("a")).toBe(0.75);
    expect(pct.get("c")).toBe(0.75);
    expect(pct.has("d")).toBe(false);
  });

  it("fill only the cells present in the mode", () => {
    const data = {
      ...austinLiftMap.payload,
      cells: [cell("9v6k", { raw: null, base: 0.4, lift: null }), cell("9v6m", { raw: 0.7, base: 0.2, lift: 1.3 })],
    } satisfies GeoLiftPayload;
    expect([...cellFills(data, "RAW").keys()]).toEqual(["9v6m"]);
    expect([...cellFills(data, "BASE").keys()]).toEqual(["9v6k", "9v6m"]);
    expect([...cellFills(data, "LIFT").keys()]).toEqual(["9v6m"]);
  });

  it("keep a coarse map's LIFT layer visible though its cells carry no confidence", () => {
    const coarse = coarseLiftMap.payload;
    expect(coarse.cells.every((c) => c.conf === 0)).toBe(true);
    const fills = cellFills(coarse, "LIFT");
    expect(fills.size).toBe(coarse.cells.length);
    for (const [geohash, f] of fills) expect(f.alpha, geohash).toBeGreaterThan(0);
    // The floor applies to coarse maps only: a fine map's zero-confidence cell stays clear.
    const fine = { ...austinLiftMap.payload, cells: [cell("9v6k", { lift: 1.4, conf: 0 })] } satisfies GeoLiftPayload;
    expect(cellFills(fine, "LIFT").get("9v6k")!.alpha).toBe(0);
    // A gated coarse cell at the top of the ramp reads as COARSE_CONF_FLOOR × its full alpha.
    const top = { ...coarse, cells: [cell("9v6k", { lift: LIFT_CLAMP.max, conf: 0 })] } satisfies GeoLiftPayload;
    expect(cellFills(top, "LIFT").get("9v6k")!.alpha).toBeCloseTo(COARSE_CONF_FLOOR * cellAlpha(cell("9v6k", { lift: LIFT_CLAMP.max, conf: 1 }), "LIFT"));
  });
});

describe("labels and placement", () => {
  it("labels the highest lifts and the lowest below the baseline, the top one with the halo", () => {
    const labels = liftLabels(austinLiftMap.payload, 7);
    const lifted = austinLiftMap.payload.neighbourhoods.filter((n) => n.lift !== null);
    expect(labels).toHaveLength(7);
    expect(labels[0]!.id).toBe(lifted[0]!.id);
    expect(labels[0]!.top).toBe(true);
    expect(labels.filter((l) => l.top)).toHaveLength(1);
    // The two lowest lifts are kept for contrast.
    const lowest = lifted.slice(-2).map((n) => n.id);
    expect(labels.slice(-2).map((l) => l.id)).toEqual(lowest);
    expect(labels.every((l) => l.lift !== null && l.at !== null)).toBe(true);
    expect(labels.some((l) => l.id === "holly")).toBe(false);
  });

  it("makes no neighbourhood claim on a coarse map", () => {
    expect(liftLabels(coarseLiftMap.payload)).toEqual([]);
  });

  it("keeps to the cap when no lift sits below the baseline", () => {
    // Area lifts are geometric means over gated cells and skew above 1.00×: the common real case.
    const above: GeoLiftPayload = {
      ...austinLiftMap.payload,
      neighbourhoods: austinLiftMap.payload.neighbourhoods.map((n, i) => (n.lift === null ? n : { ...n, lift: 1.05 + 0.04 * (20 - i) })),
    };
    const lifted = above.neighbourhoods.filter((n) => n.lift !== null);
    expect(lifted.length).toBeGreaterThan(7);
    expect(lifted.every((n) => n.lift! >= 1)).toBe(true);
    for (const max of [7, 4, 3, 1]) {
      const labels = liftLabels(above, max);
      expect(labels, `max ${max}`).toHaveLength(max);
      // The highest lifts, in order.
      expect(labels.map((l) => l.id)).toEqual(lifted.slice(0, max).map((n) => n.id));
    }
    expect(liftLabels(above, 0)).toEqual([]);
  });

  it("labels the single highest lift at max 1, even with lifts below the baseline", () => {
    const labels = liftLabels(austinLiftMap.payload, 1);
    expect(labels).toHaveLength(1);
    expect(labels[0]!.top).toBe(true);
    expect(labels[0]!.lift).toBe(Math.max(...austinLiftMap.payload.neighbourhoods.flatMap((n) => (n.lift === null ? [] : [n.lift]))));
  });

  it("places chips beside their markers without overlap and drops one that cannot fit", () => {
    const chips = [
      { id: "a", x: 50, y: 50, r: 5, w: 60, h: 18 },
      { id: "b", x: 60, y: 52, r: 5, w: 60, h: 18 },
      { id: "c", x: 2, y: 2, r: 1, w: 400, h: 18 },
    ];
    const placed = placeChips(chips, { w: 300, h: 120 });
    expect(placed.has("c")).toBe(false);
    const a = placed.get("a")!;
    const b = placed.get("b")!;
    const overlap = a.x < b.x + 60 && b.x < a.x + 60 && a.y < b.y + 18 && b.y < a.y + 18;
    expect(overlap).toBe(false);
  });

  it("opens on the neighbourhood cells when there are some", () => {
    const inside = austinLiftMap.payload.cells.filter((c) => c.neighbourhood !== null).map((c) => c.geohash);
    expect(focusBounds(austinLiftMap.payload)).toEqual(unionBounds(inside));
    expect(focusBounds(coarseLiftMap.payload)).toEqual(unionBounds(coarseLiftMap.payload.cells.map((c) => c.geohash)));
  });

  it("badges the precision, and a coarse map as making no claims", () => {
    expect(precisionBadge(austinLiftMap.payload)).toEqual({ text: "Geohash 6 · precision 0.80", coarse: false });
    expect(precisionBadge(coarseLiftMap.payload).coarse).toBe(true);
    expect(precisionBadge(coarseLiftMap.payload).text).toContain("no neighbourhood claims");
  });
});
