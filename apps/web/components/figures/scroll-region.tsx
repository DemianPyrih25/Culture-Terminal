"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cx } from "../ui/cx";

/**
 * A box that scrolls sideways when its content is wider than it (a chart drawn at its natural width on a
 * phone, a wide table). While it actually scrolls it is a named, focusable region, so keyboard users can
 * scroll it too; while it fits it adds no tab stop.
 */
export function ScrollRegion({
  label,
  children,
  className,
  hidden,
  view,
}: {
  /** The region's accessible name: the figure's plain-text title. */
  label: string;
  children: ReactNode;
  className?: string;
  hidden?: boolean;
  /** data-view, for tests and the chart sheet. */
  view?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrolls, setScrolls] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setScrolls(el.scrollWidth > el.clientWidth + 1);
    check();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(check);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      hidden={hidden}
      data-view={view}
      data-scrolls={scrolls ? "true" : undefined}
      tabIndex={scrolls ? 0 : undefined}
      role={scrolls ? "region" : undefined}
      aria-label={scrolls ? label : undefined}
      className={cx("min-w-0 overflow-x-auto", className)}
    >
      {children}
    </div>
  );
}
