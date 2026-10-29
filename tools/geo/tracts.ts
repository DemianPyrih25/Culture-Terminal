// Builds the census crosswalk tables behind @ct/geo censusUnitsOf (Part 9, area_economics), polygon-free:
//
// 1. Tracts, for the cities whose areas are not ZIP areas (New York's community districts, Austin's
//    planning areas): every 2020 census tract is assigned whole to the area that holds its interior point
//    (INTPTLAT/INTPTLONG), tested against the shipped gazetteer polygons with containsPoint. A tract whose
//    point lies in no area (a park, an airport, a cemetery, outside the planning areas) is dropped, and so
//    is a water-only tract. An area smaller than the tracts around it can hold no interior point: it gets the
//    tract whose point is nearest its centre, within NEAREST_TRACT_MAX_KM, marked as standing in (the
//    skill says its figures reach beyond the area). Writes packages/geo/src/data/tracts-<metro>.ts.
//      pnpm exec tsx tools/geo/tracts.ts --metro nyc --gazetteer <dir>/2020_Gaz_tracts_national.txt [--out <file>] [--dry]
//    Input: the Census Bureau's 2020 Gazetteer tract file,
//      https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_tracts_national.zip
// 2. ZIP clip shares, for the ZIP-area cities: how much of each area's ZCTA land lies inside the counties
//    its city is clipped to (ZCTA_CLIP_COUNTIES, as each city's tools/geo/zcta.ts --county arguments in
//    ATTRIBUTION.md), from the land areas of the 2020 ZCTA-to-county relationship file. ACS reports whole
//    ZCTAs, so a clipped area reads whole-ZIP figures; the "(… part)" label misses the clipped areas named
//    after a place. Writes packages/geo/src/data/zcta-clip.ts.
//      pnpm exec tsx tools/geo/tracts.ts --zcta-clip --relation <dir>/tab20_zcta520_county20_natl.txt [--out <file>] [--dry]
//    Input: https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt
//
// Download the inputs to a local folder outside the repository; they are never committed. Run both again
// after a gazetteer of these cities is rebuilt (the catalog test does not check these tables; the
// packages/geo census test does). The files are data: parsed, never run.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { MetroId } from "../../packages/contracts/src/index";
import { GAZETTEER_CATALOG } from "../../packages/geo/src/catalog";
import { memberZctas, NEAREST_TRACT_MAX_KM, TRACT_LOADERS, type TractCrosswalk } from "../../packages/geo/src/census";
import { loadGazetteer, type GazetteerArea, type GazetteerCatalog } from "../../packages/geo/src/gazetteer";
import { containsPoint } from "../../packages/geo/src/measure";
import { bboxOf, labelPoint, type Bbox } from "../../packages/geo/src/shapes";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * The counties each ZIP-area city is clipped to (state and county FIPS), as its zcta.ts build was run
 * (ATTRIBUTION.md, "ZIP areas for further metros" and Nashville).
 */
export const ZCTA_CLIP_COUNTIES: Readonly<Partial<Record<MetroId, readonly string[]>>> = {
  nashville: ["47037"],
  los_angeles: ["06037"],
  chicago: ["17031"],
  miami: ["12086"],
  san_francisco: ["06075"],
  seattle: ["53033"],
  boston: ["25025"],
  denver: ["08031"],
  atlanta: ["13121", "13089"],
  houston: ["48201"],
  dallas: ["48113"],
};

/** An area holding less than this share of its ZIP land is listed in the clip table. */
const LISTED_BELOW = 0.99;

export const TRACT_SOURCE =
  "U.S. Census Bureau 2020 Gazetteer census tracts, public domain; each tract assigned whole to the area holding its interior point";
export const ZCTA_CLIP_SOURCE = "U.S. Census Bureau 2020 ZCTA to county relationship file (land area), public domain";

/** Splits a Census text file (tab or pipe separated, a header row, maybe a BOM) into named columns. */
export function readTable(text: string, separator: "\t" | "|"): Record<string, string>[] {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  const header = (lines[0] ?? "").split(separator).map((h) => h.trim());
  return lines.slice(1).map((line) => {
    const cells = line.split(separator);
    return Object.fromEntries(header.map((h, i) => [h, (cells[i] ?? "").trim()]));
  });
}

export interface TractPoint {
  geoid: string;
  lat: number;
  lon: number;
  /** Land area in m². */
  aland: number;
}

/** The Gazetteer tract file's rows: GEOID, ALAND, INTPTLAT, INTPTLONG. */
export function readTractGazetteer(text: string): TractPoint[] {
  return readTable(text, "\t").map((r) => {
    const geoid = r.GEOID ?? "";
    const lat = Number(r.INTPTLAT);
    const lon = Number(r.INTPTLONG);
    const aland = Number(r.ALAND);
    if (!/^\d{11}$/.test(geoid) || !Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(aland)) {
      throw new Error(`tracts: a Gazetteer row without an 11-digit GEOID, interior point and land area (${geoid})`);
    }
    return { geoid, lat, lon, aland };
  });
}

const inBox = (b: Bbox, p: TractPoint): boolean => p.lon >= b.minLon && p.lon <= b.maxLon && p.lat >= b.minLat && p.lat <= b.maxLat;

/**
 * Assigns each tract with land to the first area (in gazetteer order) whose outline holds its interior
 * point, edge included. Reports the dropped tracts and every area left without a tract.
 */
export function assignTracts(
  areas: readonly Pick<GazetteerArea, "id" | "geometry">[],
  tracts: readonly TractPoint[],
  report: string[],
): Record<string, string[]> {
  const boxes = areas.map((a) => bboxOf(a.geometry));
  const all: Bbox = {
    minLon: Math.min(...boxes.map((b) => b.minLon)),
    minLat: Math.min(...boxes.map((b) => b.minLat)),
    maxLon: Math.max(...boxes.map((b) => b.maxLon)),
    maxLat: Math.max(...boxes.map((b) => b.maxLat)),
  };
  const out: Record<string, string[]> = Object.fromEntries(areas.map((a) => [a.id, [] as string[]]));
  let near = 0;
  let water = 0;
  let outside = 0;
  for (const t of tracts) {
    if (!inBox(all, t)) continue;
    near++;
    if (t.aland <= 0) {
      water++;
      continue;
    }
    const i = areas.findIndex((a, k) => inBox(boxes[k] as Bbox, t) && containsPoint(a.geometry, { lat: t.lat, lon: t.lon }));
    if (i < 0) outside++;
    else out[(areas[i] as { id: string }).id]?.push(t.geoid);
  }
  const assigned = Object.values(out).reduce((s, l) => s + l.length, 0);
  report.push(`${near} tracts near the areas: ${assigned} assigned, ${outside} with their point in no area, ${water} water-only`);
  for (const a of areas) {
    const list = out[a.id] as string[];
    list.sort();
    if (list.length === 0) report.push(`no tract: ${a.id} holds no tract interior point`);
  }
  return Object.fromEntries(Object.entries(out).filter(([, list]) => list.length > 0));
}

/** Kilometres between two points, on an equirectangular projection: exact enough within a city. */
function km(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const x = ((b.lon - a.lon) * Math.PI * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180)) / 180;
  const y = ((b.lat - a.lat) * Math.PI) / 180;
  return 6371 * Math.hypot(x, y);
}

/**
 * For each area without a tract: the tract with land whose interior point is nearest the area's centre
 * (its stored centroid, else its label point), within NEAREST_TRACT_MAX_KM. Reports each stand-in, and
 * each area still left without one.
 */
export function nearestTracts(
  areas: readonly Pick<GazetteerArea, "id" | "geometry" | "centroid">[],
  assigned: Readonly<Record<string, readonly string[]>>,
  tracts: readonly TractPoint[],
  report: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of areas) {
    if ((assigned[a.id]?.length ?? 0) > 0) continue;
    const centre = a.centroid ?? labelPoint(a.geometry);
    let best: { geoid: string; d: number } | null = null;
    for (const t of tracts) {
      if (t.aland <= 0) continue;
      const d = km(centre, t);
      if (d <= NEAREST_TRACT_MAX_KM && (best === null || d < best.d)) best = { geoid: t.geoid, d };
    }
    if (best === null) report.push(`unreported: ${a.id} has no tract point within ${NEAREST_TRACT_MAX_KM} km`);
    else {
      out[a.id] = best.geoid;
      report.push(`nearest: ${a.id} stands in tract ${best.geoid}, ${best.d.toFixed(2)} km from its centre`);
    }
  }
  return out;
}

/** The data module for one metro's tract table. */
export function tractModuleText(table: TractCrosswalk): string {
  const constName = `${table.metro.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_TRACTS`;
  const lines = [
    `// Census tracts per area for ${table.metro} (Part 9 census crosswalk): each 2020 tract assigned whole to the`,
    "// area holding its Gazetteer interior point. Generated by tools/geo/tracts.ts; ATTRIBUTION.md records the",
    "// source, licence and method. Polygon-free, loaded on first use. Do not edit by hand: rebuild instead.",
    'import type { TractCrosswalk } from "../census";',
    "",
    `export const ${constName}: TractCrosswalk = {`,
    `  metro: ${JSON.stringify(table.metro)},`,
    `  source: ${JSON.stringify(table.source)},`,
    "  areas: {",
    ...Object.entries(table.areas).map(([id, tracts]) => `    ${JSON.stringify(id)}: ${JSON.stringify(tracts)},`),
    "  },",
    ...(table.nearest === undefined || Object.keys(table.nearest).length === 0 ? [] : [`  nearest: ${JSON.stringify(table.nearest)},`]),
    "};",
    "",
  ];
  return lines.join("\n");
}

/** Land area per ZCTA, and its land inside each county. */
export interface ZctaLand {
  land: number;
  byCounty: Map<string, number>;
}

/** The ZCTA-to-county relationship file's land columns; rows of county parts outside every ZCTA are skipped. */
export function readZctaCountyRelation(text: string): Map<string, ZctaLand> {
  const out = new Map<string, ZctaLand>();
  for (const r of readTable(text, "|")) {
    const zcta = r.GEOID_ZCTA5_20 ?? "";
    if (zcta === "") continue;
    const county = r.GEOID_COUNTY_20 ?? "";
    const land = Number(r.AREALAND_ZCTA5_20);
    const part = Number(r.AREALAND_PART);
    if (!/^\d{5}$/.test(zcta) || !/^\d{5}$/.test(county) || !Number.isFinite(land) || !Number.isFinite(part)) {
      throw new Error(`tracts: a relationship row without a ZCTA, county and land areas (${zcta})`);
    }
    const entry = out.get(zcta) ?? { land, byCounty: new Map<string, number>() };
    entry.byCounty.set(county, (entry.byCounty.get(county) ?? 0) + part);
    out.set(zcta, entry);
  }
  return out;
}

/**
 * Per ZIP-area city and area: the whole percent of its ZCTAs' land inside the city's counties, for the
 * areas under LISTED_BELOW. Every ZCTA of every area must be in the relationship file.
 */
export function zctaClipShares(
  catalog: GazetteerCatalog,
  counties: Readonly<Partial<Record<MetroId, readonly string[]>>>,
  relation: ReadonlyMap<string, ZctaLand>,
  report: string[],
): Partial<Record<MetroId, Record<string, number>>> {
  const out: Partial<Record<MetroId, Record<string, number>>> = {};
  for (const [metro, entry] of Object.entries(catalog) as [MetroId, NonNullable<GazetteerCatalog[MetroId]>][]) {
    const zipAreas = entry.areas.filter((a) => memberZctas(a) !== null);
    if (zipAreas.length === 0) continue;
    const clip = counties[metro];
    if (clip === undefined) throw new Error(`tracts: ${metro} has ZIP areas but no clip counties in ZCTA_CLIP_COUNTIES`);
    const shares: Record<string, number> = {};
    for (const a of zipAreas) {
      let land = 0;
      let inside = 0;
      for (const zip of memberZctas(a) as string[]) {
        const z = relation.get(zip);
        if (z === undefined) throw new Error(`tracts: ZCTA ${zip} (${metro} ${a.id}) is not in the relationship file`);
        land += z.land;
        for (const c of clip) inside += z.byCounty.get(c) ?? 0;
      }
      // A ZCTA with no land (water only) is whole by definition: nothing of it lies elsewhere.
      const share = land === 0 ? 1 : inside / land;
      if (share < LISTED_BELOW) shares[a.id] = Math.floor(share * 100);
    }
    report.push(`${metro}: ${Object.keys(shares).length} of ${zipAreas.length} ZIP areas under ${LISTED_BELOW * 100}% inside`);
    out[metro] = shares;
  }
  return out;
}

/** The data module for the clip table. */
export function zctaClipModuleText(inside: Partial<Record<MetroId, Record<string, number>>>): string {
  const lines = [
    "// How much of each clipped ZIP area's ZCTA land lies inside its city's counties (Part 9 census crosswalk):",
    "// whole percent, areas under 99% only. Generated by tools/geo/tracts.ts --zcta-clip; ATTRIBUTION.md records",
    "// the source, licence and method. Polygon-free, loaded on first use. Do not edit by hand: rebuild instead.",
    'import type { ZctaClipTable } from "../census";',
    "",
    "export const ZCTA_CLIP: ZctaClipTable = {",
    `  source: ${JSON.stringify(ZCTA_CLIP_SOURCE)},`,
    "  inside: {",
    ...Object.entries(inside).map(([metro, shares]) => `    ${metro}: ${JSON.stringify(shares)},`),
    "  },",
    "};",
    "",
  ];
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      metro: { type: "string" },
      gazetteer: { type: "string" },
      "zcta-clip": { type: "boolean" },
      relation: { type: "string" },
      out: { type: "string" },
      dry: { type: "boolean" },
    },
  });
  const report: string[] = [];
  let text: string;
  let outFile: string;
  if (values["zcta-clip"] === true) {
    if (values.relation === undefined) throw new Error("usage: tracts.ts --zcta-clip --relation <tab20_zcta520_county20_natl.txt> [--out file] [--dry]");
    const relation = readZctaCountyRelation(readFileSync(values.relation, "utf8"));
    text = zctaClipModuleText(zctaClipShares(GAZETTEER_CATALOG, ZCTA_CLIP_COUNTIES, relation, report));
    outFile = values.out ?? path.join(ROOT, "packages/geo/src/data/zcta-clip.ts");
  } else {
    const { metro, gazetteer: file } = values;
    if (metro === undefined || file === undefined) {
      throw new Error("usage: tracts.ts --metro <nyc|austin> --gazetteer <2020_Gaz_tracts_national.txt> [--out file] [--dry]");
    }
    if (!(metro in TRACT_LOADERS)) throw new Error(`tracts: ${metro} is not a tract city (${Object.keys(TRACT_LOADERS).join(", ")})`);
    const gazetteer = await loadGazetteer(metro as MetroId);
    if (gazetteer === null) throw new Error(`tracts: no gazetteer ships for ${metro}`);
    const points = readTractGazetteer(readFileSync(file, "utf8"));
    const areas = assignTracts(gazetteer.areas, points, report);
    const nearest = nearestTracts(gazetteer.areas, areas, points, report);
    text = tractModuleText({ metro: metro as MetroId, source: TRACT_SOURCE, areas, nearest });
    outFile = values.out ?? path.join(ROOT, `packages/geo/src/data/tracts-${metro.replace(/_/g, "-")}.ts`);
  }
  report.push(`module ${(Buffer.byteLength(text) / 1024).toFixed(1)} KB`);
  console.log(report.join("\n"));
  if (values.dry !== true) {
    writeFileSync(outFile, text, "utf8");
    console.log(`wrote ${outFile}`);
  }
}

if (path.basename(process.argv[1] ?? "") === "tracts.ts") {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
