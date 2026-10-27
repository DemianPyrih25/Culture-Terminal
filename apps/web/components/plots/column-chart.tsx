import { Hatch } from "../ui/skeleton";
import { NO_DATA, share } from "./format";
import { PlotEmpty, PlotFigure } from "./parts";
import type { PlotBaseProps, PlotTable } from "./types";

/**
 * Column chart (interest over time): 40 px accent columns, gap 12, r 3 3 0 0, month labels 12 ink-2 under
 * them. A missing month is a hatched column; `after` adds the hatched "No data after Sep 2025" panel that
 * fills the rest of the width, so a window that ends early never reads as a drop to zero.
 */

export interface ColumnPoint {
  key?: string;
  /** "Apr". */
  label: string;
  value: number | null;
  /** The value as the table prints it; defaults to two digits. */
  display?: string;
}

export interface ColumnChartProps extends PlotBaseProps {
  points: readonly ColumnPoint[];
  /** The plot's height in px, labels excluded (default 232). */
  height?: number;
  /** The hatched panel after the last column, e.g. "No data after Sep 2025"; omitted: none. */
  after?: string | null;
}

export function columnDisplay(p: ColumnPoint): string {
  if (p.value === null) return NO_DATA;
  return p.display ?? p.value.toFixed(2);
}

export function ColumnChart({ points, height = 232, after, label, emptyLabel, className }: ColumnChartProps) {
  if (points.length === 0 || points.every((p) => p.value === null)) return <PlotEmpty label={emptyLabel} className={className} />;
  const top = Math.max(0, ...points.map((p) => p.value ?? 0));
  return (
    <PlotFigure label={label} plot="columns" className={className}>
      <div className="flex items-start gap-3">
        <div className="flex min-w-0 shrink gap-3 max-md:gap-2">
          {points.map((p) => (
            <div key={p.key ?? p.label} data-row={p.key ?? p.label} className="flex w-10 min-w-0 shrink flex-col items-center gap-2">
              <div className="flex w-full items-end" style={{ height }}>
                {p.value === null ? (
                  <Hatch label="" className="h-full min-h-0 rounded-t-xs rounded-b-none [&>span]:hidden" />
                ) : (
                  <span
                    aria-hidden="true"
                    data-bar="accent"
                    className="block w-full rounded-t-xs bg-accent"
                    style={{ height: `${(share(p.value, top) * 100).toFixed(2)}%` }}
                  />
                )}
              </div>
              <span className="type-caption text-ink-2">{p.label}</span>
            </div>
          ))}
        </div>
        {after ? (
          // The pill may wrap: on a phone the panel is narrow and must never push the page sideways.
          <div className="min-w-24 flex-1" style={{ height }}>
            <Hatch label={after} className="px-1.5 [&>span]:text-center [&>span]:whitespace-normal" />
          </div>
        ) : null}
      </div>
    </PlotFigure>
  );
}

/** The Table view: Month | value head. */
export function columnTable(points: readonly ColumnPoint[], heads: { label?: string; value?: string } = {}): PlotTable {
  return {
    columns: [{ label: heads.label ?? "Month" }, { label: heads.value ?? "Interest", numeric: true }],
    rows: points.map((p) => [p.label, columnDisplay(p)]),
  };
}
