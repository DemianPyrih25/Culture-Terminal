"use client";

import { useState, type ReactNode } from "react";
import { cx } from "../ui/cx";
import { CHROME_HEIGHT, GRID_COLUMNS_MD, GRID_COLUMNS_XL } from "./grid";

/** The two views of a brief below 768 px (PLAN §8.6). */
export type BriefTab = "report" | "sources";

const TABS: ReadonlyArray<{ id: BriefTab; label: string }> = [
  { id: "report", label: "Report" },
  { id: "sources", label: "Sources" },
];

export interface BriefGridProps {
  /** The outline column, usually an <Outline>: sticky from 768 px up, hidden below. */
  outline?: ReactNode;
  /** BriefRow elements: the reading column with each row's sidenotes. */
  children: ReactNode;
  /**
   * px from the viewport top where the sticky outline rests (default 100: under the 56 px top bar and the
   * 44 px running head; 56 on a page without a running head). Below 768 px the top bar scrolls away, so
   * the Report | Sources switch sticks 56 px higher.
   */
  stickyTop?: number;
  /** The tab shown first below 768 px. */
  defaultTab?: BriefTab;
  className?: string;
}

/**
 * The brief page grid. At 1440: margin 70 · outline 200 · gutter 60 · reading 680 · gutter 60 · sidenotes
 * 300 · margin 70, the outline sticky. Below 1280 the sidenote column folds under the paragraphs it
 * annotates. Below 768 there is one column and a Report | Sources switch: Report shows the reading
 * column, Sources the sidenotes.
 */
export function BriefGrid({ outline, children, stickyTop = CHROME_HEIGHT, defaultTab = "report", className }: BriefGridProps) {
  const [tab, setTab] = useState<BriefTab>(defaultTab);
  return (
    <div
      data-tab={tab}
      className={cx("group/brief w-full px-4 md:grid md:px-0", GRID_COLUMNS_MD, "xl:grid", GRID_COLUMNS_XL, className)}
    >
      <div
        role="group"
        aria-label="Brief view"
        className="sticky z-10 -mx-4 mb-6 flex gap-6 border-b border-line bg-paper px-4 md:hidden"
        style={{ top: Math.max(0, stickyTop - 56) }}
      >
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            aria-pressed={tab === t.id}
            onClick={() => setTab(t.id)}
            className={cx(
              "-mb-px flex h-10 items-center border-b-2 text-[13px] font-medium",
              tab === t.id ? "border-accent text-ink" : "border-transparent text-text-2",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {outline ? (
        <div className="hidden md:col-start-2 md:row-start-1 md:block">
          <div className="sticky pt-[30px]" style={{ top: stickyTop }}>
            {outline}
          </div>
        </div>
      ) : null}
      <div className="min-w-0 md:col-start-4 md:row-start-1 xl:col-[4/span_3] xl:grid xl:grid-cols-subgrid xl:content-start">
        {children}
      </div>
    </div>
  );
}
