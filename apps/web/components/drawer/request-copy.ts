/**
 * What a reader can take away from a lookup in the inspector (R8, D51). A Qloo request is copied as text:
 * its endpoint, its parameters with every entity id shown as the name it stands for ("«Juniper Cola»"),
 * and the request id. Qloo entity ids stay on our server, so the browser never holds a replayable
 * Qloo URL; the request id identifies the call. SEC EDGAR and US Census lookups (Part 9) keep an exact
 * public URL (publicRequestLink), and an OpenStreetMap lookup keeps its Overpass query with an "Open in
 * Overpass Turbo" link (overpassLink). No key or credential is ever part of any of them.
 */

/** The Qloo host the requests went to (the hackathon API). */
export const QLOO_BASE_URL = "https://hackathon.api.qloo.com";

/** The line under a Qloo lookup's request block. */
export const QLOO_IDS_LINE = "Qloo entity ids stay on our server; the request id identifies the call.";

const CREDENTIAL = /api[-_]?key|authorization|secret|token|password/i;

/** encodeURIComponent leaves ' alone, which would end a single-quoted URL in a shell. */
const encode = (value: string) => encodeURIComponent(value).replace(/'/g, "%27");

/** The parameters a copy may carry: never anything named like a credential. */
export function publicParams(params: readonly (readonly [string, string])[]): [string, string][] {
  return params.filter(([name]) => !CREDENTIAL.test(name)).map(([name, value]) => [name, value]);
}

/** A redacted value: cut with "…" (long values, id lists), a polygon's vertex count, or a masked secret. */
const SHORTENED = /…|^[A-Z]+ \(\d+ pts\)$|^\[redacted\]$/;

/** The trace event shortens long values; a copy built from them is a sketch, not the full request. */
export function hasShortenedParams(params: readonly (readonly [string, string])[]): boolean {
  return params.some(([, value]) => SHORTENED.test(value));
}

/**
 * A call's full query, from the provenance of the evidence bundle that used it (D30). An SEC, Census or
 * OpenStreetMap call also carries its host (Part 9, R6), and an OpenStreetMap call its POST body (the
 * Overpass QL). The server has already put names where Qloo entity ids were (R8).
 */
export interface CallQuery {
  path: string;
  query: Readonly<Record<string, string>>;
  /** The host of a public request ("data.sec.gov", "overpass-api.de"); absent for Qloo. */
  host?: string;
  method?: "GET" | "POST";
  /** The POST body of an OpenStreetMap request: the Overpass QL. */
  body?: string;
}

const isPublic = (source: string | undefined) => source !== undefined && source !== "qloo";

/**
 * "Copy request" for a Qloo lookup: "GET https://hackathon.api.qloo.com/v2/insights", one
 * "name=value" line per parameter (entity ids already read as «names»), then "request id: …". From the
 * full query when an evidence bundle recorded one (`exact`), else from the redacted parameters (`exact`
 * false when those were shortened). Null without an endpoint, and for a public lookup.
 */
export function requestCopy(
  request: { endpoint: string | null; params: readonly (readonly [string, string])[]; source?: string; requestId?: string | null },
  query: CallQuery | null | undefined,
): { text: string; exact: boolean } | null {
  if (isPublic(request.source) || query?.host !== undefined) return null;
  const path = query?.path ?? request.endpoint;
  if (!path) return null;
  const params = query ? Object.entries(query.query) : publicParams(request.params);
  const lines = [`GET ${QLOO_BASE_URL}${path}`, ...publicParams(params).map(([k, v]) => `${k}=${v}`)];
  if (request.requestId) lines.push(`request id: ${request.requestId}`);
  return { text: lines.join("\n"), exact: query ? true : !hasShortenedParams(request.params) };
}

// SEC EDGAR and US Census (Part 9) ---------------------------------------------------------------------

/**
 * The hosts public lookups go to: SEC company facts on data.sec.gov, the SEC ticker map on www.sec.gov
 * and the Census Data API on api.census.gov.
 */
const PUBLIC_HOSTS: Readonly<Record<string, string>> = {
  "/files/company_tickers.json": "www.sec.gov",
  "/api/xbrl/companyfacts": "data.sec.gov",
  "/data/acs/acs5": "api.census.gov",
};

/** A public request's URL: `https://<host><path>?<query>`, without any key or credential parameter. */
export function publicUrl(host: string, path: string, params: readonly (readonly [string, string])[]): string {
  const query = publicParams(params)
    .filter(([name]) => name !== "key")
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .join("&");
  return `https://${host}${path}${query ? `?${query}` : ""}`;
}

/**
 * The concrete path behind an endpoint template when no bundle recorded it: SEC company facts from the
 * CIK reference ("CIK0000000001" → "/api/xbrl/companyfacts/CIK0000000001.json"), the Census dataset from
 * the vintage in the reference ("acs5 2023 …" → "/data/2023/acs/acs5"). Null when the reference does not say.
 */
function publicPath(endpoint: string, reference: string | null): string | null {
  switch (endpoint) {
    case "/files/company_tickers.json":
      return endpoint;
    case "/api/xbrl/companyfacts": {
      const cik = /^CIK\d{10}$/.exec(reference ?? "")?.[0];
      return cik ? `/api/xbrl/companyfacts/${cik}.json` : null;
    }
    case "/data/acs/acs5": {
      const vintage = /\b(20\d{2})\b/.exec(reference ?? "")?.[1];
      return vintage ? `/data/${vintage}/acs/acs5` : null;
    }
    default:
      return null;
  }
}

/** A reference the mock transport made: the lookup was answered with invented test data, not by the source. */
export function isMockReference(reference: string | null | undefined): boolean {
  return typeof reference === "string" && reference.startsWith("mock-");
}

/**
 * An SEC or Census lookup's link: the exact URL from its bundle's provenance (`exact`), else one rebuilt
 * from its endpoint, reference and redacted parameters (`exact` false when those were shortened). Never
 * a key: the Census key is a server setting and is not part of any recorded query. Null for a Qloo or
 * OpenStreetMap lookup, for test data from the mock transport, and when the reference does not name the request.
 */
export function publicRequestLink(
  request: { source?: string; endpoint: string | null; host?: string | null; requestId: string | null; params: readonly (readonly [string, string])[] },
  query: CallQuery | null | undefined,
): { url: string; exact: boolean } | null {
  if (request.source !== "sec" && request.source !== "census") return null;
  if (isMockReference(request.requestId)) return null;
  if (query?.host) return { url: publicUrl(query.host, query.path, Object.entries(query.query)), exact: true };
  if (!request.endpoint) return null;
  const host = request.host ?? PUBLIC_HOSTS[request.endpoint];
  const path = publicPath(request.endpoint, request.requestId);
  if (!host || !path) return null;
  return { url: publicUrl(host, path, request.params), exact: !hasShortenedParams(request.params) };
}

// OpenStreetMap (R6) ------------------------------------------------------------------------------------

/** Overpass Turbo, the public web front end that runs an Overpass query and shows it on a map. */
export const OVERPASS_TURBO_URL = "https://overpass-turbo.eu/";

/**
 * An OpenStreetMap lookup's query and its Overpass Turbo link (`?Q=<query>&R` runs it on open). Null
 * without the recorded query (the body lives in the evidence provenance) and for test data from the mock
 * transport. The query holds only tag filters and gazetteer coordinates, never a key.
 */
export function overpassLink(
  request: { source?: string; requestId: string | null },
  query: CallQuery | null | undefined,
): { query: string; url: string } | null {
  if (request.source !== "osm" || isMockReference(request.requestId)) return null;
  const ql = query?.body?.trim();
  if (!ql) return null;
  return { query: ql, url: `${OVERPASS_TURBO_URL}?Q=${encodeURIComponent(ql)}&R` };
}
