"use client";

import { useId, useState, type ReactNode } from "react";
import { Button } from "./button";
import { Card } from "./card";
import { cx } from "./cx";
import { Segmented } from "./segmented";
import { Tag } from "./tag";

/** Legend and series colours. */
export type SeriesTone = "accent" | "second" | "muted" | "good" | "ink";

const SERIES_DOT: Readonly<Record<SeriesTone, string>> = {
  accent: "bg-accent",
  second: "bg-second",
  muted: "bg-chart-muted",
  good: "bg-good",
  ink: "bg-ink",
};

export interface LegendItem {
  label: string;
  tone: SeriesTone;
}

/** A chart legend: 8 px dots and 13/500 ink-2 labels, gap 20. */
export function Legend({ items, className }: { items: readonly LegendItem[]; className?: string }) {
  return (
    <ul className={cx("flex flex-wrap items-center gap-x-5 gap-y-1", className)}>
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5 type-label text-ink-2">
          <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", SERIES_DOT[item.tone])} />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

export interface ChartTableColumn {
  label: string;
  /** Right-aligned in an 80 px column, tabular figures. */
  numeric?: boolean;
}

export interface ChartTableProps {
  columns: readonly ChartTableColumn[];
  /** One cell per column; the first cell of a row is its header (th scope="row"). */
  rows: readonly (readonly ReactNode[])[];
  /** The table's accessible name (usually the chart title). */
  label: string;
  className?: string;
}

/**
 * The Table view of a chart: real table markup. Head 32 tall, 12/600 ink-2 over a line; rows 36 tall over
 * a line; numbers right-aligned in an 80 px column.
 */
export function ChartTable({ columns, rows, label, className }: ChartTableProps) {
  return (
    <table aria-label={label} className={cx("w-full border-collapse text-left tabular-nums", className)}>
      <thead>
        <tr className="h-8 border-b border-line">
          {columns.map((col) => (
            <th
              key={col.label}
              scope="col"
              className={cx(
                "text-[12px] leading-4 font-semibold text-ink-2",
                col.numeric ? "w-20 text-right" : "pr-4",
              )}
            >
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, r) => (
          <tr key={r} className="h-9 border-b border-line">
            {row.map((cell, c) => {
              const numeric = columns[c]?.numeric === true;
              const cls = cx("type-body text-ink", numeric ? "w-20 text-right" : "pr-4");
              return c === 0 ? (
                <th key={c} scope="row" className={cx(cls, "font-normal")}>
                  {cell}
                </th>
              ) : (
                <td key={c} className={cls}>
                  {cell}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export type ChartView = "chart" | "table";

export interface ChartCardProps {
  /** The fixed kind line, 13/500 ink-2: "Closest audiences". */
  kind: string;
  /** The chart's title (the exhibit title), 20/600. */
  title: ReactNode;
  /** The heading level of the title (default h3). */
  titleAs?: "h2" | "h3";
  /** Live runs: the Draft tag, and Source is disabled. */
  draft?: boolean;
  /** Legend items over the plot; hidden in the Table view. */
  legend?: readonly LegendItem[];
  /** The plot. */
  children: ReactNode;
  /** The Table view. With it, the "Chart | Table" switch shows. */
  table?: ReactNode;
  /** Controlled view (optional). */
  view?: ChartView;
  onViewChange?: (view: ChartView) => void;
  /** Opens the drawer on this figure. Without it no Source shows. */
  onSource?: () => void;
  /** The caption under the plot, 12 ink-2. */
  caption?: ReactNode;
  /** Kind and controls on one line, then the title (long titles; always on phones). */
  stacked?: boolean;
  className?: string;
}

/**
 * C/ChartCard: padding 24, gap 16. Header: kind and title on the left; Draft, the Chart | Table switch and
 * Source on the right. Then the legend, the plot (or its table) and the caption.
 */
export function ChartCard({
  kind,
  title,
  titleAs: TitleTag = "h3",
  draft,
  legend,
  children,
  table,
  view: controlledView,
  onViewChange,
  onSource,
  caption,
  stacked,
  className,
}: ChartCardProps) {
  const [ownView, setOwnView] = useState<ChartView>("chart");
  const view = controlledView ?? ownView;
  const setView = (next: ChartView) => {
    if (controlledView === undefined) setOwnView(next);
    onViewChange?.(next);
  };
  const titleId = useId();

  const controls = (
    <div className="flex shrink-0 flex-wrap items-center gap-3">
      {draft ? <Tag preset="draft" /> : null}
      {table !== undefined ? (
        <Segmented
          label="View"
          options={[
            { value: "chart", label: "Chart" },
            { value: "table", label: "Table" },
          ]}
          value={view}
          onChange={setView}
        />
      ) : null}
      {onSource || draft ? (
        <Button
          variant="quiet"
          size="sm"
          icon="receipt"
          disabled={draft}
          onClick={onSource}
          aria-label={typeof title === "string" ? `Source of ${title}` : "Source"}
        >
          Source
        </Button>
      ) : null}
    </div>
  );

  const kindLine = <p className="type-label text-ink-2">{kind}</p>;
  const titleEl = (
    <TitleTag id={titleId} className="type-title text-ink max-md:type-title-sm">
      {title}
    </TitleTag>
  );

  return (
    <Card aria-labelledby={titleId} className={cx("flex flex-col gap-4", className)}>
      {stacked ? (
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            {kindLine}
            <div className="max-md:hidden">{controls}</div>
          </div>
          {titleEl}
          <div className="mt-1.5 md:hidden">{controls}</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            {kindLine}
            {titleEl}
          </div>
          {controls}
        </div>
      )}
      {legend && legend.length > 0 && view === "chart" ? <Legend items={legend} /> : null}
      <div data-view={view}>{view === "table" && table !== undefined ? table : children}</div>
      {caption ? <p className="type-caption text-ink-2">{caption}</p> : null}
    </Card>
  );
}
