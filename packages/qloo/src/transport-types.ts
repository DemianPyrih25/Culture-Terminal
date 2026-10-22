import type { QlooParams, QlooPath } from "@ct/contracts";

/**
 * The seam between the client pipeline and whatever answers a request: the HTTP transport for
 * hackathon.api.qloo.com, or the synthetic mock transport (QLOO_MOCK=1). Both see the same
 * canonical request and return raw bytes plus the rate-limit headers, so validation, caching,
 * budgets and the ledger behave identically in mock mode.
 */

/** A request after validation and canonicalisation (PLAN §5.1 steps 1–2). */
export interface CanonicalRequest {
  path: QlooPath;
  /** `filter.type` for /v2/insights and /v2/trending, else null. */
  filterType: string | null;
  /** Canonical parameters: keys sorted, order-free lists sorted, numbers normalised, WKT rounded to 5 dp. */
  params: QlooParams;
  /** The same parameters as canonical strings (lists comma-joined): the provenance `query`. */
  query: Record<string, string>;
  /** URL query string built from `query` in key order, without the leading "?". */
  qs: string;
  /** sha256 hex of "v1|GET|" + path + "?" + qs. */
  key: string;
}

/** Rate-limit and tracing headers captured from every response; null when absent. */
export interface QlooHeaders {
  requestId: string | null;
  monthLimit: number | null;
  monthRemaining: number | null;
  /** Seconds until the monthly window resets, as sent. */
  monthReset: number | null;
  secondLimit: number | null;
  secondRemaining: number | null;
  /** Seconds until the per-second window resets, as sent. */
  secondReset: number | null;
}

export interface TransportResponse {
  status: number;
  /** Raw response body (JSON text as bytes), at most 5 MB. */
  body: Uint8Array;
  headers: QlooHeaders;
  /** Wall time of this attempt in ms. */
  ms: number;
}

/** One attempt. Network failures, timeouts and the size cap reject with QlooNetworkError. */
export type Transport = (request: CanonicalRequest, signal?: AbortSignal) => Promise<TransportResponse>;
