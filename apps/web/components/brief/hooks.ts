"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FreshCalls } from "./fresh";

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

/**
 * Whether a request stamp flashes: once, as its call lands (see FreshCalls). `known` are the calls the
 * first paint already showed; `qlooCallIds` the calls in the run now.
 */
export function useFreshCalls(qlooCallIds: readonly string[], known: Iterable<string> = []): (qlooCallId: string) => boolean {
  const [tracker] = useState(() => new FreshCalls(new Set(known)));
  const ids = qlooCallIds.join(" ");
  useEffect(() => {
    tracker.observe(ids === "" ? [] : ids.split(" "), Date.now());
  }, [tracker, ids]);
  return useCallback((qlooCallId: string) => tracker.isFresh(qlooCallId, Date.now()), [tracker]);
}

/**
 * True once the element has scrolled up under the top `offset` px of the viewport (the sticky top bar):
 * the running head and the trace note take over from the page head then. False on the server.
 */
export function useScrolledPast(element: HTMLElement | null, offset: number): boolean {
  const [past, setPast] = useState(false);
  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry) setPast(!entry.isIntersecting && entry.boundingClientRect.top < offset);
      },
      { rootMargin: `-${offset}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [element, offset]);
  return past;
}

/** Whether a media query matches; false on the server and the first client render, so markup matches. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    const first = setTimeout(update, 0);
    list.addEventListener("change", update);
    return () => {
      clearTimeout(first);
      list.removeEventListener("change", update);
    };
  }, [query]);
  return matches;
}
