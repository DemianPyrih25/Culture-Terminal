import { cx } from "../ui/cx";
import { NO_DATA, distance, times } from "./format";
import { NoDataMark, PlotEmpty, PlotFigure, PlotTagView, tagText } from "./parts";
import type { PlotBaseProps, PlotTable, PlotTag } from "./types";

/**
 * C/MiniBar columns (N08 "What this area has more and less of"): a "More here" column (green) and a
 * "Less here" column (red), each row a name 13/500 ink + value 13/500 ink-2 + optional tag over an
 * 8 px sunken track (240 wide). Lengths are log2 distances from the baseline, on one scale for both
 * columns, so 0.5× and 2× draw alike.
 */

export interface MiniBarRow {
  key?: string;
  label: string;
  /** The ratio vs the baseline; null reads "No data". */
  value: number | null;
  /** Printed value; defaults to "2.4×". */
  display?: string;
  tag?: PlotTag | null;
}

export interface MiniBarColumn {
  key?: string;
  /** "More here". */
  label: string;
  tone: "accent" | "second";
  rows: readonly MiniBarRow[];
}

export interface MiniBarColumnsProps extends PlotBaseProps {
  columns: readonly MiniBarColumn[];
  /** The ratio a bar grows from (default 1); null draws plain values from zero. */
  baseline?: number | null;
}

export function miniBarDisplay(row: MiniBarRow): string {
  if (row.value === null) return NO_DATA;
  return row.display ?? times(row.value);
}

function length(row: MiniBarRow, baseline: number | null): number {
  if (baseline === null) return row.value !== null && row.value > 0 ? row.value : 0;
  return distance(row.value, baseline) ?? 0;
}

/** Each row's bar share, column by column, on one scale. */
export function miniBarShares(columns: readonly MiniBarColumn[], baseline: number | null = 1): number[][] {
  const top = Math.max(0, ...columns.flatMap((c) => c.rows.map((r) => length(r, baseline))));
  return columns.map((c) => c.rows.map((r) => (top > 0 ? length(r, baseline) / top : 0)));
}

export function MiniBarColumns({ columns, baseline = 1, label, emptyLabel, className }: MiniBarColumnsProps) {
  if (columns.every((c) => c.rows.length === 0)) return <PlotEmpty label={emptyLabel} className={className} />;
  const shares = miniBarShares(columns, baseline);
  return (
    <PlotFigure label={label} plot="mini-bars" className={className}>
      <div className="grid gap-x-12 gap-y-6 md:grid-cols-2">
        {columns.map((col, c) => (
          <div key={col.key ?? col.label} data-column={col.key ?? col.label} className="flex min-w-0 flex-col gap-3">
            <span className="inline-flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-ink-2">
              <span aria-hidden="true" className={cx("size-2 rounded-full", col.tone === "accent" ? "bg-good" : "bg-danger")} />
              {col.label}
            </span>
            {col.rows.length === 0 ? (
              <NoDataMark className="self-start" />
            ) : (
              <ul className="flex flex-col gap-2">
                {col.rows.map((row, r) => (
                  <li key={row.key ?? row.label} data-row={row.key ?? row.label} className="flex flex-col gap-1">
                    <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 type-label">
                      <span className="text-ink">{row.label}</span>
                      {row.value === null ? null : <span className="font-mono text-ink-2 tabular-nums">{miniBarDisplay(row)}</span>}
                      <PlotTagView tag={row.tag} className="ml-1.5" />
                    </span>
                    {row.value === null ? (
                      <NoDataMark className="self-start" />
                    ) : (
                      <span className="relative h-2 w-full max-w-60 overflow-hidden rounded-xs bg-sunken">
                        <span
                          aria-hidden="true"
                          data-bar={col.tone}
                          className={cx("absolute inset-y-0 left-0 rounded-xs", col.tone === "accent" ? "bg-good" : "bg-danger")}
                          style={{ width: `${(shares[c]![r]! * 100).toFixed(2)}%` }}
                        />
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </PlotFigure>
  );
}

/** The Table view: Side | Name | Ratio | Note. */
export function miniBarTable(columns: readonly MiniBarColumn[]): PlotTable {
  const withNote = columns.some((c) => c.rows.some((r) => r.tag));
  return {
    columns: [{ label: "Name" }, { label: "Side" }, { label: "Ratio", numeric: true }, ...(withNote ? [{ label: "Note" }] : [])],
    rows: columns.flatMap((c) =>
      c.rows.map((r) => [r.label, c.label, miniBarDisplay(r), ...(withNote ? [tagText(r.tag)] : [])]),
    ),
  };
}
