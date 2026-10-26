import type { MetroId } from "@ct/contracts";

/**
 * The neighbourhood outlines a LiftMap draws: the gazetteer polygons (@ct/geo) of one metro, served
 * as GeoJSON by /api/geo/[metro]. The GeoLift dataset names neighbourhoods by gazetteer id only, so
 * the outlines travel once per metro, cached, instead of inside every dataset.
 */

export type OutlineGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface OutlineFeature {
  type: "Feature";
  id: string;
  properties: {
    id: string;
    name: string;
    /** [lon, lat]: where the neighbourhood's marker and label go. */
    centroid: [number, number];
  };
  geometry: OutlineGeometry;
}

export interface OutlineCollection {
  type: "FeatureCollection";
  metro: MetroId;
  /** Boundary attribution (publisher and licence), or null for a metro without a gazetteer. */
  source: string | null;
  features: OutlineFeature[];
}

/** The outlines route of a metro. */
export function outlinesUrl(metro: MetroId): string {
  return `/api/geo/${metro}`;
}
