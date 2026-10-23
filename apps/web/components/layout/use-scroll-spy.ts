"use client";

import { useEffect, useState } from "react";
import { activeSection, isScrolledToBottom, spyRootMargin, type SpySection } from "./scrollspy";

/**
 * The id of the section the reader is in, among the elements with `ids` (document order). An
 * IntersectionObserver reports each section whose top crosses the activation line `offset` px below the
 * viewport top (under the sticky chrome), however fast the page moves (see spyRootMargin); scrollend
 * settles the bottom-of-page rule. Where scrollend is missing (older Safari), a passive scroll listener,
 * throttled to one measurement per frame, does that instead. Null before the first measurement, on the
 * server, and when no element exists.
 */
export function useScrollSpy(ids: readonly string[], offset: number): string | null {
  const [active, setActive] = useState<string | null>(null);
  // A stable dependency for the ids; HTML ids hold no spaces.
  const key = ids.join(" ");

  useEffect(() => {
    const list = key === "" ? [] : key.split(" ");
    const elements = list
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0 || typeof IntersectionObserver === "undefined") return;
    const root = document.scrollingElement ?? document.documentElement;

    const measure = () => {
      const sections: SpySection[] = [];
      for (const el of elements) {
        const rect = el.getBoundingClientRect();
        // Hidden sections (a collapsed tab, display: none) have no box and never count.
        if (rect.width === 0 && rect.height === 0) continue;
        sections.push({ id: el.id, top: rect.top });
      }
      const bottom = isScrolledToBottom(root.scrollTop, window.innerHeight, root.scrollHeight);
      setActive(activeSection(sections, offset, bottom));
    };

    let observer: IntersectionObserver | null = null;
    const observe = () => {
      observer?.disconnect();
      const rootMargin = spyRootMargin(offset, window.innerHeight, root.scrollHeight);
      observer = new IntersectionObserver(measure, { rootMargin, threshold: 0 });
      for (const el of elements) observer.observe(el);
    };

    // One measurement per frame while scrolling, only where scrollend cannot settle the page.
    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    const settles = "onscrollend" in window;

    observe();
    window.addEventListener("resize", observe);
    if (settles) window.addEventListener("scrollend", measure);
    else window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", observe);
      window.removeEventListener("scrollend", measure);
      window.removeEventListener("scroll", onScroll);
    };
  }, [key, offset]);

  return active;
}
