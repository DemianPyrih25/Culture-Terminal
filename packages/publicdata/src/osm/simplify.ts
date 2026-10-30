import { OSM_QUERY_LIMITS } from "@ct/contracts";

/**
 * Polygon simplification for Overpass `poly:` filters (Part 11 design §3.1). A gazetteer outline can
 * have hundreds of vertices; Overpass parses every vertex of every `poly:` filter, and the request body
 * repeats the polygon per key. So each ring is cut to at most OSM_QUERY_LIMITS.polyVertices (48) with
 * Douglas-Peucker, raising the tolerance until it fits, and rounded to 5 decimals (about 1 m).
 * Coordinates are [lat, lon]; distances are planar with longitude scaled by cos(latitude), which is
 * exact enough at neighbourhood scale.
 */

export type LatLon = readonly [number, number];

/** 5 decimals: about 1.1 m of latitude. */
export const OSM_COORD_DECIMALS = 5;

const round = (n: number): number => Number(n.toFixed(OSM_COORD_DECIMALS));

/** The smallest tolerance tried, in degrees of latitude (about 1 m); doubled until the ring fits. */
const START_TOLERANCE = 1e-5;
const MAX_ROUNDS = 40;

/**
 * The ring with at most `maxVertices` vertices (open: the closing vertex is not repeated), rounded to 5
 * decimals, consecutive duplicates removed. Throws on fewer than 3 distinct vertices or a coordinate
 * out of range.
 */
export function simplifyRing(ring: readonly LatLon[], maxVertices: number = OSM_QUERY_LIMITS.polyVertices): [number, number][] {
  if (maxVertices < 3) throw new RangeError(`maxVertices must be at least 3, got ${maxVertices}`);
  for (const [lat, lon] of ring) {
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      throw new RangeError(`ring vertex [${lat}, ${lon}] is not a [lat, lon] coordinate`);
    }
  }
  const open = dedupe(ring.map(([lat, lon]) => [round(lat), round(lon)] as [number, number]));
  if (open.length < 3) throw new RangeError(`a polygon needs at least 3 distinct vertices, got ${open.length}`);
  if (open.length <= maxVertices) return open;

  const cos = Math.cos((meanLat(open) * Math.PI) / 180);
  let tolerance = START_TOLERANCE;
  for (let attempt = 0; attempt < MAX_ROUNDS; attempt++, tolerance *= 2) {
    const kept = simplifyClosed(open, tolerance, cos);
    if (kept.length <= maxVertices && kept.length >= 3) return kept;
    if (kept.length < 3) break;
  }
  // A ring no tolerance brings to 3..max vertices (only a degenerate sliver): sample it evenly.
  return dedupe(Array.from({ length: maxVertices }, (_, i) => open[Math.floor((i * open.length) / maxVertices)] as [number, number]));
}

/** Overpass `poly:` text: "lat lon lat lon …". */
export function polyText(ring: readonly LatLon[]): string {
  return ring.map(([lat, lon]) => `${round(lat)} ${round(lon)}`).join(" ");
}

function dedupe(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const last = out.at(-1);
    if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
  }
  // An explicitly closed ring repeats its first vertex at the end.
  while (out.length > 1) {
    const first = out[0] as [number, number];
    const last = out.at(-1) as [number, number];
    if (first[0] !== last[0] || first[1] !== last[1]) break;
    out.pop();
  }
  return out;
}

const meanLat = (points: readonly LatLon[]): number => points.reduce((s, p) => s + p[0], 0) / points.length;

/**
 * Douglas-Peucker on a closed ring: split at vertex 0 and the vertex farthest from it, simplify both
 * chains, and join them without repeating the split points.
 */
function simplifyClosed(points: readonly [number, number][], tolerance: number, cos: number): [number, number][] {
  let far = 0;
  let best = -1;
  for (let i = 1; i < points.length; i++) {
    const d = dist2(points[0] as LatLon, points[i] as LatLon, cos);
    if (d > best) {
      best = d;
      far = i;
    }
  }
  const a = chain(points, 0, far, tolerance, cos);
  const b = chain([...points.slice(far), points[0] as [number, number]], 0, points.length - far, tolerance, cos);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

/** Douglas-Peucker on points[from..to], both ends kept (iterative, so long rings never overflow the stack). */
function chain(points: readonly [number, number][], from: number, to: number, tolerance: number, cos: number): [number, number][] {
  const keep = new Uint8Array(points.length);
  keep[from] = 1;
  keep[to] = 1;
  const stack: [number, number][] = [[from, to]];
  const tol2 = tolerance * tolerance;
  while (stack.length > 0) {
    const [s, e] = stack.pop() as [number, number];
    let index = -1;
    let max = tol2;
    for (let i = s + 1; i < e; i++) {
      const d = segDist2(points[i] as LatLon, points[s] as LatLon, points[e] as LatLon, cos);
      if (d > max) {
        max = d;
        index = i;
      }
    }
    if (index >= 0) {
      keep[index] = 1;
      stack.push([s, index], [index, e]);
    }
  }
  const out: [number, number][] = [];
  for (let i = from; i <= to; i++) if (keep[i]) out.push(points[i] as [number, number]);
  return out;
}

function dist2(a: LatLon, b: LatLon, cos: number): number {
  const dy = a[0] - b[0];
  const dx = (a[1] - b[1]) * cos;
  return dx * dx + dy * dy;
}

/** Squared distance from p to the segment a–b, in latitude degrees. */
function segDist2(p: LatLon, a: LatLon, b: LatLon, cos: number): number {
  const ax = a[1] * cos;
  const bx = b[1] * cos;
  const px = p[1] * cos;
  const dx = bx - ax;
  const dy = b[0] - a[0];
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (p[0] - a[0]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx - px;
  const qy = a[0] + t * dy - p[0];
  return qx * qx + qy * qy;
}
