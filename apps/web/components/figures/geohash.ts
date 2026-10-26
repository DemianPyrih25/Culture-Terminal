/**
 * Geohash arithmetic for the LiftMap: cell bounds and centres for the static schematic, the map's
 * fitted view and the neighbourhood label fallback. Pure and dependency-free, so the server render
 * and the browser bundle need no geo library.
 */

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";
const INDEX: ReadonlyMap<string, number> = new Map([...BASE32].map((c, i) => [c, i]));

/** [west, south, east, north] in degrees. */
export type Bounds = readonly [number, number, number, number];

/** The cell a geohash names, or null when the string is not a geohash. */
export function geohashBounds(geohash: string): Bounds | null {
  if (geohash.length === 0 || geohash.length > 12) return null;
  const lat: [number, number] = [-90, 90];
  const lon: [number, number] = [-180, 180];
  let even = true;
  for (const ch of geohash.toLowerCase()) {
    const bits = INDEX.get(ch);
    if (bits === undefined) return null;
    for (let b = 4; b >= 0; b -= 1) {
      const range = even ? lon : lat;
      const mid = (range[0] + range[1]) / 2;
      if ((bits >> b) & 1) range[0] = mid;
      else range[1] = mid;
      even = !even;
    }
  }
  return [lon[0], lat[0], lon[1], lat[1]];
}

/** The centre of a geohash cell as { lat, lon }, or null when the string is not a geohash. */
export function geohashCentre(geohash: string): { lat: number; lon: number } | null {
  const b = geohashBounds(geohash);
  return b === null ? null : { lat: (b[1] + b[3]) / 2, lon: (b[0] + b[2]) / 2 };
}

/** The geohash of a point at `precision` characters. */
export function encodeGeohash(lat: number, lon: number, precision: number): string {
  const latR: [number, number] = [-90, 90];
  const lonR: [number, number] = [-180, 180];
  let out = "";
  let bits = 0;
  let n = 0;
  let even = true;
  while (out.length < precision) {
    const range = even ? lonR : latR;
    const value = even ? lon : lat;
    const mid = (range[0] + range[1]) / 2;
    bits <<= 1;
    if (value >= mid) {
      bits |= 1;
      range[0] = mid;
    } else range[1] = mid;
    even = !even;
    n += 1;
    if (n === 5) {
      out += BASE32[bits];
      bits = 0;
      n = 0;
    }
  }
  return out;
}

/** The box around several cells, or null when none is a geohash. */
export function unionBounds(geohashes: Iterable<string>): Bounds | null {
  let w = Infinity;
  let s = Infinity;
  let e = -Infinity;
  let n = -Infinity;
  for (const g of geohashes) {
    const b = geohashBounds(g);
    if (b === null) continue;
    w = Math.min(w, b[0]);
    s = Math.min(s, b[1]);
    e = Math.max(e, b[2]);
    n = Math.max(n, b[3]);
  }
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/** Web Mercator y of a latitude, in radians of the projected plane (north is larger). */
export function mercatorY(lat: number): number {
  const phi = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
  return Math.log(Math.tan(Math.PI / 4 + phi / 2));
}
