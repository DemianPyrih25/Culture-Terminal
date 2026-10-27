import type { GeoApi, LatLon, MetroId, Neighbourhood } from "@ct/contracts";
import { METRO_CENTRES } from "@ct/quant";

/**
 * The most areas a model is shown for one metro (AREAS in the run context, the GHOST's area names). A
 * large county holds hundreds of ZIP areas (Los Angeles 296, Cook 176, Harris 143), and the full list
 * would run to thousands of tokens; every map city of 60 areas or fewer is listed whole.
 */
export const AREAS_MAX = 60;

/** Squared distance in degrees, longitude scaled by latitude: enough to order nearby areas. */
function squaredDistance(a: LatLon, b: LatLon): number {
  const dLon = (a.lon - b.lon) * Math.cos((b.lat * Math.PI) / 180);
  return (a.lat - b.lat) ** 2 + dLon ** 2;
}

/**
 * A metro's areas as a model sees them: all of them, or for a metro with more than AREAS_MAX, the area
 * the question names first, then the areas nearest it (nearest the city centre when it names none),
 * up to AREAS_MAX. Every area id of the metro stays valid in a tool call.
 */
export function listedAreas(geo: Pick<GeoApi, "neighbourhoods">, metro: MetroId, named: Neighbourhood | null = null): readonly Neighbourhood[] {
  const all = geo.neighbourhoods(metro);
  if (all.length <= AREAS_MAX) return all;
  const anchor = named?.centroid ?? METRO_CENTRES[metro];
  const rank = (n: Neighbourhood): number => (n.id === named?.id ? -1 : squaredDistance(n.centroid, anchor));
  return [...all].sort((a, b) => rank(a) - rank(b)).slice(0, AREAS_MAX);
}
