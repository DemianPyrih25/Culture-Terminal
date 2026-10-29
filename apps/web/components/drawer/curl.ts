/**
 * "Copy as curl" for a Qloo request in the inspector (PLAN §5.1): the request's URL with its query and
 * the key as the shell placeholder $QLOO_API_KEY. The query is the full canonical one from the evidence
 * provenance where the call fed a bundle; otherwise the redacted parameters, flagged when shortened. The
 * browser never holds a key, so none can be copied; a parameter that looks like a credential is dropped
 * as well. SEC EDGAR and US Census lookups (Part 9) get a plain URL instead (publicRequestLink): they need
 * no Qloo key, and the Census key is never part of a recorded query.
 */

/** The Qloo host the requests went to (the hackathon API). */
export const QLOO_BASE_URL = "https://hackathon.api.qloo.com";

/** What the header carries instead of a key: the reader's own shell variable. */
export const API_KEY_PLACEHOLDER = "$QLOO_API_KEY";

const CREDENTIAL = /api[-_]?key|authorization|secret|token|password/i;

/** encodeURIComponent leaves ' alone, which would end the single-quoted URL in a shell. */
const encode = (value: string) => encodeURIComponent(value).replace(/'/g, "%27");

/** The parameters a curl may carry: never anything named like a credential. */
export function publicParams(params: readonly (readonly [string, string])[]): [string, string][] {
  return params.filter(([name]) => !CREDENTIAL.test(name)).map(([name, value]) => [name, value]);
}

/** "https://hackathon.api.qloo.com/v2/insights?filter.type=urn%3Aentity%3Abrand&take=6". */
export function requestUrl(endpoint: string, params: readonly (readonly [string, string])[]): string {
  const query = publicParams(params)
    .map(([name, value]) => `${encode(name)}=${encode(value)}`)
    .join("&");
  return `${QLOO_BASE_URL}${endpoint}${query ? `?${query}` : ""}`;
}

/** curl '<url>' -H "x-api-key: $QLOO_API_KEY": the header in double quotes so the shell expands it. */
export function curlCommand(endpoint: string, params: readonly (readonly [string, string])[]): string {
  return `curl '${requestUrl(endpoint, params)}' -H "x-api-key: ${API_KEY_PLACEHOLDER}"`;
}

/** A redacted value: cut with "…" (long values, id lists), a polygon's vertex count, or a masked secret. */
const SHORTENED = /…|^[A-Z]+ \(\d+ pts\)$|^\[redacted\]$/;

/** The trace event shortens long values; a curl built from them is a sketch, not a replay. */
export function hasShortenedParams(params: readonly (readonly [string, string])[]): boolean {
  return params.some(([, value]) => SHORTENED.test(value));
}

/**
 * A call's full canonical query, from the provenance of the evidence bundle that used it (D30). An SEC or
 * Census call also carries its host (Part 9); its query never holds a key.
 */
export interface CallQuery {
  path: string;
  query: Readonly<Record<string, string>>;
  /** The host of an SEC or Census request ("data.sec.gov"); absent for Qloo. */
  host?: string;
}

/**
 * The request's curl: from its full query when an evidence bundle recorded one (`exact`), else from the
 * redacted parameters (`exact` false when those were shortened). Null without an endpoint, and for an SEC
 * or Census lookup.
 */
export function requestCurl(
  request: { endpoint: string | null; params: readonly (readonly [string, string])[]; source?: string },
  query: CallQuery | null | undefined,
): { command: string; exact: boolean } | null {
  // An SEC or Census lookup is a plain URL (publicRequestLink), never a curl with a Qloo key.
  if ((request.source !== undefined && request.source !== "qloo") || query?.host !== undefined) return null;
  if (query) return { command: curlCommand(query.path, Object.entries(query.query)), exact: true };
  if (!request.endpoint) return null;
  return { command: curlCommand(request.endpoint, request.params), exact: !hasShortenedParams(request.params) };
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

/** A reference the mock transport made: the lookup was answered with invented test data, not by SEC or the Census. */
export function isMockReference(reference: string | null | undefined): boolean {
  return typeof reference === "string" && reference.startsWith("mock-");
}

/**
 * An SEC or Census lookup's link: the exact URL from its bundle's provenance (`exact`), else one rebuilt
 * from its endpoint, reference and redacted parameters (`exact` false when those were shortened). Never
 * a key: the Census key is a server setting and is not part of any recorded query. Null for a Qloo lookup,
 * for test data from the mock transport, and when the reference does not name the request.
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
