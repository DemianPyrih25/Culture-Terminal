import { METRO_LABEL, MetroId, type GeoApi, type LatLon, type Neighbourhood } from "@ct/contracts";
import Flatbush from "flatbush";
import type { MultiPolygon, Polygon } from "geojson";
import ngeohash from "ngeohash";
import { GAZETTEER_CATALOG } from "./catalog";
import { CENSUS_CROSSWALK, censusUnitsOf, censusUnitsOfMetro, type CensusCrosswalk, type CensusUnits } from "./census";
import {
  GAZETTEER_LOADERS,
  type CatalogArea,
  type CatalogMetro,
  type Gazetteer,
  type GazetteerCatalog,
  type GazetteerLoader,
  type GazetteerMetro,
} from "./gazetteer";
import { areaKm2, containsPoint } from "./measure";
import { normaliseAreaName } from "./names";
import { bboxOf, labelPoint, MAX_WKT_VERTICES, outline, outlineWkt, queryWkt } from "./shapes";

/**
 * The gazetteer (PLAN §10.1, D28): neighbourhoods per gazetteer metro, name matching for CLERK's
 * area text, polygons for signal.location and point-in-polygon for geohash cells. Skills reach it
 * only through SkillCtx.geo.
 *
 * Names, ids, centroids, areas and captions come from the catalog (catalog.ts) and answer at once for
 * every metro. The polygons behind locate and polygonWkt load per metro on first use: a caller awaits
 * ensure(metro) (or ensureMetros) before it asks either for that metro, and asking before then throws
 * GeoNotLoadedError rather than answering "no neighbourhood".
 */

export interface GeoOptions {
  /**
   * Gazetteers indexed at once, polygons included (tests and tools). Without it, createGeo serves the
   * shipped gazetteers: the catalog now, each metro's polygons on first ensure.
   */
  gazetteers?: Readonly<Partial<Record<GazetteerMetro, Gazetteer>>>;
  /** Without `gazetteers`: the area catalog. Defaults to GAZETTEER_CATALOG. */
  catalog?: GazetteerCatalog;
  /** Without `gazetteers`: how each metro's polygons load. Defaults to GAZETTEER_LOADERS. */
  loaders?: Readonly<Partial<Record<GazetteerMetro, GazetteerLoader>>>;
  /** The census crosswalk tables behind censusUnits. Defaults to CENSUS_CROSSWALK, the shipped ones. */
  census?: CensusCrosswalk;
}

/** The GeoApi createGeo returns: SkillCtx.geo, plus the loader its callers await. */
export interface Geo extends GeoApi {
  /**
   * Loads and indexes the metro's polygons, once per Geo: concurrent calls share one load, later calls
   * resolve at once, and a failed load is tried again by the next call. Resolves at once for a metro
   * without neighbourhoods.
   */
  ensure(metro: MetroId): Promise<void>;
  /** Whether locate and polygonWkt answer for the metro now. */
  ready(metro: MetroId): boolean;
  /**
   * The Census units of a neighbourhood (census.ts): ZCTAs for a ZIP area, tracts in New York and
   * Austin; null for an area this Geo does not serve. Loads only the small crosswalk table, no polygons.
   */
  censusUnits(metro: MetroId, id: string): Promise<CensusUnits | null>;
  /** The Census units of every neighbourhood of a city, in list order. */
  censusUnitsOfMetro(metro: MetroId): Promise<CensusUnits[]>;
}

/** locate or polygonWkt asked for a metro whose polygons were not loaded first. */
export class GeoNotLoadedError extends Error {
  constructor(readonly metro: MetroId) {
    super(`the ${METRO_LABEL[metro]} neighbourhood boundaries are not loaded: await geo.ensure("${metro}") first`);
    this.name = "GeoNotLoadedError";
  }
}

/** Neighbourhood ids are the `ref` of an `{kind: "nbhd"}` area, so they follow AreaArg's pattern. */
const AREA_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface NameIndex {
  source: string | null;
  list: readonly Neighbourhood[];
  byId: ReadonlyMap<string, Neighbourhood>;
  byName: ReadonlyMap<string, Neighbourhood>;
}

interface ShapeIndex {
  /** Neighbourhood ids in box order. */
  ids: readonly string[];
  shapes: ReadonlyMap<string, Polygon | MultiPolygon>;
  /** signal.location WKT per neighbourhood, written once when the metro loads. */
  wkt: ReadonlyMap<string, string>;
  /** Bounding boxes in `ids` order; null without neighbourhoods (Flatbush needs at least one item). */
  boxes: Flatbush | null;
}

const NO_NAMES: NameIndex = { source: null, list: [], byId: new Map(), byName: new Map() };

function checkId(metro: MetroId, id: string, seen: Set<string>): void {
  if (!AREA_ID.test(id)) throw new Error(`${metro} gazetteer: "${id}" is not a valid neighbourhood id`);
  if (seen.has(id)) throw new Error(`${metro} gazetteer: neighbourhood id "${id}" repeats`);
  seen.add(id);
}

/** Indexes one metro's names. Gazetteer data is ours, so a malformed module fails loudly. */
function indexNames(metro: MetroId, source: string, areas: readonly CatalogArea[]): NameIndex {
  const list: Neighbourhood[] = [];
  const byId = new Map<string, Neighbourhood>();
  const byName = new Map<string, Neighbourhood>();
  const seen = new Set<string>();
  for (const a of areas) {
    checkId(metro, a.id, seen);
    const n: Neighbourhood = { id: a.id, name: a.name, metro, centroid: a.centroid, areaKm2: a.areaKm2 };
    list.push(n);
    byId.set(a.id, n);
    for (const name of [a.name, ...(a.aliases ?? []), ...(a.approximateAliases ?? [])]) {
      const key = normaliseAreaName(name);
      const taken = byName.get(key);
      if (taken !== undefined && taken.id !== a.id) {
        throw new Error(`${metro} gazetteer: "${name}" names both ${taken.id} and ${a.id}`);
      }
      byName.set(key, n);
    }
  }
  return { source, list, byId, byName };
}

/** Indexes one metro's polygons, validating every outline and query polygon. */
function indexShapes(metro: MetroId, gazetteer: Gazetteer): ShapeIndex {
  if (gazetteer.metro !== metro) throw new Error(`gazetteer for ${metro} declares metro ${gazetteer.metro}`);
  const ids: string[] = [];
  const shapes = new Map<string, Polygon | MultiPolygon>();
  const wkt = new Map<string, string>();
  const seen = new Set<string>();
  for (const a of gazetteer.areas) {
    checkId(metro, a.id, seen);
    const ring = outline(a.geometry);
    if (ring.length < 4) throw new Error(`${metro} gazetteer: ${a.id} has no usable outline`);
    const queryRing = a.query?.coordinates[0];
    if (a.query !== undefined && (queryRing === undefined || queryRing.length < 4 || queryRing.length > MAX_WKT_VERTICES)) {
      throw new Error(`${metro} gazetteer: ${a.id} has a query polygon outside 4–${MAX_WKT_VERTICES} points`);
    }
    ids.push(a.id);
    shapes.set(a.id, a.geometry);
    wkt.set(a.id, a.query === undefined ? outlineWkt(a.geometry) : queryWkt(a.query));
  }
  let boxes: Flatbush | null = null;
  if (ids.length > 0) {
    boxes = new Flatbush(ids.length);
    for (const id of ids) {
      const b = bboxOf(shapes.get(id) as Polygon | MultiPolygon);
      boxes.add(b.minLon, b.minLat, b.maxLon, b.maxLat);
    }
    boxes.finish();
  }
  return { ids, shapes, wkt, boxes };
}

/** A gazetteer's catalog entry, as createGeo computes it: centroids and areas filled in. */
export function catalogEntry(gazetteer: Gazetteer): { source: string; areas: CatalogArea[] } {
  return {
    source: gazetteer.source,
    areas: gazetteer.areas.map((a) => ({
      id: a.id,
      name: a.name,
      ...(a.aliases === undefined ? {} : { aliases: a.aliases }),
      ...(a.approximateAliases === undefined ? {} : { approximateAliases: a.approximateAliases }),
      centroid: a.centroid ?? labelPoint(a.geometry),
      areaKm2: a.areaKm2 ?? areaKm2(a.geometry),
    })),
  };
}

/** A loaded gazetteer must be the one the catalog was generated from: same source, same ids in order. */
function checkAgainstCatalog(metro: MetroId, names: NameIndex, gazetteer: Gazetteer): void {
  const ids = gazetteer.areas.map((a) => a.id);
  const same =
    names.source === gazetteer.source && ids.length === names.list.length && ids.every((id, i) => names.list[i]?.id === id);
  if (!same) {
    throw new Error(`${metro} gazetteer does not match catalog.ts: regenerate it with \`pnpm --filter @ct/geo test -u\``);
  }
}

export function createGeo(options: GeoOptions = {}): Geo {
  const names = new Map<MetroId, NameIndex>();
  const shapes = new Map<MetroId, ShapeIndex>();
  const pending = new Map<MetroId, Promise<void>>();
  /** What censusUnits answers from: each served metro's catalog entry. */
  const served: Partial<Record<MetroId, CatalogMetro>> = {};
  let loaders: Readonly<Partial<Record<GazetteerMetro, GazetteerLoader>>> = {};

  if (options.gazetteers !== undefined) {
    for (const metro of MetroId.options) {
      const g = options.gazetteers[metro];
      if (g === undefined) continue;
      // Polygons first: they validate every outline before a centroid is computed from one.
      shapes.set(metro, indexShapes(metro, g));
      const entry = catalogEntry(g);
      names.set(metro, indexNames(metro, entry.source, entry.areas));
      served[metro] = entry;
    }
  } else {
    const catalog = options.catalog ?? GAZETTEER_CATALOG;
    loaders = options.loaders ?? GAZETTEER_LOADERS;
    for (const metro of MetroId.options) {
      const entry = catalog[metro];
      if (entry === undefined) continue;
      if (entry.areas.length > 0 && loaders[metro] === undefined) throw new Error(`catalog.ts lists ${metro} but no gazetteer loads it`);
      names.set(metro, indexNames(metro, entry.source, entry.areas));
      served[metro] = entry;
    }
  }

  const of = (metro: MetroId): NameIndex => names.get(metro) ?? NO_NAMES;
  const census = { catalog: served, crosswalk: options.census ?? CENSUS_CROSSWALK };
  /** The metro's polygons; null for a metro without neighbourhoods. */
  const shapesOf = (metro: MetroId): ShapeIndex | null => {
    if (of(metro).list.length === 0) return null;
    const s = shapes.get(metro);
    if (s === undefined) throw new GeoNotLoadedError(metro);
    return s;
  };

  return {
    metros: () => MetroId.options,
    neighbourhoods: (metro) => of(metro).list,
    neighbourhood: (metro, id) => of(metro).byId.get(id) ?? null,
    matchNeighbourhood: (metro, text) => of(metro).byName.get(normaliseAreaName(text)) ?? null,
    polygonWkt: (metro, id) => (of(metro).byId.has(id) ? (shapesOf(metro)?.wkt.get(id) ?? null) : null),
    locate(metro, point: LatLon) {
      const s = shapesOf(metro);
      if (s === null || s.boxes === null) return null;
      for (const i of s.boxes.search(point.lon, point.lat, point.lon, point.lat)) {
        const id = s.ids[i];
        const shape = id === undefined ? undefined : s.shapes.get(id);
        if (id !== undefined && shape !== undefined && containsPoint(shape, point)) return id;
      }
      return null;
    },
    geohashCentroid(geohash) {
      if (!/^[0-9b-hjkmnp-z]{1,12}$/.test(geohash)) throw new RangeError(`geohashCentroid: "${geohash}" is not a geohash`);
      const { latitude, longitude } = ngeohash.decode(geohash);
      return { lat: latitude, lon: longitude };
    },
    boundarySource: (metro) =>
      of(metro).source ?? `No neighbourhood boundaries for ${METRO_LABEL[metro]} in this build; area exhibits are unavailable.`,
    ready: (metro) => of(metro).list.length === 0 || shapes.has(metro),
    censusUnits: (metro, id) => censusUnitsOf(metro, id, census),
    censusUnitsOfMetro: (metro) => censusUnitsOfMetro(metro, census),
    ensure(metro) {
      if (of(metro).list.length === 0 || shapes.has(metro)) return Promise.resolve();
      const known = pending.get(metro);
      if (known !== undefined) return known;
      const load = loaders[metro];
      if (load === undefined) return Promise.reject(new GeoNotLoadedError(metro));
      const loading = Promise.resolve()
        .then(load)
        .then((gazetteer) => {
          const s = indexShapes(metro, gazetteer);
          checkAgainstCatalog(metro, of(metro), gazetteer);
          shapes.set(metro, s);
        })
        .finally(() => pending.delete(metro));
      pending.set(metro, loading);
      return loading;
    },
  };
}
