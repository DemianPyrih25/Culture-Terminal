import { createHash } from "node:crypto";
import type { QlooParams, QlooParamValue } from "@ct/contracts";
import type { QlooPath } from "./allowlist";
import { canonicalLatLon, canonicalWkt, formatNumber, looksLikeWkt, parseLatLon, parseWkt } from "./geometry";
import { BOOLEAN_PARAMS, LIST_PARAMS, listItems, LOCATION_PARAMS, NUMERIC_PARAMS } from "./params";
import type { CanonicalRequest } from "./transport-types";
import { filterTypeOf, numericValue } from "./validate";

/**
 * Canonical requests and cache keys (PLAN §5.1 step 2). Two requests that mean the same thing get
 * the same key: keys sorted, order-free lists sorted and de-duplicated, numbers in one plain form,
 * WKT rounded to 5 dp. The query string uses the encoding the probe sent live (commas and colons
 * literal), so a key here equals the probe's `sha256("v1|GET|path?qs")`.
 */

/**
 * Key namespace. Mock mode hashes under its own prefix, so synthetic bodies in the shared cache can
 * never be served as live data, and live bodies never answer a mock run.
 */
export type CacheNamespace = "v1" | "mock-v1";

export function canonicalize(path: QlooPath, params: QlooParams, namespace: CacheNamespace = "v1"): CanonicalRequest {
  const canonicalParams: Record<string, QlooParamValue> = {};
  const query: Record<string, string> = {};
  for (const key of Object.keys(params).sort()) {
    const value = params[key];
    if (value === undefined) continue;
    const canonical = canonicalValue(path, key, value);
    canonicalParams[key] = canonical;
    query[key] = queryText(canonical);
  }
  const qs = buildQueryString(query);
  return {
    path,
    filterType: filterTypeOf(path, params),
    params: canonicalParams,
    query,
    qs,
    key: sha256Hex(`${namespace}|GET|${path}?${qs}`),
  };
}

function canonicalValue(path: QlooPath, key: string, value: QlooParamValue): QlooParamValue {
  if (LIST_PARAMS.has(key) && (typeof value === "string" || Array.isArray(value))) {
    return [...new Set(listItems(value as string | readonly string[]))].sort();
  }
  if (NUMERIC_PARAMS.has(key)) return numericValue(value) ?? textOf(value);
  if (BOOLEAN_PARAMS.has(key) && (value === "true" || value === "false")) return value === "true";
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (LOCATION_PARAMS.has(key)) return canonicalLocation(path, text);
  return text;
}

function canonicalLocation(path: QlooPath, text: string): string {
  if (path === "/search") {
    const pair = parseLatLon(text);
    return pair === null ? text : canonicalLatLon(pair);
  }
  if (!looksLikeWkt(text)) return text;
  try {
    return canonicalWkt(parseWkt(text));
  } catch {
    return text;
  }
}

const textOf = (value: QlooParamValue): string =>
  Array.isArray(value) ? value.join(",") : String(value).trim();

function queryText(value: QlooParamValue): string {
  if (typeof value === "number") return formatNumber(value);
  return textOf(value);
}

/** Percent-encoding with commas and colons kept literal, as the probe sent URNs and id lists. */
export function encodeQueryValue(value: string): string {
  return encodeURIComponent(value).replace(/%2C/gi, ",").replace(/%3A/gi, ":");
}

/** `k=v&…` in key order, without the leading "?". */
export function buildQueryString(query: Readonly<Record<string, string>>): string {
  return Object.keys(query)
    .sort()
    .map((k) => `${encodeQueryValue(k)}=${encodeQueryValue(query[k] ?? "")}`)
    .join("&");
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

const REDACT_MAX_CHARS = 96;
const REDACT_LIST_SHOWN = 2;

/**
 * Canonical query values shortened for the `qloo` trace event: polygons become a vertex count, long
 * id lists show their first items and a count, and any other long value is cut. Credentials never
 * travel in the query; a key-like parameter is masked anyway.
 */
export function redactParams(query: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) out[key] = redactValue(key, value);
  return out;
}

function redactValue(key: string, value: string): string {
  if (/api[-_.]?key|authorization|secret|token/i.test(key)) return "[redacted]";
  if (LOCATION_PARAMS.has(key) && looksLikeWkt(value)) {
    try {
      const parsed = parseWkt(value);
      if (parsed.type !== "POINT") return `${parsed.type} (${parsed.coordinates.length} pts)`;
    } catch {
      // Not parseable: fall through to the length cut.
    }
  }
  if (LIST_PARAMS.has(key)) {
    const items = value.split(",");
    if (items.length > REDACT_LIST_SHOWN + 1) {
      return `${items.slice(0, REDACT_LIST_SHOWN).join(",")},… (+${items.length - REDACT_LIST_SHOWN})`;
    }
  }
  return value.length > REDACT_MAX_CHARS ? `${value.slice(0, REDACT_MAX_CHARS - 1)}…` : value;
}
