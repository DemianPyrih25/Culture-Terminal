// LiftMap scales: geohash arithmetic, the log2 lift ramp with confidence as alpha, the RAW/BASE
// percentile ramp, pin and flag sizes, flag placement and the precision badge.
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
  flagSize,
  liftRgb,
  liftT,
  pinRadius,
  placeChips,
  precisionBadge,
  unionBounds,
} from "../../components/figures";
import { austinLiftMap, coarseLiftMap } from "../../components/figures/fixtures";
import {
  MIN_BUSY_AREA_VENUES as QUANT_MIN_BUSY_AREA_VENUES,
  MIN_SUPPLY_VENUES as QUANT_MIN_SUPPLY_VENUES,
  THIN_SUPPLY_LABEL as QUANT_THIN_SUPPLY_LABEL,
} from "@ct/quant";
import { whiteSpace, type AreaLift } from "../../../../packages/quant/src/skills/geoLift/lift";
import { liftTableSpec } from "../../components/figures/lift-map";
import {
  areaSupply,
  COARSE_CONF_FLOOR,
  cellAlpha,
  fewRivals,
  flagName,
  focusBounds,
  heatRgb,
  MIN_BUSY_AREA_VENUES,
  MIN_SUPPLY_VENUES,
  namedAreas,
  namedPins,
  supplyUnknown,
  THIN_SUPPLY_LABEL,
} from "../../components/figures/lift-scale";

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

  it("colours lift on the diverging ramp (red below, paper at 1.00x, green above) and heat on the blue ramp", () => {
    expect(liftRgb(1)).toEqual([238, 234, 226]);
    expect(liftRgb(1.6)).toEqual([30, 122, 79]);
    expect(liftRgb(0.6)).toEqual([180, 50, 44]);
    expect(heatRgb(0)).toEqual([232, 236, 247]);
    expect(heatRgb(1)).toEqual([29, 62, 158]);
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

  it("formats lifts with the × sign and sizes pins and flags", () => {
    expect(formatLift(1.4812)).toBe("1.48×");
    expect(formatLift(0.8)).toBe("0.80×");
    expect(pinRadius({ fewRivals: true })).toBe(20);
    expect(pinRadius({})).toBe(14);
    expect(flagSize({ name: "A long neighbourhood name", lift: 1.2 }).w).toBeGreaterThan(flagSize({ name: "Short", lift: 1.2 }).w);
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

describe("flag names", () => {
  it("keeps a name of up to 30 characters, and shortens a longer one to its bracketed name, first place or first words", () => {
    expect(flagName("West Austin Neighborhood Group")).toBe("West Austin Neighborhood Group");
    expect(flagName("ZIP 37206 (East Nashville)")).toBe("ZIP 37206 (East Nashville)");
    expect(flagName("ZIP 77005 (West University Place)")).toBe("West University Place");
    expect(flagName("Morningside Heights-Hamilton Heights")).toBe("Morningside Heights…");
    expect(flagName("Alder Point Birch Hollow Cedar Bend Dune Park")).toBe("Alder Point Birch Hollow…");
  });

  it("sizes a flag by the name it shows", () => {
    expect(flagSize({ name: "ZIP 77005 (West University Place)", lift: 1.5 })).toEqual(flagSize({ name: "West University Place", lift: 1.5 }));
  });
});

describe("competitor counts on the lift map", () => {
  const base = austinLiftMap.payload;

  it("reads the sample by the same floors and label as geo_lift", () => {
    expect(MIN_SUPPLY_VENUES).toBe(QUANT_MIN_SUPPLY_VENUES);
    expect(MIN_BUSY_AREA_VENUES).toBe(QUANT_MIN_BUSY_AREA_VENUES);
    expect(THIN_SUPPLY_LABEL).toBe(QUANT_THIN_SUPPLY_LABEL);
  });

  it("gives every area the same supply read as geo_lift's white space on the same invented areas", () => {
    // Six invented areas; b is tiny, so its one venue is the densest of the capped sample.
    const lifted = (id: string, demandPct: number, areaKm2 = 1): AreaLift => ({ id, name: id, areaKm2, covered: 10, n: 10, lift: 1 + demandPct, conf: 0.8, reason: null, demandPct, raw: null, rawPct: null, standing: null });
    const areas = [lifted("a", 1), lifted("b", 0.8, 0.05), lifted("c", 0.6), lifted("d", 0.4), lifted("e", 0.2), lifted("f", 0)];
    const counts = new Map([["a", 0], ["b", 1], ["c", 4], ["d", 6], ["e", 2], ["f", 5]]);
    const ws = whiteSpace(areas, counts, true);
    const neighbourhoods = areas.map((a) => {
      const s = ws.get(a.id)!;
      return { id: a.id, name: a.id, n: a.n, lift: a.lift, conf: a.conf, demandPct: a.demandPct, supplyPct: s.supplyPct, supplyCount: s.count, whiteSpace: s.whiteSpace, quadrant: s.quadrant, reason: null };
    });
    const data = { ...base, supply: { source: "places_sample" as const, capped: true, points: [] }, supplyGap: undefined, neighbourhoods };
    for (const n of neighbourhoods) {
      const read = areaSupply(n, data);
      const s = ws.get(n.id)!;
      expect(read.kind, n.id).toBe(s.thin ? "thin" : "label");
      if (read.kind === "label") expect(read.quadrant).toBe(s.quadrant);
    }
    expect(areaSupply(neighbourhoods[0]!, data)).toEqual({ kind: "thin", count: 0, cappedZero: true });
    expect(areaSupply(neighbourhoods[1]!, data)).toEqual({ kind: "thin", count: 1, cappedZero: false });
  });

  it("withholds a stored crowded reading from fewer than three venues", () => {
    const capped = { ...base, supply: { source: "places_sample" as const, capped: true, points: [] }, supplyGap: undefined };
    const neighbourhoods = capped.neighbourhoods.map((n, i) => ({ ...n, supplyCount: n.supplyCount === null ? null : 12, quadrant: i === 0 ? ("PROVEN_CROWDED" as const) : n.quadrant }));
    const first = neighbourhoods[0]!;
    const stored = { ...capped, neighbourhoods: neighbourhoods.map((n, i) => (i === 0 ? { ...n, supplyCount: 1 } : n)) };
    expect(areaSupply({ ...first, supplyCount: 1 }, stored)).toMatchObject({ kind: "thin" });
    expect(areaSupply({ ...first, supplyCount: 3 }, stored)).toMatchObject({ kind: "label", quadrant: "PROVEN_CROWDED" });
    const row = liftTableSpec(stored, "Invented").rows.find((r) => r.key === first.id);
    expect(row !== undefined && "cells" in row ? row.cells[row.cells.length - 1] : null).toBe(THIN_SUPPLY_LABEL);
  });

  it("is unknown with the map's own reason, or for a stored sample too thin to read", () => {
    expect(supplyUnknown({ ...base, supplyGap: "Invented reason." })).toBe("Invented reason.");
    const thin = { ...base, supplyGap: undefined, neighbourhoods: base.neighbourhoods.map((n) => ({ ...n, supplyCount: n.supplyCount === null ? null : 0 })) };
    if (base.supply !== null) expect(supplyUnknown(thin)).toMatch(/places only 0 similar venues/);
    expect(supplyUnknown({ ...base, supply: null, supplyGap: undefined })).toBeNull();
  });

  it("never marks few rivals where the count is unknown, or for an area with no venue in a capped sample", () => {
    const capped = { ...base, supply: { source: "places_sample" as const, capped: true, points: [] }, supplyGap: undefined };
    const counted = capped.neighbourhoods.map((n) => ({ ...n, supplyCount: 12 }));
    expect(fewRivals({ quadrant: "LATENT_OPEN", supplyCount: 0 }, { ...capped, neighbourhoods: counted })).toBe(false);
    expect(fewRivals({ quadrant: "LATENT_OPEN", supplyCount: 2 }, { ...capped, neighbourhoods: counted })).toBe(true);
    expect(fewRivals({ quadrant: "LATENT_OPEN", supplyCount: 2 }, { ...capped, neighbourhoods: counted, supplyGap: "Invented reason." })).toBe(false);
  });

  it("lists and pins the areas the question names, and shows unknown venues as unknown in the table", () => {
    const lifted = base.neighbourhoods.filter((n) => n.lift !== null);
    const last = lifted[lifted.length - 1];
    if (last === undefined) throw new Error("expected areas with a lift");
    const data: GeoLiftPayload = { ...base, focusAreas: [last.id], supplyGap: "Invented reason." };
    expect(namedAreas(data)[0]).toMatchObject({ id: last.id, rank: [expect.any(Number), lifted.length] });
    expect(namedPins(data).map((p) => [p.id, p.named, p.rank])).toEqual([[last.id, true, undefined]]);
    const table = liftTableSpec(data, "Invented");
    // Unknown, never "not measured" or 0; the named area first, with its rank and the map's reason.
    expect(JSON.stringify(table.rows)).toContain('"reason":"Unknown"');
    expect(JSON.stringify(table.rows)).not.toContain("not measured");
    const first = table.rows[0];
    expect(first?.key).toBe(last.id);
    expect(first !== undefined && "cells" in first ? first.cells[0] : null).toBe(`${last.name} · Your area · #${lifted.length} of ${lifted.length}`);
    expect(first !== undefined && "cells" in first ? first.cells[6] : null).toEqual({ kind: "missing", reason: "Unknown: Invented reason." });
    const totals = table.rows.find((r) => r.key === "cells");
    expect(totals !== undefined && "cells" in totals ? totals.cells : []).toContain("Unknown: Invented reason.");
  });
});
