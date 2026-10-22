import { hashHex } from "./mock/hash";
import { answer } from "./mock/router";
import type { CanonicalRequest, QlooHeaders, Transport } from "./transport-types";

/**
 * The synthetic Qloo transport (QLOO_MOCK=1): a clean clone runs the whole app with no key and no
 * network (PLAN §12.1). Every allowlisted path and filter.type is answered with invented entities
 * in the probe's response shapes, so the cache, budgets and the ledger behave as in live mode.
 * Bodies are a pure function of the request (hashes, never Math.random), with one exception: the
 * process remembers the entities /search returned, so later rows for those ids carry the searched
 * name in every transport; a new process shows an invented name until the id is searched again.
 * Scores never depend on that memory.
 */

/** An injected failure for tests: matching attempts get `status` and `body` instead of data. */
export interface MockFault {
  /** Substring of the path plus the unencoded query, e.g. "/search?query=Brand Alpha". */
  match: string;
  status: number;
  /** Response body; defaults to `{"error": <reason>}`. A 200 with `{"error_msg": …}` is a rate-limit body. */
  body?: unknown;
  /** Fail this many matching attempts, then answer normally; every attempt when omitted. */
  times?: number;
}

export interface MockTransportOptions {
  /** Simulated latency per attempt in ms. */
  latencyMs?: number;
  /** Injected failures, checked in order before any synthetic answer. */
  faults?: readonly MockFault[];
}

/** Rate-limit headers: a healthy month, far above the 38,000 development stop (D24). */
const MONTH_LIMIT = 50_000;
const MONTH_REMAINING = 49_000;
const MONTH_RESET_S = 1_209_600;
const SECOND_LIMIT = 10;

const FAULT_REASONS: Readonly<Record<number, string>> = {
  400: "bad request",
  401: "invalid API key",
  403: "forbidden",
  429: "rate limit exceeded",
  500: "internal server error",
  502: "bad gateway",
  503: "service unavailable",
  504: "gateway timeout",
};

const encoder = new TextEncoder();

function headersFor(request: CanonicalRequest, status: number): QlooHeaders {
  return {
    // Derived from the canonical key, never UUID-shaped (D29).
    requestId: `mock-${hashHex("request", request.key).slice(0, 16)}`,
    monthLimit: MONTH_LIMIT,
    monthRemaining: MONTH_REMAINING,
    monthReset: MONTH_RESET_S,
    secondLimit: SECOND_LIMIT,
    secondRemaining: status === 429 ? 0 : SECOND_LIMIT - 1,
    secondReset: 1,
  };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMockTransport(options: MockTransportOptions = {}): Transport {
  const faults = options.faults ?? [];
  const faultUses = new Map<MockFault, number>();

  function injected(request: CanonicalRequest): { status: number; body: unknown } | null {
    const target = `${request.path}?${Object.entries(request.query)
      .map(([k, v]) => `${k}=${v}`)
      .join("&")}`;
    for (const fault of faults) {
      const uses = faultUses.get(fault) ?? 0;
      if (!target.includes(fault.match) || (fault.times !== undefined && uses >= fault.times)) continue;
      faultUses.set(fault, uses + 1);
      return { status: fault.status, body: fault.body ?? { error: FAULT_REASONS[fault.status] ?? `mock fault ${fault.status}` } };
    }
    return null;
  }

  return async (request, signal) => {
    const started = performance.now();
    signal?.throwIfAborted();
    if (options.latencyMs !== undefined && options.latencyMs > 0) await sleep(options.latencyMs, signal);
    const reply = injected(request) ?? answer(request);
    return {
      status: reply.status,
      body: encoder.encode(JSON.stringify(reply.body)),
      headers: headersFor(request, reply.status),
      ms: Math.round(performance.now() - started),
    };
  };
}
