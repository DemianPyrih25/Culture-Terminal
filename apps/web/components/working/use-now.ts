"use client";

import { useEffect, useRef, useState } from "react";
import type { ConnectionStatus } from "../../lib/sse-client";

/** Below this, a gap between the server's clock and the browser's is page-load time, not a skewed clock. */
const CLOCK_SKEW_MS = 5000;

/**
 * A wall clock that ticks once a second while `active`. It starts at `initial` (the server's clock at
 * render), so the first client render matches the server's markup; the ticks start after hydration. A
 * browser clock that runs well ahead of or behind the server's is corrected by the gap, so timers
 * measured against event times neither stick at 0 nor race ahead.
 */
export function useNow(initial: number, active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(initial);
  const offset = useRef<number | null>(null);
  useEffect(() => {
    if (!active) return;
    if (offset.current === null) {
      const skew = initial - Date.now();
      offset.current = Math.abs(skew) > CLOCK_SKEW_MS ? skew : 0;
    }
    const tick = () => setNow(Date.now() + (offset.current ?? 0));
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active, intervalMs, initial]);
  return now;
}

/** How long a reconnect may take before the reader is told live updates stopped. */
export const RECONNECT_GRACE_MS = 5000;

/** The live stream is lost: it failed, or has been reconnecting for more than five seconds. */
export function useConnectionLost(connection: ConnectionStatus | undefined, graceMs = RECONNECT_GRACE_MS): boolean {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (connection !== "reconnecting") {
      const reset = setTimeout(() => setLate(false), 0);
      return () => clearTimeout(reset);
    }
    const timer = setTimeout(() => setLate(true), graceMs);
    return () => clearTimeout(timer);
  }, [connection, graceMs]);
  return connection === "failed" || (connection === "reconnecting" && late);
}
