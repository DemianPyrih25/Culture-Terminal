// The gazetteer over invented neighbourhoods: made-up names and shapes, no boundary data (D29).
import { MetroId } from "@ct/contracts";
import type { Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import { createGeo, GAZETTEERS, MAX_WKT_VERTICES, normaliseAreaName, type Gazetteer } from "../src/index";

const square = (lon: number, lat: number, size: number): Polygon => ({
  type: "Polygon",
  coordinates: [
    [
      [lon, lat],
      [lon + size, lat],
      [lon + size, lat + size],
      [lon, lat + size],
      [lon, lat],
    ],
  ],
});

/** A many-sided ring around a centre, to exercise the WKT vertex budget. */
const circle = (lon: number, lat: number, r: number, sides: number): Polygon => {
  const ring = Array.from({ length: sides }, (_, i) => {
    const t = (2 * Math.PI * i) / sides;
    return [lon + r * Math.cos(t), lat + r * Math.sin(t)];
  });
  return { type: "Polygon", coordinates: [[...ring, ring[0] as number[]]] };
};

const SYNTHETIC: Gazetteer = {
  metro: "nashville",
  source: "Synthetic test boundaries",
  areas: [
    { id: "maple_hollow", name: "Maple Hollow", aliases: ["The Hollow"], geometry: square(-86.8, 36.1, 0.02) },
    { id: "cedar_bend", name: "Cédar Bend", geometry: circle(-86.7, 36.2, 0.01, 120) },
  ],
};

describe("createGeo", () => {
  it("ships no gazetteer yet: metros are listed, every lookup is empty, and the source says so", () => {
    expect(GAZETTEERS).toEqual({});
    const geo = createGeo();
    expect(geo.metros()).toEqual(MetroId.options);
    for (const metro of geo.metros()) {
      expect(geo.neighbourhoods(metro)).toEqual([]);
      expect(geo.neighbourhood(metro, "maple_hollow")).toBeNull();
      expect(geo.matchNeighbourhood(metro, "Maple Hollow")).toBeNull();
      expect(geo.polygonWkt(metro, "maple_hollow")).toBeNull();
      expect(geo.locate(metro, { lat: 36.11, lon: -86.79 })).toBeNull();
      expect(geo.boundarySource(metro)).toMatch(/^No neighbourhood boundaries for (Nashville|Austin) in this build/);
    }
  });

  it("indexes a gazetteer: neighbourhoods with centroid and area, lookups by id and by name", () => {
    const geo = createGeo({ gazetteers: { nashville: SYNTHETIC } });
    const list = geo.neighbourhoods("nashville");
    expect(list.map((n) => n.id)).toEqual(["maple_hollow", "cedar_bend"]);
    const hollow = geo.neighbourhood("nashville", "maple_hollow");
    expect(hollow?.centroid.lat).toBeCloseTo(36.11, 6);
    expect(hollow?.centroid.lon).toBeCloseTo(-86.79, 6);
    // 0.02° × 0.02° at this latitude is a little under 4 km².
    expect(hollow?.areaKm2).toBeGreaterThan(3.5);
    expect(hollow?.areaKm2).toBeLessThan(4);
    expect(geo.neighbourhoods("austin")).toEqual([]);
    expect(geo.boundarySource("nashville")).toBe("Synthetic test boundaries");

    expect(geo.matchNeighbourhood("nashville", "maple hollow neighbourhood")?.id).toBe("maple_hollow");
    expect(geo.matchNeighbourhood("nashville", "the hollow")?.id).toBe("maple_hollow");
    expect(geo.matchNeighbourhood("nashville", "Cedar Bend")?.id).toBe("cedar_bend");
    expect(geo.matchNeighbourhood("nashville", "Hollow Maple")).toBeNull();
    expect(geo.matchNeighbourhood("austin", "Maple Hollow")).toBeNull();
  });

  it("locates a point inside a polygon, not just inside its bounding box", () => {
    const geo = createGeo({ gazetteers: { nashville: SYNTHETIC } });
    expect(geo.locate("nashville", { lat: 36.11, lon: -86.79 })).toBe("maple_hollow");
    expect(geo.locate("nashville", { lat: 36.2, lon: -86.7 })).toBe("cedar_bend");
    // Inside the circle's bounding box but outside the circle.
    expect(geo.locate("nashville", { lat: 36.2095, lon: -86.6905 })).toBeNull();
    expect(geo.locate("nashville", { lat: 30.27, lon: -97.74 })).toBeNull();
  });

  it("writes lon-first canonical WKT within the vertex budget", () => {
    const geo = createGeo({ gazetteers: { nashville: SYNTHETIC } });
    expect(geo.polygonWkt("nashville", "maple_hollow")).toBe(
      "POLYGON((-86.8 36.1,-86.78 36.1,-86.78 36.12,-86.8 36.12,-86.8 36.1))",
    );
    const wkt = geo.polygonWkt("nashville", "cedar_bend") ?? "";
    const points = /^POLYGON\(\((.*)\)\)$/.exec(wkt)?.[1]?.split(",") ?? [];
    expect(points.length).toBeLessThanOrEqual(MAX_WKT_VERTICES);
    expect(points.length).toBeGreaterThan(10);
    expect(points[0]).toBe(points[points.length - 1]);
    for (const p of points) expect(p).toMatch(/^-86\.\d{1,5} 36\.\d{1,5}$/);
  });

  it("decodes geohash centroids and rejects text that is not a geohash", () => {
    const geo = createGeo();
    const c = geo.geohashCentroid("dn6m9");
    expect(c.lat).toBeGreaterThan(36);
    expect(c.lat).toBeLessThan(36.3);
    expect(c.lon).toBeGreaterThan(-87);
    expect(c.lon).toBeLessThan(-86.6);
    expect(() => geo.geohashCentroid("not a hash")).toThrow(RangeError);
  });

  it("refuses malformed gazetteer data at start-up", () => {
    const area = SYNTHETIC.areas[0];
    if (area === undefined) throw new Error("fixture");
    expect(() => createGeo({ gazetteers: { austin: SYNTHETIC } })).toThrow(/declares metro nashville/);
    expect(() => createGeo({ gazetteers: { nashville: { ...SYNTHETIC, areas: [area, area] } } })).toThrow(/repeats/);
    expect(() => createGeo({ gazetteers: { nashville: { ...SYNTHETIC, areas: [{ ...area, id: "Maple Hollow" }] } } })).toThrow(
      /not a valid neighbourhood id/,
    );
    const clash = { ...area, id: "other", aliases: [] };
    expect(() => createGeo({ gazetteers: { nashville: { ...SYNTHETIC, areas: [area, clash] } } })).toThrow(/names both/);
  });
});

describe("normaliseAreaName", () => {
  it("folds case, accents, punctuation, a leading 'the' and a generic suffix", () => {
    expect(normaliseAreaName("  The Cédar-Bend District ")).toBe("cedar bend");
    expect(normaliseAreaName("St. Elmo's")).toBe("st elmos");
    expect(normaliseAreaName("The")).toBe("the");
    expect(normaliseAreaName("Area")).toBe("area");
  });
});
