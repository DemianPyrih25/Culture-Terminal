/**
 * "Copy as curl" for a Qloo request in the inspector (PLAN §5.1): the request's URL with its query and
 * the key as the shell placeholder $QLOO_API_KEY. The query is the full canonical one from the evidence
 * provenance where the call fed a bundle; otherwise the redacted parameters, flagged when shortened. The
 * browser never holds a key, so none can be copied; a parameter that looks like a credential is dropped
 * as well.
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

/** A Qloo call's full canonical query, from the provenance of the evidence bundle that used it (D30). */
export interface CallQuery {
  path: string;
  query: Readonly<Record<string, string>>;
}

/**
 * The request's curl: from its full query when an evidence bundle recorded one (`exact`), else from the
 * redacted parameters (`exact` false when those were shortened). Null without an endpoint.
 */
export function requestCurl(
  request: { endpoint: string | null; params: readonly (readonly [string, string])[] },
  query: CallQuery | null | undefined,
): { command: string; exact: boolean } | null {
  if (query) return { command: curlCommand(query.path, Object.entries(query.query)), exact: true };
  if (!request.endpoint) return null;
  return { command: curlCommand(request.endpoint, request.params), exact: !hasShortenedParams(request.params) };
}
