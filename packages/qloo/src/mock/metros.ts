import type { City } from "./cities";
import { distanceKm, type LatLon, parseLatLon, wktCentroid } from "./geo";
import { metroCodeOfId } from "./ids";

/**
 * Synthetic metros, one per map city (D28), placed on public coordinates: city centres and well-known
 * neighbourhood centroids. Heatmap precision follows the probe (G6): Nashville at geohash-6, Austin at
 * geohash-7; New York and the ZIP-area cities follow Nashville.
 */

export interface Neighborhood {
  name: string;
  at: LatLon;
  /** Share of the metro's baseline popularity peak this neighbourhood carries. */
  weight: number;
}

export interface Metro extends City {
  key:
    | "nashville"
    | "austin"
    | "new_york"
    | "los_angeles"
    | "chicago"
    | "miami"
    | "san_francisco"
    | "seattle"
    | "boston"
    | "denver"
    | "atlanta"
    | "houston"
    | "dallas";
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
  {
    key: "los_angeles",
    code: "4",
    name: "Los Angeles",
    state: "California",
    stateCode: "CA",
    county: "Los Angeles County",
    center: { lat: 34.0522, lon: -118.2437 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "Downtown", at: { lat: 34.0407, lon: -118.2468 }, weight: 1 },
      { name: "Hollywood", at: { lat: 34.0983, lon: -118.3267 }, weight: 0.7 },
      { name: "Koreatown", at: { lat: 34.0618, lon: -118.3004 }, weight: 0.65 },
      { name: "Silver Lake", at: { lat: 34.0869, lon: -118.2702 }, weight: 0.6 },
      { name: "Echo Park", at: { lat: 34.0782, lon: -118.2606 }, weight: 0.5 },
      { name: "Venice", at: { lat: 33.9908, lon: -118.4601 }, weight: 0.55 },
      { name: "Santa Monica", at: { lat: 34.0195, lon: -118.4912 }, weight: 0.6 },
      { name: "Highland Park", at: { lat: 34.1119, lon: -118.199 }, weight: 0.4 },
    ],
  },
  {
    key: "chicago",
    code: "5",
    name: "Chicago",
    state: "Illinois",
    stateCode: "IL",
    county: "Cook County",
    center: { lat: 41.8781, lon: -87.6298 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "The Loop", at: { lat: 41.8837, lon: -87.6289 }, weight: 1 },
      { name: "West Loop", at: { lat: 41.8827, lon: -87.6475 }, weight: 0.8 },
      { name: "Wicker Park", at: { lat: 41.9088, lon: -87.6796 }, weight: 0.6 },
      { name: "Logan Square", at: { lat: 41.9234, lon: -87.7083 }, weight: 0.5 },
      { name: "Lincoln Park", at: { lat: 41.9214, lon: -87.6513 }, weight: 0.65 },
      { name: "Lakeview", at: { lat: 41.9434, lon: -87.6553 }, weight: 0.55 },
      { name: "Pilsen", at: { lat: 41.8575, lon: -87.6576 }, weight: 0.45 },
      { name: "Hyde Park", at: { lat: 41.7943, lon: -87.5907 }, weight: 0.4 },
    ],
  },
  {
    key: "miami",
    code: "6",
    name: "Miami",
    state: "Florida",
    stateCode: "FL",
    county: "Miami-Dade County",
    center: { lat: 25.7617, lon: -80.1918 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "Downtown", at: { lat: 25.7743, lon: -80.1937 }, weight: 1 },
      { name: "Brickell", at: { lat: 25.7601, lon: -80.1937 }, weight: 0.8 },
      { name: "Wynwood", at: { lat: 25.8005, lon: -80.1994 }, weight: 0.65 },
      { name: "Little Havana", at: { lat: 25.7656, lon: -80.219 }, weight: 0.5 },
      { name: "Coconut Grove", at: { lat: 25.7126, lon: -80.257 }, weight: 0.45 },
      { name: "Miami Beach", at: { lat: 25.7907, lon: -80.13 }, weight: 0.7 },
      { name: "Little Haiti", at: { lat: 25.8288, lon: -80.1995 }, weight: 0.35 },
      { name: "Coral Gables", at: { lat: 25.7215, lon: -80.2684 }, weight: 0.5 },
    ],
  },
  {
    key: "san_francisco",
    code: "7",
    name: "San Francisco",
    state: "California",
    stateCode: "CA",
    county: "San Francisco County",
    center: { lat: 37.7749, lon: -122.4194 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "Financial District", at: { lat: 37.7946, lon: -122.3999 }, weight: 1 },
      { name: "SoMa", at: { lat: 37.7785, lon: -122.4056 }, weight: 0.75 },
      { name: "Mission District", at: { lat: 37.7599, lon: -122.4148 }, weight: 0.7 },
      { name: "Hayes Valley", at: { lat: 37.7759, lon: -122.4245 }, weight: 0.6 },
      { name: "North Beach", at: { lat: 37.8061, lon: -122.4103 }, weight: 0.55 },
      { name: "Castro", at: { lat: 37.7609, lon: -122.435 }, weight: 0.5 },
      { name: "Haight-Ashbury", at: { lat: 37.7692, lon: -122.4481 }, weight: 0.45 },
      { name: "Marina", at: { lat: 37.8037, lon: -122.4368 }, weight: 0.4 },
    ],
  },
  {
    key: "seattle",
    code: "8",
    name: "Seattle",
    state: "Washington",
    stateCode: "WA",
    county: "King County",
    center: { lat: 47.6062, lon: -122.3321 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "Downtown", at: { lat: 47.605, lon: -122.3344 }, weight: 1 },
      { name: "Capitol Hill", at: { lat: 47.6253, lon: -122.3222 }, weight: 0.75 },
      { name: "Pioneer Square", at: { lat: 47.6015, lon: -122.3343 }, weight: 0.6 },
      { name: "Ballard", at: { lat: 47.6687, lon: -122.3846 }, weight: 0.55 },
      { name: "Fremont", at: { lat: 47.651, lon: -122.3505 }, weight: 0.5 },
      { name: "University District", at: { lat: 47.6615, lon: -122.3138 }, weight: 0.45 },
      { name: "Queen Anne", at: { lat: 47.6374, lon: -122.357 }, weight: 0.4 },
      { name: "Georgetown", at: { lat: 47.547, lon: -122.32 }, weight: 0.35 },
    ],
  },
  {
    key: "boston",
    code: "9",
    name: "Boston",
    state: "Massachusetts",
    stateCode: "MA",
    county: "Suffolk County",
    center: { lat: 42.3601, lon: -71.0589 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "Downtown", at: { lat: 42.3555, lon: -71.0605 }, weight: 1 },
      { name: "Back Bay", at: { lat: 42.3503, lon: -71.081 }, weight: 0.8 },
      { name: "North End", at: { lat: 42.3647, lon: -71.0542 }, weight: 0.65 },
      { name: "South End", at: { lat: 42.3388, lon: -71.0765 }, weight: 0.6 },
      { name: "Fenway", at: { lat: 42.3429, lon: -71.1003 }, weight: 0.55 },
      { name: "Seaport", at: { lat: 42.3519, lon: -71.0446 }, weight: 0.5 },
      { name: "Jamaica Plain", at: { lat: 42.3097, lon: -71.1151 }, weight: 0.45 },
      { name: "Allston", at: { lat: 42.3539, lon: -71.1337 }, weight: 0.4 },
    ],
  },
  {
    key: "denver",
    code: "a",
    name: "Denver",
    state: "Colorado",
    stateCode: "CO",
    county: "Denver County",
    center: { lat: 39.7392, lon: -104.9903 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "Downtown", at: { lat: 39.7439, lon: -104.9903 }, weight: 1 },
      { name: "LoDo", at: { lat: 39.7525, lon: -105.0005 }, weight: 0.8 },
      { name: "RiNo", at: { lat: 39.77, lon: -104.981 }, weight: 0.6 },
      { name: "Capitol Hill", at: { lat: 39.7313, lon: -104.9789 }, weight: 0.55 },
      { name: "Highlands", at: { lat: 39.7605, lon: -105.0107 }, weight: 0.55 },
      { name: "Cherry Creek", at: { lat: 39.7173, lon: -104.9535 }, weight: 0.5 },
      { name: "Baker", at: { lat: 39.7183, lon: -104.9934 }, weight: 0.45 },
      { name: "Five Points", at: { lat: 39.7547, lon: -104.9781 }, weight: 0.4 },
    ],
  },
  {
    key: "atlanta",
    code: "b",
    name: "Atlanta",
    state: "Georgia",
    stateCode: "GA",
    county: "Fulton County",
    center: { lat: 33.749, lon: -84.388 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "Downtown", at: { lat: 33.755, lon: -84.39 }, weight: 1 },
      { name: "Midtown", at: { lat: 33.7844, lon: -84.3834 }, weight: 0.8 },
      { name: "Old Fourth Ward", at: { lat: 33.7638, lon: -84.372 }, weight: 0.6 },
      { name: "Buckhead", at: { lat: 33.8381, lon: -84.38 }, weight: 0.6 },
      { name: "Inman Park", at: { lat: 33.7615, lon: -84.353 }, weight: 0.5 },
      { name: "Virginia-Highland", at: { lat: 33.7817, lon: -84.3534 }, weight: 0.45 },
      { name: "Decatur", at: { lat: 33.7748, lon: -84.2963 }, weight: 0.4 },
      { name: "West End", at: { lat: 33.7368, lon: -84.4135 }, weight: 0.35 },
    ],
  },
  {
    key: "houston",
    code: "c",
    name: "Houston",
    state: "Texas",
    stateCode: "TX",
    county: "Harris County",
    center: { lat: 29.7604, lon: -95.3698 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "Downtown", at: { lat: 29.7589, lon: -95.3677 }, weight: 1 },
      { name: "Montrose", at: { lat: 29.7442, lon: -95.3906 }, weight: 0.7 },
      { name: "Midtown", at: { lat: 29.7404, lon: -95.3772 }, weight: 0.65 },
      { name: "The Heights", at: { lat: 29.798, lon: -95.398 }, weight: 0.6 },
      { name: "Rice Village", at: { lat: 29.7164, lon: -95.4141 }, weight: 0.5 },
      { name: "EaDo", at: { lat: 29.7516, lon: -95.3487 }, weight: 0.45 },
      { name: "River Oaks", at: { lat: 29.7517, lon: -95.4152 }, weight: 0.4 },
      { name: "Third Ward", at: { lat: 29.731, lon: -95.3602 }, weight: 0.35 },
    ],
  },
  {
    key: "dallas",
    code: "d",
    name: "Dallas",
    state: "Texas",
    stateCode: "TX",
    county: "Dallas County",
    center: { lat: 32.7767, lon: -96.797 },
    precision: 6,
    radiusKm: 13,
    density: { peak: 1.1, scaleKm: 8, floor: 0 },
    pocketKm: 1.6,
    neighborhoods: [
      { name: "Downtown", at: { lat: 32.781, lon: -96.7981 }, weight: 1 },
      { name: "Uptown", at: { lat: 32.8007, lon: -96.8007 }, weight: 0.8 },
      { name: "Deep Ellum", at: { lat: 32.7843, lon: -96.7837 }, weight: 0.65 },
      { name: "Oak Lawn", at: { lat: 32.8115, lon: -96.8135 }, weight: 0.55 },
      { name: "Bishop Arts", at: { lat: 32.749, lon: -96.828 }, weight: 0.5 },
      { name: "Lower Greenville", at: { lat: 32.8137, lon: -96.7703 }, weight: 0.45 },
      { name: "Design District", at: { lat: 32.7983, lon: -96.8231 }, weight: 0.4 },
      { name: "Lakewood", at: { lat: 32.8128, lon: -96.7485 }, weight: 0.35 },
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
