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
import { createGeo, loadGazetteers, MAX_WKT_VERTICES, normaliseAreaName, type Gazetteer, type GazetteerMetro } from "../src/index";
import { centroid, labelPoint, outline } from "../src/shapes";
import { edgesOf, overlapProblem, polygonsOf, ringProblem, signedArea } from "./validity";

const GAZETTEERS = await loadGazetteers();
/** The shipped gazetteers as the server serves them: createGeo's lazy default, every metro loaded. */
const SHIPPED = createGeo();
await Promise.all(MetroId.options.map((metro) => SHIPPED.ensure(metro)));

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
 * contracts MetroId only, so a gazetteer it does not serve (the NYC tabulation areas) is indexed under
 * a stand-in id: its data passes through the same index, validation and lookups.
 */
function geoFor(metro: GazetteerMetro, gazetteer: Gazetteer): { geo: GeoApi; id: MetroId } {
  const parsed = MetroId.safeParse(metro);
  if (parsed.success && GAZETTEERS[parsed.data] === gazetteer) return { geo: SHIPPED, id: parsed.data };
  return { geo: createGeo({ gazetteers: { nashville: { ...gazetteer, metro: "nashville" } } }), id: "nashville" };
}

/** Generous metro boxes: every vertex of a metro's data lies inside. */
const METRO_BOX: Record<GazetteerMetro, { minLon: number; minLat: number; maxLon: number; maxLat: number }> = {
  nashville: { minLon: -87.06, minLat: 35.96, maxLon: -86.51, maxLat: 36.41 },
  austin: { minLon: -98.0, minLat: 30.05, maxLon: -97.55, maxLat: 30.55 },
  nyc: { minLon: -74.26, minLat: 40.49, maxLon: -73.69, maxLat: 40.92 },
  los_angeles: { minLon: -118.96, minLat: 32.99, maxLon: -117.63, maxLat: 34.83 },
  chicago: { minLon: -88.28, minLat: 41.46, maxLon: -87.51, maxLat: 42.16 },
  miami: { minLon: -80.88, minLat: 25.13, maxLon: -80.1, maxLat: 25.98 },
  san_francisco: { minLon: -122.52, minLat: 37.7, maxLon: -122.35, maxLat: 37.84 },
  seattle: { minLon: -122.54, minLat: 47.08, maxLon: -121.06, maxLat: 47.79 },
  boston: { minLon: -71.2, minLat: 42.22, maxLon: -70.95, maxLat: 42.46 },
  denver: { minLon: -105.12, minLat: 39.6, maxLon: -104.59, maxLat: 39.92 },
  atlanta: { minLon: -84.86, minLat: 33.49, maxLon: -84.02, maxLat: 34.19 },
  houston: { minLon: -95.97, minLat: 29.49, maxLon: -94.9, maxLat: 30.18 },
  dallas: { minLon: -97.05, minLat: 32.54, maxLon: -96.51, maxLat: 33.0 },
};

/**
 * The largest plausible area, in km². Nashville's areas are ZIP areas (D37), larger than Austin's
 * planning areas: the largest, ZIP 37221 (Bellevue), is about 117 km². NYC's largest district, Staten
 * Island's South Shore, is about 51 km²; its largest tabulation area, also on Staten Island, about 19 km².
 * The ZIP-area cities (D39) hold rural and water ZIPs: ZIP 33034 takes in the Everglades and Florida Bay
 * (about 1,704 km²), ZIP 98022 (Enumclaw) about 1,164 km², ZIP 90704 Santa Catalina Island with its
 * water (about 765 km²), and Harris County's largest, ZIP 77532 (Crosby), about 226 km².
 */
const MAX_AREA_KM2: Record<Label, number> = {
  nashville: 120,
  austin: 60,
  nyc: 60,
  "nyc-ntas": 25,
  los_angeles: 800,
  chicago: 110,
  miami: 1750,
  san_francisco: 20,
  seattle: 1200,
  boston: 25,
  denver: 130,
  atlanta: 170,
  houston: 235,
  dallas: 110,
};

/**
 * Areas whose area-weighted centroid lies outside them, so they store an interior point instead:
 * ZIP 37209 wraps round a bend of the Cumberland River, and its centroid falls on the far bank. East
 * Flatbush and Ridgewood-Maspeth-Middle Village wrap round cemeteries the districts leave out. The
 * ZIP-area cities' ones are crescents, islands and ZIPs cut by a county line.
 */
const CENTROID_OUTSIDE: Record<Label, readonly string[]> = {
  nashville: ["zcta_37209"],
  austin: [],
  nyc: ["east_flatbush", "ridgewood_maspeth_middle_village"],
  "nyc-ntas": [],
  los_angeles: ["zcta_90007", "zcta_90274", "zcta_91355", "zcta_91390", "zcta_93532", "zcta_93563"],
  chicago: ["zcta_60192"],
  miami: [],
  san_francisco: ["zcta_94105", "zcta_94107"],
  seattle: [],
  boston: ["zcta_02115"],
  denver: ["zcta_80123", "zcta_80222", "zcta_80246"],
  atlanta: ["zcta_30087"],
  houston: [],
  dallas: [],
};

/**
 * The data module budget, in JSON characters. NYC has three times Austin's tabulation areas, and their
 * 40-point query outlines alone take about 160,000 characters. The large counties are built at a wider
 * simplification interval to stay near 600 KB: Los Angeles at 85 m (296 areas), Houston at 25 m,
 * Chicago and Seattle at 20 m.
 */
const MAX_CHARS: Record<Label, number> = {
  nashville: 300_000,
  austin: 300_000,
  nyc: 300_000,
  "nyc-ntas": 450_000,
  los_angeles: 600_000,
  chicago: 500_000,
  miami: 330_000,
  san_francisco: 100_000,
  seattle: 510_000,
  boston: 150_000,
  denver: 150_000,
  atlanta: 450_000,
  houston: 560_000,
  dallas: 450_000,
};

/** San Francisco has only 27 residential ZIP areas, plus the Presidio and Treasure Island, merged or not. */
const MIN_AREAS: Partial<Record<Label, number>> = { san_francisco: 25 };

/** Every name an area matches by: its display name, its aliases and its approximate aliases. */
const namesOf = (a: Gazetteer["areas"][number]): string[] => [a.name, ...(a.aliases ?? []), ...(a.approximateAliases ?? [])];

describe.each(BUILT.map((b) => [b.label, b] as const))("the %s gazetteer", (label, { metro, gazetteer }) => {
  const areas = gazetteer.areas;

  it("declares its metro, names its source and stays within the size budget", () => {
    expect(gazetteer.metro).toBe(metro);
    expect(gazetteer.source).toMatch(/public domain|CC|ODbL|NYC Open Data Law/);
    expect(areas.length).toBeGreaterThanOrEqual(MIN_AREAS[label] ?? 30);
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
  }, 60_000);

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
    // Los Angeles County's box holds about 256,000 samples: seconds alone, longer beside the full suite.
  }, 60_000);
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
  const geo = SHIPPED;

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
  const geo = SHIPPED;
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

/** One ZIP-area city (D39): its county, the label of a ZIP area cut by the county line, and its checks. */
interface ZipCity {
  metro: MetroId;
  county: string;
  /** The bracket label of a ZIP area keeping under 90% inside the county, or null when none does. */
  partLabel: string | null;
  /** The sum of areaKm2, in km². */
  totalKm2: readonly [number, number];
  /** Public landmarks at least 150 m inside the ZIP area of their street address; null for a point outside the county. */
  landmarks: readonly (readonly [string, number, number, string | null])[];
  /** Each approximate alias with its USGS GNIS populated-place point and the ZIP area holding it. */
  aliases: readonly (readonly [string, number, number, string])[];
  /** ZCTAs too small to stand alone, merged into a neighbour that answers to their ZIP. */
  merged: Readonly<Record<string, readonly string[]>>;
  /** Names no area answers to: places on or near a ZIP border, without a GNIS point, or another metro's. */
  noArea: readonly string[];
  /** Display names to pin, and texts that match an area by ZIP or alias. */
  names: readonly (readonly [string, string])[];
  matches: readonly (readonly [string, string])[];
}

const ZIP_CITIES: readonly ZipCity[] = [
  {
    metro: "los_angeles",
    county: "Los Angeles County",
    partLabel: "Los Angeles part",
    totalKm2: [10_150, 10_330],
    landmarks: [
      ["Griffith Observatory, 2800 East Observatory Road", 34.1184, -118.3004, "zcta_90027"],
      ["Los Angeles City Hall, 200 North Spring Street", 34.0537, -118.2427, "zcta_90012"],
      ["Dodger Stadium, 1000 Vin Scully Avenue", 34.0739, -118.24, "zcta_90012"],
      ["LACMA, 5905 Wilshire Boulevard", 34.0639, -118.3592, "zcta_90036"],
      ["Getty Center, 1200 Getty Center Drive", 34.078, -118.4741, "zcta_90049"],
      ["Rose Bowl, Pasadena", 34.1613, -118.1676, "zcta_91103"],
      ["TCL Chinese Theatre, Hollywood Boulevard", 34.1022, -118.3409, "zcta_90028"],
      ["Hollywood Bowl, 2301 North Highland Avenue", 34.1122, -118.3391, "zcta_90068"],
      ["Crypto.com Arena, 1111 South Figueroa Street", 34.043, -118.2673, "zcta_90015"],
      ["Aquarium of the Pacific, Long Beach", 33.762, -118.1966, "zcta_90802"],
      ["Universal Studios Hollywood", 34.1381, -118.3534, "zcta_91608"],
      ["Venice Beach Boardwalk at Windward Avenue", 33.9875, -118.4725, "zcta_90291"],
      ["Third Street Promenade, Santa Monica", 34.016, -118.4966, "zcta_90401"],
      ["The Huntington, San Marino", 34.1291, -118.1145, "zcta_91108"],
      ["Disneyland, Anaheim (Orange County)", 33.8121, -117.919, null],
      ["Pacific Ocean off Santa Monica Bay", 33.95, -118.6, null],
    ],
    aliases: [
      ["Baldwin Hills", 34.0058333, -118.3413889, "zcta_90008"],
      ["Leimert Park", 34.0069572, -118.3314646, "zcta_90008"],
      ["West Los Angeles", 34.0463986, -118.448135, "zcta_90025"],
      ["Hollywood", 34.0983425, -118.3267434, "zcta_90028"],
      ["Lincoln Heights", 34.0705664, -118.2050727, "zcta_90031"],
      ["El Sereno", 34.0811213, -118.1778495, "zcta_90032"],
      ["Palms", 34.0227889, -118.4056334, "zcta_90034"],
      ["Eagle Rock", 34.1388968, -118.2139624, "zcta_90041"],
      ["Highland Park", 34.1119534, -118.1989617, "zcta_90042"],
      ["Westchester", 33.9597349, -118.4006322, "zcta_90045"],
      ["Brentwood", 34.0519536, -118.4739692, "zcta_90049"],
      ["Glassell Park", 34.1094537, -118.2392407, "zcta_90065"],
      ["Mount Washington", 34.0991764, -118.2203511, "zcta_90065"],
      ["Cypress Park", 34.0922322, -118.2245179, "zcta_90065"],
      ["Mar Vista", 34.0047335, -118.4309115, "zcta_90066"],
      ["Bel Air", 34.0833418, -118.4486913, "zcta_90077"],
      ["Malibu", 34.0050079, -118.8100893, "zcta_90265"],
      ["Pacific Palisades", 34.0480643, -118.5264706, "zcta_90272"],
      ["Topanga", 34.0936181, -118.6014735, "zcta_90290"],
      ["Venice", 33.9908445, -118.4600787, "zcta_90291"],
      ["Marina del Rey", 33.9802893, -118.4517449, "zcta_90292"],
      ["Playa del Rey", 33.9489011, -118.4456331, "zcta_90293"],
      ["Harbor City", 33.7900173, -118.2978496, "zcta_90710"],
      ["San Pedro", 33.7358518, -118.2922934, "zcta_90731"],
      ["Wilmington", 33.780018, -118.2625711, "zcta_90744"],
      ["Belmont Shore", 33.7572397, -118.1370103, "zcta_90803"],
      ["Bixby Knolls", 33.8355721, -118.1767353, "zcta_90807"],
      ["Altadena", 34.1897275, -118.1311819, "zcta_91001"],
      ["Tujunga", 34.252225, -118.2884105, "zcta_91042"],
      ["La Crescenta", 34.2241708, -118.2400751, "zcta_91214"],
      ["Canoga Park", 34.2011156, -118.5981424, "zcta_91303"],
      ["Winnetka", 34.2133375, -118.5720309, "zcta_91306"],
      ["Chatsworth", 34.2572252, -118.6011992, "zcta_91311"],
      ["Pacoima", 34.2625025, -118.427027, "zcta_91331"],
      ["Reseda", 34.2011156, -118.5364742, "zcta_91335"],
      ["Sylmar", 34.3077785, -118.4492499, "zcta_91342"],
      ["Lake View Terrace", 34.2763908, -118.3611912, "zcta_91342"],
      ["North Hills", 34.2363889, -118.4847222, "zcta_91343"],
      ["Mission Hills", 34.2572249, -118.4670285, "zcta_91345"],
      ["Sun Valley", 34.2175042, -118.3703576, "zcta_91352"],
      ["Tarzana", 34.1733385, -118.553974, "zcta_91356"],
      ["Panorama City", 34.224726, -118.4498052, "zcta_91402"],
      ["Lake Balboa", 34.192058, -118.493171, "zcta_91406"],
      ["North Hollywood", 34.1722281, -118.3789684, "zcta_91601"],
      ["Studio City", 34.1486178, -118.3964686, "zcta_91604"],
      ["Universal City", 34.1388962, -118.3534115, "zcta_91608"],
    ],
    merged: { zcta_91214: ["91046"], zcta_90015: ["90079"], zcta_90746: ["90747"], zcta_90802: ["90831"] },
    noArea: ["Koreatown", "Echo Park", "Silver Lake", "Los Feliz", "Westwood", "Sherman Oaks", "Downtown", "West Hollywood", "Santa Monica", "Atwater Village"],
    names: [
      ["zcta_90065", "ZIP 90065 (Glassell Park)"],
      ["zcta_90026", "ZIP 90026"],
      ["zcta_90265", "ZIP 90265 (Malibu)"],
    ],
    matches: [
      ["venice neighborhood", "zcta_90291"],
      ["ZIP 90026", "zcta_90026"],
      ["90026", "zcta_90026"],
      ["ZIP 91046", "zcta_91214"],
      ["90079", "zcta_90015"],
    ],
  },
  {
    metro: "chicago",
    county: "Cook County",
    partLabel: "Cook part",
    totalKm2: [2_490, 2_530],
    landmarks: [
      ["Willis Tower, 233 South Wacker Drive", 41.8789, -87.6359, "zcta_60606"],
      ["Museum of Science and Industry", 41.7906, -87.5831, "zcta_60637"],
      ["Rockefeller Chapel, University of Chicago", 41.7887, -87.5966, "zcta_60637"],
      ["Navy Pier", 41.8917, -87.6086, "zcta_60611"],
      ["Lincoln Park Zoo", 41.9211, -87.634, "zcta_60614"],
      ["Garfield Park Conservatory", 41.8863, -87.7173, "zcta_60624"],
      ["Field Museum", 41.8663, -87.617, "zcta_60605"],
      ["National Museum of Mexican Art, Pilsen", 41.8562, -87.6729, "zcta_60608"],
      ["Illinois Centennial Monument, Logan Square", 41.9217, -87.7071, "zcta_60647"],
      ["Naperville (DuPage County)", 41.7508, -88.1535, null],
      ["Lake Michigan off the Loop", 41.88, -87.5, null],
    ],
    aliases: [
      ["Pilsen", 41.8575329, -87.6575528, "zcta_60608"],
      ["Bridgeport", 41.8380887, -87.6511631, "zcta_60608"],
      ["Back of the Yards", 41.8075332, -87.6661628, "zcta_60609"],
      ["Near North Side", 41.9000327, -87.6344975, "zcta_60610"],
      ["Streeterville", 41.8933662, -87.6219969, "zcta_60611"],
      ["Lincoln Park", 41.9216992, -87.647832, "zcta_60614"],
      ["Chinatown", 41.8516999, -87.6292183, "zcta_60616"],
      ["South Chicago", 41.722813, -87.536434, "zcta_60617"],
      ["Avondale", 41.9389208, -87.711168, "zcta_60618"],
      ["Chatham", 41.7411454, -87.6125481, "zcta_60619"],
      ["Englewood", 41.7797559, -87.6458836, "zcta_60621"],
      ["West Town", 41.9014213, -87.6861661, "zcta_60622"],
      ["West Garfield Park", 41.8805878, -87.7292227, "zcta_60624"],
      ["Albany Park", 41.968365, -87.7233915, "zcta_60625"],
      ["Rogers Park", 42.0086426, -87.6667239, "zcta_60626"],
      ["Roseland", 41.7019787, -87.625881, "zcta_60628"],
      ["Pullman", 41.6928123, -87.6058802, "zcta_60628"],
      ["Chicago Lawn", 41.7750332, -87.6964408, "zcta_60629"],
      ["Jefferson Park", 41.970587, -87.763393, "zcta_60630"],
      ["Brighton Park", 41.8189217, -87.6989421, "zcta_60632"],
      ["Hegewisch", 41.6536462, -87.5469885, "zcta_60633"],
      ["Woodlawn", 41.7794786, -87.599493, "zcta_60637"],
      ["Irving Park", 41.953365, -87.7364471, "zcta_60641"],
      ["Beverly", 41.7180893, -87.6736608, "zcta_60643"],
      ["Morgan Park", 41.6903117, -87.6667156, "zcta_60643"],
      ["Austin", 41.8875319, -87.7647796, "zcta_60644"],
      ["Sauganash", 41.9900315, -87.7422816, "zcta_60646"],
      ["Edgebrook", 41.9969756, -87.7653383, "zcta_60646"],
      ["Logan Square", 41.9233654, -87.6992228, "zcta_60647"],
      ["South Shore", 41.761979, -87.5778252, "zcta_60649"],
      ["Humboldt Park", 41.9028099, -87.7208896, "zcta_60651"],
      ["Ashburn", 41.7475332, -87.7111628, "zcta_60652"],
      ["Mount Greenwood", 41.6980891, -87.7086616, "zcta_60655"],
    ],
    merged: {},
    noArea: ["Hyde Park", "Wicker Park", "Lakeview", "Lake View", "Wrigleyville", "The Loop", "Uptown", "Bronzeville", "Evanston"],
    names: [["zcta_60608", "ZIP 60608 (Pilsen)"]],
    matches: [["the 60614", "zcta_60614"]],
  },
  {
    metro: "miami",
    county: "Miami-Dade County",
    partLabel: "Miami-Dade part",
    totalKm2: [4_120, 4_190],
    landmarks: [
      ["Wynwood Walls, 2516 NW 2nd Avenue", 25.801, -80.1994, "zcta_33127"],
      ["Domino Park, Calle Ocho", 25.7657, -80.219, "zcta_33135"],
      ["Fairchild Tropical Botanic Garden", 25.6765, -80.2729, "zcta_33156"],
      ["Lincoln Road Mall, Miami Beach", 25.7907, -80.1395, "zcta_33139"],
      ["Bill Baggs Cape Florida State Park", 25.6676, -80.1569, "zcta_33149"],
      ["Zoo Miami", 25.6115, -80.397, "zcta_33177"],
      ["University of Miami, Coral Gables", 25.7189, -80.2786, "zcta_33146"],
      ["Fort Lauderdale (Broward County)", 26.1224, -80.1373, null],
    ],
    aliases: [
      ["Redland", 25.5284426, -80.4903347, "zcta_33031"],
      ["Fisher Island", 25.7609329, -80.1400459, "zcta_33109"],
      ["Coconut Grove", 25.7126013, -80.2569947, "zcta_33133"],
      ["Little Havana", 25.7680556, -80.2330556, "zcta_33135"],
      ["Allapattah", 25.8145422, -80.2239376, "zcta_33142"],
      ["Flagami", 25.762322, -80.3161626, "zcta_33144"],
      ["Key Biscayne", 25.693713, -80.1628248, "zcta_33149"],
      ["Kendall", 25.6792695, -80.3172743, "zcta_33156"],
    ],
    merged: { zcta_33136: ["33101"] },
    noArea: ["Wynwood", "Brickell", "Little Haiti", "South Beach", "Miami Beach", "Westchester", "Design District"],
    names: [["zcta_33034", "ZIP 33034 (Miami-Dade part)"]],
    matches: [["ZIP 33101", "zcta_33136"]],
  },
  {
    metro: "san_francisco",
    county: "San Francisco County",
    partLabel: null,
    totalKm2: [128, 133],
    landmarks: [
      ["San Francisco City Hall", 37.7793, -122.4193, "zcta_94102"],
      ["Salesforce Tower, 415 Mission Street", 37.7897, -122.3972, "zcta_94105"],
      ["Ghirardelli Square", 37.8059, -122.4229, "zcta_94109"],
      ["Castro Theatre, 429 Castro Street", 37.762, -122.4348, "zcta_94114"],
      ["de Young Museum, Golden Gate Park", 37.7715, -122.4687, "zcta_94118"],
      ["Presidio Main Post", 37.7989, -122.4662, "zcta_94129"],
      ["San Francisco State University", 37.7241, -122.4799, "zcta_94132"],
      ["San Francisco Zoo", 37.733, -122.503, "zcta_94132"],
      ["Chase Center, 1 Warriors Way", 37.768, -122.3877, "zcta_94158"],
      ["Oakland (Alameda County)", 37.8044, -122.2712, null],
      ["Sausalito (Marin County)", 37.8591, -122.4853, null],
    ],
    aliases: [
      ["Potrero District", 37.759652, -122.3980262, "zcta_94107"],
      ["Mission District", 37.75993, -122.4191376, "zcta_94110"],
      ["Ingleside", 37.7229872, -122.4530272, "zcta_94112"],
      ["Haight-Ashbury", 37.7699298, -122.4469157, "zcta_94117"],
      ["Marina District", 37.8029843, -122.4374715, "zcta_94123"],
      ["Bayview District", 37.7340974, -122.3913596, "zcta_94124"],
      ["North Beach", 37.8057618, -122.4121934, "zcta_94133"],
    ],
    merged: {},
    noArea: ["Pacific Heights", "Chinatown", "SoMa", "Sunset District", "Richmond District", "Castro", "Nob Hill"],
    names: [["zcta_94110", "ZIP 94110 (Mission District)"]],
    matches: [
      ["the Mission District", "zcta_94110"],
      ["Haight Ashbury", "zcta_94117"],
      ["94110", "zcta_94110"],
    ],
  },
  {
    metro: "seattle",
    county: "King County",
    partLabel: "King part",
    totalKm2: [5_670, 5_770],
    landmarks: [
      ["Space Needle, 400 Broad Street", 47.6205, -122.3493, "zcta_98109"],
      ["Suzzallo Library, University of Washington", 47.6557, -122.308, "zcta_98195"],
      ["Discovery Park", 47.6573, -122.4057, "zcta_98199"],
      ["Gas Works Park", 47.6456, -122.3344, "zcta_98103"],
      ["Woodland Park Zoo", 47.6685, -122.3505, "zcta_98103"],
      ["Fremont Troll", 47.651, -122.3473, "zcta_98103"],
      ["Volunteer Park", 47.6302, -122.315, "zcta_98112"],
      ["Alki Beach", 47.5793, -122.4096, "zcta_98116"],
      ["Museum of Flight, 9404 East Marginal Way South", 47.518, -122.2964, "zcta_98108"],
      ["Bellevue Downtown Park", 47.6129, -122.2042, "zcta_98004"],
      ["Seattle-Tacoma International Airport", 47.4502, -122.3088, "zcta_98158"],
      ["Everett (Snohomish County)", 47.979, -122.2021, null],
      ["Tacoma (Pierce County)", 47.2529, -122.4443, null],
    ],
    aliases: [
      ["Mercer Island", 47.5706548, -122.2220673, "zcta_98040"],
      ["Vashon", 47.4473205, -122.4598502, "zcta_98070"],
      ["Capitol Hill", 47.6234317, -122.3195706, "zcta_98102"],
      ["Green Lake", 47.6870424, -122.333183, "zcta_98103"],
      ["Georgetown", 47.5517653, -122.3290145, "zcta_98108"],
      ["South Park", 47.5264878, -122.3145692, "zcta_98108"],
      ["Madison Park", 47.6348208, -122.2795695, "zcta_98112"],
      ["Montlake", 47.6413889, -122.3041667, "zcta_98112"],
      ["Ravenna", 47.6756537, -122.2976262, "zcta_98115"],
      ["Wedgwood", 47.6867648, -122.2956818, "zcta_98115"],
      ["Maple Leaf", 47.6939869, -122.3229051, "zcta_98115"],
      ["West Seattle", 47.5709315, -122.3865166, "zcta_98116"],
      ["Alki", 47.5762092, -122.4098507, "zcta_98116"],
      ["Columbia City", 47.56, -122.2772222, "zcta_98118"],
      ["Rainier Beach", 47.5167659, -122.2581784, "zcta_98118"],
      ["Seward Park", 47.5508333, -122.2608333, "zcta_98118"],
      ["Queen Anne", 47.6359314, -122.366239, "zcta_98119"],
      ["Lake City", 47.7175981, -122.2837374, "zcta_98125"],
      ["Northgate", 47.7131534, -122.3209608, "zcta_98125"],
      ["Fauntleroy", 47.5231539, -122.392905, "zcta_98136"],
      ["Beacon Hill", 47.5775987, -122.3098475, "zcta_98144"],
      ["Mount Baker", 47.5784321, -122.2895691, "zcta_98144"],
      ["Skyway", 47.4914884, -122.2542892, "zcta_98178"],
    ],
    merged: { zcta_98104: ["98154", "98164", "98174"] },
    noArea: ["Ballard", "Fremont", "Belltown", "Wallingford", "University District", "Bellevue", "South Lake Union"],
    names: [["zcta_98116", "ZIP 98116 (West Seattle)"]],
    matches: [["ZIP 98154", "zcta_98104"]],
  },
  {
    metro: "boston",
    county: "Suffolk County",
    partLabel: "Suffolk part",
    totalKm2: [160, 172],
    landmarks: [
      ["Fenway Park, 4 Jersey Street", 42.3467, -71.0972, "zcta_02215"],
      ["Bunker Hill Monument", 42.3763, -71.0608, "zcta_02129"],
      ["Franklin Park Zoo, 1 Franklin Park Road", 42.303, -71.086, "zcta_02121"],
      ["Logan International Airport", 42.3656, -71.0096, "zcta_02128"],
      ["Revere Beach Reservation", 42.41, -70.992, "zcta_02151"],
      ["Arnold Arboretum, 125 Arborway", 42.2995, -71.122, "zcta_02130"],
      // Inside the raw outline of ZCTA 02133, merged into 02108.
      ["Massachusetts State House", 42.3588, -71.0638, "zcta_02108"],
      ["Harvard Yard, Cambridge (Middlesex County)", 42.3744, -71.1169, null],
      ["Quincy Center (Norfolk County)", 42.2516, -71.0027, null],
    ],
    aliases: [
      ["North End", 42.3651, -71.0545, "zcta_02113"],
      ["Roxbury", 42.3251, -71.09533, "zcta_02119"],
      ["Grove Hall", 42.31121, -71.0745, "zcta_02121"],
      ["Fields Corner", 42.3001, -71.05783, "zcta_02122"],
      ["Dorchester Center", 42.29177, -71.07172, "zcta_02124"],
      ["Uphams Corner", 42.31676, -71.06061, "zcta_02125"],
      ["Mattapan", 42.27232, -71.087, "zcta_02126"],
      ["South Boston", 42.33343, -71.04949, "zcta_02127"],
      ["East Boston", 42.3751, -71.03922, "zcta_02128"],
      ["Charlestown", 42.37787, -71.062, "zcta_02129"],
      ["Jamaica Plain", 42.30982, -71.12033, "zcta_02130"],
      ["Roslindale", 42.29121, -71.1245, "zcta_02131"],
      ["West Roxbury", 42.27926, -71.1495, "zcta_02132"],
      ["Allston", 42.35843, -71.12589, "zcta_02134"],
      ["Brighton", 42.3501, -71.15644, "zcta_02135"],
      ["Hyde Park", 42.25565, -71.1245, "zcta_02136"],
      ["Chelsea", 42.39176, -71.03283, "zcta_02150"],
      ["Revere", 42.40843, -71.01199, "zcta_02151"],
      ["Winthrop", 42.3751, -70.98283, "zcta_02152"],
    ],
    merged: { zcta_02108: ["02203", "02133"] },
    noArea: ["Back Bay", "Beacon Hill", "South End", "Fenway", "Dorchester", "Mission Hill", "Chinatown", "Seaport"],
    names: [
      ["zcta_02113", "ZIP 02113 (North End)"],
      ["zcta_02467", "ZIP 02467 (Suffolk part)"],
    ],
    matches: [
      ["ZIP 02122", "zcta_02122"],
      ["02122", "zcta_02122"],
      ["zip code 02122", "zcta_02122"],
      ["02133", "zcta_02108"],
    ],
  },
  {
    metro: "denver",
    county: "Denver County",
    partLabel: "Denver part",
    totalKm2: [390, 405],
    landmarks: [
      ["Union Station, 1701 Wynkoop Street", 39.7527, -105.0002, "zcta_80202"],
      ["Empower Field at Mile High, 1701 Bryant Street", 39.7439, -105.0201, "zcta_80204"],
      ["Denver Botanic Gardens, 1007 York Street", 39.732, -104.9601, "zcta_80206"],
      ["Denver Zoo, 2300 Steele Street", 39.75, -104.949, "zcta_80205"],
      ["Washington Park", 39.7, -104.97, "zcta_80209"],
      ["Denver International Airport", 39.8561, -104.6737, "zcta_80249"],
      ["Red Rocks, Morrison (Jefferson County)", 39.6654, -105.2057, null],
      ["Aurora Municipal Center (Arapahoe County)", 39.7085, -104.8187, null],
      ["Glendale, an Arapahoe County enclave inside Denver", 39.7005, -104.9353, null],
    ],
    aliases: [
      ["Five Points", 39.75472, -104.97806, "zcta_80205"],
      ["University Park", 39.67861, -104.96944, "zcta_80210"],
      ["Bear Valley", 39.66278, -105.06083, "zcta_80227"],
      ["Montbello", 39.7936, -104.83359, "zcta_80239"],
    ],
    merged: { zcta_80202: ["80293", "80290", "80294"], zcta_80203: ["80264"] },
    noArea: ["LoDo", "RiNo", "Capitol Hill", "Cherry Creek", "Highlands", "Washington Park", "Stapleton", "Glendale", "Highland Park"],
    names: [["zcta_80205", "ZIP 80205 (Five Points)"]],
    matches: [
      ["80219", "zcta_80219"],
      ["80293", "zcta_80202"],
    ],
  },
  {
    metro: "atlanta",
    county: "Fulton and DeKalb Counties",
    partLabel: "Fulton-DeKalb part",
    totalKm2: [2_060, 2_100],
    landmarks: [
      ["Mercedes-Benz Stadium, 1 AMB Drive NW", 33.7553, -84.4006, "zcta_30313"],
      ["Fox Theatre, 660 Peachtree Street NE", 33.7726, -84.3856, "zcta_30308"],
      ["Piedmont Park, 1320 Monroe Drive NE", 33.7851, -84.3738, "zcta_30306"],
      ["Martin Luther King Jr. birth home, 501 Auburn Avenue NE", 33.7553, -84.3713, "zcta_30312"],
      ["Lenox Square, 3393 Peachtree Road NE", 33.8463, -84.3621, "zcta_30326"],
      ["Decatur Square", 33.7748, -84.2963, "zcta_30030"],
      ["Emory University Quadrangle", 33.7907, -84.3243, "zcta_30322"],
      // Inside the raw outline of ZCTA 30334, merged into 30303.
      ["Georgia State Capitol", 33.749, -84.388, "zcta_30303"],
      ["Hartsfield-Jackson terminal (ZCTA 30337, Clayton County)", 33.6407, -84.4277, null],
      ["Marietta Square (Cobb County)", 33.9526, -84.5499, null],
      ["Gwinnett Place, Duluth (Gwinnett County)", 33.9604, -84.1418, null],
    ],
    aliases: [
      ["Avondale Estates", 33.77149, -84.26714, "zcta_30002"],
      ["Milton", 34.13216, -84.30067, "zcta_30004"],
      ["Alpharetta", 34.07538, -84.29409, "zcta_30009"],
      ["Clarkston", 33.80955, -84.23964, "zcta_30021"],
      ["Johns Creek", 34.02893, -84.19858, "zcta_30022"],
      ["Decatur", 33.77483, -84.29631, "zcta_30030"],
      ["Lithonia", 33.71233, -84.10519, "zcta_30058"],
      ["Roswell", 34.02316, -84.36159, "zcta_30075"],
      ["Stone Mountain", 33.80816, -84.1702, "zcta_30083"],
      ["Tucker", 33.85455, -84.21714, "zcta_30084"],
      ["Fairburn", 33.56706, -84.58104, "zcta_30213"],
      ["Palmetto", 33.51789, -84.66965, "zcta_30268"],
      ["Union City", 33.58706, -84.54243, "zcta_30291"],
      ["Five Points", 33.75427, -84.38965, "zcta_30303"],
      ["Buckhead", 33.83955, -84.37937, "zcta_30305"],
      ["Virginia-Highland", 33.78233, -84.35131, "zcta_30306"],
      ["Virginia Highlands", 33.78233, -84.35131, "zcta_30306"],
      ["West End", 33.74066, -84.42743, "zcta_30310"],
      ["Cascade Heights", 33.72233, -84.46326, "zcta_30311"],
      ["Vine City", 33.7615, -84.41021, "zcta_30314"],
      ["East Atlanta", 33.74011, -84.34493, "zcta_30316"],
      ["Kirkwood", 33.75622, -84.32326, "zcta_30317"],
      ["Brookhaven", 33.85844, -84.3402, "zcta_30319"],
      ["Sandy Springs", 33.92427, -84.37854, "zcta_30328"],
      ["College Park", 33.65344, -84.44937, "zcta_30337"],
      ["Dunwoody", 33.94621, -84.33465, "zcta_30338"],
      ["Chamblee", 33.89205, -84.29881, "zcta_30341"],
      ["East Point", 33.67955, -84.43937, "zcta_30344"],
      ["Hapeville", 33.66011, -84.4102, "zcta_30354"],
    ],
    merged: { zcta_30303: ["30334"] },
    noArea: ["Midtown", "Old Fourth Ward", "Inman Park", "Little Five Points", "Grant Park", "Edgewood", "Ansley Park"],
    names: [
      ["zcta_30306", "ZIP 30306 (Virginia-Highland)"],
      ["zcta_30097", "ZIP 30097 (Fulton-DeKalb part)"],
    ],
    matches: [
      ["30318", "zcta_30318"],
      ["30334", "zcta_30303"],
    ],
  },
  {
    metro: "houston",
    county: "Harris County",
    partLabel: "Harris part",
    totalKm2: [4_560, 4_620],
    landmarks: [
      ["Rice University, 6100 Main Street", 29.7174, -95.4018, "zcta_77005"],
      ["Menil Collection, 1533 Sul Ross Street", 29.7375, -95.3985, "zcta_77006"],
      ["Texas Medical Center", 29.707, -95.398, "zcta_77030"],
      ["The Galleria, 5085 Westheimer Road", 29.739, -95.4613, "zcta_77056"],
      ["NRG Stadium", 29.6847, -95.4107, "zcta_77054"],
      ["Space Center Houston, 1601 NASA Parkway", 29.5519, -95.0983, "zcta_77058"],
      ["George Bush Intercontinental Airport", 29.9902, -95.3368, "zcta_77032"],
      ["San Jacinto Monument", 29.7497, -95.0807, "zcta_77571"],
      ["Sugar Land Town Square (Fort Bend County)", 29.5958, -95.6224, null],
      ["The Woodlands Mall (Montgomery County)", 30.1626, -95.4618, null],
    ],
    aliases: [
      ["West University Place", 29.71801, -95.43383, "zcta_77005"],
      ["Houston Heights", 29.798, -95.39799, "zcta_77008"],
      ["The Heights", 29.798, -95.39799, "zcta_77008"],
      ["Woodland Heights", 29.7846, -95.3806, "zcta_77009"],
      ["Cloverleaf", 29.77828, -95.17188, "zcta_77015"],
      ["Garden Oaks", 29.8272, -95.424, "zcta_77018"],
      ["Oak Forest", 29.8281, -95.4524, "zcta_77018"],
      ["Eastwood", 29.7372, -95.3303, "zcta_77023"],
      ["Jacinto City", 29.76745, -95.23382, "zcta_77029"],
      ["Westbury", 29.6484, -95.4959, "zcta_77035"],
      ["Jersey Village", 29.88773, -95.563, "zcta_77040"],
      ["Alief", 29.71106, -95.59633, "zcta_77072"],
      ["Sharpstown", 29.6961, -95.5088, "zcta_77074"],
      ["Meyerland", 29.68495, -95.46744, "zcta_77096"],
      ["Huffman", 30.02716, -95.08576, "zcta_77336"],
      ["Humble", 29.99883, -95.26216, "zcta_77338"],
      ["Atascocita", 29.99883, -95.1766, "zcta_77346"],
      ["Spring", 30.07994, -95.41716, "zcta_77373"],
      ["Tomball", 30.09716, -95.61605, "zcta_77375"],
      ["Klein", 30.04772, -95.53244, "zcta_77379"],
      ["Bellaire", 29.70579, -95.45883, "zcta_77401"],
      ["Hockley", 30.02689, -95.8444, "zcta_77447"],
      ["Baytown", 29.7355, -94.97743, "zcta_77520"],
      ["Channelview", 29.77606, -95.11465, "zcta_77530"],
      ["Crosby", 29.91189, -95.06215, "zcta_77532"],
      ["Deer Park", 29.70523, -95.12382, "zcta_77536"],
      ["Galena Park", 29.73356, -95.23021, "zcta_77547"],
      ["Highlands", 29.81884, -95.05604, "zcta_77562"],
      ["La Porte", 29.66578, -95.01937, "zcta_77571"],
      ["Seabrook", 29.56412, -95.02548, "zcta_77586"],
      ["South Houston", 29.66301, -95.23549, "zcta_77587"],
      ["Webster", 29.53773, -95.11826, "zcta_77598"],
    ],
    merged: {},
    noArea: ["Montrose", "Midtown", "River Oaks", "Kingwood", "Pasadena", "Clear Lake", "Mission Bend", "Cypress", "Katy", "Heights", "Five Points"],
    names: [["zcta_77008", "ZIP 77008 (Houston Heights)"]],
    matches: [["77071", "zcta_77071"]],
  },
  {
    metro: "dallas",
    county: "Dallas County",
    partLabel: "Dallas part",
    totalKm2: [2_320, 2_370],
    landmarks: [
      ["Sixth Floor Museum, 411 Elm Street", 32.7798, -96.8084, "zcta_75202"],
      ["Dallas Museum of Art, 1717 North Harwood Street", 32.7877, -96.801, "zcta_75201"],
      ["Klyde Warren Park", 32.7894, -96.8016, "zcta_75201"],
      ["Fair Park", 32.7793, -96.7597, "zcta_75210"],
      ["Deep Ellum, Elm Street at Malcolm X Boulevard", 32.7843, -96.7837, "zcta_75226"],
      ["Bishop Arts District", 32.749, -96.828, "zcta_75208"],
      ["Dallas Love Field", 32.8471, -96.8518, "zcta_75235"],
      ["Highland Park Village", 32.8358, -96.8053, "zcta_75205"],
      ["AT&T Stadium, Arlington (Tarrant County)", 32.7473, -97.0945, null],
      ["Plano (Collin County)", 33.0198, -96.6989, null],
    ],
    aliases: [
      ["Addison", 32.96179, -96.82917, "zcta_75001"],
      ["Carrollton", 32.95373, -96.89028, "zcta_75006"],
      ["Coppell", 32.95457, -97.01501, "zcta_75019"],
      ["Garland", 32.91262, -96.63888, "zcta_75040"],
      ["Sachse", 32.97623, -96.59527, "zcta_75048"],
      ["Rowlett", 32.9029, -96.56388, "zcta_75088"],
      ["Cedar Hill", 32.58847, -96.95612, "zcta_75104"],
      ["DeSoto", 32.58986, -96.85695, "zcta_75115"],
      ["Duncanville", 32.6518, -96.90834, "zcta_75116"],
      ["Hutchins", 32.6493, -96.71305, "zcta_75141"],
      ["Lancaster", 32.59208, -96.75611, "zcta_75146"],
      ["Mesquite", 32.7668, -96.59916, "zcta_75149"],
      ["Seagoville", 32.63958, -96.53832, "zcta_75159"],
      ["Wilmer", 32.58902, -96.68527, "zcta_75172"],
      ["Balch Springs", 32.72874, -96.62277, "zcta_75180"],
      ["Sunnyvale", 32.79652, -96.56082, "zcta_75182"],
      ["Highland Park", 32.83346, -96.79195, "zcta_75205"],
      ["Farmers Branch", 32.92651, -96.89612, "zcta_75234"],
    ],
    merged: { zcta_75202: ["75270"] },
    noArea: ["Deep Ellum", "Uptown", "Bishop Arts", "Oak Cliff", "Lakewood", "Richardson", "Irving", "Grand Prairie"],
    names: [["zcta_75205", "ZIP 75205 (Highland Park)"]],
    matches: [
      ["75203", "zcta_75203"],
      ["75270", "zcta_75202"],
    ],
  },
];

describe.each(ZIP_CITIES.map((c) => [c.metro, c] as const))("%s ZIP-area lookups (D39)", (metro, city) => {
  const geo = SHIPPED;
  const areas = GAZETTEERS[metro]?.areas ?? [];

  it("covers its county with the area of its ZIP areas", () => {
    const total = areas.reduce((s, a) => s + (a.areaKm2 ?? 0), 0);
    expect(total).toBeGreaterThan(city.totalKm2[0]);
    expect(total).toBeLessThan(city.totalKm2[1]);
  });

  it.each(city.landmarks)("%s lies in its ZIP area, or in none outside the county", (_name, lat, lon, id) => {
    expect(geo.locate(metro, { lat, lon })).toBe(id);
  });

  it.each(city.aliases)("%s names the ZIP area that holds its place point", (alias, lat, lon, id) => {
    expect(geo.locate(metro, { lat, lon })).toBe(id);
    expect(geo.matchNeighbourhood(metro, alias)?.id).toBe(id);
  });

  it("marks every neighbourhood alias approximate, and answers otherwise only to ZIPs it holds", () => {
    const approximate = areas.flatMap((a) => (a.approximateAliases ?? []).map((alias) => `${alias} = ${a.id}`));
    expect(approximate.sort()).toEqual(city.aliases.map(([alias, , , id]) => `${alias} = ${id}`).sort());
    for (const a of areas) {
      const zips = [a.id.slice("zcta_".length), ...(city.merged[a.id] ?? [])];
      for (const alias of a.aliases ?? []) expect(zips.flatMap((zip) => [`ZIP ${zip}`, zip]), a.id).toContain(alias);
    }
    for (const [host, zips] of Object.entries(city.merged)) {
      for (const zip of zips) expect(geo.matchNeighbourhood(metro, `ZIP ${zip}`)?.id, zip).toBe(host);
    }
  });

  it(`labels ZIP areas as ZIP areas, with the approximate neighbourhood or the ${city.county} part in brackets`, () => {
    for (const a of areas) {
      const zip = /^zcta_(\d{5})$/.exec(a.id)?.[1];
      expect(zip, a.id).toBeDefined();
      const [, nameZip, label] = /^ZIP (\d{5})(?: \((.+)\))?$/.exec(a.name) ?? [];
      expect(nameZip, a.id).toBe(zip);
      if (a.approximateAliases !== undefined) expect(label, a.id).toBe(a.approximateAliases[0]);
      else if (label !== undefined) expect(label, a.id).toBe(city.partLabel);
    }
    for (const [id, name] of city.names) expect(geo.neighbourhood(metro, id)?.name).toBe(name);
  });

  it.each(city.matches)("matches %s", (text, id) => {
    expect(geo.matchNeighbourhood(metro, text)?.id).toBe(id);
  });

  it("does not guess at names on or near a ZIP border, without a GNIS point, or another metro's", () => {
    for (const name of city.noArea) expect(geo.matchNeighbourhood(metro, name), name).toBeNull();
    expect(geo.matchNeighbourhood(metro, "East Nashville")).toBeNull();
  });

  it("names the boundary source for captions, approximate names included", () => {
    expect(geo.boundarySource(metro)).toBe(
      `U.S. Census Bureau 2020 ZIP Code Tabulation Areas clipped to ${city.county}, public domain; neighbourhood names approximate`,
    );
  });
});
