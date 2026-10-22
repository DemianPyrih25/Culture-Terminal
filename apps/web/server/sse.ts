import "server-only";
import { encodeSseEvent, type RunEvent } from "@ct/contracts";

/** Browsers wait this long before reconnecting (SPEC §3.2). */
export const SSE_RETRY_MS = 2000;
/** A comment line this often keeps proxies from closing an idle stream. */
export const SSE_PING_MS = 15_000;

export const SSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Type": "text/event-stream",
  // no-transform also stops the Next.js server from gzipping, which would buffer the stream.
  "Cache-Control": "no-cache, no-transform",
  "X-Accel-Buffering": "no",
  Connection: "keep-alive",
};

/** One event: `id: <seq>` for Last-Event-ID resume, then the event as a single `data:` line. */
export const sseEventFrame = (event: RunEvent): string => encodeSseEvent(event);

export const sseComment = (text: string): string => `: ${text.replace(/[\r\n]+/g, " ")}\n\n`;

export const sseRetry = (ms: number): string => `retry: ${Math.max(0, Math.round(ms))}\n\n`;

const INT4_MAX = 2_147_483_647;

/** A seq cursor: a non-negative integer that fits run_events.seq, or null for anything else. */
export function parseSeq(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const text = raw.trim();
  if (!/^\d{1,10}$/.test(text)) return null;
  const n = Number(text);
  return n <= INT4_MAX ? n : null;
}

/**
 * Where a stream resumes: the browser's Last-Event-ID wins (an automatic reconnect), then ?after=
 * (a client resuming by hand), else from the start. Invalid values fall through to the next source.
 */
export function parseCursor(lastEventId: string | null, after: string | null): number {
  return parseSeq(lastEventId) ?? parseSeq(after) ?? 0;
}

export interface SseResponseOptions {
  pingMs?: number;
  retryMs?: number;
  onError?: (err: unknown) => void;
}

/**
 * Streams events as Server-Sent Events. The source gets an AbortSignal that fires when the client
 * goes away (request abort or stream cancel), so it can unsubscribe and stop reading the database.
 * The response ends when the source ends.
 */
export function sseResponse(
  source: (signal: AbortSignal) => AsyncIterable<RunEvent>,
  requestSignal: AbortSignal | undefined,
  options: SseResponseOptions = {},
): Response {
  const encoder = new TextEncoder();
  const abort = new AbortController();
  let ping: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  const onRequestAbort = () => abort.abort();
  const cleanup = () => {
    closed = true;
    if (ping) clearInterval(ping);
    requestSignal?.removeEventListener("abort", onRequestAbort);
  };
  if (requestSignal?.aborted) abort.abort();
  else requestSignal?.addEventListener("abort", onRequestAbort, { once: true });

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          // The consumer is gone; the abort path below tidies up.
          abort.abort();
        }
      };
      send(sseRetry(options.retryMs ?? SSE_RETRY_MS));
      ping = setInterval(() => send(sseComment("ping")), options.pingMs ?? SSE_PING_MS);

      void (async () => {
        try {
          for await (const event of source(abort.signal)) {
            if (abort.signal.aborted) break;
            send(sseEventFrame(event));
          }
        } catch (err) {
          if (!abort.signal.aborted) options.onError?.(err);
        } finally {
          cleanup();
          try {
            controller.close();
          } catch {
            // Already closed or errored by a cancel.
          }
        }
      })();
    },
    cancel() {
      abort.abort();
      cleanup();
    },
  });

  return new Response(stream, { status: 200, headers: SSE_HEADERS });
}
