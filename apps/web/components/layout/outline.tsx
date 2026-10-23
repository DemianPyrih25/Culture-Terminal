"use client";

import type { ReactNode } from "react";
import { cx } from "../ui/cx";
import { CHROME_HEIGHT } from "./grid";
import { resolveActiveItem, type OutlineItem } from "./scrollspy";
import { useScrollSpy } from "./use-scroll-spy";

// The item type and the active-item rule live in ./scrollspy (no "use client"), so servers can use them.
export type { OutlineItem } from "./scrollspy";

export interface OutlineMeta {
  /** Mono line, e.g. "Brief 0001 · 6 Jul 2026". */
  trace?: string;
  /** Plain line, e.g. "3 min read · 1 figure · 12 sources". */
  text?: ReactNode;
}

export interface OutlineProps {
  items: readonly OutlineItem[];
  /** Default "On this brief"; the library uses "On this page". */
  heading?: string;
  /** Forces the active item; leave undefined to follow the scroll position. */
  activeId?: string | null;
  /** The activation line in px below the viewport top (default: under the sticky chrome). */
  spyOffset?: number;
  /** The footer under the links. */
  meta?: OutlineMeta;
  className?: string;
}

/**
 * A/Outline: ON THIS BRIEF, then one 30 px link per section on a hairline rail; the active one carries a
 * 2 px accent bar and ink text (aria-current). A section not written yet is a faint disabled link that
 * says so to screen readers. A meta footer closes it.
 */
export function Outline({
  items,
  heading = "On this brief",
  activeId,
  spyOffset = CHROME_HEIGHT + 24,
  meta,
  className,
}: OutlineProps) {
  const spied = useScrollSpy(
    items.filter((i) => !i.pending).map((i) => i.id),
    spyOffset,
  );
  const active = resolveActiveItem(items, activeId, spied);

  return (
    <nav aria-label={heading} className={cx("flex w-full flex-col", className)}>
      <p className="pb-3 pl-[14px] text-[10px] leading-none font-semibold tracking-[1.2px] text-dim uppercase">
        {heading}
      </p>
      <ul className="flex flex-col border-l border-line">
        {items.map((item) => {
          const isActive = item.id === active;
          const body = (
            <>
              <span>{item.label}</span>
              {item.count !== undefined ? (
                <span className={cx("pr-2 text-[12px] font-normal", "text-dim")}>
                  {item.count}
                </span>
              ) : null}
            </>
          );
          const row = cx(
            // The 2 px bar overlaps the 1 px rail; labels start 14 px in, under the heading.
            "-ml-px flex h-[30px] items-center justify-between gap-3 border-l-2 pl-3 text-[13px]",
            isActive ? "border-accent font-medium text-ink" : "border-transparent",
          );
          return (
            <li key={item.id}>
              {item.pending ? (
                // No destination yet: a disabled link, out of the tab order, with its reason spoken.
                <a role="link" aria-disabled="true" className={cx(row, "cursor-default text-faint")}>
                  {body}
                  <span className="sr-only"> (not written yet)</span>
                </a>
              ) : (
                <a
                  href={`#${item.id}`}
                  aria-current={isActive ? "location" : undefined}
                  className={cx(row, !isActive && "text-dim hover:text-ink", "focus-visible:-outline-offset-2")}
                >
                  {body}
                </a>
              )}
            </li>
          );
        })}
      </ul>
      {meta && (meta.trace || meta.text) ? (
        <div className="flex flex-col gap-1 pt-[18px] pl-[14px]">
          {meta.trace ? <p className="font-mono text-[10.5px] text-dim">{meta.trace}</p> : null}
          {meta.text ? <p className="text-[11px] leading-4 text-dim">{meta.text}</p> : null}
        </div>
      ) : null}
    </nav>
  );
}
