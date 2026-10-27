import type { LatLon, MetroId } from "@ct/contracts";
import type { MultiPolygon, Polygon } from "geojson";

/**
 * The gazetteer data shape (D28): one module per metro, holding neighbourhood polygons and their
 * attribution. createGeo indexes whatever gazetteers it is given, so a metro's data module, its loader
 * below and its catalog entry are all a new gazetteer needs.
 */

export interface GazetteerArea {
  /** Stable slug, the `ref` of an `{kind: "nbhd"}` area (contracts AreaArg), e.g. hyde_park or zcta_37206. */
  id: string;
  name: string;
  /** Other names people use for the area, matched like `name`. */
  aliases?: readonly string[];
  /**
   * Names of places whose borders the area only approximates, matched like `name`: a ZIP area for the
   * community it is commonly named for, whose own borders can take in only part of it (D37).
   * ATTRIBUTION.md lists each one.
   */
  approximateAliases?: readonly string[];
  /** Lon-first GeoJSON, as the open-data boundary files publish it: the display outline. */
  geometry: Polygon | MultiPolygon;
  /**
   * The outline signal.location sends: a simple ring of at most MAX_WKT_VERTICES points, the closing
   * one included, reduced at build time without self-intersections. Without it, polygonWkt reduces
   * the display outline at run time.
   */
  query?: Polygon;
  /**
   * A point inside the outline, as createGeo computes it (shapes labelPoint): its area-weighted
   * centroid, or an interior label point when that falls outside. Computed at start-up when absent.
   */
  centroid?: LatLon;
  /** Build-time geodesic area in km² (as createGeo computes it); computed at start-up when absent. */
  areaKm2?: number;
}

/** A metro a gazetteer is built for: every map city is a contracts MetroId (D28). */
export type GazetteerMetro = MetroId;

export interface Gazetteer {
  metro: GazetteerMetro;
  /** Boundary attribution shown in exhibit captions: the publisher and the licence. */
  source: string;
  areas: readonly GazetteerArea[];
}

/**
 * One gazetteer's areas without their polygons: what name matching, area lists, centroids and captions
 * need. catalog.ts holds it for every shipped gazetteer, generated from the data modules (see there), so
 * the server answers those questions without loading a single polygon.
 */
export interface CatalogArea {
  id: string;
  name: string;
  aliases?: readonly string[];
  approximateAliases?: readonly string[];
  centroid: LatLon;
  areaKm2: number;
}

export interface CatalogMetro {
  /** Boundary attribution, as the gazetteer's `source`. */
  source: string;
  areas: readonly CatalogArea[];
}

export type GazetteerCatalog = Readonly<Partial<Record<GazetteerMetro, CatalogMetro>>>;

/** Loads one metro's gazetteer module on demand. */
export type GazetteerLoader = () => Promise<Gazetteer>;

/**
 * The gazetteers this build ships (ATTRIBUTION.md), one per map city (D28), each loaded on first use:
 * the polygons are megabytes of data, and a process needs only the metros its questions name. A metro
 * without one has no neighbourhoods, so area tools and the AREAS list stay empty for it. Nashville has
 * no open-licence neighbourhood set, so it ships Census ZIP areas with approximate neighbourhood
 * aliases (D37); the ten ZIP-area cities follow it, built by tools/geo/zcta.ts and clipped to their
 * core counties (D39). A new gazetteer needs a loader here and a regenerated catalog.ts.
 *
 * NYC ships the city's 59 community districts, built from its residential Neighborhood Tabulation
 * Areas. Lift needs 5 gated cells per area (D18): at geohash-6, the precision of Nashville's live
 * heatmaps and of the mock's New York, every district holds at least 5 cells (median 14), while 96 of
 * the 197 NTAs hold fewer than 5. The NTAs ship too (data/nyc-ntas.ts, tested alongside): if a live NYC
 * baseline heatmap comes back at geohash-7, serve NYC_NTAS here instead.
 */
export const GAZETTEER_LOADERS: Readonly<Partial<Record<GazetteerMetro, GazetteerLoader>>> = {
  nashville: () => import("./data/nashville").then((m) => m.NASHVILLE),
  austin: () => import("./data/austin").then((m) => m.AUSTIN),
  nyc: () => import("./data/nyc-districts").then((m) => m.NYC_DISTRICTS),
  los_angeles: () => import("./data/los-angeles").then((m) => m.LOS_ANGELES),
  chicago: () => import("./data/chicago").then((m) => m.CHICAGO),
  miami: () => import("./data/miami").then((m) => m.MIAMI),
  san_francisco: () => import("./data/san-francisco").then((m) => m.SAN_FRANCISCO),
  seattle: () => import("./data/seattle").then((m) => m.SEATTLE),
  boston: () => import("./data/boston").then((m) => m.BOSTON),
  denver: () => import("./data/denver").then((m) => m.DENVER),
  atlanta: () => import("./data/atlanta").then((m) => m.ATLANTA),
  houston: () => import("./data/houston").then((m) => m.HOUSTON),
  dallas: () => import("./data/dallas").then((m) => m.DALLAS),
};

/** One metro's shipped gazetteer, loaded on demand (the module system keeps it); null without one. */
export async function loadGazetteer(metro: GazetteerMetro): Promise<Gazetteer | null> {
  const load = GAZETTEER_LOADERS[metro];
  return load === undefined ? null : load();
}

/** Every shipped gazetteer, loaded: for tests and build tools, never for a request path. */
export async function loadGazetteers(): Promise<Readonly<Partial<Record<GazetteerMetro, Gazetteer>>>> {
  const entries = await Promise.all(
    (Object.entries(GAZETTEER_LOADERS) as [GazetteerMetro, GazetteerLoader][]).map(async ([metro, load]) => [metro, await load()] as const),
  );
  return Object.fromEntries(entries);
}
