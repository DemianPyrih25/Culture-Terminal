import { MetroId } from "@ct/contracts";
import { createGeo, GAZETTEER_CATALOG, loadGazetteer, type Gazetteer } from "@ct/geo";
import type { OutlineCollection, OutlineFeature } from "../../../components/figures/lift-outlines";

/**
 * The LiftMap outlines of a metro (/api/geo/[metro]): the gazetteer's display polygons as GeoJSON,
 * each with its id, name and centroid, plus the boundary attribution. Built from @ct/geo, so a new
 * gazetteer shows up here without code; a metro without one answers an empty collection. Only the
 * asked metro's gazetteer loads.
 */

export async function outlinesFor(
  metro: MetroId,
  gazetteers?: Readonly<Partial<Record<MetroId, Gazetteer>>>,
): Promise<OutlineCollection> {
  const gazetteer = gazetteers === undefined ? await loadGazetteer(metro) : gazetteers[metro];
  if (!gazetteer) return { type: "FeatureCollection", metro, source: null, features: [] };
  // Centroids as the gazetteer index computes them: the catalog's for a shipped gazetteer.
  const areas = gazetteers === undefined ? (GAZETTEER_CATALOG[metro]?.areas ?? []) : createGeo({ gazetteers }).neighbourhoods(metro);
  const centroids = new Map(areas.map((a) => [a.id, a.centroid]));
  const features: OutlineFeature[] = gazetteer.areas.map((a) => {
    const c = centroids.get(a.id) ?? a.centroid ?? { lat: 0, lon: 0 };
    return {
      type: "Feature",
      id: a.id,
      properties: { id: a.id, name: a.name, centroid: [c.lon, c.lat] },
      geometry: a.geometry as OutlineFeature["geometry"],
    };
  });
  return { type: "FeatureCollection", metro, source: gazetteer.source, features };
}

/** The route's answer: the collection, cached for a day (gazetteers change only with a deploy), or 404. */
export async function outlinesResponse(metro: string): Promise<Response> {
  const parsed = MetroId.safeParse(metro);
  if (!parsed.success) return Response.json({ error: "unknown metro" }, { status: 404 });
  return Response.json(await outlinesFor(parsed.data), {
    headers: { "cache-control": "public, max-age=86400, stale-while-revalidate=604800" },
  });
}
