import { describe, expect, it } from "vitest";
import { osmElementUrl, osmReference, OverpassRuntimeError, parseCounts, parseEnvelope, parsePlaces } from "../../src/osm/parse";
import { countsQuery } from "../../src/osm/query";
import { BAR, CAFE, CIRCLE, countsBody, OSM_BASE, placesBody, SQUARE } from "./support";

const plan = (() => {
  const built = countsQuery({ shapes: [SQUARE, CIRCLE], types: [CAFE, BAR] });
  if (built.plan.kind !== "counts") throw new Error("counts plan expected");
  return built.plan;
})();

describe("Overpass answers", () => {
  it("maps count elements back by statement order", () => {
    const counts = parseCounts(countsBody([1, 2, 3, 4]), plan);
    expect(counts).toEqual({
      osmBase: "2026-10-01T12:00:00.000Z",
      counts: { "area-a": { bar: 1, cafe: 2 }, "area-b": { bar: 3, cafe: 4 } },
    });
    expect(osmReference(counts.osmBase)).toBe(`osm-${OSM_BASE}`);
    expect(osmReference(null)).toBe("osm-unknown");
  });

  it("refuses a wrong number of counts or a malformed total", () => {
    expect(() => parseCounts(countsBody([1, 2, 3]), plan)).toThrow(/expected 4 count elements/);
    const bad = countsBody([1, 2, 3, 4]) as { elements: { tags: { total: string } }[] };
    (bad.elements[2] as { tags: { total: string } }).tags.total = "-1";
    expect(() => parseCounts(bad, plan)).toThrow(/whole number/);
    expect(() => parseCounts({ nope: true }, plan)).toThrow();
  });

  it("treats a runtime-error remark as a failure, never as data", () => {
    const body = countsBody([1, 2, 3, 4], { remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' });
    expect(() => parseEnvelope(body)).toThrow(OverpassRuntimeError);
    expect(() => parseCounts(body, plan)).toThrow(OverpassRuntimeError);
  });

  it("keeps named places with a position and a matching type, once each", () => {
    const { places, osmBase } = parsePlaces(
      placesBody([
        { type: "node", id: 11, lat: 10.15, lon: 20.15, tags: { amenity: "cafe", name: "Example Cafe One", brand: "Example Brand" } },
        { type: "way", id: 12, center: { lat: 10.16, lon: 20.16 }, tags: { amenity: "pub", name: " Example Pub " } },
        { type: "node", id: 11, lat: 10.15, lon: 20.15, tags: { amenity: "cafe", name: "Example Cafe One" } },
        { type: "node", id: 13, lat: 10.1, lon: 20.1, tags: { amenity: "cafe" } },
        { type: "way", id: 14, tags: { amenity: "cafe", name: "No Centre" } },
        { type: "node", id: 15, lat: 10.1, lon: 20.1, tags: { amenity: "bank", name: "Example Bank" } },
        { type: "count", id: 0, tags: { total: "1" } },
      ]),
      [CAFE, BAR],
    );
    expect(osmBase).toBe("2026-10-01T12:00:00.000Z");
    expect(places).toEqual([
      { name: "Example Cafe One", brand: "Example Brand", lat: 10.15, lon: 20.15, typeKey: "cafe", osmType: "node", osmId: 11 },
      { name: "Example Pub", brand: null, lat: 10.16, lon: 20.16, typeKey: "bar", osmType: "way", osmId: 12 },
    ]);
    expect(osmElementUrl(places[1] as (typeof places)[number])).toBe("https://www.openstreetmap.org/way/12");
  });

  it("reads a missing data date as unknown", () => {
    expect(parseEnvelope({ elements: [] }).osmBase).toBeNull();
    expect(parseEnvelope({ osm3s: { timestamp_osm_base: "not a date" }, elements: [] }).osmBase).toBeNull();
  });
});
