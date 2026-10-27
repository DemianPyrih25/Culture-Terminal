// Map-city centres and the per-metro place search area (D28, D44), checked against the gazetteers.
import { MetroId } from "@ct/contracts";
import { createGeo } from "@ct/geo";
import { describe, expect, it } from "vitest";
import { marketLabel, METRO_CENTRES, metroReachKm, PLACE_SEARCH_MIN_RADIUS_MILES, placeSearchArea } from "@ct/quant";
import raw from "../../../../config/metros.json";

describe("METRO_CENTRES", () => {
  const geo = createGeo();

  it("places each of the 13 map cities inside one of its own gazetteer areas, near its config centre", async () => {
    await Promise.all(MetroId.options.map((metro) => geo.ensure(metro)));
    expect(Object.keys(METRO_CENTRES)).toEqual(MetroId.options);
    for (const metro of MetroId.options) {
      const centre = METRO_CENTRES[metro];
      expect(geo.locate(metro, centre), metro).not.toBeNull();
      const config = raw.gazetteer.find((m) => m.id === metro)?.center;
      expect(Math.abs((config?.lat ?? 0) - centre.lat), metro).toBeLessThan(0.01);
      expect(Math.abs((config?.lon ?? 0) - centre.lon), metro).toBeLessThan(0.01);
    }
  });
});

describe("placeSearchArea", () => {
  it("keeps Nashville's and Austin's 25-mile search around the same centres, so their cache keys hold", () => {
    expect(placeSearchArea("nashville")).toEqual({ centre: { lat: 36.1627, lon: -86.7816 }, radiusMiles: 25 });
    expect(placeSearchArea("austin")).toEqual({ centre: { lat: 30.2672, lon: -97.7431 }, radiusMiles: 25 });
  });

  it("reaches every corner of a map city's gazetteer bounds, so a venue anywhere on the map resolves", () => {
    const geo = createGeo();
    for (const metro of MetroId.options) {
      const area = placeSearchArea(metro);
      expect(area, metro).not.toBeNull();
      // Every area centroid lies inside the radius.
      const radiusKm = (area?.radiusMiles ?? 0) * 1.609344;
      for (const n of geo.neighbourhoods(metro)) {
        const dLat = (n.centroid.lat - METRO_CENTRES[metro].lat) * 111.2;
        const dLon = (n.centroid.lon - METRO_CENTRES[metro].lon) * 111.2 * Math.cos((METRO_CENTRES[metro].lat * Math.PI) / 180);
        expect(Math.hypot(dLat, dLon), `${metro} ${n.id}`).toBeLessThan(radiusKm);
      }
    }
    expect(placeSearchArea("los_angeles")?.radiusMiles).toBe(84);
    expect(placeSearchArea("seattle")?.radiusMiles).toBe(70);
  });

  it("searches every market around its config centre, never under the floor", () => {
    expect(raw.markets).toHaveLength(51);
    for (const m of raw.markets) {
      const area = placeSearchArea(m.id);
      expect(area?.radiusMiles, m.id).toBeGreaterThanOrEqual(PLACE_SEARCH_MIN_RADIUS_MILES);
      if (!MetroId.safeParse(m.id).success) expect(area?.centre, m.id).toEqual(m.center);
    }
    expect(placeSearchArea("washington_dc")).toEqual({ centre: { lat: 38.91, lon: -77.04 }, radiusMiles: 25 });
    expect(placeSearchArea("riverton")).toBeNull();
  });
});

describe("metroReachKm", () => {
  it("takes the floor for a compact metro and the search radius for a large county", () => {
    expect(metroReachKm("nashville", 60)).toBe(60);
    expect(metroReachKm("los_angeles", 60)).toBeCloseTo(84 * 1.609344, 6);
  });
});

describe("marketLabel", () => {
  it("names a map city, a market by its config label, and an unknown id in words", () => {
    expect(marketLabel("nyc")).toBe("New York City");
    expect(marketLabel("st_louis")).toBe("St. Louis");
    expect(marketLabel("washington_dc")).toBe("Washington");
    expect(marketLabel("riverton_falls")).toBe("Riverton Falls");
  });
});
