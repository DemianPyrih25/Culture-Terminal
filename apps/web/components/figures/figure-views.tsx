"use client";

import { useState, type ReactNode } from "react";
import { Button } from "../ui/button";
import { Segmented } from "../ui/segmented";
import { Tag } from "../ui/tag";
import { ScrollRegion } from "./scroll-region";

/**
 * The interactive part of a figure: the header's "Chart | Table" switch and Source button, and the two
 * views. For an SVG plot the table is always in the markup, visually hidden while the chart shows, so
 * screen readers and the no-JavaScript page still have every value. A plot that is already an HTML table
 * (htmlPlot) keeps its table view hidden from everyone until switched, so nothing is read twice.
 */
export function FigureViews({
  heading,
  legend,
  plot,
  table,
  label,
  captions,
  footer,
  htmlPlot = false,
  draft = false,
  onSource,
}: {
  /** The kind line and title. */
  heading: ReactNode;
  legend: ReactNode | null;
  plot: ReactNode;
  /** The accessible table; null when there is nothing to tabulate (no switch then). */
  table: ReactNode | null;
  /** The figure's plain-text name, so each switch and Source button is named after its figure. */
  label: string;
  captions: ReactNode;
  footer: ReactNode;
  htmlPlot?: boolean;
  draft?: boolean;
  onSource?: () => void;
}) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const showTable = view === "table";
  const controls =
    table !== null || draft || onSource ? (
      <div className="flex shrink-0 flex-wrap items-center gap-3">
        {draft ? <Tag preset="draft" /> : null}
        {table !== null ? (
          <Segmented
            label={`View: ${label}`}
            options={[
              { value: "chart", label: "Chart" },
              { value: "table", label: "Table" },
            ]}
            value={view}
            onChange={setView}
          />
        ) : null}
        {onSource || draft ? (
          <Button variant="quiet" size="sm" icon="receipt" disabled={draft} onClick={onSource} aria-label={`Source: ${label}`}>
            Source
          </Button>
        ) : null}
      </div>
    ) : null;
  return (
    <>
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        {heading}
        {controls}
      </div>
      {legend && !showTable ? <div>{legend}</div> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        {/* A plot drawn at its natural width scrolls on a narrow screen instead of shrinking its text. */}
        <ScrollRegion hidden={showTable} view="plot" label={label}>
          {plot}
        </ScrollRegion>
        {table !== null ? (
          htmlPlot || showTable ? (
            <ScrollRegion hidden={!showTable} view="table" label={`Table: ${label}`}>
              {table}
            </ScrollRegion>
          ) : (
            // Visually hidden, never a scroll box: screen readers read it whole.
            <div className="sr-only" data-view="table">
              {table}
            </div>
          )
        ) : null}
      </div>
      {captions}
      {footer}
    </>
  );
}
