import type { LatLon } from "@ct/contracts";
import type { MultiPolygon, Polygon, Position } from "geojson";

/**
 * Planar ring geometry for neighbourhood-sized polygons, where lon/lat distortion is negligible:
 * the outline a WKT signal uses, its centroid, a point inside it and its bounding box. Areas in km²
 * come from @turf/area, which is geodesic.
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

/** The polygon (outer ring, then holes) whose outer ring has the largest area. */
function largestPolygon(geometry: Polygon | MultiPolygon): readonly Ring[] {
  const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let best: readonly Ring[] = [[]];
  let bestArea = -1;
  for (const polygon of polygons) {
    const area = Math.abs(doubleArea(polygon[0] ?? []));
    if (area > bestArea) {
      best = polygon;
      bestArea = area;
    }
  }
  return best;
}

/** The outer ring of the polygon with the largest area: holes and islands do not change a taste signal. */
export function outline(geometry: Polygon | MultiPolygon): Ring {
  return largestPolygon(geometry)[0] ?? [];
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

/** Where the parallel at `y` runs inside the rings (even-odd), as [west, east] longitude spans. */
function spansAt(rings: readonly Ring[], y: number): [number, number][] {
  const xs: number[] = [];
  for (const ring of rings) {
    const pts = openRing(ring);
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i] as Position;
      const b = pts[(i + 1) % pts.length] as Position;
      // Half-open in latitude, so a vertex on the parallel is counted once.
      if (lat(a) > y !== lat(b) > y) xs.push(lon(a) + ((y - lat(a)) / (lat(b) - lat(a))) * (lon(b) - lon(a)));
    }
  }
  xs.sort((p, q) => p - q);
  const spans: [number, number][] = [];
  for (let i = 0; i + 1 < xs.length; i += 2) spans.push([xs[i] as number, xs[i + 1] as number]);
  return spans;
}

/**
 * A point inside the outline's polygon, for markers and point queries: the outline's area-weighted
 * centroid when it lies inside, holes excluded; otherwise the middle of the widest span of the polygon
 * along the parallel through that centroid. An area wrapped round a river bend can have its centroid
 * on the far bank, in another area.
 */
export function labelPoint(geometry: Polygon | MultiPolygon): LatLon {
  const polygon = largestPolygon(geometry);
  const c = centroid(polygon[0] ?? []);
  const spans = spansAt(polygon, c.lat);
  if (spans.length === 0 || spans.some(([west, east]) => west < c.lon && c.lon < east)) return c;
  const [west, east] = spans.reduce((best, s) => (s[1] - s[0] > best[1] - best[0] ? s : best));
  return { lat: c.lat, lon: (west + east) / 2 };
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

/** Distinct vertices as closed lon-first WKT in the canonical form the Qloo client sends. */
function ringWkt(pts: readonly Position[], caller: string): string {
  if (pts.length < 3) throw new Error(`${caller}: the outline has fewer than 3 vertices`);
  if (pts.length > MAX_WKT_VERTICES - 1) throw new Error(`${caller}: ${pts.length + 1} points exceed the ${MAX_WKT_VERTICES}-point budget`);
  const first = pts[0] as Position;
  const body = [...pts, first].map((p) => `${coordinate(lon(p))} ${coordinate(lat(p))}`).join(",");
  return `POLYGON((${body}))`;
}

/**
 * The outline as lon-first WKT, closed, with at most MAX_WKT_VERTICES points including the closing
 * one, in the canonical form the Qloo client sends: `POLYGON((-86.9 36.05,-86.65 36.05,…))`.
 */
export function outlineWkt(geometry: Polygon | MultiPolygon): string {
  return ringWkt(simplifyRing(outline(geometry), MAX_WKT_VERTICES - 1), "outlineWkt");
}

/** A build-time query polygon (GazetteerArea.query) as WKT: its outer ring as is, already in budget. */
export function queryWkt(query: Polygon): string {
  return ringWkt(openRing(query.coordinates[0] ?? []), "queryWkt");
}
