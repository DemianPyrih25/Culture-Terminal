import { distanceKm, type LatLon } from "./geo";
import { normalizeName } from "./names";

/**
 * Public US market cities outside the mock metros: the config/metros.json markets that are no map
 * city, with state and public centre coordinates (D29 allows both). Locality search resolves each market offline under
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
  city("Portland", "Oregon", "OR", 45.52, -122.68),
  city("Phoenix", "Arizona", "AZ", 33.45, -112.07),
  city("Philadelphia", "Pennsylvania", "PA", 39.95, -75.17),
  city("Washington", "District of Columbia", "DC", 38.91, -77.04),
  city("Detroit", "Michigan", "MI", 42.33, -83.05),
  city("Minneapolis", "Minnesota", "MN", 44.98, -93.27),
  city("San Diego", "California", "CA", 32.72, -117.16),
  city("Tampa", "Florida", "FL", 27.95, -82.46),
  city("Baltimore", "Maryland", "MD", 39.29, -76.61),
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
  city("San Antonio", "Texas", "TX", 29.42, -98.49),
  city("Las Vegas", "Nevada", "NV", 36.17, -115.14),
  city("New Orleans", "Louisiana", "LA", 29.95, -90.07),
  // Spelled as config/metros.json queries it (the locality search knows the full spelling).
  city("Saint Louis", "Missouri", "MO", 38.63, -90.2),
  city("Pittsburgh", "Pennsylvania", "PA", 40.44, -80.0),
  city("Orlando", "Florida", "FL", 28.54, -81.38),
  city("Sacramento", "California", "CA", 38.58, -121.49),
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
