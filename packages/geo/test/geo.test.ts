// The gazetteer over invented neighbourhoods: made-up names and shapes, no boundary data (D29).
import { METRO_LABEL, MetroId } from "@ct/contracts";
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
  it("a metro without a gazetteer: listed, every lookup empty, and the source says so", () => {
    const geo = createGeo({ gazetteers: {} });
    expect(geo.metros()).toEqual(MetroId.options);
    for (const metro of geo.metros()) {
      expect(geo.neighbourhoods(metro)).toEqual([]);
      expect(geo.neighbourhood(metro, "maple_hollow")).toBeNull();
      expect(geo.matchNeighbourhood(metro, "Maple Hollow")).toBeNull();
      expect(geo.polygonWkt(metro, "maple_hollow")).toBeNull();
      expect(geo.locate(metro, { lat: 36.11, lon: -86.79 })).toBeNull();
      expect(geo.boundarySource(metro)).toMatch(new RegExp(`^No neighbourhood boundaries for ${METRO_LABEL[metro]} in this build`));
    }
  });

  it("ships the Nashville, Austin and NYC gazetteers by default", () => {
    expect(Object.keys(GAZETTEERS)).toEqual(["nashville", "austin", "nyc"]);
    const geo = createGeo();
    expect(geo.neighbourhoods("nashville").length).toBeGreaterThan(0);
    expect(geo.neighbourhoods("austin").length).toBeGreaterThan(0);
    for (const metro of geo.metros()) expect(geo.boundarySource(metro)).not.toMatch(/^No neighbourhood boundaries/);
  });

  it("serves a shipped gazetteer once contracts MetroId takes its metro, and not before", () => {
    const geo = createGeo();
    for (const [metro, gazetteer] of Object.entries(GAZETTEERS)) {
      const served = MetroId.safeParse(metro);
      if (served.success) expect(geo.neighbourhoods(served.data), metro).toHaveLength(gazetteer.areas.length);
      else expect(geo.metros(), metro).not.toContain(metro);
    }
  });

  it("uses a build-time query polygon, centroid and area when the data module carries them", () => {
    const area = SYNTHETIC.areas[1];
    if (area === undefined) throw new Error("fixture");
    const query = square(-86.71, 36.19, 0.02);
    const geo = createGeo({
      gazetteers: { nashville: { ...SYNTHETIC, areas: [{ ...area, query, centroid: { lat: 36.2, lon: -86.7 }, areaKm2: 1.25 }] } },
    });
    expect(geo.polygonWkt("nashville", "cedar_bend")).toBe("POLYGON((-86.71 36.19,-86.69 36.19,-86.69 36.21,-86.71 36.21,-86.71 36.19))");
    expect(geo.neighbourhood("nashville", "cedar_bend")).toMatchObject({ centroid: { lat: 36.2, lon: -86.7 }, areaKm2: 1.25 });
    const tooLong = circle(-86.7, 36.2, 0.01, MAX_WKT_VERTICES);
    expect(() => createGeo({ gazetteers: { nashville: { ...SYNTHETIC, areas: [{ ...area, query: tooLong }] } } })).toThrow(/query polygon outside/);
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

  it("matches approximate aliases like names, and refuses one that names another area", () => {
    const [hollow, bend] = SYNTHETIC.areas;
    if (hollow === undefined || bend === undefined) throw new Error("fixture");
    const zipped: Gazetteer = {
      ...SYNTHETIC,
      areas: [{ ...hollow, id: "zcta_00001", name: "ZIP 00001 (Maple Hollow)", aliases: ["ZIP 00001", "00001"], approximateAliases: ["Maple Hollow"] }, bend],
    };
    const geo = createGeo({ gazetteers: { nashville: zipped } });
    expect(geo.matchNeighbourhood("nashville", "the Maple Hollow area")?.id).toBe("zcta_00001");
    expect(geo.matchNeighbourhood("nashville", "ZIP code 00001")?.id).toBe("zcta_00001");
    expect(geo.matchNeighbourhood("nashville", "00001")?.id).toBe("zcta_00001");
    expect(geo.neighbourhood("nashville", "zcta_00001")?.name).toBe("ZIP 00001 (Maple Hollow)");
    const clash: Gazetteer = { ...zipped, areas: [...zipped.areas, { ...bend, id: "other", name: "Other", approximateAliases: ["00001"] }] };
    expect(() => createGeo({ gazetteers: { nashville: clash } })).toThrow(/"00001" names both zcta_00001 and other/);
  });

  it("computes a centroid inside the area when the area-weighted one falls in a notch or a hole", () => {
    // A U open to the north: its area-weighted centroid, near 36.1271 -86.77, lies in the notch.
    const u: Polygon = {
      type: "Polygon",
      coordinates: [[[-86.8, 36.1], [-86.74, 36.1], [-86.74, 36.16], [-86.76, 36.16], [-86.76, 36.12], [-86.78, 36.12], [-86.78, 36.16], [-86.8, 36.16], [-86.8, 36.1]]],
    };
    // A square round a hole at its centre.
    const ring: Polygon = {
      type: "Polygon",
      coordinates: [
        [[-86.7, 36.2], [-86.66, 36.2], [-86.66, 36.24], [-86.7, 36.24], [-86.7, 36.2]],
        [[-86.69, 36.21], [-86.69, 36.23], [-86.67, 36.23], [-86.67, 36.21], [-86.69, 36.21]],
      ],
    };
    const geo = createGeo({
      gazetteers: {
        nashville: { ...SYNTHETIC, areas: [{ id: "u_bend", name: "U Bend", geometry: u }, { id: "ring_park", name: "Ring Park", geometry: ring }] },
      },
    });
    const bend = geo.neighbourhood("nashville", "u_bend");
    expect(bend?.centroid.lat).toBeCloseTo(36.12714, 4);
    expect(geo.locate("nashville", bend?.centroid ?? { lat: 0, lon: 0 })).toBe("u_bend");
    expect(Math.abs((bend?.centroid.lon ?? 0) + 86.77)).toBeCloseTo(0.02, 6); // the middle of an arm
    const park = geo.neighbourhood("nashville", "ring_park");
    expect(park?.centroid.lat).toBeCloseTo(36.22, 6);
    expect(geo.locate("nashville", park?.centroid ?? { lat: 0, lon: 0 })).toBe("ring_park");
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
    expect(normaliseAreaName("the Hollow neighbourhood")).toBe("hollow");
    expect(normaliseAreaName("St. Elmo's")).toBe("st elmos");
    expect(normaliseAreaName("The")).toBe("the");
    expect(normaliseAreaName("Area")).toBe("area");
  });

  it("keeps 'the' before a single word, where it is part of a name, but not before a bare ZIP", () => {
    expect(normaliseAreaName("The Hollow")).toBe("the hollow");
    expect(normaliseAreaName("the 00001")).toBe("00001");
  });

  it("writes a ZIP area one way, however the text names it", () => {
    const forms = ["ZIP 00001", "zip code 00001", "ZIP-code 00001", "zipcode 00001", "00001 zipcode", "the 00001 ZIP code", "00001 ZIP area"];
    for (const text of forms) expect(normaliseAreaName(text), text).toBe("zip 00001");
    expect(normaliseAreaName("00001")).toBe("00001");
    expect(normaliseAreaName("ZIP 00001 (Maple Hollow)")).toBe("zip 00001 maple hollow");
    expect(normaliseAreaName("Zip Line Park")).toBe("zip line park");
  });
});
