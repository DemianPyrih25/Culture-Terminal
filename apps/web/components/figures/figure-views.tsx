"use client";

import { useState, type ReactNode } from "react";

/**
 * The interactive part of a figure: the ⧉ toggle that swaps the plot for its table, and the ⓘ
 * link to the method. For an SVG plot the table is always in the markup, visually hidden while the
 * plot shows, so screen readers and the no-JavaScript page still have every value. A plot that is
 * already an HTML table (htmlPlot) keeps its table view hidden from everyone until toggled, so
 * nothing is read twice.
 */
export function FigureViews({
  plot,
  table,
  source,
  methodHref,
  label,
  note = null,
  htmlPlot = false,
  compact = false,
}: {
  plot: ReactNode;
  /** The accessible table; null when there is nothing to tabulate yet (no toggle then). */
  table: ReactNode | null;
  /** The source line, rendered left of the controls. */
  source: ReactNode;
  methodHref: string | null;
  /** The figure's plain-text name, so each toggle and method link is named after its figure. */
  label: string;
  /** A fixed caption printed under either view. */
  note?: string | null;
  htmlPlot?: boolean;
  compact?: boolean;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <>
      <div hidden={showTable} data-view="plot">
        {plot}
      </div>
      {table !== null ? (
        htmlPlot ? (
          <div hidden={!showTable} className="pt-2" data-view="table">
            {table}
          </div>
        ) : (
          <div className={showTable ? "pt-2" : "sr-only"} data-view="table">
            {table}
          </div>
        )
      ) : null}
      {note ? (
        <p className={`m-0 font-ui text-[11px] leading-[16px] text-dim ${compact ? "pt-1" : "pt-2"}`} data-fixed-caption="true">
          {note}
        </p>
      ) : null}
      <div className={`mt-auto flex flex-wrap items-center gap-x-2.5 gap-y-1 ${compact ? "pt-1.5" : "pt-2.5"}`}>
        {source}
        <div className="ml-auto flex items-center gap-3">
          {table !== null ? (
            <button
              type="button"
              aria-pressed={showTable}
              aria-label={`Table view: ${label}`}
              onClick={() => setShowTable((v) => !v)}
              className={`inline-flex items-center gap-1 rounded-brief font-ui text-[11px] hover:text-accent ${
                showTable ? "text-accent" : "text-dim"
              }`}
            >
              <TableGlyph />
              Table
            </button>
          ) : null}
          {methodHref ? (
            <a
              href={methodHref}
              aria-label={`Method: ${label}`}
              className="inline-flex items-center gap-1 rounded-brief font-ui text-[11px] text-dim hover:text-accent"
            >
              <InfoGlyph />
              Method
            </a>
          ) : null}
        </div>
      </div>
    </>
  );
}

/** ⧉: two overlapping squares, drawn so it renders the same without a symbol font. */
function TableGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true" className="fill-none stroke-current">
      <rect x="0.5" y="0.5" width="8" height="8" />
      <rect x="3.5" y="3.5" width="8" height="8" />
    </svg>
  );
}

/** ⓘ: a circled i. */
function InfoGlyph() {
  return (
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true">
      <circle cx="6" cy="6" r="5.5" className="fill-none stroke-current" />
      <circle cx="6" cy="3.6" r="0.8" className="fill-current" />
      <rect x="5.4" y="5.2" width="1.2" height="4" className="fill-current" />
    </svg>
  );
}
