import type { LatLon } from "@ct/contracts";
import type { MultiPolygon, Polygon, Position } from "geojson";

/**
 * Planar ring geometry for neighbourhood-sized polygons, where lon/lat distortion is negligible:
 * the outline a WKT signal uses, its centroid and its bounding box. Areas in km² come from
 * @turf/area, which is geodesic.
 */

/** Qloo's signal.location polygon budget (GeoApi.polygonWkt). */
export const MAX_WKT_VERTICES = 40;
/** Canonical WKT precision, as the Qloo client sends it (about a metre). */
const COORD_DP = 5;

type Ring = readonly Position[];

export interface Bbox {
  minLon: number;
  minLat: number;
  maxLon: number;
  maxLat: number;
}

const lon = (p: Position): number => p[0] ?? Number.NaN;
const lat = (p: Position): number => p[1] ?? Number.NaN;

/** The ring without its closing point, which GeoJSON repeats. */
function openRing(ring: Ring): Position[] {
  const first = ring[0];
  const last = ring[ring.length - 1];
  const closed = ring.length > 1 && first !== undefined && last !== undefined && lon(first) === lon(last) && lat(first) === lat(last);
  return closed ? ring.slice(0, -1) : [...ring];
}

/** Twice the signed planar area of a ring (shoelace). */
function doubleArea(ring: Ring): number {
  const pts = openRing(ring);
  let sum = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as Position;
    const b = pts[(i + 1) % pts.length] as Position;
    sum += lon(a) * lat(b) - lon(b) * lat(a);
  }
  return sum;
}

/** The outer ring of the polygon with the largest area: holes and islands do not change a taste signal. */
export function outline(geometry: Polygon | MultiPolygon): Ring {
  const outers = geometry.type === "Polygon" ? [geometry.coordinates[0] ?? []] : geometry.coordinates.map((p) => p[0] ?? []);
  let best: Ring = [];
  let bestArea = -1;
  for (const ring of outers) {
    const area = Math.abs(doubleArea(ring));
    if (area > bestArea) {
      best = ring;
      bestArea = area;
    }
  }
  return best;
}

/** Area-weighted centroid of a ring; the vertex mean when the ring is degenerate. */
export function centroid(ring: Ring): LatLon {
  const pts = openRing(ring);
  if (pts.length === 0) throw new Error("centroid: the ring has no points");
  const a2 = doubleArea(ring);
  if (a2 === 0) {
    return {
      lat: pts.reduce((s, p) => s + lat(p), 0) / pts.length,
      lon: pts.reduce((s, p) => s + lon(p), 0) / pts.length,
    };
  }
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i] as Position;
    const b = pts[(i + 1) % pts.length] as Position;
    const cross = lon(a) * lat(b) - lon(b) * lat(a);
    cx += (lon(a) + lon(b)) * cross;
    cy += (lat(a) + lat(b)) * cross;
  }
  return { lat: cy / (3 * a2), lon: cx / (3 * a2) };
}

export function bboxOf(geometry: Polygon | MultiPolygon): Bbox {
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
  const box: Bbox = { minLon: Infinity, minLat: Infinity, maxLon: -Infinity, maxLat: -Infinity };
  for (const p of rings.flat()) {
    box.minLon = Math.min(box.minLon, lon(p));
    box.minLat = Math.min(box.minLat, lat(p));
    box.maxLon = Math.max(box.maxLon, lon(p));
    box.maxLat = Math.max(box.maxLat, lat(p));
  }
  return box;
}

/** Triangle area of a vertex with its neighbours: what dropping it would change (Visvalingam). */
function weight(pts: readonly Position[], i: number): number {
  const n = pts.length;
  const a = pts[(i - 1 + n) % n] as Position;
  const b = pts[i] as Position;
  const c = pts[(i + 1) % n] as Position;
  return Math.abs((lon(a) - lon(c)) * (lat(b) - lat(a)) - (lon(a) - lon(b)) * (lat(c) - lat(a)));
}

/**
 * Drops the least significant vertices (Visvalingam–Whyatt) until the ring has at most `max`
 * distinct vertices. Deterministic: ties drop the earliest vertex.
 */
export function simplifyRing(ring: Ring, max: number): Position[] {
  if (max < 3) throw new RangeError(`simplifyRing: a ring needs at least 3 vertices, got max ${max}`);
  const pts = openRing(ring);
  while (pts.length > max) {
    let drop = 0;
    let least = Infinity;
    for (let i = 0; i < pts.length; i++) {
      const w = weight(pts, i);
      if (w < least) {
        least = w;
        drop = i;
      }
    }
    pts.splice(drop, 1);
  }
  return pts;
}

const coordinate = (x: number): string => {
  const factor = 10 ** COORD_DP;
  const rounded = Math.round(x * factor) / factor;
  return Object.is(rounded, -0) ? "0" : String(rounded);
};

/**
 * The outline as lon-first WKT, closed, with at most MAX_WKT_VERTICES points including the closing
 * one, in the canonical form the Qloo client sends: `POLYGON((-86.9 36.05,-86.65 36.05,…))`.
 */
export function outlineWkt(geometry: Polygon | MultiPolygon): string {
  const pts = simplifyRing(outline(geometry), MAX_WKT_VERTICES - 1);
  if (pts.length < 3) throw new Error("outlineWkt: the outline has fewer than 3 vertices");
  const first = pts[0] as Position;
  const body = [...pts, first].map((p) => `${coordinate(lon(p))} ${coordinate(lat(p))}`).join(",");
  return `POLYGON((${body}))`;
}
