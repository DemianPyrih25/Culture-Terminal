import type { City } from "./cities";
import { distanceKm, type LatLon, parseLatLon, wktCentroid } from "./geo";
import { metroCodeOfId } from "./ids";

/**
 * Synthetic metros, placed on public coordinates: city centres and well-known neighbourhood
 * centroids. Heatmap precision follows the probe (G6): Nashville at geohash-6, Austin at geohash-7.
 */

export interface Neighborhood {
  name: string;
  at: LatLon;
  /** Share of the metro's baseline popularity peak this neighbourhood carries. */
  weight: number;
}

export interface Metro extends City {
  key: "nashville" | "austin" | "new_york";
  /** Hex digit embedded in place and locality ids so later requests can recover the metro. */
  code: string;
  county: string;
  precision: number;
  /** Heatmap cells reach this far from the centre. */
  radiusKm: number;
  /** Cell inclusion probability: peak · exp(−(d/scaleKm)²) + floor, capped at 1. */
  density: { peak: number; scaleKm: number; floor: number };
  /** Radius of a planted concept pocket; wider where cells are coarser. */
  pocketKm: number;
  neighborhoods: readonly Neighborhood[];
}

export const METROS: readonly Metro[] = [
  {
    key: "nashville",
    code: "1",
    name: "Nashville",
    state: "Tennessee",
    stateCode: "TN",
    county: "Davidson County",
    center: { lat: 36.1627, lon: -86.7816 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "Downtown", at: { lat: 36.1612, lon: -86.7775 }, weight: 1 },
      { name: "East Nashville", at: { lat: 36.1866, lon: -86.747 }, weight: 0.55 },
      { name: "The Gulch", at: { lat: 36.152, lon: -86.789 }, weight: 0.8 },
      { name: "12 South", at: { lat: 36.1246, lon: -86.7898 }, weight: 0.5 },
      { name: "Germantown", at: { lat: 36.1795, lon: -86.79 }, weight: 0.6 },
      { name: "Midtown", at: { lat: 36.151, lon: -86.8 }, weight: 0.7 },
      { name: "Sylvan Park", at: { lat: 36.145, lon: -86.841 }, weight: 0.35 },
      { name: "Wedgewood-Houston", at: { lat: 36.138, lon: -86.77 }, weight: 0.4 },
    ],
  },
  {
    key: "austin",
    code: "2",
    name: "Austin",
    state: "Texas",
    stateCode: "TX",
    county: "Travis County",
    center: { lat: 30.2672, lon: -97.7431 },
    precision: 7,
    radiusKm: 8,
    density: { peak: 0.12, scaleKm: 5, floor: 0.02 },
    pocketKm: 0.9,
    neighborhoods: [
      { name: "Downtown", at: { lat: 30.268, lon: -97.743 }, weight: 1 },
      { name: "East Austin", at: { lat: 30.262, lon: -97.722 }, weight: 0.55 },
      { name: "South Congress", at: { lat: 30.248, lon: -97.75 }, weight: 0.75 },
      { name: "Hyde Park", at: { lat: 30.305, lon: -97.728 }, weight: 0.4 },
      { name: "Mueller", at: { lat: 30.298, lon: -97.705 }, weight: 0.35 },
      { name: "Zilker", at: { lat: 30.264, lon: -97.77 }, weight: 0.5 },
      { name: "North Loop", at: { lat: 30.318, lon: -97.722 }, weight: 0.3 },
      { name: "Rainey Street", at: { lat: 30.259, lon: -97.738 }, weight: 0.7 },
    ],
  },
  {
    key: "new_york",
    code: "3",
    name: "New York",
    state: "New York",
    stateCode: "NY",
    county: "New York County",
    center: { lat: 40.7306, lon: -73.9866 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "Midtown", at: { lat: 40.7549, lon: -73.984 }, weight: 1 },
      { name: "Lower East Side", at: { lat: 40.715, lon: -73.9843 }, weight: 0.7 },
      { name: "Williamsburg", at: { lat: 40.7081, lon: -73.9571 }, weight: 0.65 },
      { name: "Astoria", at: { lat: 40.7644, lon: -73.9235 }, weight: 0.45 },
      { name: "Harlem", at: { lat: 40.8116, lon: -73.9465 }, weight: 0.45 },
      { name: "Park Slope", at: { lat: 40.671, lon: -73.9814 }, weight: 0.5 },
      { name: "Chelsea", at: { lat: 40.7465, lon: -74.0014 }, weight: 0.8 },
      { name: "Bushwick", at: { lat: 40.6944, lon: -73.9213 }, weight: 0.4 },
    ],
  },
];

const AUSTIN = METROS[1] as Metro;

/** Fallback metro for location values the mock cannot place (the task's default). */
export const DEFAULT_METRO: Metro = AUSTIN;

export function metroByCode(code: string | null): Metro | null {
  return METROS.find((m) => m.code === code) ?? null;
}

/** The metro a name mentions ("East Nashville, TN" → Nashville), or null. */
export function metroInName(name: string): Metro | null {
  const lower = name.toLowerCase();
  return METROS.find((m) => lower.includes(m.name.toLowerCase())) ?? null;
}

/** The metro neighbourhood whose centroid is nearest the point. */
export function nearestNeighborhood(metro: Metro, point: LatLon): Neighborhood {
  const [first, ...rest] = metro.neighborhoods;
  if (!first) throw new Error(`metro ${metro.key} has no neighbourhoods`);
  return rest.reduce((best, n) => (distanceKm(point, n.at) < distanceKm(point, best.at) ? n : best), first);
}

/** The metro whose centre is within 60 km of the point, or null. */
export function metroNear(point: LatLon): Metro | null {
  let best: Metro | null = null;
  let bestKm = 60;
  for (const m of METROS) {
    const km = distanceKm(point, m.center);
    if (km < bestKm) {
      best = m;
      bestKm = km;
    }
  }
  return best;
}

/**
 * The metro a location value points at: a mock locality or place id (metro digit), a name, WKT or
 * a `lat,lon` pair. Null when nothing matches.
 */
export function metroOfLocation(value: string): Metro | null {
  const byId = metroByCode(metroCodeOfId(value));
  if (byId) return byId;
  const point = wktCentroid(value) ?? parseLatLon(value);
  if (point) return metroNear(point);
  return metroInName(value);
}
