import type { MetroId } from "@ct/contracts";
import type { MultiPolygon, Polygon } from "geojson";

/**
 * The gazetteer data shape (D28): one module per metro, holding neighbourhood polygons and their
 * attribution. createGeo indexes whatever gazetteers it is given, so a metro's data module is the
 * only thing a new gazetteer needs.
 */

export interface GazetteerArea {
  /** Stable slug, the `ref` of an `{kind: "nbhd"}` area (contracts AreaArg), e.g. east_nashville. */
  id: string;
  name: string;
  /** Other names people use for the area, matched like `name`. */
  aliases?: readonly string[];
  /** Lon-first GeoJSON, as the open-data boundary files publish it. */
  geometry: Polygon | MultiPolygon;
}

export interface Gazetteer {
  metro: MetroId;
  /** Boundary attribution shown in exhibit captions: the publisher and the licence. */
  source: string;
  areas: readonly GazetteerArea[];
}

/**
 * The gazetteers this build ships. The Nashville and Austin boundary modules register here; a metro
 * without one has no neighbourhoods, so area tools and the AREAS list stay empty for it.
 */
export const GAZETTEERS: Readonly<Partial<Record<MetroId, Gazetteer>>> = {};
