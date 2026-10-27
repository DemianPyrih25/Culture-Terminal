// The city side of a map city (PLAN Part 8, §5.4 cost table, D25): the four requests every geo_lift and
// block_dna run makes on the city whatever the question, built by the skills' own request builders so
// the warmed cache keys are the keys a run asks for. Locality ids come from kv and go into the
// requests only: nothing here prints them.
import type { InsightsFilterType, MarketLocality, QlooParams, TagRef } from "@ct/contracts";
import { canonicalize, type CacheNamespace, type QlooEnv } from "@ct/qloo";
// @ct/quant does not export its request builders (change request: export them); the relative imports
// keep these requests the skills' own, so a change to a skill's request shape changes them too.
import { brandParams, tagParams } from "../../../packages/quant/src/skills/blockDna";
import { cityLocation } from "../../../packages/quant/src/skills/blockDna/location";
import { HEATMAP_BASELINE } from "../../../packages/quant/src/skills/findTags/curated";
import { tagTypeOf } from "@ct/quant";
import { geoLiftRequests } from "../../../packages/quant/src/skills/geoLift";

export type CitySideKind = "baseline" | "fingerprint" | "music" | "brands";

/** The four city-side requests in the order they are warmed. */
export const CITY_SIDE_KINDS: readonly CitySideKind[] = ["baseline", "fingerprint", "music", "brands"];

export const CITY_SIDE_LABEL: Readonly<Record<CitySideKind, string>> = {
  baseline: "restaurant baseline heatmap (geo_lift)",
  fingerprint: "city tag fingerprint (block_dna)",
  music: "city music tags (block_dna SOUND)",
  brands: "city brand list (block_dna local brands)",
};

export interface CitySideRequest {
  kind: CitySideKind;
  filterType: InsightsFilterType;
  /** The insights params without filter.type, as the skill passes them to QlooApi.insights. */
  params: QlooParams;
}

/** The params with filter.type, as the cache probe, pin() and the canonical key take them. */
export const withFilterType = (r: CitySideRequest): QlooParams => ({ "filter.type": r.filterType, ...r.params });

/**
 * geo_lift's restaurant baseline for a locality: the baseline request of geoLiftRequests, which does
 * not depend on the concept (any concept that shapes a map gives the same baseline).
 */
function baselineParams(localityId: string): QlooParams {
  const tag = { ref: "T1" as TagRef, tagId: HEATMAP_BASELINE.tagId, name: HEATMAP_BASELINE.label, type: tagTypeOf(HEATMAP_BASELINE.tagId), signalCapable: true };
  const requests = geoLiftRequests(localityId, { heatmapTags: [tag], placeFilters: [], analogs: [], label: HEATMAP_BASELINE.label, notices: [] }, false);
  if (requests === null) throw new Error("geo_lift built no request for the restaurant baseline");
  return requests.baseline;
}

/** The city side of one pinned locality: baseline heatmap, tag fingerprint, music tags and brand list. */
export function citySideRequests(locality: MarketLocality): CitySideRequest[] {
  const city = cityLocation(locality);
  return [
    { kind: "baseline", filterType: "urn:heatmap", params: baselineParams(locality.entityId) },
    { kind: "fingerprint", filterType: "urn:tag", params: tagParams(city, false) },
    { kind: "music", filterType: "urn:tag", params: tagParams(city, true) },
    { kind: "brands", filterType: "urn:entity:brand", params: brandParams(city) },
  ];
}

/** The cache namespace the client keys an environment's answers under (mock data never meets live). */
export const cacheNamespace = (env: QlooEnv): CacheNamespace => (env === "mock" ? "mock-v1" : "v1");

/** The L2 cache key of a city-side request, for reading whether its entry is pinned. */
export function citySideKey(r: CitySideRequest, env: QlooEnv): string {
  return canonicalize("/v2/insights", withFilterType(r), cacheNamespace(env)).key;
}

/** Rows in an insights answer: heatmap cells, tags or entities. */
export function rowsOf(data: unknown): number {
  const results = (data as { results?: Record<string, unknown> } | null)?.results;
  if (results === undefined || results === null) return 0;
  for (const key of ["heatmap", "tags", "entities"]) {
    const rows = results[key];
    if (Array.isArray(rows)) return rows.length;
  }
  return 0;
}
