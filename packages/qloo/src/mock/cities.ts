import { distanceKm, type LatLon } from "./geo";
import { normalizeName } from "./names";

/**
 * Public US market cities outside the mock metros: the config/metros.json markets, with state and
 * public centre coordinates (D29 allows both). Locality search resolves each market offline under
 * the config rule (an exact name whose disambiguation names the state), and located places and
 * destinations near or named after one carry its city and state instead of a mock metro's.
 */

export interface City {
  name: string;
  state: string;
  stateCode: string;
  center: LatLon;
}

const city = (name: string, state: string, stateCode: string, lat: number, lon: number): City => ({ name, state, stateCode, center: { lat, lon } });

export const CITIES: readonly City[] = [
  city("Los Angeles", "California", "CA", 34.05, -118.24),
  city("Chicago", "Illinois", "IL", 41.88, -87.63),
  city("Houston", "Texas", "TX", 29.76, -95.37),
  city("Dallas", "Texas", "TX", 32.78, -96.8),
  city("Atlanta", "Georgia", "GA", 33.75, -84.39),
  city("Denver", "Colorado", "CO", 39.74, -104.99),
  city("Seattle", "Washington", "WA", 47.61, -122.33),
  city("Portland", "Oregon", "OR", 45.52, -122.68),
  city("Phoenix", "Arizona", "AZ", 33.45, -112.07),
  city("Miami", "Florida", "FL", 25.76, -80.19),
  city("Philadelphia", "Pennsylvania", "PA", 39.95, -75.17),
  city("Boston", "Massachusetts", "MA", 42.36, -71.06),
  city("San Francisco", "California", "CA", 37.77, -122.42),
  city("Louisville", "Kentucky", "KY", 38.25, -85.76),
  city("Kansas City", "Missouri", "MO", 39.1, -94.58),
  city("Indianapolis", "Indiana", "IN", 39.77, -86.16),
  city("Columbus", "Ohio", "OH", 39.96, -83.0),
  city("Cincinnati", "Ohio", "OH", 39.1, -84.51),
  city("Charlotte", "North Carolina", "NC", 35.23, -80.84),
  city("Raleigh", "North Carolina", "NC", 35.78, -78.64),
  city("Richmond", "Virginia", "VA", 37.54, -77.44),
  city("Birmingham", "Alabama", "AL", 33.52, -86.8),
  city("Knoxville", "Tennessee", "TN", 35.96, -83.92),
  city("Chattanooga", "Tennessee", "TN", 35.05, -85.31),
  city("Memphis", "Tennessee", "TN", 35.15, -90.05),
  city("Oklahoma City", "Oklahoma", "OK", 35.47, -97.52),
  city("Tulsa", "Oklahoma", "OK", 36.15, -95.99),
  city("Omaha", "Nebraska", "NE", 41.26, -95.93),
  city("Des Moines", "Iowa", "IA", 41.59, -93.62),
  city("Grand Rapids", "Michigan", "MI", 42.96, -85.67),
  city("Greenville", "South Carolina", "SC", 34.85, -82.4),
  city("Little Rock", "Arkansas", "AR", 34.75, -92.29),
  city("Salt Lake City", "Utah", "UT", 40.76, -111.89),
  city("Boise", "Idaho", "ID", 43.62, -116.2),
  city("Spokane", "Washington", "WA", 47.66, -117.43),
];

const CITY_BY_NAME: ReadonlyMap<string, City> = new Map(CITIES.map((c) => [normalizeName(c.name), c]));

/** Places within this distance of a city centre belong to it. */
const CITY_REACH_KM = 40;

/** The market city a name is, compared in normal form ("kansas city" → Kansas City), or null. */
export function cityNamed(name: string): City | null {
  return CITY_BY_NAME.get(normalizeName(name)) ?? null;
}

/** The market city whose centre is nearest the point and within reach, or null. */
export function cityNear(point: LatLon): City | null {
  let best: City | null = null;
  let bestKm = CITY_REACH_KM;
  for (const c of CITIES) {
    const km = distanceKm(point, c.center);
    if (km < bestKm) {
      best = c;
      bestKm = km;
    }
  }
  return best;
}
