import type { ProvenanceRequest } from "@ct/contracts";
import { buildQueryString } from "./canonical";
import { normaliseBaseUrl } from "./http-transport";
import type { QlooCallRecord } from "./records";

/** The kit's provenance envelope entry for a call (D30): method, path and the canonical query. */
export function provenanceRequest(record: Pick<QlooCallRecord, "path" | "query">): ProvenanceRequest {
  return { method: "GET", path: record.path, query: { ...record.query } };
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * "Copy as curl" for the ledger drawer. The key is always the `$QLOO_API_KEY` placeholder, expanded
 * by the reader's own shell; the real key never appears.
 */
export function curlFor(request: ProvenanceRequest, baseUrl: string): string {
  const qs = buildQueryString(request.query);
  const url = `${normaliseBaseUrl(baseUrl)}${request.path}${qs === "" ? "" : `?${qs}`}`;
  return `curl -sS ${shellQuote(url)} -H "X-Api-Key: $QLOO_API_KEY" -H 'Accept: application/json'`;
}
