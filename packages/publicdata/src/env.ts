import { resolveQlooEnv } from "@ct/qloo";
import type { PublicDataClientOptions, PublicDataEnvDeps, PublicTransport } from "./api";
import { createPublicHttpTransport, isHeaderSafe } from "./http-transport";
import { createMockPublicTransport } from "./mock";
import { DEFAULT_OSM_DAILY_MAX, DEFAULT_OSM_OVERPASS_URL, overpassFallbackTarget, overpassTarget } from "./osm/client";

/**
 * Client options from the environment:
 * - QLOO_MOCK: "1" answers SEC, Census and OpenStreetMap from the invented mock transport too (env
 *   "mock", no network).
 * - SEC_USER_AGENT: sent verbatim as the User-Agent to SEC (product name and a contact email, as SEC's
 *   fair-access policy asks). Unset leaves SEC not configured: its calls fail with not_configured and
 *   the tool says so; the app still starts. A value with a line break or non-ASCII text is refused.
 * - CENSUS_API_KEY: the Census Data API key, only ever a query parameter on the wire (never in a cache
 *   key, call row, event or provenance). The API now redirects keyless requests to its missing-key
 *   page, so unset leaves Census not configured the same way.
 * - OSM_USER_AGENT: sent verbatim as the User-Agent to Overpass (product name and a contact, as the
 *   Overpass usage policy asks), validated like SEC_USER_AGENT. Unset leaves OpenStreetMap not
 *   configured: local_supply is not planned and the run says so (OSM_NOT_CONFIGURED).
 * - OSM_OVERPASS_URL: the Overpass endpoint (default https://overpass-api.de/api/interpreter); an
 *   http(s) URL with no credentials or query.
 * - OSM_OVERPASS_FALLBACK_URL: a second Overpass endpoint, checked the same way (unset by default: no
 *   fallback). When the primary fails or is too slow, one request goes there inside the same deadline.
 * - OSM_DAILY_MAX: Overpass network requests per UTC day for the whole deploy (default 2000).
 * - QLOO_TAG labels call rows; the environment (dev, prod, mock) is resolved as for the Qloo client.
 */
export function publicDataOptionsFromEnv(env: NodeJS.ProcessEnv, deps: PublicDataEnvDeps): PublicDataClientOptions {
  const publicEnv = resolveQlooEnv(env);
  const secUserAgent = env.SEC_USER_AGENT?.trim() || null;
  if (secUserAgent !== null && !isHeaderSafe(secUserAgent)) {
    throw new Error("SEC_USER_AGENT must be one line of printable ASCII, e.g. \"Culture Terminal ops@example.com\"");
  }
  const osmUserAgent = env.OSM_USER_AGENT?.trim() || null;
  if (osmUserAgent !== null && !isHeaderSafe(osmUserAgent)) {
    throw new Error("OSM_USER_AGENT must be one line of printable ASCII, e.g. \"Culture Terminal (ops@example.com)\"");
  }
  const osmOverpass = overpassTarget(env.OSM_OVERPASS_URL?.trim() || DEFAULT_OSM_OVERPASS_URL);
  const osmOverpassUrl = osmOverpass.url;
  const osmOverpassFallbackUrl = overpassFallbackTarget(env.OSM_OVERPASS_FALLBACK_URL, osmOverpass)?.url ?? null;
  const osmDailyMax = osmDailyMaxFromEnv(env);
  const censusApiKey = env.CENSUS_API_KEY?.trim() || null;
  const transport: PublicTransport =
    publicEnv === "mock"
      ? createMockPublicTransport()
      : createPublicHttpTransport({ secUserAgent, censusApiKey, osmUserAgent, osmOverpassUrl, osmOverpassFallbackUrl, fetch: deps.fetch });
  return {
    env: publicEnv,
    transport,
    store: deps.store,
    tag: env.QLOO_TAG?.trim() || "dev",
    secUserAgent,
    osmUserAgent,
    osmOverpassUrl,
    osmOverpassFallbackUrl,
    osmDailyMax,
    logger: deps.logger,
  };
}

/** OSM_DAILY_MAX as a whole number ≥ 0 (default 2000); anything else is refused at start. /status reads it too. */
export function osmDailyMaxFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.OSM_DAILY_MAX?.trim();
  if (raw === undefined || raw === "") return DEFAULT_OSM_DAILY_MAX;
  if (!/^\d{1,7}$/.test(raw)) throw new Error(`OSM_DAILY_MAX must be a whole number of requests per day, got "${raw.slice(0, 20)}"`);
  return Number(raw);
}
