import { resolveQlooEnv } from "@ct/qloo";
import type { PublicDataClientOptions, PublicDataEnvDeps, PublicTransport } from "./api";
import { createPublicHttpTransport, isHeaderSafe } from "./http-transport";
import { createMockPublicTransport } from "./mock";

/**
 * Client options from the environment:
 * - QLOO_MOCK: "1" answers SEC and Census from the invented mock transport too (env "mock", no network).
 * - SEC_USER_AGENT: sent verbatim as the User-Agent to SEC (product name and a contact email, as SEC's
 *   fair-access policy asks). Unset leaves SEC not configured: its calls fail with not_configured and
 *   the tool says so; the app still starts. A value with a line break or non-ASCII text is refused.
 * - CENSUS_API_KEY: the Census Data API key, only ever a query parameter on the wire (never in a cache
 *   key, call row, event or provenance). The API now redirects keyless requests to its missing-key
 *   page, so unset leaves Census not configured the same way.
 * - QLOO_TAG labels call rows; the environment (dev, prod, mock) is resolved as for the Qloo client.
 */
export function publicDataOptionsFromEnv(env: NodeJS.ProcessEnv, deps: PublicDataEnvDeps): PublicDataClientOptions {
  const publicEnv = resolveQlooEnv(env);
  const secUserAgent = env.SEC_USER_AGENT?.trim() || null;
  if (secUserAgent !== null && !isHeaderSafe(secUserAgent)) {
    throw new Error("SEC_USER_AGENT must be one line of printable ASCII, e.g. \"Culture Terminal ops@example.com\"");
  }
  const censusApiKey = env.CENSUS_API_KEY?.trim() || null;
  const transport: PublicTransport =
    publicEnv === "mock" ? createMockPublicTransport() : createPublicHttpTransport({ secUserAgent, censusApiKey, fetch: deps.fetch });
  return {
    env: publicEnv,
    transport,
    store: deps.store,
    tag: env.QLOO_TAG?.trim() || "dev",
    secUserAgent,
    logger: deps.logger,
  };
}
