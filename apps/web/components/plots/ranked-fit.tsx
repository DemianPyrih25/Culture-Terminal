import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { NO_DATA, share } from "./format";
import { NoDataMark, PlotEmpty, PlotFigure } from "./parts";
import type { PlotBaseProps, PlotTable } from "./types";

/**
 * C/RankedFitRow, stacked (N09 "Best fit for this corner", area_profile "Who climbs here vs citywide"):
 * rank 13/500 in a 16 px slot, name 15/600, a 160 × 12 track (the first row accent, the rest muted), the
 * value ("91/100") in a 48 px slot and a good-ink arrow-up when the row climbs. Below md the name takes
 * its own line (up to two lines, never cut to a few letters) over the track, value and arrow.
 */

export interface RankedFitRow {
  key?: string;
  label: string;
  /** Fit 0–100 (or any value on `max`); null reads "No data". */
  value: number | null;
  /** Printed value; defaults to "91/100". */
  display?: string;
  /** Fits better here than citywide: the arrow. */
  climbs?: boolean;
}

export interface RankedFitListProps extends PlotBaseProps {
  rows: readonly RankedFitRow[];
  /** The scale's top (default 100). */
  max?: number;
  /** The arrow's meaning, for the legend and screen readers (default "fits better here than citywide"). */
  climbLabel?: string;
}

export const CLIMB_LABEL = "fits better here than citywide";

export function fitDisplay(row: RankedFitRow, max = 100): string {
  if (row.value === null) return NO_DATA;
  return row.display ?? `${Math.round(row.value)}/${max}`;
}

/** The legend over the list: arrow-up good-ink + its meaning. */
export function ClimbLegend({ label = CLIMB_LABEL, className }: { label?: string; className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-1.5 type-label text-ink-2", className)}>
      <Icon name="arrow-up" size={14} className="text-good-ink" />
      {label}
    </span>
  );
}

export function RankedFitList({ rows, max = 100, climbLabel = CLIMB_LABEL, label, emptyLabel, className }: RankedFitListProps) {
  if (rows.length === 0) return <PlotEmpty label={emptyLabel} className={className} />;
  return (
    <PlotFigure label={label} plot="ranked-fit" className={className}>
      <ol className="flex flex-col">
        {rows.map((row, i) => (
          <li
            key={row.key ?? row.label}
            data-row={row.key ?? row.label}
            className="grid grid-cols-[16px_minmax(0,1fr)_48px_14px] items-center gap-x-3 gap-y-1 py-2 md:min-h-11 md:grid-cols-[16px_minmax(0,1fr)_160px_48px_14px] md:py-1"
          >
            <span className="type-label text-ink-2 tabular-nums">{i + 1}</span>
            <span className="col-span-3 min-w-0 text-[15px] leading-6 font-semibold text-ink [overflow-wrap:anywhere] md:col-span-1">
              {row.label}
            </span>
            {row.value === null ? (
              <NoDataMark className="col-start-2 justify-self-start md:col-start-auto" />
            ) : (
              <span className="relative col-start-2 h-3 w-full overflow-hidden bg-sunken md:col-start-auto">
                <span
                  aria-hidden="true"
                  data-bar={i === 0 ? "accent" : "muted"}
                  className={cx("absolute inset-y-0 left-0 rounded-r-xs", i === 0 ? "bg-accent" : "bg-chart-muted")}
                  style={{ width: `${(share(row.value, max) * 100).toFixed(2)}%` }}
                />
              </span>
            )}
            <span className="type-label text-ink-2 tabular-nums">{row.value === null ? "" : fitDisplay(row, max)}</span>
            {row.climbs ? (
              <span data-climbs="true" className="inline-flex">
                <Icon name="arrow-up" size={14} className="text-good-ink" />
                <span className="sr-only">{climbLabel}</span>
              </span>
            ) : (
              <span />
            )}
          </li>
        ))}
      </ol>
    </PlotFigure>
  );
}

/** The Table view: # | Name | Fit | Climbs. */
export function rankedFitTable(rows: readonly RankedFitRow[], heads: { label?: string; value?: string; max?: number } = {}): PlotTable {
  const withClimb = rows.some((r) => r.climbs);
  return {
    columns: [
      { label: heads.label ?? "Tenant" },
      { label: "Rank", numeric: true },
      { label: heads.value ?? "Fit", numeric: true },
      ...(withClimb ? [{ label: "Better here than citywide" }] : []),
    ],
    rows: rows.map((r, i) => [r.label, String(i + 1), fitDisplay(r, heads.max), ...(withClimb ? [r.climbs ? "Yes" : "No"] : [])]),
  };
}
