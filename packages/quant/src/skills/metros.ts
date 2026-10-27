import { METRO_LABEL, MetroId, type LatLon, type MarketId } from "@ct/contracts";
import { z } from "zod";
import raw from "../../../../config/metros.json";

/**
 * Public city-centre coordinates of the 13 map cities (D28). Place mentions are searched around these
 * (S0), so a venue name is matched inside the metro the question is about rather than anywhere.
 */
export const METRO_CENTRES: Readonly<Record<MetroId, LatLon>> = {
  nashville: { lat: 36.1627, lon: -86.7816 },
  austin: { lat: 30.2672, lon: -97.7431 },
  nyc: { lat: 40.7128, lon: -74.006 },
  los_angeles: { lat: 34.0522, lon: -118.2437 },
  chicago: { lat: 41.8781, lon: -87.6298 },
  miami: { lat: 25.7617, lon: -80.1918 },
  san_francisco: { lat: 37.7749, lon: -122.4194 },
  seattle: { lat: 47.6062, lon: -122.3321 },
  boston: { lat: 42.3601, lon: -71.0589 },
  denver: { lat: 39.7392, lon: -104.9903 },
  atlanta: { lat: 33.749, lon: -84.388 },
  houston: { lat: 29.7604, lon: -95.3698 },
  dallas: { lat: 32.7767, lon: -96.797 },
};

/**
 * The smallest place search radius, in miles (Qloo's unit for filter.radius): a venue just over a
 * county line still resolves, and Nashville's and Austin's searches keep the radius, and so the
 * cache keys, they had before the radius was set per metro.
 */
export const PLACE_SEARCH_MIN_RADIUS_MILES = 25;

const Box = z.object({ min_lon: z.number(), min_lat: z.number(), max_lon: z.number(), max_lat: z.number() });
const Entry = z.object({ id: z.string(), label: z.string().min(1), center: z.object({ lat: z.number(), lon: z.number() }), bbox: Box });
const MetrosConfig = z.object({ gazetteer: z.array(Entry), markets: z.array(Entry) });

/** config/metros.json is ours, so a malformed file fails loudly at start-up. */
const CONFIG = MetrosConfig.parse(raw);
const MARKETS: ReadonlyMap<string, z.infer<typeof Entry>> = new Map(CONFIG.markets.map((m) => [m.id, m]));
const MAP_CITY_BOXES: ReadonlyMap<string, z.infer<typeof Box>> = new Map(CONFIG.gazetteer.map((m) => [m.id, m.bbox]));

const EARTH_RADIUS_KM = 6371.0088;
const KM_PER_MILE = 1.609344;

function distanceKm(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** The distance from a centre to the farthest corner of a box, in km. */
function reachKm(centre: LatLon, box: z.infer<typeof Box>): number {
  const corners: LatLon[] = [
    { lat: box.min_lat, lon: box.min_lon },
    { lat: box.min_lat, lon: box.max_lon },
    { lat: box.max_lat, lon: box.min_lon },
    { lat: box.max_lat, lon: box.max_lon },
  ];
  return Math.max(...corners.map((c) => distanceKm(centre, c)));
}

/** Where place mentions in a metro or market are searched (D44): a centre and a radius in whole miles. */
export interface PlaceSearchArea {
  centre: LatLon;
  radiusMiles: number;
}

/**
 * The place search area of a map city or market (D44), or null for an id config/metros.json does not
 * list. A map city searches around its METRO_CENTRES point, a market around its config centre; the
 * radius reaches the farthest corner of the bbox (a map city's is its gazetteer's bounds), so a venue
 * anywhere on the map resolves, and is never under PLACE_SEARCH_MIN_RADIUS_MILES.
 */
export function placeSearchArea(id: MarketId): PlaceSearchArea | null {
  const metro = MetroId.safeParse(id);
  const market = MARKETS.get(id);
  const centre = metro.success ? METRO_CENTRES[metro.data] : market?.center;
  const box = MAP_CITY_BOXES.get(id) ?? market?.bbox;
  if (centre === undefined || box === undefined) return null;
  const miles = Math.ceil(reachKm(centre, box) / KM_PER_MILE);
  return { centre, radiusMiles: Math.max(PLACE_SEARCH_MIN_RADIUS_MILES, miles) };
}

/**
 * How far from its centre a point can lie and still be in the map city, in km: the place search
 * radius, and never under `floorKm`. Los Angeles County reaches Santa Catalina Island, about 130 km out.
 */
export function metroReachKm(metro: MetroId, floorKm: number): number {
  const area = placeSearchArea(metro);
  return Math.max(floorKm, area === null ? 0 : area.radiusMiles * KM_PER_MILE);
}

/** A market's label without a locality: its config/metros.json label, else the id in words ("kansas_city" → "Kansas City"). */
export function marketLabel(id: MarketId): string {
  const metro = MetroId.safeParse(id);
  if (metro.success) return METRO_LABEL[metro.data];
  return MARKETS.get(id)?.label ?? id.replace(/_/g, " ").replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/** The "lat,lon" form /search takes in filter.location (latitude first, unlike WKT). */
export function latLonParam(c: LatLon): string {
  return `${c.lat},${c.lon}`;
}

/** The filter.location of a map city's place search. */
export function metroCentreLatLon(metro: MetroId): string {
  return latLonParam(METRO_CENTRES[metro]);
}
