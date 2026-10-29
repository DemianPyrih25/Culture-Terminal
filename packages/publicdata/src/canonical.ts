import { buildQueryString, sha256Hex } from "@ct/qloo";
import type { PublicEnv, PublicRequest } from "./api";

/**
 * Canonical public-data requests and cache keys. A request's query is built by this package only (SEC
 * and Census builders), already in one canonical form, and never holds an API key: the live transport
 * adds CENSUS_API_KEY on the wire. So the key is in neither the cache key, the call log nor provenance.
 */

/** Key namespace: mock bodies can never answer a live call, and live bodies never answer a mock one. */
export type PublicCacheNamespace = "pd-v1" | "mock-pd-v1";

export const namespaceFor = (env: PublicEnv): PublicCacheNamespace => (env === "mock" ? "mock-pd-v1" : "pd-v1");

/** Query parameter names that look like a credential. The builders never produce one; this is a guard. */
const SECRET_PARAM = /^key$|api[-_.]?key|authorization|secret|token/i;

export function isSecretParam(name: string): boolean {
  return SECRET_PARAM.test(name);
}

/** `k=v&…` in key order (commas and colons literal), the same encoding the Qloo client uses. */
export function publicQueryString(query: Readonly<Record<string, string>>): string {
  return buildQueryString(query);
}

/** sha256Hex(`<namespace>|GET|<source>|<path>?<sorted qs>`). Refuses a query that carries a credential. */
export function publicCacheKey(request: PublicRequest, namespace: PublicCacheNamespace): string {
  for (const name of Object.keys(request.query)) {
    if (isSecretParam(name)) throw new Error(`@ct/publicdata: the query parameter "${name}" must never be part of a request`);
  }
  return sha256Hex(`${namespace}|GET|${request.source}|${request.path}?${publicQueryString(request.query)}`);
}

const REDACT_MAX_CHARS = 96;
const REDACT_LIST_SHOWN = 2;

/**
 * The query shortened for the `public` trace event and the call log: long comma lists (ACS variables,
 * ZCTAs) show their first items and a count, other long values are cut, and a key-like parameter is
 * masked (none is ever present).
 */
export function redactPublicParams(query: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) out[key] = redactValue(key, value);
  return out;
}

function redactValue(key: string, value: string): string {
  if (isSecretParam(key)) return "[redacted]";
  // `for=zip code tabulation area:a,b,c,…` keeps its geography label in front of the shortened list.
  const colon = value.lastIndexOf(":");
  const head = colon >= 0 ? value.slice(0, colon + 1) : "";
  const items = value.slice(head.length).split(",");
  if (items.length > REDACT_LIST_SHOWN + 1) {
    return `${head}${items.slice(0, REDACT_LIST_SHOWN).join(",")},… (+${items.length - REDACT_LIST_SHOWN})`;
  }
  return value.length > REDACT_MAX_CHARS ? `${value.slice(0, REDACT_MAX_CHARS - 1)}…` : value;
}
