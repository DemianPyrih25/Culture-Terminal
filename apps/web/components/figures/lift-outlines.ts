import type { MetroId } from "@ct/contracts";

/**
 * The neighbourhood outlines a LiftMap draws: the gazetteer polygons (@ct/geo) of one metro, served
 * as GeoJSON by /api/geo/[metro]. The GeoLift dataset names neighbourhoods by gazetteer id only, so
 * the outlines travel once per metro, cached, instead of inside every dataset.
 */

export type OutlineGeometry =
  | { type: "Polygon"; coordinates: number[][][] }
  | { type: "MultiPolygon"; coordinates: number[][][][] };

export interface OutlineFeature {
  type: "Feature";
  id: string;
  properties: {
    id: string;
    name: string;
    /** [lon, lat]: where the neighbourhood's marker and label go. */
    centroid: [number, number];
  };
  geometry: OutlineGeometry;
}

export interface OutlineCollection {
  type: "FeatureCollection";
  metro: MetroId;
  /** Boundary attribution (publisher and licence), or null for a metro without a gazetteer. */
  source: string | null;
  features: OutlineFeature[];
}

/** The outlines route of a metro. */
export function outlinesUrl(metro: MetroId): string {
  return `/api/geo/${metro}`;
}

/** A metro's outlines, or a failed request (an error status or no network), told apart from an empty list. */
export type OutlinesResult = { ok: true; features: OutlineFeature[] } | { ok: false };

const outlinesCache = new Map<string, Promise<OutlinesResult>>();

/** The outlines of a metro, cached per url. A failure is not cached, so a retry asks again. */
export function fetchOutlines(url: string): Promise<OutlinesResult> {
  const known = outlinesCache.get(url);
  if (known) return known;
  const load = fetch(url)
    .then((res) => {
      if (!res.ok) throw new Error(`outlines: HTTP ${res.status}`);
      return res.json() as Promise<OutlineCollection>;
    })
    .then((json): OutlinesResult => ({ ok: true, features: Array.isArray(json?.features) ? json.features : [] }))
    .catch((): OutlinesResult => {
      outlinesCache.delete(url);
      return { ok: false };
    });
  outlinesCache.set(url, load);
  return load;
}

/** The outlines of a metro; a failed request reads as none (the lift map then draws without them). */
export function loadOutlines(url: string): Promise<OutlineFeature[]> {
  return fetchOutlines(url).then((r) => (r.ok ? r.features : []));
}


/** The outline of one area of a metro, matched by gazetteer id or by name (case and accents ignored). */
export function findOutline(features: readonly OutlineFeature[], area: { id?: string | null; name?: string | null }): OutlineFeature | null {
  const fold = (t: string) => t.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
  if (area.id) {
    const byId = features.find((f) => f.properties.id === area.id);
    if (byId) return byId;
  }
  if (area.name) {
    const name = fold(area.name);
    // Exact first; then a gazetteer label that carries the name, e.g. "ZIP 37206 (East Nashville)".
    return (
      features.find((f) => fold(f.properties.name) === name) ??
      features.find((f) => fold(f.properties.name).includes(`(${name})`)) ??
      features.find((f) => fold(f.properties.name).includes(name)) ??
      null
    );
  }
  return null;
}
