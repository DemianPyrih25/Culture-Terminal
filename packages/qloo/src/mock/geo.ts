/** Minimal geometry for the synthetic API: geohash cells, distances and WKT centroids. */

export interface LatLon {
  lat: number;
  lon: number;
}

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export function geohashEncode(lat: number, lon: number, precision: number): string {
  let latMin = -90;
  let latMax = 90;
  let lonMin = -180;
  let lonMax = 180;
  let hash = "";
  let bits = 0;
  let index = 0;
  let lonTurn = true;
  while (hash.length < precision) {
    if (lonTurn) {
      const mid = (lonMin + lonMax) / 2;
      index = index * 2 + (lon >= mid ? 1 : 0);
      if (lon >= mid) lonMin = mid;
      else lonMax = mid;
    } else {
      const mid = (latMin + latMax) / 2;
      index = index * 2 + (lat >= mid ? 1 : 0);
      if (lat >= mid) latMin = mid;
      else latMax = mid;
    }
    lonTurn = !lonTurn;
    if (++bits === 5) {
      hash += BASE32.charAt(index);
      bits = 0;
      index = 0;
    }
  }
  return hash;
}

/** Cell size in degrees at a geohash precision (longitude takes the odd bit). */
export function geohashCellSize(precision: number): { lat: number; lon: number } {
  const bits = 5 * precision;
  return { lat: 180 / 2 ** Math.floor(bits / 2), lon: 360 / 2 ** Math.ceil(bits / 2) };
}

export function distanceKm(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

/** Moves a point by kilometres north and east (flat approximation, fine at metro scale). */
export function offsetKm(from: LatLon, northKm: number, eastKm: number): LatLon {
  const lat = from.lat + northKm / 111.32;
  const lon = from.lon + eastKm / (111.32 * Math.cos((from.lat * Math.PI) / 180));
  return { lat, lon };
}

/**
 * Vertex mean of a lon-first WKT POINT or POLYGON (outer ring, closing vertex dropped), or null
 * when the value is not WKT. Qloo resolves both forms to the same area at neighbourhood scale (G8).
 */
export function wktCentroid(wkt: string): LatLon | null {
  const match = /^\s*(POINT|POLYGON)\s*\(+([^)]*)\)/i.exec(wkt);
  if (!match?.[2]) return null;
  const points = match[2]
    .split(",")
    .map((pair) => pair.trim().split(/\s+/).map(Number))
    .filter((xy): xy is [number, number] => xy.length === 2 && xy.every(Number.isFinite));
  if (points.length === 0) return null;
  const first = points[0];
  const last = points[points.length - 1];
  const ring = points.length > 1 && first && last && first[0] === last[0] && first[1] === last[1] ? points.slice(0, -1) : points;
  const lon = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lat = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  return { lat, lon };
}

/** A `lat,lon` pair as /search takes it in `filter.location`, or null. */
export function parseLatLon(value: string): LatLon | null {
  const parts = value.split(",").map((s) => Number(s.trim()));
  if (parts.length !== 2) return null;
  const [lat, lon] = parts;
  if (lat === undefined || lon === undefined || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  return { lat, lon };
}
