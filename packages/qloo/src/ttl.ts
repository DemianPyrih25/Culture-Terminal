import { PROBE_FACTS } from "./allowlist";
import type { CanonicalRequest } from "./transport-types";

/**
 * Cache TTL classes (D25). Catalogue lookups change slowly (30 d); insights, rank and heatmaps are
 * kept 14 d; the heatmap baseline, city fingerprints and frozen-window trending are pinned and never
 * expire. A 4xx answer is kept one day so a bad request fails without the network; 429, 5xx and
 * rate-limit bodies are never stored.
 */

export const DAY_MS = 86_400_000;
export const CATALOGUE_TTL_MS = 30 * DAY_MS;
export const INSIGHTS_TTL_MS = 14 * DAY_MS;
export const ERROR_TTL_MS = DAY_MS;

/** An expired entry may still answer a failed network call while younger than this many TTLs. */
export const STALE_TTL_MULTIPLE = 4;

export interface TtlOptions {
  /** Metro locality ids whose city fingerprints are pinned: urn:tag lists and the Block DNA city brand list. */
  pinnedLocalities?: ReadonlySet<string>;
}

/** Whether a successful answer to this request is pinned (D25). */
export function isPinnedRequest(request: CanonicalRequest, options: TtlOptions = {}): boolean {
  const q = request.query;
  if (request.path === "/v2/trending") {
    return q["filter.start_date"] === PROBE_FACTS.trendingWindow.start && q["filter.end_date"] === PROBE_FACTS.trendingWindow.end;
  }
  if (request.path !== "/v2/insights") return false;
  if (request.filterType === "urn:heatmap") {
    return q["signal.interests.tags"] === PROBE_FACTS.heatmapBaselineTag && q["signal.interests.entities"] === undefined;
  }
  if (request.filterType === "urn:tag") {
    const location = q["signal.location"];
    return location !== undefined && options.pinnedLocalities?.has(location) === true;
  }
  if (request.filterType === "urn:entity:brand") {
    // The Block DNA city brand list (D25): a pinned locality under the popularity cap and nothing else,
    // so tenant-fit rank calls with a city context (filter.results.entities) stay at 14 days.
    const location = q["signal.location"];
    const rest = Object.keys(q).filter((k) => k !== "filter.type" && k !== "take" && k !== "signal.location");
    return location !== undefined && options.pinnedLocalities?.has(location) === true && rest.length === 1 && rest[0] === "filter.popularity.max";
  }
  return false;
}

/** TTL in ms for a successful answer, or null when it is pinned. */
export function successTtlMs(request: CanonicalRequest, options: TtlOptions = {}): number | null {
  if (isPinnedRequest(request, options)) return null;
  switch (request.path) {
    case "/search":
    case "/entities":
    case "/v2/tags":
    case "/v2/audiences":
      return CATALOGUE_TTL_MS;
    case "/v2/insights":
    case "/v2/trending":
      return INSIGHTS_TTL_MS;
  }
}
