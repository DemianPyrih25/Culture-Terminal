import type { LatLon, MetroId, RESERVED_METRO_IDS } from "@ct/contracts";
import type { MultiPolygon, Polygon } from "geojson";
import { AUSTIN } from "./data/austin";
import { NASHVILLE } from "./data/nashville";
import { NYC_DISTRICTS } from "./data/nyc-districts";

/**
 * The gazetteer data shape (D28): one module per metro, holding neighbourhood polygons and their
 * attribution. createGeo indexes whatever gazetteers it is given, so a metro's data module is the
 * only thing a new gazetteer needs.
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

/**
 * A metro a gazetteer is built for: a MetroId, or an id contracts reserves for a later tier (NYC, P1).
 * A reserved metro's data can ship ahead of its id; createGeo serves it once MetroId takes the id.
 */
export type GazetteerMetro = MetroId | (typeof RESERVED_METRO_IDS)[number];

export interface Gazetteer {
  metro: GazetteerMetro;
  /** Boundary attribution shown in exhibit captions: the publisher and the licence. */
  source: string;
  areas: readonly GazetteerArea[];
}

/**
 * The gazetteers this build ships (ATTRIBUTION.md). A metro without one has no neighbourhoods, so
 * area tools and the AREAS list stay empty for it. Nashville has no open-licence neighbourhood set,
 * so it ships Census ZIP areas with approximate neighbourhood aliases (D37). A further metro can ship
 * Census ZIP areas built by tools/geo/zcta.ts.
 *
 * NYC (P1), served once contracts MetroId takes "nyc", ships the city's 59 community districts, built
 * from its residential Neighborhood Tabulation Areas. Lift needs 5 gated cells per area (D18): at
 * geohash-6, the precision of Nashville's live heatmaps and of the mock's New York, every district holds
 * at least 5 cells (median 14), while 96 of the 197 NTAs hold fewer than 5. The NTAs ship too
 * (data/nyc-ntas.ts, tested alongside): if a live NYC baseline heatmap comes back at geohash-7, serve
 * NYC_NTAS here instead.
 */
export const GAZETTEERS: Readonly<Partial<Record<GazetteerMetro, Gazetteer>>> = { nashville: NASHVILLE, austin: AUSTIN, nyc: NYC_DISTRICTS };
