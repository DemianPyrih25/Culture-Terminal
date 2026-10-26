import { MetroId, type GeoApi } from "@ct/contracts";
import { GAZETTEERS, createGeo, type Gazetteer } from "@ct/geo";
import type { OutlineCollection, OutlineFeature } from "../../../components/figures/lift-outlines";

/**
 * The LiftMap outlines of a metro (/api/geo/[metro]): the gazetteer's display polygons as GeoJSON,
 * each with its id, name and centroid, plus the boundary attribution. Built from @ct/geo, so a new
 * gazetteer shows up here without code; a metro without one answers an empty collection.
 */

let geo: GeoApi | null = null;

export function outlinesFor(
  metro: MetroId,
  gazetteers: Readonly<Partial<Record<MetroId, Gazetteer>>> = GAZETTEERS,
): OutlineCollection {
  const gazetteer = gazetteers[metro];
  if (!gazetteer) return { type: "FeatureCollection", metro, source: null, features: [] };
  // Centroids come from the gazetteer index, which computes any the data module leaves out.
  const index = gazetteers === GAZETTEERS ? (geo ??= createGeo()) : createGeo({ gazetteers });
  const features: OutlineFeature[] = gazetteer.areas.map((a) => {
    const c = index.neighbourhood(metro, a.id)?.centroid ?? a.centroid ?? { lat: 0, lon: 0 };
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
export function outlinesResponse(metro: string): Response {
  const parsed = MetroId.safeParse(metro);
  if (!parsed.success) return Response.json({ error: "unknown metro" }, { status: 404 });
  return Response.json(outlinesFor(parsed.data), {
    headers: { "cache-control": "public, max-age=86400, stale-while-revalidate=604800" },
  });
}
