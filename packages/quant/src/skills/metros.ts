import type { LatLon, MetroId } from "@ct/contracts";

/**
 * Public city-centre coordinates of the gazetteer metros. Place mentions are searched around these
 * (S0), so a venue name is matched inside the metro the question is about rather than anywhere.
 */
export const METRO_CENTRES: Readonly<Record<MetroId, LatLon>> = {
  nashville: { lat: 36.1627, lon: -86.7816 },
  austin: { lat: 30.2672, lon: -97.7431 },
};

/** Search radius around a metro centre for place resolution, in miles (Qloo's unit for filter.radius). */
export const PLACE_SEARCH_RADIUS_MILES = 25;

/** The "lat,lon" form /search takes in filter.location (latitude first, unlike WKT). */
export function metroCentreLatLon(metro: MetroId): string {
  const c = METRO_CENTRES[metro];
  return `${c.lat},${c.lon}`;
}
