import type { Bounds } from "./geohash";
import { mercatorY } from "./geohash";
import type { OutlineGeometry } from "./lift-outlines";

/**
 * Pure geometry for the area map (tenant_mix, area_profile): the rings of an outline, its bounds, and a
 * Mercator fit of the outline into a box, so the server-free schematic and the tests share one projection.
 */

/** The corner pin's flag. */
export const CORNER_LABEL = "Your corner";

/** The area map's caption. */
export function areaMapCaption(area: string, venues: boolean): string {
  return venues ? `Outline: ${area} boundary. Dots: a sample of venues nearby.` : `Outline: ${area} boundary.`;
}

export interface GeoPoint {
  lat: number;
  lon: number;
}

/** The outer and inner rings of a Polygon or MultiPolygon, as [lon, lat] lists. */
export function outlineRings(geometry: OutlineGeometry): number[][][] {
  return geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
}

/** [west, south, east, north] of an outline, or null when it has no point. */
export function outlineBounds(geometry: OutlineGeometry): Bounds | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const ring of outlineRings(geometry)) {
    for (const [lon, lat] of ring) {
      if (lon === undefined || lat === undefined) continue;
      w = Math.min(w, lon);
      e = Math.max(e, lon);
      s = Math.min(s, lat);
      n = Math.max(n, lat);
    }
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/** A Mercator fit of bounds into a width × height box with a margin. */
export function fitProjection(bounds: Bounds, width: number, height: number, margin = 28) {
  const toX = (lon: number) => (lon * Math.PI) / 180;
  const x0 = toX(bounds[0]);
  const x1 = toX(bounds[2]);
  const y0 = mercatorY(bounds[1]);
  const y1 = mercatorY(bounds[3]);
  const k = Math.min((width - margin * 2) / Math.max(1e-9, x1 - x0), (height - margin * 2) / Math.max(1e-9, y1 - y0));
  const offX = (width - (x1 - x0) * k) / 2;
  const offY = (height - (y1 - y0) * k) / 2;
  return (p: GeoPoint) => ({ x: offX + (toX(p.lon) - x0) * k, y: height - offY - (mercatorY(p.lat) - y0) * k });
}

/** An SVG path of the outline in a projection, one closed subpath per ring. */
export function outlinePath(geometry: OutlineGeometry, project: (p: GeoPoint) => { x: number; y: number }): string {
  return outlineRings(geometry)
    .filter((ring) => ring.length > 2)
    .map(
      (ring) =>
        ring
          .map(([lon, lat], i) => {
            const at = project({ lat: lat ?? 0, lon: lon ?? 0 });
            return `${i === 0 ? "M" : "L"}${at.x.toFixed(1)} ${at.y.toFixed(1)}`;
          })
          .join("") + "Z",
    )
    .join("");
}
