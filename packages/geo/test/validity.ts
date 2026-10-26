// Exact validity checks for gazetteer data, shared by the shipped-data tests and the gazetteer build
// tests (tools/geo): closed simple rings on the 5-decimal lattice, and areas that do not overlap.
import type { MultiPolygon, Polygon, Position } from "geojson";

export const polygonsOf = (g: Polygon | MultiPolygon): Position[][][] => (g.type === "Polygon" ? [g.coordinates] : g.coordinates);

export function signedArea(ring: readonly Position[]): number {
  let s = 0;
  for (let i = 0; i + 1 < ring.length; i++) {
    const a = ring[i] as Position;
    const b = ring[i + 1] as Position;
    s += (a[0] as number) * (b[1] as number) - (b[0] as number) * (a[1] as number);
  }
  return s / 2;
}

function orient(a: Position, b: Position, c: Position): number {
  const v = ((b[0] as number) - (a[0] as number)) * ((c[1] as number) - (a[1] as number)) - ((b[1] as number) - (a[1] as number)) * ((c[0] as number) - (a[0] as number));
  return Math.sign(v);
}

function within(a: Position, b: Position, p: Position): boolean {
  return (
    Math.min(a[0] as number, b[0] as number) <= (p[0] as number) &&
    (p[0] as number) <= Math.max(a[0] as number, b[0] as number) &&
    Math.min(a[1] as number, b[1] as number) <= (p[1] as number) &&
    (p[1] as number) <= Math.max(a[1] as number, b[1] as number)
  );
}

function segmentsMeet(a: Position, b: Position, c: Position, d: Position): boolean {
  const [o1, o2, o3, o4] = [orient(a, b, c), orient(a, b, d), orient(c, d, a), orient(c, d, b)];
  if (o1 !== o2 && o3 !== o4) return true;
  return (o1 === 0 && within(a, b, c)) || (o2 === 0 && within(a, b, d)) || (o3 === 0 && within(c, d, a)) || (o4 === 0 && within(c, d, b));
}

/** 5-decimal degrees times 2e5: vertices and edge midpoints become exact integers. */
type Lattice = [number, number];
const toLattice = (p: Position): Lattice => [Math.round((p[0] as number) * 2e5), Math.round((p[1] as number) * 2e5)];

export interface Edges {
  edges: [Lattice, Lattice][];
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export function edgesOf(g: Polygon | MultiPolygon): Edges {
  const edges: [Lattice, Lattice][] = [];
  for (const ring of polygonsOf(g).flat()) {
    for (let i = 0; i + 1 < ring.length; i++) edges.push([toLattice(ring[i] as Position), toLattice(ring[i + 1] as Position)]);
  }
  const xs = edges.map((e) => e[0][0]);
  const ys = edges.map((e) => e[0][1]);
  return { edges, minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

/** Strictly inside (crossing number over every ring, exact on the lattice); a point on an edge is not. */
function strictlyInside(p: Lattice, shape: Edges): boolean {
  if (p[0] <= shape.minX || p[0] >= shape.maxX || p[1] <= shape.minY || p[1] >= shape.maxY) return false;
  let inside = false;
  for (const [a, b] of shape.edges) {
    const o = orient(a, b, p);
    if (o === 0 && within(a, b, p)) return false;
    if (a[1] > p[1] !== b[1] > p[1] && (b[1] > a[1] ? o > 0 : o < 0)) inside = !inside;
  }
  return inside;
}

/**
 * Why two areas overlap, or null when their interiors are disjoint: an edge of one properly crosses an
 * edge of the other, or a vertex or edge midpoint of one lies strictly inside the other. Exact, so a
 * sliver of any width is caught; shared borders and T-junctions are allowed.
 */
export function overlapProblem(a: Edges, b: Edges): string | null {
  if (a.minX > b.maxX || b.minX > a.maxX || a.minY > b.maxY || b.minY > a.maxY) return null;
  const near = (s: Edges, box: Edges): [Lattice, Lattice][] =>
    s.edges.filter(([p, q]) => Math.max(p[0], q[0]) >= box.minX && Math.min(p[0], q[0]) <= box.maxX && Math.max(p[1], q[1]) >= box.minY && Math.min(p[1], q[1]) <= box.maxY);
  const nearA = near(a, b);
  const nearB = near(b, a);
  for (const [p, q] of nearA) {
    for (const [r, s] of nearB) {
      const [o1, o2, o3, o4] = [orient(p, q, r), orient(p, q, s), orient(r, s, p), orient(r, s, q)];
      if (o1 * o2 < 0 && o3 * o4 < 0) return `edges cross near ${p.map((x) => x / 2e5).join(" ")}`;
    }
  }
  for (const [edges, other] of [[nearA, b], [nearB, a]] as const) {
    for (const [p, q] of edges) {
      for (const point of [p, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as Lattice]) {
        if (strictlyInside(point, other)) return `${point.map((x) => x / 2e5).join(" ")} lies inside the other area`;
      }
    }
  }
  return null;
}

/** Why a ring is not a valid closed simple ring, or null when it is. */
export function ringProblem(ring: readonly Position[]): string | null {
  if (ring.length < 4) return `${ring.length} points`;
  const first = ring[0] as Position;
  const last = ring[ring.length - 1] as Position;
  if (first[0] !== last[0] || first[1] !== last[1]) return "not closed";
  const pts = ring.slice(0, -1);
  for (const p of pts) {
    if (p.length !== 2 || !p.every((x) => Number.isFinite(x))) return "bad coordinate";
    if (!p.every((x) => Math.abs(x * 1e5 - Math.round(x * 1e5)) < 1e-6)) return `more than 5 decimals at ${p.join(" ")}`;
  }
  if (new Set(pts.map((p) => p.join(" "))).size !== pts.length) return "repeated vertex";
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      if (segmentsMeet(pts[i] as Position, pts[i + 1] as Position, pts[j] as Position, pts[(j + 1) % n] as Position)) return `edges ${i} and ${j} meet`;
    }
  }
  return null;
}
