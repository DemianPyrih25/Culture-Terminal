import { QlooNetworkError } from "./errors";
import type { QlooHeaders, Transport } from "./transport-types";

/**
 * The live transport (PLAN §5.1 step 7): one GET per attempt with the X-Api-Key header, a 20 s
 * timeout and a 5 MB cap enforced while the body streams. Redirects are never followed, so the key
 * cannot leak to another host. Nothing here logs; errors carry no headers.
 */

export const DEFAULT_TIMEOUT_MS = 20_000;
export const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_QLOO_BASE_URL = "https://hackathon.api.qloo.com";

export interface HttpTransportOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  maxBytes?: number;
  /** Injectable for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** The base URL without a trailing slash. HTTPS only, except for a local test server. */
export function normaliseBaseUrl(baseUrl: string): string {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`Qloo base URL "${baseUrl}" is not a URL`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOCAL_HOSTS.has(url.hostname))) {
    throw new Error(`Qloo base URL must use https, got "${url.origin}"`);
  }
  if (url.search !== "" || url.hash !== "") throw new Error("Qloo base URL must not carry a query or fragment");
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

export function createHttpTransport(options: HttpTransportOptions): Transport {
  const base = normaliseBaseUrl(options.baseUrl);
  const apiKey = options.apiKey.trim();
  if (apiKey === "") throw new Error("createHttpTransport: the Qloo API key is empty");
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  return async (request, signal) => {
    const url = request.qs === "" ? `${base}${request.path}` : `${base}${request.path}?${request.qs}`;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const started = performance.now();
    try {
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { "X-Api-Key": apiKey, Accept: "application/json" },
        redirect: "manual",
        signal: combined,
      });
      const body = await readCapped(response, maxBytes);
      return { status: response.status, body, headers: readQlooHeaders(response.headers), ms: performance.now() - started };
    } catch (err) {
      if (signal?.aborted) throw signal.reason;
      if (timeout.aborted) throw new QlooNetworkError("timeout", `no response from Qloo within ${timeoutMs} ms`, { cause: err });
      if (err instanceof QlooNetworkError) throw err;
      throw new QlooNetworkError("network", `request to Qloo failed (${describe(err)})`, { cause: err });
    }
  };
}

/** Reads the body, refusing anything over `maxBytes` as it streams instead of after buffering it all. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array> {
  const tooLarge = () => new QlooNetworkError("too_large", `Qloo response exceeds ${maxBytes} bytes`);
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

function headerNumber(headers: Headers, name: string): number | null {
  const raw = headers.get(name);
  if (raw === null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** The tracing and rate-limit headers Qloo sends on every response (PROBE_FINDINGS "Run"). */
export function readQlooHeaders(headers: Headers): QlooHeaders {
  const requestId = headers.get("x-qloo-request-id")?.trim();
  return {
    requestId: requestId ? requestId : null,
    monthLimit: headerNumber(headers, "x-month-ratelimit-limit"),
    monthRemaining: headerNumber(headers, "x-month-ratelimit-remaining"),
    monthReset: headerNumber(headers, "x-month-ratelimit-reset"),
    secondLimit: headerNumber(headers, "x-second-ratelimit-limit"),
    secondRemaining: headerNumber(headers, "x-second-ratelimit-remaining"),
    secondReset: headerNumber(headers, "x-second-ratelimit-reset"),
  };
}

// Only the error class and code: a message could echo request details.
function describe(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const name = typeof e?.name === "string" ? e.name : "Error";
  const code = typeof e?.cause?.code === "string" ? e.cause.code : typeof e?.code === "string" ? e.code : "";
  return code ? `${name}:${code}` : name;
}
