import { PROBE_FACTS } from "./allowlist";
import { looksLikeWkt } from "./geometry";
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
  /**
   * When non-empty, only these locality ids count as pinned cities for the urn:tag fingerprints and the
   * Block DNA city brand list (tests). Empty or absent, every locality id does (a WKT area never does).
   */
  pinnedLocalities?: ReadonlySet<string>;
}

/** The parameters a city fingerprint may carry besides its locality (Block DNA tagParams: take, the SOUND tag type). */
const FINGERPRINT_KEYS: ReadonlySet<string> = new Set(["filter.type", "signal.location", "take", "filter.tag.types"]);
/** The parameters of the Block DNA city brand list (brandParams: the G9 popularity cap). */
const CITY_BRAND_KEYS: ReadonlySet<string> = new Set(["filter.type", "signal.location", "take", "filter.popularity.max"]);

/**
 * True when signal.location is a whole city: a Qloo locality id, not a WKT point or polygon (an area
 * or a site, kept 14 d), and one of `pinnedLocalities` when that set is given.
 */
function isCityLocation(location: string | undefined, options: TtlOptions): boolean {
  if (location === undefined || location === "" || looksLikeWkt(location)) return false;
  const only = options.pinnedLocalities;
  return only === undefined || only.size === 0 || only.has(location);
}

const keysWithin = (query: Readonly<Record<string, string>>, allowed: ReadonlySet<string>): boolean =>
  Object.keys(query).every((k) => allowed.has(k));

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
    // The city fingerprints of Block DNA (whole list and SOUND list): a locality and nothing that narrows it.
    return isCityLocation(q["signal.location"], options) && keysWithin(q, FINGERPRINT_KEYS);
  }
  if (request.filterType === "urn:entity:brand") {
    // The Block DNA city brand list (D25): a locality under the popularity cap and nothing else, so
    // tenant-fit rank calls with a city context (filter.results.entities) stay at 14 days.
    return isCityLocation(q["signal.location"], options) && q["filter.popularity.max"] !== undefined && keysWithin(q, CITY_BRAND_KEYS);
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
