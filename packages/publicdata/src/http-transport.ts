import { PUBLIC_ENDPOINTS } from "@ct/contracts";
import { PublicDataError, type PublicRequest, type PublicTransport } from "./api";
import { publicQueryString } from "./canonical";
import { OSM_TIMEOUT_MS, overpassFallbackTarget, overpassTarget } from "./osm/client";

/**
 * The live transport: one HTTPS GET per attempt to the three SEC and Census hosts only, a 20 s timeout
 * and a body cap enforced while it streams. Redirects are never followed (the Census API answers a
 * missing or invalid key with one). SEC gets SEC_USER_AGENT verbatim as its User-Agent, as SEC's
 * fair-access policy requires; Census gets CENSUS_API_KEY as the `key` query parameter, added here on
 * the wire only, so it is in no cache key, call row, event or provenance. OpenStreetMap is the one POST,
 * and only to the configured OSM_OVERPASS_URL or OSM_OVERPASS_FALLBACK_URL: the form body `data=<QL>` (a
 * read-only query), with OSM_USER_AGENT as the User-Agent the Overpass usage policy asks for (both
 * instances), and a 45 s timeout (the query itself is limited to 25 s; the client's per-call deadline
 * aborts sooner through the signal). Errors never carry the URL.
 */

export const PUBLIC_TIMEOUT_MS = 20_000;
/** A company-facts file runs to several MB before the client keeps only its SecConcepts. */
export const PUBLIC_MAX_RESPONSE_BYTES = 40 * 1024 * 1024;

/** SEC and Census hosts; the Overpass host is whatever OSM_OVERPASS_URL names. */
const HOSTS: ReadonlySet<string> = new Set(
  Object.values(PUBLIC_ENDPOINTS)
    .filter((e) => e.source !== "osm")
    .map((e) => e.host),
);

export interface PublicHttpTransportOptions {
  /** Sent verbatim as the User-Agent to SEC; null makes every SEC request fail with not_configured. */
  secUserAgent: string | null;
  /** The Census Data API key; null makes every Census request fail with not_configured. */
  censusApiKey: string | null;
  /** Sent verbatim as the User-Agent to Overpass; null or absent makes every OpenStreetMap request fail with not_configured. */
  osmUserAgent?: string | null;
  /** The Overpass endpoint (default https://overpass-api.de/api/interpreter); OpenStreetMap requests go nowhere else but the fallback. */
  osmOverpassUrl?: string;
  /** OSM_OVERPASS_FALLBACK_URL: the one other Overpass endpoint requests may go to; null or absent allows none. */
  osmOverpassFallbackUrl?: string | null;
  timeoutMs?: number;
  /** Timeout of one Overpass request (default 45 s: a busy instance queues it first). */
  osmTimeoutMs?: number;
  maxBytes?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

/** The live transport, marked with whether it can reach Census (it holds a key). */
export type PublicHttpTransport = PublicTransport & { readonly censusKeyed: boolean };

/** Printable ASCII only: a header value never carries a line break. */
export const isHeaderSafe = (value: string): boolean => /^[\x20-\x7e]+$/.test(value);

/** The URL of a request as sent, with the Census `in` clause split into its documented parameters. No key. */
export function publicUrl(request: PublicRequest): string {
  const parts: string[] = [];
  const { in: inClause, ...rest } = request.query;
  const qs = publicQueryString(rest);
  if (qs !== "") parts.push(qs);
  if (inClause !== undefined) {
    for (const piece of inClause.split(" ").filter((p) => p !== "")) parts.push(`in=${encodeURIComponent(piece).replace(/%3A/gi, ":")}`);
  }
  return `https://${request.host}${request.path}${parts.length > 0 ? `?${parts.join("&")}` : ""}`;
}

export function createPublicHttpTransport(options: PublicHttpTransportOptions): PublicHttpTransport {
  const userAgent = options.secUserAgent?.trim() || null;
  if (userAgent !== null && !isHeaderSafe(userAgent)) throw new Error("SEC_USER_AGENT must be printable ASCII on one line");
  const censusKey = options.censusApiKey?.trim() || null;
  const osmUserAgent = options.osmUserAgent?.trim() || null;
  if (osmUserAgent !== null && !isHeaderSafe(osmUserAgent)) throw new Error("OSM_USER_AGENT must be printable ASCII on one line");
  const overpass = overpassTarget(options.osmOverpassUrl);
  const overpassTargets = [overpass, overpassFallbackTarget(options.osmOverpassFallbackUrl, overpass)].filter((t) => t !== null);
  const maxBytes = options.maxBytes ?? PUBLIC_MAX_RESPONSE_BYTES;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const transport = async (request: PublicRequest, signal?: AbortSignal) => {
    const osm = request.source === "osm";
    const target = osm ? overpassTargets.find((t) => t.host === request.host && t.path === request.path) : undefined;
    if (osm ? target === undefined : !HOSTS.has(request.host)) {
      throw new PublicDataError("bad_request", `host ${request.host} is not a public-data host`, { source: request.source });
    }
    if ((request.method === "POST") !== osm) {
      throw new PublicDataError("bad_request", `${request.method ?? "GET"} is not how ${request.host} is read`, { source: request.source });
    }
    let url = target !== undefined ? target.url : publicUrl(request);
    const headers: Record<string, string> = { Accept: "application/json" };
    let body: string | undefined;
    if (osm) {
      if (osmUserAgent === null) {
        throw new PublicDataError("not_configured", "OSM_USER_AGENT is not set: the Overpass API usage policy asks for a User-Agent naming the product and a contact", { source: "osm" });
      }
      if (request.body === undefined || request.body === "") throw new PublicDataError("bad_request", "an Overpass request needs a query", { source: "osm" });
      headers["User-Agent"] = osmUserAgent;
      headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
      body = `data=${encodeURIComponent(request.body)}`;
    } else if (request.source === "sec") {
      if (userAgent === null) {
        throw new PublicDataError("not_configured", "SEC_USER_AGENT is not set: SEC EDGAR requires a User-Agent naming the product and a contact email", { source: "sec" });
      }
      headers["User-Agent"] = userAgent;
      headers["Accept-Encoding"] = "gzip, deflate";
    } else {
      if (censusKey === null) {
        throw new PublicDataError("not_configured", "CENSUS_API_KEY is not set: the Census Data API requires a key", { source: "census" });
      }
      url += `${url.includes("?") ? "&" : "?"}key=${encodeURIComponent(censusKey)}`;
    }
    const timeoutMs = osm ? (options.osmTimeoutMs ?? OSM_TIMEOUT_MS) : (options.timeoutMs ?? PUBLIC_TIMEOUT_MS);
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const started = performance.now();
    try {
      const init: RequestInit = { method: osm ? "POST" : "GET", headers, redirect: "manual", signal: combined };
      if (body !== undefined) init.body = body;
      const response = await fetchImpl(url, init);
      const bytes = await readCapped(response, maxBytes, request);
      const retryAfterS = parseRetryAfter(response.headers.get("retry-after"), Date.now());
      return { status: response.status, body: new TextDecoder().decode(bytes), ms: performance.now() - started, retryAfterS };
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (err instanceof PublicDataError) throw err;
      if (timeout.aborted) {
        throw new PublicDataError("unavailable", `no response from ${request.host} within ${timeoutMs} ms`, { source: request.source, cause: err });
      }
      throw new PublicDataError("unavailable", `request to ${request.host} failed (${describe(err)})`, { source: request.source, cause: err });
    }
  };
  return Object.assign(transport, { censusKeyed: censusKey !== null });
}

/** Retry-After in seconds: a number of seconds or an HTTP date; null when absent or unreadable. */
export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (header === null) return null;
  const text = header.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const at = Date.parse(text);
  return Number.isNaN(at) ? null : Math.max(0, (at - nowMs) / 1000);
}

/** Reads the body, refusing anything over `maxBytes` as it streams. */
async function readCapped(response: Response, maxBytes: number, request: PublicRequest): Promise<Uint8Array> {
  const tooLarge = () =>
    new PublicDataError("invalid_response", `the ${request.host} response exceeds ${maxBytes} bytes`, { source: request.source, status: response.status });
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (!response.body) return new Uint8Array(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooLarge();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

// Only the error class and code: a message could echo the URL, and a Census URL carries the key.
function describe(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const name = typeof e?.name === "string" ? e.name : "Error";
  const code = typeof e?.cause?.code === "string" ? e.cause.code : typeof e?.code === "string" ? e.code : "";
  return code ? `${name}:${code}` : name;
}
