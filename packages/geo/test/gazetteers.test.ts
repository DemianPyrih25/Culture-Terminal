// The shipped boundary data (D28, D37): geometry validity, ids and names, the WKT budget, stored
// centroid and area, no overlaps, public landmarks landing in the neighbourhood they are known to be
// in, points in areas a gazetteer leaves out landing in none, and each approximate alias naming the
// area that holds the place.
import { area } from "@turf/area";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import { MetroId, type GeoApi } from "@ct/contracts";
import type { Polygon } from "geojson";
import { describe, expect, it } from "vitest";
import { NYC_NTAS } from "../src/data/nyc-ntas";
import { createGeo, GAZETTEERS, MAX_WKT_VERTICES, normaliseAreaName, type Gazetteer, type GazetteerMetro } from "../src/index";
import { centroid, labelPoint, outline } from "../src/shapes";
import { edgesOf, overlapProblem, polygonsOf, ringProblem, signedArea } from "./validity";

/** "nyc" is NYC's served gazetteer, its community districts; "nyc-ntas" the tabulation areas that ship beside it. */
type Label = GazetteerMetro | "nyc-ntas";

interface Built {
  label: Label;
  metro: GazetteerMetro;
  gazetteer: Gazetteer;
}

/** Every gazetteer this build ships: the ones GAZETTEERS serves, and NYC's tabulation areas. */
const BUILT: readonly Built[] = [
  ...(Object.entries(GAZETTEERS) as [GazetteerMetro, Gazetteer][]).map(([metro, gazetteer]) => ({ label: metro, metro, gazetteer })),
  { label: "nyc-ntas", metro: "nyc", gazetteer: NYC_NTAS },
];

/**
 * A GeoApi serving the gazetteer, and the id to ask it by. createGeo serves the GAZETTEERS entry of a
 * contracts MetroId only, so a gazetteer it does not serve (NYC's, until MetroId takes "nyc", and the
 * NYC tabulation areas) is indexed under a stand-in id: its data passes through the same index,
 * validation and lookups.
 */
function geoFor(metro: GazetteerMetro, gazetteer: Gazetteer): { geo: GeoApi; id: MetroId } {
  const parsed = MetroId.safeParse(metro);
  if (parsed.success && GAZETTEERS[parsed.data] === gazetteer) return { geo: createGeo(), id: parsed.data };
  return { geo: createGeo({ gazetteers: { nashville: { ...gazetteer, metro: "nashville" } } }), id: "nashville" };
}

/** Generous metro boxes: every vertex of a metro's data lies inside. */
const METRO_BOX: Record<GazetteerMetro, { minLon: number; minLat: number; maxLon: number; maxLat: number }> = {
  nashville: { minLon: -87.06, minLat: 35.96, maxLon: -86.51, maxLat: 36.41 },
  austin: { minLon: -98.0, minLat: 30.05, maxLon: -97.55, maxLat: 30.55 },
  nyc: { minLon: -74.26, minLat: 40.49, maxLon: -73.69, maxLat: 40.92 },
};

/**
 * The largest plausible area, in km². Nashville's areas are ZIP areas (D37), larger than Austin's
 * planning areas: the largest, ZIP 37221 (Bellevue), is about 117 km². NYC's largest district, Staten
 * Island's South Shore, is about 51 km²; its largest tabulation area, also on Staten Island, about 19 km².
 */
const MAX_AREA_KM2: Record<Label, number> = { nashville: 120, austin: 60, nyc: 60, "nyc-ntas": 25 };

/**
 * Areas whose area-weighted centroid lies outside them, so they store an interior point instead:
 * ZIP 37209 wraps round a bend of the Cumberland River, and its centroid falls on the far bank. East
 * Flatbush and Ridgewood-Maspeth-Middle Village wrap round cemeteries the districts leave out.
 */
const CENTROID_OUTSIDE: Record<Label, readonly string[]> = {
  nashville: ["zcta_37209"],
  austin: [],
  nyc: ["east_flatbush", "ridgewood_maspeth_middle_village"],
  "nyc-ntas": [],
};

/**
 * The data module budget, in JSON characters. NYC has three times Austin's tabulation areas, and their
 * 40-point query outlines alone take about 160,000 characters.
 */
const MAX_CHARS: Record<Label, number> = { nashville: 300_000, austin: 300_000, nyc: 300_000, "nyc-ntas": 450_000 };

/** Every name an area matches by: its display name, its aliases and its approximate aliases. */
const namesOf = (a: Gazetteer["areas"][number]): string[] => [a.name, ...(a.aliases ?? []), ...(a.approximateAliases ?? [])];

describe.each(BUILT.map((b) => [b.label, b] as const))("the %s gazetteer", (label, { metro, gazetteer }) => {
  const areas = gazetteer.areas;

  it("declares its metro, names its source and stays within the size budget", () => {
    expect(gazetteer.metro).toBe(metro);
    expect(gazetteer.source).toMatch(/public domain|CC|ODbL|NYC Open Data Law/);
    expect(areas.length).toBeGreaterThanOrEqual(30);
    expect(JSON.stringify(gazetteer).length).toBeLessThan(MAX_CHARS[label]);
  });

  it("has unique ids, names and aliases", () => {
    expect(new Set(areas.map((a) => a.id)).size).toBe(areas.length);
    expect(new Set(areas.map((a) => normaliseAreaName(a.name))).size).toBe(areas.length);
    const keys = areas.flatMap((a) => [...new Set(namesOf(a).map(normaliseAreaName))]);
    expect(new Set(keys).size).toBe(keys.length);
    for (const a of areas) expect(a.id).toMatch(/^[a-z0-9][a-z0-9_-]{0,63}$/);
  });

  it("has valid, closed, simple rings inside the metro, outer rings counter-clockwise", () => {
    const box = METRO_BOX[metro];
    for (const a of areas) {
      for (const poly of polygonsOf(a.geometry)) {
        poly.forEach((ring, k) => {
          expect(ringProblem(ring), `${a.id} ring ${k}`).toBeNull();
          expect(Math.sign(signedArea(ring)), `${a.id} ring ${k} orientation`).toBe(k === 0 ? 1 : -1);
          for (const [lon, lat] of ring as [number, number][]) {
            expect(lon >= box.minLon && lon <= box.maxLon && lat >= box.minLat && lat <= box.maxLat, `${a.id} vertex ${lon} ${lat}`).toBe(true);
          }
        });
      }
    }
  });

  it("has plausible neighbourhood areas", () => {
    for (const a of areas) {
      const km2 = area(a.geometry) / 1_000_000;
      expect(km2, a.id).toBeGreaterThan(0.1);
      expect(km2, a.id).toBeLessThan(MAX_AREA_KM2[label]);
    }
  });

  it("stores a centroid inside its own area and the area createGeo would compute", () => {
    const { geo, id } = geoFor(metro, gazetteer);
    const outside: string[] = [];
    for (const a of areas) {
      const c = labelPoint(a.geometry);
      expect(a.centroid?.lat, a.id).toBeCloseTo(c.lat, 4);
      expect(a.centroid?.lon, a.id).toBeCloseTo(c.lon, 4);
      expect(geo.locate(id, a.centroid ?? c), a.id).toBe(a.id);
      // The area-weighted centroid where it lies inside the area, an interior point only where it does not.
      const weighted = centroid(outline(a.geometry));
      const inside = geo.locate(id, weighted) === a.id;
      if (inside) expect(c, a.id).toEqual(weighted);
      else outside.push(a.id);
      expect(Math.abs((a.areaKm2 ?? 0) / (area(a.geometry) / 1_000_000) - 1), a.id).toBeLessThan(0.005);
    }
    expect(outside).toEqual(CENTROID_OUTSIDE[label]);
  });

  it("has a simple query polygon within the WKT budget that follows the outline", () => {
    const { geo, id } = geoFor(metro, gazetteer);
    for (const a of areas) {
      const ring = a.query?.coordinates[0] ?? [];
      expect(a.query?.coordinates.length, a.id).toBe(1);
      expect(ringProblem(ring), `${a.id} query`).toBeNull();
      expect(ring.length, a.id).toBeLessThanOrEqual(MAX_WKT_VERTICES);
      const share = Math.abs(signedArea(ring)) / Math.abs(signedArea(outline(a.geometry)));
      expect(share, a.id).toBeGreaterThan(0.8);
      expect(share, a.id).toBeLessThan(1.2);
      const wkt = geo.polygonWkt(id, a.id) ?? "";
      const points = /^POLYGON\(\((.*)\)\)$/.exec(wkt)?.[1]?.split(",") ?? [];
      expect(points.length, a.id).toBe(ring.length);
      expect(points[0]).toBe(points[points.length - 1]);
    }
  });

  it("does not overlap: no edges cross and no vertex or edge midpoint lies inside another area", () => {
    const shapes = areas.map((a) => ({ id: a.id, edges: edgesOf(a.geometry) }));
    for (let i = 0; i < shapes.length; i++) {
      for (let j = i + 1; j < shapes.length; j++) {
        const [x, y] = [shapes[i], shapes[j]] as [(typeof shapes)[number], (typeof shapes)[number]];
        expect(overlapProblem(x.edges, y.edges), `${x.id} and ${y.id}`).toBeNull();
      }
    }
  });

  it("does not overlap: no sampled point lies inside two neighbourhoods", () => {
    const shapes = areas.map((a) => {
      const pts = polygonsOf(a.geometry).flat(2);
      const lons = pts.map((p) => p[0] as number);
      const lats = pts.map((p) => p[1] as number);
      return { id: a.id, g: a.geometry, minLon: Math.min(...lons), maxLon: Math.max(...lons), minLat: Math.min(...lats), maxLat: Math.max(...lats) };
    });
    const minLon = Math.min(...shapes.map((s) => s.minLon));
    const maxLon = Math.max(...shapes.map((s) => s.maxLon));
    const minLat = Math.min(...shapes.map((s) => s.minLat));
    const maxLat = Math.max(...shapes.map((s) => s.maxLat));
    let inside = 0;
    // An irregular step keeps sample points off the 5-decimal vertex lattice.
    for (let lon = minLon + 0.00113; lon < maxLon; lon += 0.00317) {
      for (let lat = minLat + 0.00071; lat < maxLat; lat += 0.00291) {
        const hits = shapes.filter(
          (s) => lon >= s.minLon && lon <= s.maxLon && lat >= s.minLat && lat <= s.maxLat && booleanPointInPolygon([lon, lat], s.g, { ignoreBoundary: true }),
        );
        if (hits.length > 0) inside++;
        expect(hits.length, `${lon} ${lat}: ${hits.map((h) => h.id).join(", ")}`).toBeLessThanOrEqual(1);
      }
    }
    expect(inside).toBeGreaterThan(1000);
  });
});

describe("the exact overlap check", () => {
  const square = (x0: number, y0: number, x1: number, y1: number): Polygon => ({
    type: "Polygon",
    coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]],
  });
  const base = edgesOf(square(-97.7, 30.2, -97.69, 30.21));

  it("allows neighbours that share a border, a T-junction or a corner", () => {
    expect(overlapProblem(base, edgesOf(square(-97.69, 30.2, -97.68, 30.21)))).toBeNull();
    expect(overlapProblem(base, edgesOf(square(-97.69, 30.205, -97.68, 30.215)))).toBeNull();
    expect(overlapProblem(base, edgesOf(square(-97.69, 30.21, -97.68, 30.22)))).toBeNull();
  });

  it("catches a one-metre sliver, a contained area and a diagonal that only meets the boundary at vertices", () => {
    expect(overlapProblem(base, edgesOf(square(-97.69001, 30.2, -97.68, 30.21)))).not.toBeNull();
    expect(overlapProblem(base, edgesOf(square(-97.698, 30.202, -97.692, 30.208)))).not.toBeNull();
    const half: Polygon = { type: "Polygon", coordinates: [[[-97.7, 30.2], [-97.69, 30.2], [-97.69, 30.21], [-97.7, 30.2]]] };
    expect(overlapProblem(base, edgesOf(half))).not.toBeNull();
  });
});

/** Public landmarks, at least 150 m inside the planning area they belong to. */
const AUSTIN_LANDMARKS: readonly [string, number, number, string][] = [
  ["Texas State Capitol", 30.27467, -97.74035, "downtown"],
  ["UT Tower", 30.28613, -97.73937, "university_of_texas"],
  ["Elisabet Ney Museum", 30.30726, -97.72639, "hyde_park"],
  ["Thinkery, Mueller", 30.29872, -97.70591, "mueller"],
  ["West 24th and Rio Grande Streets, West Campus", 30.2879, -97.7447, "west_university"],
  ["Speedway and East 32nd Street, North Campus", 30.2963, -97.7362, "north_university"],
  ["Fiesta Gardens", 30.2516, -97.7235, "holly"],
  ["Plaza Saltillo", 30.2626, -97.7298, "east_cesar_chavez"],
  ["Victory Grill, East 11th Street", 30.26929, -97.72842, "central_east_austin"],
  ["Big Stacy Park, Travis Heights", 30.23852, -97.74306, "south_river_city"],
  ["Oracle waterfront campus, East Riverside", 30.2421, -97.7225, "riverside"],
  ["Zilker Elementary School", 30.2537, -97.7663, "zilker"],
  ["Barton Springs Pool", 30.26394, -97.77134, "barton_hills"],
  ["Lions Municipal Golf Course, Tarrytown", 30.2905, -97.7748, "west_austin_neighborhood_group"],
  ["Clarksville", 30.279, -97.76, "old_west_austin"],
  ["Cherrywood Coffeehouse", 30.2947, -97.7158, "upper_boggy_creek"],
  ["St. Edward's University", 30.2289, -97.7536, "st_edwards"],
  ["The Domain", 30.4021, -97.7253, "north_burnet"],
];

describe("Austin lookups", () => {
  const geo = createGeo();

  it.each(AUSTIN_LANDMARKS)("%s lies in its neighbourhood", (_name, lat, lon, id) => {
    expect(geo.locate("austin", { lat, lon })).toBe(id);
  });

  it("leaves points outside the planning areas unassigned", () => {
    expect(geo.locate("austin", { lat: 30.1975, lon: -97.6664 })).toBeNull(); // the airport
    expect(geo.locate("austin", { lat: 36.1612, lon: -86.7785 })).toBeNull(); // Nashville
  });

  it.each([
    ["Travis Heights", "south_river_city"],
    ["Mueller", "mueller"],
    ["RMMA", "mueller"],
    ["East Riverside", "riverside"],
    ["East 11th", "central_east_austin"],
    ["Downtown Austin", "downtown"],
    ["UT", "university_of_texas"],
    ["Tarrytown", "west_austin_neighborhood_group"],
    ["Clarksville", "old_west_austin"],
    ["Cherrywood", "upper_boggy_creek"],
    ["the Holly neighborhood", "holly"],
    ["East Cesar Chávez", "east_cesar_chavez"],
    ["Zilker", "zilker"],
    ["Hyde Park", "hyde_park"],
    ["West Campus", "west_university"],
    ["North Campus", "north_university"],
  ])("matches %s by name or alias", (text, id) => {
    expect(geo.matchNeighbourhood("austin", text)?.id).toBe(id);
  });

  it("spells display names as readers do", () => {
    expect(geo.neighbourhood("austin", "mckinney")?.name).toBe("McKinney");
    expect(geo.neighbourhood("austin", "mueller")?.name).toBe("Mueller");
  });

  it("does not guess at names that straddle planning areas, cover a small part of one or are not in the data", () => {
    expect(geo.matchNeighbourhood("austin", "South Congress")).toBeNull();
    // Official sub-districts that cover too little of their planning area to stand for it.
    expect(geo.matchNeighbourhood("austin", "Blackland")).toBeNull();
    expect(geo.matchNeighbourhood("austin", "Fairview Park")).toBeNull();
    expect(geo.matchNeighbourhood("austin", "East Nashville")).toBeNull();
  });

  it("names the boundary source for captions", () => {
    expect(geo.boundarySource("austin")).toBe("City of Austin Neighborhood Planning Areas (data.austintexas.gov), public domain");
  });
});

/**
 * Public landmarks, at least 150 m inside the ZIP area of their street address. Fort Negley and Radnor
 * Lake are USGS GNIS points; the others are rounded to 4 decimals.
 */
const NASHVILLE_LANDMARKS: readonly [string, number, number, string][] = [
  ["Centennial Park and the Parthenon, 2500 West End Avenue", 36.1497, -86.8133, "zcta_37203"],
  ["Fort Negley, 1100 Fort Negley Boulevard", 36.145, -86.775, "zcta_37203"],
  ["Belmont University, 1900 Belmont Boulevard", 36.1335, -86.7957, "zcta_37212"],
  ["Fisk University, 1000 17th Avenue North", 36.1685, -86.805, "zcta_37208"],
  ["Shelby Park, 401 South 20th Street", 36.168, -86.7335, "zcta_37206"],
  ["Five Points, Woodland and South 11th Streets", 36.1766, -86.7497, "zcta_37206"],
  ["Radnor Lake, 1160 Otter Creek Road", 36.06078, -86.80284, "zcta_37220"],
];

/**
 * Each approximate alias (D37) with the USGS GNIS point of that place, at least 300 m inside its ZIP
 * area. GNIS puts Joelton's populated-place point 30 m from the edge of ZIP 37080, so the former Joelton
 * Air Force Station, also a GNIS point, stands in for it.
 */
const NASHVILLE_ALIASES: readonly [string, number, number, string][] = [
  ["East Nashville", 36.17256, -86.75972, "zcta_37206"],
  ["Inglewood", 36.21422, -86.73028, "zcta_37216"],
  ["Green Hills", 36.10367, -86.81667, "zcta_37215"],
  ["Donelson", 36.16256, -86.67, "zcta_37214"],
  ["Antioch", 36.06006, -86.67222, "zcta_37013"],
  ["Hermitage", 36.19617, -86.6225, "zcta_37076"],
  ["Madison", 36.25616, -86.71389, "zcta_37115"],
  ["Old Hickory", 36.25978, -86.64777, "zcta_37138"],
  ["Bellevue", 36.06478, -86.93945, "zcta_37221"],
  ["Joelton", 36.33778, -86.86056, "zcta_37080"],
];

/** ZCTAs too small to stand alone, merged into the neighbour they share the longest border with. */
const MERGED_ZCTAS: Readonly<Record<string, readonly string[]>> = { zcta_37201: ["37238"] };

describe("Nashville lookups", () => {
  const geo = createGeo();
  const areas = GAZETTEERS.nashville?.areas ?? [];

  it.each(NASHVILLE_LANDMARKS)("%s lies in its ZIP area", (_name, lat, lon, id) => {
    expect(geo.locate("nashville", { lat, lon })).toBe(id);
  });

  it.each(NASHVILLE_ALIASES)("%s names the ZIP area that holds its place point", (alias, lat, lon, id) => {
    expect(geo.locate("nashville", { lat, lon })).toBe(id);
    expect(geo.matchNeighbourhood("nashville", alias)?.id).toBe(id);
  });

  it("marks every neighbourhood alias approximate, and Austin has none", () => {
    const approximate = areas.flatMap((a) => (a.approximateAliases ?? []).map((alias) => `${alias} = ${a.id}`));
    expect(approximate.sort()).toEqual(NASHVILLE_ALIASES.map(([alias, , , id]) => `${alias} = ${id}`).sort());
    for (const a of areas) {
      const zips = [a.id.slice("zcta_".length), ...(MERGED_ZCTAS[a.id] ?? [])];
      for (const alias of a.aliases ?? []) expect(zips.flatMap((zip) => [`ZIP ${zip}`, zip]), a.id).toContain(alias);
    }
    expect(GAZETTEERS.austin?.areas.flatMap((a) => a.approximateAliases ?? [])).toEqual([]);
  });

  it("labels ZIP areas as ZIP areas, with the approximate neighbourhood or the county part in brackets", () => {
    for (const a of areas) {
      const zip = /^zcta_(\d{5})$/.exec(a.id)?.[1];
      expect(zip, a.id).toBeDefined();
      const [, nameZip, label] = /^ZIP (\d{5})(?: \((.+)\))?$/.exec(a.name) ?? [];
      expect(nameZip, a.id).toBe(zip);
      if (a.approximateAliases !== undefined) expect(label, a.id).toBe(a.approximateAliases[0]);
      else if (label !== undefined) expect(label, a.id).toBe("Davidson part");
    }
    expect(geo.neighbourhood("nashville", "zcta_37206")?.name).toBe("ZIP 37206 (East Nashville)");
    expect(geo.neighbourhood("nashville", "zcta_37203")?.name).toBe("ZIP 37203");
    expect(geo.neighbourhood("nashville", "zcta_37027")?.name).toBe("ZIP 37027 (Davidson part)");
  });

  it.each([
    ["East Nashville", "zcta_37206"],
    ["east nashville neighborhood", "zcta_37206"],
    ["the East Nashville area", "zcta_37206"],
    ["ZIP 37206 (East Nashville)", "zcta_37206"],
    ["ZIP 37206", "zcta_37206"],
    ["37206", "zcta_37206"],
    ["ZIP code 37206", "zcta_37206"],
    ["the 37206 ZIP code", "zcta_37206"],
    ["zipcode 37206", "zcta_37206"],
    ["the 37206", "zcta_37206"],
    ["zip 37203", "zcta_37203"],
    ["Old Hickory", "zcta_37138"],
    ["Hermitage", "zcta_37076"],
    ["the Hermitage area", "zcta_37076"],
  ])("matches %s by name, ZIP or approximate alias", (text, id) => {
    expect(geo.matchNeighbourhood("nashville", text)?.id).toBe(id);
  });

  it("folds the tiny ZCTA 37238 into ZIP 37201, which answers to its ZIP and holds its block", () => {
    expect(geo.matchNeighbourhood("nashville", "37238")?.id).toBe("zcta_37201");
    expect(geo.matchNeighbourhood("nashville", "ZIP 37238")?.id).toBe("zcta_37201");
    expect(geo.neighbourhood("nashville", "zcta_37201")?.name).toBe("ZIP 37201");
    expect(geo.locate("nashville", { lat: 36.1656, lon: -86.7795 })).toBe("zcta_37201"); // inside the raw 37238 outline
  });

  it("reads The Hermitage, the historic site in ZIP 37138, as no area rather than the community of Hermitage", () => {
    expect(geo.matchNeighbourhood("nashville", "The Hermitage")).toBeNull();
    expect(geo.locate("nashville", { lat: 36.2152, lon: -86.6131 })).toBe("zcta_37138");
  });

  it("does not guess at neighbourhoods inside a larger ZIP area, ZIPs it does not hold or other metros' names", () => {
    const inside = ["12 South", "Germantown", "The Nations", "Midtown", "Wedgewood-Houston", "Sylvan Park", "Lockeland Springs", "Five Points", "The Gulch"];
    for (const name of inside) expect(geo.matchNeighbourhood("nashville", name), name).toBeNull();
    expect(geo.matchNeighbourhood("nashville", "ZIP 78704")).toBeNull();
    expect(geo.matchNeighbourhood("nashville", "Hyde Park")).toBeNull();
    expect(geo.matchNeighbourhood("austin", "37206")).toBeNull();
  });

  it("covers Davidson County and leaves points outside it unassigned", () => {
    // Davidson County's 2020 outline is about 1,361 km² of land and water; the ZIP areas cover all of it.
    const total = areas.reduce((s, a) => s + (a.areaKm2 ?? 0), 0);
    expect(total).toBeGreaterThan(1340);
    expect(total).toBeLessThan(1370);
    expect(geo.locate("nashville", { lat: 35.9251, lon: -86.8689 })).toBeNull(); // Franklin, Williamson County
    expect(geo.locate("nashville", { lat: 30.27467, lon: -97.74035 })).toBeNull(); // Austin
  });

  it("names the boundary source for captions, approximate names included", () => {
    expect(geo.boundarySource("nashville")).toBe(
      "U.S. Census Bureau 2020 ZIP Code Tabulation Areas clipped to Davidson County, public domain; neighbourhood names approximate",
    );
  });
});

/**
 * Public landmarks, at least 150 m inside the tabulation area they lie in, rounded to 4 decimals, with
 * that tabulation area and the district holding it. City Island is a separate part of its areas: a
 * point there is placed in them, though its name is no alias.
 */
const NYC_LANDMARKS: readonly [string, number, number, string, string][] = [
  ["Duffy Square, Times Square", 40.759, -73.9845, "midtown_times_square", "midtown_flatiron_union_square"],
  ["Flatiron Building", 40.7411, -73.9897, "midtown_south_flatiron_union_square", "midtown_flatiron_union_square"],
  ["Washington Square Arch", 40.7312, -73.9971, "greenwich_village", "greenwich_village_soho"],
  ["Stonewall Inn", 40.7334, -74.0021, "west_village", "greenwich_village_soho"],
  ["New York Stock Exchange", 40.7069, -74.0113, "financial_district_battery_park_city", "financial_district_tribeca"],
  ["Lincoln Center", 40.7725, -73.9835, "upper_west_side_lincoln_square", "upper_west_side"],
  ["Low Library, Columbia University", 40.808, -73.9621, "morningside_heights", "morningside_heights_hamilton_heights"],
  ["Fort Greene Park", 40.6914, -73.9754, "fort_greene", "downtown_brooklyn_fort_greene"],
  ["Pratt Institute", 40.6911, -73.9635, "clinton_hill", "downtown_brooklyn_fort_greene"],
  ["Peter Luger Steak House, Broadway", 40.7098, -73.9623, "williamsburg", "williamsburg_greenpoint"],
  ["Third Avenue and Third Street, Gowanus", 40.6748, -73.9888, "carroll_gardens_cobble_hill_gowanus_red_hook", "park_slope_carroll_gardens"],
  ["The Cyclone, Coney Island", 40.5752, -73.9776, "coney_island_sea_gate", "coney_island_brighton_beach"],
  ["Brighton Beach station", 40.5777, -73.9612, "brighton_beach", "coney_island_brighton_beach"],
  ["Troutman Street and St. Nicholas Avenue, Bushwick", 40.7051, -73.9221, "bushwick_west", "bushwick"],
  ["Flushing-Main Street station", 40.7596, -73.83, "flushing_willets_point", "flushing_murray_hill_whitestone"],
  ["Queens Center", 40.7348, -73.8697, "elmhurst", "elmhurst_corona"],
  ["Arthur Avenue Retail Market", 40.855, -73.8884, "belmont", "tremont_belmont_west_farms"],
  ["Hunts Point food markets", 40.81, -73.878, "hunts_point", "longwood_hunts_point"],
  ["Wave Hill", 40.8987, -73.9118, "riverdale_spuyten_duyvil", "riverdale_kingsbridge_marble_hill"],
  ["City Island Avenue", 40.8468, -73.7868, "pelham_bay_country_club_city_island", "co_op_city_throgs_neck"],
];

/**
 * Points in tabulation areas the gazetteers leave out (parks, a cemetery, airports, special areas, each
 * the area the point lies in in the source data) or outside the city: no area holds them, so a lift
 * cell there is left out of every neighbourhood.
 */
const NYC_LEFT_OUT: readonly [string, number, number][] = [
  ["Bethesda Terrace, Central Park", 40.774, -73.9708],
  ["Long Meadow, Prospect Park", 40.665, -73.97],
  ["Yankee Stadium (Yankee Stadium-Macombs Dam Park)", 40.8292, -73.9265],
  ["Bronx Zoo (Bronx Park)", 40.8506, -73.8769],
  ["Green-Wood Cemetery", 40.6528, -73.9903],
  ["John F. Kennedy International Airport", 40.6413, -73.7781],
  ["LaGuardia Airport", 40.7769, -73.874],
  ["United Nations Headquarters", 40.7489, -73.968],
  ["Rikers Island", 40.793, -73.886],
  ["Hoboken, New Jersey", 40.744, -74.0324],
];

/** Parks, a cemetery, an airport and another metro's neighbourhood: names no NYC area answers to. */
const NYC_NO_AREA = ["Central Park", "Prospect Park", "Green-Wood Cemetery", "LaGuardia Airport", "East Nashville"];

/**
 * Each district's approximate aliases (tools/geo/nyc.ts): the places its tabulation areas list, and
 * the base name of a bracketed one, where no other district's areas list the name, no suburb across
 * the city line bears it, and the place lies inside the district's query outline.
 */
const NYC_DISTRICT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  astoria_queensbridge: ["Astoria (North)", "Astoria", "Ditmars", "Steinway", "Old Astoria", "Hallets Point", "Astoria (Central)", "Astoria (East)", "Woodside (North)", "Queensbridge", "Ravenswood", "Dutch Kills"],
  auburndale_bayside_douglaston: ["Auburndale", "Bayside", "Oakland Gardens", "Hollis Hills"],
  bay_ridge_dyker_heights: ["Bay Ridge", "Dyker Heights"],
  bedford_stuyvesant: ["Bedford-Stuyvesant (West)", "Bedford-Stuyvesant (East)"],
  bensonhurst_bath_beach: ["Bensonhurst", "Bath Beach", "Gravesend (West)"],
  borough_park_kensington: ["Sunset Park (East)", "Borough Park (West)", "Borough Park", "Kensington", "Mapleton", "Midwood (West)"],
  bushwick: ["Bushwick (West)", "Bushwick (East)"],
  canarsie_flatlands: ["Flatlands", "Marine Park", "Mill Basin", "Bergen Beach", "Canarsie"],
  chelsea_hells_kitchen: ["Chelsea", "Hudson Yards", "Hell's Kitchen"],
  co_op_city_throgs_neck: ["Westchester Square", "Throgs Neck", "Schuylerville", "Pelham Bay", "Country Club"],
  coney_island_brighton_beach: ["Gravesend (South)", "Coney Island", "Sea Gate", "Brighton Beach"],
  crown_heights_north: ["Prospect Heights"],
  crown_heights_south: ["Prospect Lefferts Gardens", "Wingate"],
  downtown_brooklyn_fort_greene: ["Brooklyn Heights", "Downtown Brooklyn", "DUMBO", "Boerum Hill", "Fort Greene", "Clinton Hill"],
  east_flatbush: ["Erasmus", "Farragut", "Rugby", "Remsen Village"],
  east_harlem: ["East Harlem (South)", "East Harlem (North)"],
  east_midtown_murray_hill: ["Stuyvesant Town", "Peter Cooper Village", "Gramercy", "Kips Bay", "East Midtown", "Turtle Bay"],
  east_new_york_cypress_hills: ["Cypress Hills", "East New York (North)", "East New York", "New Lots", "Spring Creek", "Starrett City", "City Line"],
  elmhurst_corona: ["Elmhurst", "Corona"],
  financial_district_tribeca: ["Financial District", "Battery Park City", "Tribeca", "Civic Center"],
  flatbush_midwood: ["Flatbush", "Flatbush (West)", "Ditmas Park", "Parkville"],
  flushing_murray_hill_whitestone: ["College Point", "Whitestone", "Beechhurst", "Bay Terrace", "Clearview", "Broadway Flushing", "East Flushing", "Queensboro Hill", "Flushing", "Willets Point"],
  fordham_bedford_park_norwood: ["University Heights (North)", "Fordham", "Bedford Park", "Norwood"],
  forest_hills_rego_park: ["Rego Park", "Forest Hills"],
  fresh_meadows_hillcrest_briarwood: ["Kew Gardens Hills", "Pomonok", "Electchester", "Hillcrest", "Fresh Meadows", "Utopia", "Jamaica Estates", "Holliswood", "Jamaica Hills", "Briarwood"],
  greenwich_village_soho: ["SoHo", "Little Italy", "Hudson Square", "Greenwich Village", "West Village"],
  harlem: ["Harlem (South)", "Harlem (North)"],
  highbridge_concourse: ["Concourse", "Concourse Village", "Highbridge", "Mount Eden", "Claremont (West)"],
  jackson_heights_east_elmhurst: ["Jackson Heights", "East Elmhurst", "North Corona"],
  jamaica_st_albans_hollis: ["Jamaica", "South Jamaica", "Baisley Park", "Springfield Gardens (North)", "Rochdale Village", "St. Albans", "Hollis"],
  kew_gardens_richmond_hill_woodhaven: ["Kew Gardens", "Richmond Hill", "South Richmond Hill", "Ozone Park (North)", "Woodhaven"],
  long_island_city_sunnyside_woodside: ["Long Island City", "Hunters Point", "Sunnyside"],
  longwood_hunts_point: ["Hunts Point", "Longwood"],
  lower_east_side_chinatown: ["Chinatown", "Two Bridges", "Lower East Side", "East Village"],
  melrose_mott_haven_port_morris: ["Mott Haven", "Port Morris", "Melrose"],
  mid_island: ["Grasmere", "Arrochar", "South Beach", "Dongan Hills", "New Dorp", "Midland Beach", "Todt Hill", "Emerson Hill", "Lighthouse Hill", "Manor Heights", "New Springville", "Willowbrook", "Bulls Head", "Travis"],
  midtown_flatiron_union_square: ["Midtown South", "Flatiron", "Union Square", "Midtown", "Times Square"],
  morningside_heights_hamilton_heights: ["Morningside Heights", "Manhattanville", "West Harlem", "Hamilton Heights", "Sugar Hill"],
  morris_heights_mount_hope: ["University Heights (South)", "Morris Heights", "Mount Hope", "Fordham Heights"],
  morrisania_crotona_park_east: ["Morrisania", "Claremont Village", "Claremont (East)", "Crotona Park East"],
  north_shore: ["St. George", "New Brighton", "Tompkinsville", "Stapleton", "Clifton", "Fox Hills", "Rosebank", "Shore Acres", "Park Hill", "West New Brighton", "Silver Lake", "Grymes Hill", "Westerleigh", "Castleton Corners", "Port Richmond", "Mariner's Harbor", "Arlington", "Graniteville"],
  ocean_hill_brownsville: ["Ocean Hill", "Brownsville"],
  park_slope_carroll_gardens: ["Carroll Gardens", "Cobble Hill", "Gowanus", "Red Hook", "Park Slope"],
  pelham_parkway_morris_park: ["Pelham Parkway", "Van Nest", "Morris Park", "Pelham Gardens", "Allerton"],
  queens_village_bellerose_rosedale: ["Glen Oaks", "Bellerose", "Queens Village", "Cambria Heights", "Laurelton", "Springfield Gardens (South)", "Brookville", "Rosedale"],
  ridgewood_maspeth_middle_village: ["Maspeth", "Ridgewood", "Glendale", "Middle Village"],
  riverdale_kingsbridge_marble_hill: ["Kingsbridge Heights", "Van Cortlandt Village", "Kingsbridge", "Marble Hill", "Riverdale", "Spuyten Duyvil"],
  sheepshead_bay_gravesend_east: ["Gravesend (East)", "Homecrest", "Madison", "Sheepshead Bay", "Manhattan Beach", "Gerritsen Beach"],
  soundview_parkchester: ["Soundview", "Bruckner", "Bronx River", "Clason Point", "Unionport", "Parkchester"],
  south_ozone_park_howard_beach: ["South Ozone Park", "Howard Beach", "Lindenwood"],
  south_shore: ["Oakwood", "Richmondtown", "Great Kills", "Eltingville", "Arden Heights", "Rossville", "Annadale", "Huguenot", "Prince's Bay", "Woodrow", "Tottenville", "Charleston"],
  sunset_park_windsor_terrace: ["Windsor Terrace", "South Slope", "Sunset Park (West)", "Sunset Park (Central)"],
  the_rockaways: ["Far Rockaway", "Bayswater", "Rockaway Beach", "Arverne", "Edgemere", "Belle Harbor", "Rockaway Park"],
  tremont_belmont_west_farms: ["West Farms", "Tremont", "Belmont"],
  upper_east_side_roosevelt_island: ["Upper East Side", "Carnegie Hill", "Yorkville"],
  upper_west_side: ["Lincoln Square", "Upper West Side (Central)", "Manhattan Valley"],
  wakefield_williamsbridge_eastchester: ["Williamsbridge", "Olinville", "Eastchester", "Edenwald", "Baychester", "Wakefield", "Woodlawn"],
  washington_heights_inwood: ["Washington Heights (South)", "Washington Heights", "Washington Heights (North)", "Inwood"],
  williamsburg_greenpoint: ["Greenpoint", "Williamsburg", "South Williamsburg", "East Williamsburg"],
};

/**
 * Each tabulation area's approximate aliases (tools/geo/nyc.ts): the places its name lists, bracketed
 * ones excepted, where no other area lists the name, no suburb across the city line bears it, and the
 * place lies inside the area's query outline.
 */
const NYC_NTA_ALIASES: Readonly<Record<string, readonly string[]>> = {
  annadale_huguenot_princes_bay_woodrow: ["Annadale", "Huguenot", "Prince's Bay", "Woodrow"],
  arden_heights_rossville: ["Arden Heights", "Rossville"],
  astoria_north_ditmars_steinway: ["Ditmars", "Steinway"],
  bay_terrace_clearview: ["Bay Terrace", "Clearview"],
  breezy_point_belle_harbor_rockaway_park_broad_channel: ["Belle Harbor", "Rockaway Park"],
  carroll_gardens_cobble_hill_gowanus_red_hook: ["Carroll Gardens", "Cobble Hill", "Gowanus", "Red Hook"],
  castle_hill_unionport: ["Unionport"],
  chelsea_hudson_yards: ["Chelsea", "Hudson Yards"],
  chinatown_two_bridges: ["Chinatown", "Two Bridges"],
  claremont_village_claremont_east: ["Claremont Village"],
  concourse_concourse_village: ["Concourse", "Concourse Village"],
  coney_island_sea_gate: ["Coney Island", "Sea Gate"],
  douglaston_little_neck: ["Douglaston", "Little Neck"],
  downtown_brooklyn_dumbo_boerum_hill: ["Downtown Brooklyn", "DUMBO", "Boerum Hill"],
  east_flatbush_erasmus: ["Erasmus"],
  east_flatbush_farragut: ["Farragut"],
  east_flatbush_remsen_village: ["Remsen Village"],
  east_flatbush_rugby: ["Rugby"],
  east_midtown_turtle_bay: ["East Midtown", "Turtle Bay"],
  east_new_york_city_line: ["City Line"],
  east_new_york_new_lots: ["New Lots"],
  eastchester_edenwald_baychester: ["Eastchester", "Edenwald", "Baychester"],
  far_rockaway_bayswater: ["Far Rockaway", "Bayswater"],
  financial_district_battery_park_city: ["Financial District", "Battery Park City"],
  flatbush_west_ditmas_park_parkville: ["Ditmas Park", "Parkville"],
  flushing_willets_point: ["Flushing", "Willets Point"],
  fresh_meadows_utopia: ["Fresh Meadows", "Utopia"],
  glen_oaks_floral_park_new_hyde_park: ["Glen Oaks"],
  grasmere_arrochar_south_beach_dongan_hills: ["Grasmere", "Arrochar", "South Beach", "Dongan Hills"],
  gravesend_east_homecrest: ["Homecrest"],
  great_kills_eltingville: ["Great Kills", "Eltingville"],
  hamilton_heights_sugar_hill: ["Hamilton Heights", "Sugar Hill"],
  howard_beach_lindenwood: ["Howard Beach", "Lindenwood"],
  jamaica_estates_holliswood: ["Jamaica Estates", "Holliswood"],
  jamaica_hills_briarwood: ["Jamaica Hills", "Briarwood"],
  kingsbridge_heights_van_cortlandt_village: ["Kingsbridge Heights", "Van Cortlandt Village"],
  kingsbridge_marble_hill: ["Kingsbridge", "Marble Hill"],
  long_island_city_hunters_point: ["Long Island City", "Hunters Point"],
  manhattanville_west_harlem: ["Manhattanville", "West Harlem"],
  mapleton_midwood_west: ["Mapleton"],
  marine_park_mill_basin_bergen_beach: ["Mill Basin", "Bergen Beach"],
  mariners_harbor_arlington_graniteville: ["Mariner's Harbor", "Arlington", "Graniteville"],
  midtown_south_flatiron_union_square: ["Midtown South", "Flatiron", "Union Square"],
  midtown_times_square: ["Midtown", "Times Square"],
  mott_haven_port_morris: ["Mott Haven", "Port Morris"],
  mount_eden_claremont_west: ["Mount Eden"],
  murray_hill_broadway_flushing: ["Broadway Flushing"],
  murray_hill_kips_bay: ["Kips Bay"],
  new_dorp_midland_beach: ["New Dorp", "Midland Beach"],
  new_springville_willowbrook_bulls_head_travis: ["New Springville", "Willowbrook", "Bulls Head", "Travis"],
  oakland_gardens_hollis_hills: ["Oakland Gardens", "Hollis Hills"],
  oakwood_richmondtown: ["Oakwood", "Richmondtown"],
  old_astoria_hallets_point: ["Old Astoria", "Hallets Point"],
  pelham_bay_country_club_city_island: ["Country Club"],
  pelham_parkway_van_nest: ["Pelham Parkway", "Van Nest"],
  pomonok_electchester_hillcrest: ["Pomonok", "Electchester", "Hillcrest"],
  prospect_lefferts_gardens_wingate: ["Prospect Lefferts Gardens", "Wingate"],
  queensbridge_ravenswood_dutch_kills: ["Queensbridge", "Ravenswood", "Dutch Kills"],
  riverdale_spuyten_duyvil: ["Riverdale", "Spuyten Duyvil"],
  rockaway_beach_arverne_edgemere: ["Rockaway Beach", "Arverne", "Edgemere"],
  rosebank_shore_acres_park_hill: ["Rosebank", "Shore Acres", "Park Hill"],
  sheepshead_bay_manhattan_beach_gerritsen_beach: ["Sheepshead Bay", "Manhattan Beach", "Gerritsen Beach"],
  soho_little_italy_hudson_square: ["SoHo", "Little Italy", "Hudson Square"],
  soundview_bruckner_bronx_river: ["Bruckner", "Bronx River"],
  soundview_clason_point: ["Clason Point"],
  spring_creek_starrett_city: ["Spring Creek", "Starrett City"],
  springfield_gardens_north_rochdale_village: ["Rochdale Village"],
  springfield_gardens_south_brookville: ["Brookville"],
  st_george_new_brighton: ["St. George", "New Brighton"],
  stuyvesant_town_peter_cooper_village: ["Stuyvesant Town", "Peter Cooper Village"],
  throgs_neck_schuylerville: ["Throgs Neck", "Schuylerville"],
  todt_hill_emerson_hill_lighthouse_hill_manor_heights: ["Todt Hill", "Emerson Hill", "Lighthouse Hill", "Manor Heights"],
  tompkinsville_stapleton_clifton_fox_hills: ["Tompkinsville", "Stapleton", "Clifton", "Fox Hills"],
  tottenville_charleston: ["Tottenville", "Charleston"],
  tribeca_civic_center: ["Tribeca", "Civic Center"],
  university_heights_north_fordham: ["Fordham"],
  university_heights_south_morris_heights: ["Morris Heights"],
  upper_east_side_carnegie_hill: ["Carnegie Hill"],
  upper_east_side_yorkville: ["Yorkville"],
  upper_west_side_lincoln_square: ["Lincoln Square"],
  upper_west_side_manhattan_valley: ["Manhattan Valley"],
  wakefield_woodlawn: ["Wakefield", "Woodlawn"],
  west_new_brighton_silver_lake_grymes_hill: ["West New Brighton", "Silver Lake", "Grymes Hill"],
  westerleigh_castleton_corners: ["Westerleigh", "Castleton Corners"],
  whitestone_beechhurst: ["Whitestone", "Beechhurst"],
  williamsbridge_olinville: ["Williamsbridge", "Olinville"],
  windsor_terrace_south_slope: ["Windsor Terrace", "South Slope"],
};

/**
 * Aliases listed only by a tabulation area of several parts, with the USGS GNIS populated-place point
 * that places them inside the query outline, at least 150 m from the border: the tabulation area, then
 * the district.
 */
const NYC_GNIS_PLACED: readonly [string, number, number, string | null, string][] = [
  ["Belle Harbor", 40.57594, -73.84819, "breezy_point_belle_harbor_rockaway_park_broad_channel", "the_rockaways"],
  ["Rockaway Park", 40.58011, -73.83625, "breezy_point_belle_harbor_rockaway_park_broad_channel", "the_rockaways"],
  ["Unionport", 40.82732, -73.85013, "castle_hill_unionport", "soundview_parkchester"],
  ["Country Club", 40.83917, -73.81972, "pelham_bay_country_club_city_island", "co_op_city_throgs_neck"],
  // On an island part of its tabulation area, but on the district's main part.
  ["Pelham Bay", 40.85056, -73.83333, null, "co_op_city_throgs_neck"],
];

/** Each area's approximate aliases as `alias = id`, sorted. */
const aliasRows = (areas: Gazetteer["areas"]): string[] => areas.flatMap((a) => (a.approximateAliases ?? []).map((alias) => `${alias} = ${a.id}`)).sort();
const tableRows = (table: Readonly<Record<string, readonly string[]>>): string[] => Object.entries(table).flatMap(([id, list]) => list.map((alias) => `${alias} = ${id}`)).sort();

describe("NYC districts", () => {
  const gazetteer = GAZETTEERS.nyc as Gazetteer;
  const { geo, id } = geoFor("nyc", gazetteer);
  const ntas = geoFor("nyc", NYC_NTAS);

  it("ships the city's 59 community districts, about 649 km², under readable slugs of their names", () => {
    expect(gazetteer.areas).toHaveLength(59);
    const total = gazetteer.areas.reduce((s, a) => s + (a.areaKm2 ?? 0), 0);
    expect(total).toBeGreaterThan(640);
    expect(total).toBeLessThan(660);
    for (const a of gazetteer.areas) expect(a.id, a.name).toMatch(/^[a-z][a-z_]*[a-z]$/);
    expect(geo.neighbourhood(id, "chelsea_hells_kitchen")?.name).toBe("Chelsea-Hell's Kitchen");
    expect(geo.neighbourhood(id, "crown_heights_north")?.name).toBe("Crown Heights (North)");
  });

  it("is made of whole tabulation areas: each one's centroid lies in a district, and the areas add up", () => {
    for (const a of NYC_NTAS.areas) expect(geo.locate(id, a.centroid ?? labelPoint(a.geometry)), a.id).not.toBeNull();
    const sum = (g: Gazetteer): number => g.areas.reduce((s, a) => s + (a.areaKm2 ?? 0), 0);
    expect(Math.abs(sum(gazetteer) / sum(NYC_NTAS) - 1)).toBeLessThan(0.005);
  });

  it.each(NYC_LANDMARKS)("%s lies in its district", (_name, lat, lon, _nta, district) => {
    expect(geo.locate(id, { lat, lon })).toBe(district);
  });

  it.each(NYC_LEFT_OUT)("%s lies in no district", (_name, lat, lon) => {
    expect(geo.locate(id, { lat, lon })).toBeNull();
  });

  it("marks every alias approximate, and has no exact aliases", () => {
    expect(aliasRows(gazetteer.areas)).toEqual(tableRows(NYC_DISTRICT_ALIASES));
    expect(gazetteer.areas.flatMap((a) => a.aliases ?? [])).toEqual([]);
  });

  it("matches each alias to its district, which holds the tabulation area of that name or alias", () => {
    for (const [district, aliases] of Object.entries(NYC_DISTRICT_ALIASES)) {
      for (const alias of aliases) {
        expect(geo.matchNeighbourhood(id, alias)?.id, alias).toBe(district);
        const nta = ntas.geo.matchNeighbourhood(ntas.id, alias);
        if (nta !== null) expect(geo.locate(id, nta.centroid), alias).toBe(district);
      }
    }
  });

  it.each(NYC_GNIS_PLACED)("%s lies in its district at its GNIS point", (alias, lat, lon, _nta, district) => {
    expect(geo.locate(id, { lat, lon })).toBe(district);
    expect(geo.matchNeighbourhood(id, alias)?.id).toBe(district);
  });

  it.each([
    ["Williamsburg", "williamsburg_greenpoint"],
    ["Bushwick", "bushwick"],
    ["Astoria", "astoria_queensbridge"],
    ["Harlem", "harlem"],
    ["Upper West Side", "upper_west_side"],
    ["Upper East Side", "upper_east_side_roosevelt_island"],
    ["Bedford-Stuyvesant", "bedford_stuyvesant"],
    ["the East Village", "lower_east_side_chinatown"],
    ["Lower East Side", "lower_east_side_chinatown"],
    ["SoHo", "greenwich_village_soho"],
    ["Chelsea", "chelsea_hells_kitchen"],
    ["Hell's Kitchen", "chelsea_hells_kitchen"],
    ["Midtown", "midtown_flatiron_union_square"],
    ["DUMBO", "downtown_brooklyn_fort_greene"],
    ["Park Slope", "park_slope_carroll_gardens"],
    ["Long Island City", "long_island_city_sunnyside_woodside"],
    ["Bellerose", "queens_village_bellerose_rosedale"],
    ["Pelham Bay", "co_op_city_throgs_neck"],
  ])("matches %s by name or approximate alias", (text, district) => {
    expect(geo.matchNeighbourhood(id, text)?.id).toBe(district);
  });

  it("does not guess at places two districts share, places off the query outline, suburbs' names or left-out areas", () => {
    // Split between districts, or listed by areas in two of them.
    for (const name of ["Murray Hill", "Crown Heights", "Sunset Park", "Woodside", "Midwood", "Gravesend", "Bed-Stuy"]) {
      expect(geo.matchNeighbourhood(id, name), name).toBeNull();
    }
    // On a part of the district apart from the query outline that Block DNA sends.
    for (const name of ["Co-op City", "Douglaston", "Little Neck", "City Island", "Broad Channel", "Breezy Point", "Roosevelt Island", "Lenox Hill", "Castle Hill"]) {
      expect(geo.matchNeighbourhood(id, name), name).toBeNull();
    }
    // Villages across the city line in Nassau County.
    for (const name of ["Floral Park", "New Hyde Park"]) expect(geo.matchNeighbourhood(id, name), name).toBeNull();
    for (const name of NYC_NO_AREA) expect(geo.matchNeighbourhood(id, name), name).toBeNull();
  });

  it("names the boundary source for captions", () => {
    expect(geo.boundarySource(id)).toBe(
      "NYC Department of City Planning 2020 Community District Tabulation Areas (NYC Open Data), no use restrictions (NYC Open Data Law); residential areas only",
    );
  });
});

describe("NYC tabulation areas", () => {
  const { geo, id } = geoFor("nyc", NYC_NTAS);
  const areas = NYC_NTAS.areas;

  it("ships the city's 197 residential tabulation areas, about 649 km², under readable slugs of their names", () => {
    expect(areas).toHaveLength(197);
    const total = areas.reduce((s, a) => s + (a.areaKm2 ?? 0), 0);
    expect(total).toBeGreaterThan(640);
    expect(total).toBeLessThan(660);
    for (const a of areas) expect(a.id, a.name).toMatch(/^[a-z][a-z_]*[a-z]$/);
    expect(geo.neighbourhood(id, "hells_kitchen")?.name).toBe("Hell's Kitchen");
    expect(geo.neighbourhood(id, "bedford_stuyvesant_west")?.name).toBe("Bedford-Stuyvesant (West)");
  });

  it.each(NYC_LANDMARKS)("%s lies in its tabulation area", (_name, lat, lon, nta) => {
    expect(geo.locate(id, { lat, lon })).toBe(nta);
  });

  it.each(NYC_LEFT_OUT)("%s lies in no area", (_name, lat, lon) => {
    expect(geo.locate(id, { lat, lon })).toBeNull();
  });

  it("marks every alias approximate, and has no exact aliases", () => {
    expect(aliasRows(areas)).toEqual(tableRows(NYC_NTA_ALIASES));
    expect(areas.flatMap((a) => a.aliases ?? [])).toEqual([]);
  });

  it("matches each alias to the tabulation area whose name lists it", () => {
    for (const [nta, aliases] of Object.entries(NYC_NTA_ALIASES)) {
      for (const alias of aliases) {
        expect(geo.matchNeighbourhood(id, alias)?.id, alias).toBe(nta);
        expect(geo.neighbourhood(id, nta)?.name, alias).toContain(alias);
      }
    }
  });

  it.each(NYC_GNIS_PLACED.filter((row) => row[3] !== null))("%s lies in its tabulation area at its GNIS point", (alias, lat, lon, nta) => {
    expect(geo.locate(id, { lat, lon })).toBe(nta);
    expect(geo.matchNeighbourhood(id, alias)?.id).toBe(nta);
  });

  it.each([
    ["Hell's Kitchen", "hells_kitchen"],
    ["hells kitchen", "hells_kitchen"],
    ["the East Village", "east_village"],
    ["Williamsburg", "williamsburg"],
    ["Bedford-Stuyvesant (West)", "bedford_stuyvesant_west"],
    ["Financial District-Battery Park City", "financial_district_battery_park_city"],
    ["Financial District", "financial_district_battery_park_city"],
    ["SoHo", "soho_little_italy_hudson_square"],
    ["Tribeca", "tribeca_civic_center"],
    ["Chelsea", "chelsea_hudson_yards"],
    ["DUMBO", "downtown_brooklyn_dumbo_boerum_hill"],
    ["Times Square", "midtown_times_square"],
    ["Long Island City", "long_island_city_hunters_point"],
    ["the Flatiron District", "midtown_south_flatiron_union_square"],
    ["Coney Island", "coney_island_sea_gate"],
    ["Bellerose", "bellerose"],
  ])("matches %s by name or approximate alias", (text, nta) => {
    expect(geo.matchNeighbourhood(id, text)?.id).toBe(nta);
  });

  it("does not guess at places several areas share, places off the query outline, suburbs' names or left-out areas", () => {
    // Split between several tabulation areas, or listed by more than one name.
    for (const name of ["Bushwick", "Astoria", "Harlem", "Upper West Side", "Bed-Stuy", "Murray Hill", "East Flatbush", "Soundview"]) {
      expect(geo.matchNeighbourhood(id, name), name).toBeNull();
    }
    // Listed only by a tabulation area of several parts, with no GNIS point inside its query outline.
    for (const name of ["Roosevelt Island", "Lenox Hill", "City Island", "Pelham Bay", "Broad Channel", "Breezy Point", "Castle Hill"]) {
      expect(geo.matchNeighbourhood(id, name), name).toBeNull();
    }
    // Villages across the city line in Nassau County.
    for (const name of ["Floral Park", "New Hyde Park"]) expect(geo.matchNeighbourhood(id, name), name).toBeNull();
    for (const name of NYC_NO_AREA) expect(geo.matchNeighbourhood(id, name), name).toBeNull();
  });

  it("names the boundary source for captions", () => {
    expect(geo.boundarySource(id)).toBe(
      "NYC Department of City Planning 2020 Neighborhood Tabulation Areas (NYC Open Data), no use restrictions (NYC Open Data Law); residential areas only",
    );
  });
});
