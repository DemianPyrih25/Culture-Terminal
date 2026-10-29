import type { CensusGeo, CensusUnits, MetroId, TractUnits, ZctaUnits } from "@ct/contracts";
import { GAZETTEER_CATALOG } from "./catalog";
import type { CatalogArea, GazetteerCatalog } from "./gazetteer";

/**
 * The census crosswalk (Part 9, area_economics): the Census units a neighbourhood is made of, so ACS
 * 5-year estimates for those units can be rolled up to it. Polygon-free: it answers from the catalog
 * and two kinds of small generated tables, each loaded on first use like the gazetteers.
 *
 * - ZIP-area cities (Nashville and the ten of D39): an area is one ZCTA, or a host ZCTA with the tiny
 *   ones merged into it (tools/geo/build.ts), so its units are the zip of its id `zcta_<zip>` plus every
 *   alias "ZIP <zip>". ACS reports whole ZCTAs, so an area clipped to the city's counties gets figures for
 *   the whole ZIP: `clipped` says so, from its "(… part)" label or from the share of its ZCTAs' land that
 *   lies inside the counties (data/zcta-clip.ts; the label alone misses clipped ZIPs named after a place).
 * - New York and Austin: 2020 census tracts, each assigned whole to the area holding its interior point
 *   (data/tracts-<metro>.ts, built by tools/geo/tracts.ts from the Census 2020 Gazetteer tract file).
 *   A tract whose point lies in no area (a park, an airport, outside the planning areas) belongs to none.
 */

/** One metro's tract table: tract GEOIDs (state, county, tract: 11 digits) per area id. */
export interface TractCrosswalk {
  metro: MetroId;
  /** Where the tracts and their interior points come from, and how they were assigned. */
  source: string;
  /** Areas holding no tract interior point are absent. */
  areas: Readonly<Record<string, readonly string[]>>;
  /**
   * For an area holding no tract interior point (one smaller than the tracts around it): the tract whose
   * interior point is nearest the area's centre, within NEAREST_TRACT_MAX_KM. It stands in for the area
   * and reaches beyond it, so its figures are approximate for the area.
   */
  nearest?: Readonly<Record<string, string>>;
}

/** Loads one metro's tract table on demand. */
export type TractCrosswalkLoader = () => Promise<TractCrosswalk>;

/** How much of each clipped ZIP area's ZCTA land lies inside its city's counties. */
export interface ZctaClipTable {
  source: string;
  /**
   * Per metro and area id: the whole percent (0-98) of the land of the area's ZCTAs inside the counties
   * the city is clipped to. Areas with 99% or more inside are absent.
   */
  inside: Readonly<Partial<Record<MetroId, Readonly<Record<string, number>>>>>;
}

/** Where the crosswalk tables load from: the shipped modules, or test doubles. */
export interface CensusCrosswalk {
  tracts: Readonly<Partial<Record<MetroId, TractCrosswalkLoader>>>;
  zctaClip: () => Promise<ZctaClipTable>;
}

/** The tract cities: their areas are not ZIP areas, so their units are tracts (D28). */
export const TRACT_LOADERS: Readonly<Partial<Record<MetroId, TractCrosswalkLoader>>> = {
  nyc: () => import("./data/tracts-nyc").then((m) => m.NYC_TRACTS),
  austin: () => import("./data/tracts-austin").then((m) => m.AUSTIN_TRACTS),
};

export const CENSUS_CROSSWALK: CensusCrosswalk = {
  tracts: TRACT_LOADERS,
  zctaClip: () => import("./data/zcta-clip").then((m) => m.ZCTA_CLIP),
};

// The unit types are contracts' (GeoApi.censusUnits), re-exported here for the package's callers.
export type { CensusUnits, TractUnits, ZctaUnits };

const ZCTA_AREA_ID = /^zcta_(\d{5})$/;
const ZIP_ALIAS = /^ZIP (\d{5})$/;
const PART_LABEL = /\([^()]* part\)$/;
const TRACT_GEOID = /^\d{11}$/;
/** How far the nearest tract interior point of an area holding none may lie from the area's centre. */
export const NEAREST_TRACT_MAX_KM = 2;
/** An area keeping less than this share of its ZIP land is a part, as tools/geo/zcta.ts labels them. */
export const MIN_WHOLE_PCT = 90;

/** A ZIP area's member ZCTAs (its id's zip, then every "ZIP <zip>" alias); null for any other area. */
export function memberZctas(area: Pick<CatalogArea, "id" | "aliases">): string[] | null {
  const own = ZCTA_AREA_ID.exec(area.id)?.[1];
  if (own === undefined) return null;
  const zctas = [own];
  for (const alias of area.aliases ?? []) {
    const zip = ZIP_ALIAS.exec(alias)?.[1];
    if (zip !== undefined && !zctas.includes(zip)) zctas.push(zip);
  }
  return zctas;
}

/** A ZIP area's units, given its city's clip table entry. */
export function zctaUnitsOf(metro: MetroId, area: CatalogArea, clip: Readonly<Record<string, number>> | undefined): ZctaUnits | null {
  const zctas = memberZctas(area);
  if (zctas === null) return null;
  const insidePct = clip?.[area.id] ?? null;
  const clipped = PART_LABEL.test(area.name) || (insidePct !== null && insidePct < MIN_WHOLE_PCT);
  return { kind: "zcta", metro, areaId: area.id, zctas, clipped, insidePct };
}

/** The distinct counties of tract GEOIDs, in order. */
export function countiesOf(tracts: readonly string[]): { state: string; county: string }[] {
  const seen = new Map<string, { state: string; county: string }>();
  for (const t of tracts) {
    if (!TRACT_GEOID.test(t)) throw new Error(`census crosswalk: "${t}" is not an 11-digit tract GEOID`);
    const key = t.slice(0, 5);
    if (!seen.has(key)) seen.set(key, { state: t.slice(0, 2), county: t.slice(2, 5) });
  }
  return [...seen.values()].sort((a, b) => (a.state + a.county).localeCompare(b.state + b.county));
}

/** A tract-city area's units, from its city's tract table. */
export function tractUnitsOf(metro: MetroId, areaId: string, table: TractCrosswalk): TractUnits {
  if (table.metro !== metro) throw new Error(`census crosswalk: the tract table for ${metro} declares ${table.metro}`);
  const own = table.areas[areaId] ?? [];
  const nearest = own.length === 0 ? table.nearest?.[areaId] : undefined;
  const tracts = nearest === undefined ? [...own].sort() : [nearest];
  return { kind: "tract", metro, areaId, tracts, nearestOnly: nearest !== undefined, counties: countiesOf(tracts) };
}

export interface CensusUnitsOptions {
  /** The areas to answer for; defaults to GAZETTEER_CATALOG. */
  catalog?: GazetteerCatalog;
  /** Defaults to CENSUS_CROSSWALK, the shipped tables. */
  crosswalk?: CensusCrosswalk;
}

async function unitsFor(metro: MetroId, areas: readonly CatalogArea[], crosswalk: CensusCrosswalk): Promise<CensusUnits[]> {
  if (areas.length === 0) return [];
  const loadTracts = crosswalk.tracts[metro];
  if (loadTracts !== undefined) {
    const table = await loadTracts();
    return areas.map((a) => tractUnitsOf(metro, a.id, table));
  }
  if (areas.every((a) => memberZctas(a) === null)) return [];
  const clip = (await crosswalk.zctaClip()).inside[metro];
  return areas.flatMap((a) => zctaUnitsOf(metro, a, clip) ?? []);
}

/**
 * The Census units of one neighbourhood: ZCTAs for a ZIP area, tracts in New York and Austin. Null for
 * an area the catalog does not list, or one that is neither (no shipped city has such areas).
 */
export async function censusUnitsOf(metro: MetroId, areaId: string, options: CensusUnitsOptions = {}): Promise<CensusUnits | null> {
  const area = (options.catalog ?? GAZETTEER_CATALOG)[metro]?.areas.find((a) => a.id === areaId);
  if (area === undefined) return null;
  const [units] = await unitsFor(metro, [area], options.crosswalk ?? CENSUS_CROSSWALK);
  return units ?? null;
}

/** The Census units of every neighbourhood of a city, in catalog order: the city comparator's rollup. */
export async function censusUnitsOfMetro(metro: MetroId, options: CensusUnitsOptions = {}): Promise<CensusUnits[]> {
  return unitsFor(metro, (options.catalog ?? GAZETTEER_CATALOG)[metro]?.areas ?? [], options.crosswalk ?? CENSUS_CROSSWALK);
}

/**
 * The ACS requests that cover a set of units: one ZCTA list (sorted, distinct), and one request per
 * county for tracts (the API returns every tract of a county; the caller keeps the ones it needs).
 */
export function censusGeosOf(units: readonly CensusUnits[]): CensusGeo[] {
  const zctas = new Set<string>();
  const counties = new Map<string, { state: string; county: string }>();
  for (const u of units) {
    if (u.kind === "zcta") for (const z of u.zctas) zctas.add(z);
    else for (const c of u.counties) counties.set(c.state + c.county, c);
  }
  const geos: CensusGeo[] = [];
  if (zctas.size > 0) geos.push({ kind: "zcta", zctas: [...zctas].sort() });
  for (const key of [...counties.keys()].sort()) {
    const c = counties.get(key) as { state: string; county: string };
    geos.push({ kind: "tract", state: c.state, county: c.county });
  }
  return geos;
}
