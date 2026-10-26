import { area } from "@turf/area";
import { booleanPointInPolygon } from "@turf/boolean-point-in-polygon";
import type { LatLon } from "@ct/contracts";
import type { MultiPolygon, Polygon } from "geojson";

/**
 * Geodesic measures of a neighbourhood outline, shared by createGeo and the gazetteer builds
 * (tools/geo), so a data module stores exactly what createGeo would compute.
 */

/** Geodesic area in km² (@turf/area). */
export function areaKm2(geometry: Polygon | MultiPolygon): number {
  return area(geometry) / 1_000_000;
}

/** Whether the outline holds the point, its edge included: the test GeoApi.locate applies. */
export function containsPoint(geometry: Polygon | MultiPolygon, point: LatLon): boolean {
  return booleanPointInPolygon([point.lon, point.lat], geometry);
}
