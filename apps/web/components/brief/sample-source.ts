import type { RunEvent } from "@ct/contracts";
import type { EventSourceLike } from "../../lib/sse-client";

/**
 * A stand-in EventSource that serves recorded events instead of the server's stream, so the dev sample
 * viewer replays a run that was never stored. It honours ?after=<seq> like the real stream, opens on
 * the next tick and sends every event at once, as a finished run's stream does.
 */
export function recordedEventSource(events: readonly RunEvent[]): (url: string) => EventSourceLike {
  return (url) => {
    const after = Number(new URL(url, "http://local.invalid").searchParams.get("after") ?? "0") || 0;
    let closed = false;
    const source: { -readonly [K in keyof EventSourceLike]: EventSourceLike[K] } = {
      readyState: 0,
      onopen: null,
      onmessage: null,
      onerror: null,
      close() {
        closed = true;
        source.readyState = 2;
      },
    };
    setTimeout(() => {
      if (closed) return;
      source.readyState = 1;
      source.onopen?.(new Event("open"));
      for (const event of events) {
        if (closed) return;
        if (event.seq > after) source.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
      }
    }, 0);
    return source;
  };
}
