import { NO_DATA, signed } from "./format";
import { NoDataMark, PlotEmpty, PlotFigure } from "./parts";
import type { PlotBaseProps, PlotTable } from "./types";

/**
 * C/DivergingRow, stacked (N12 and N14 "Who the fans are"). A 1 px ink-3 zero line at the centre; more
 * than average is a green (good) bar to the right, less a red (danger) bar to the left. The value sits outside the
 * bar's end (8 px gap), signed with U+2212; the label sits on the other side of zero, 12 px from the line.
 * Scale: px per unit = (half-width − 60) / max(0.48, max |v|).
 */

export interface DivergingRow {
  key?: string;
  /** "Women", "18–24". */
  label: string;
  /** The index vs the average audience; null reads "No data". */
  value: number | null;
  /** Printed value; defaults to the signed value with two digits ("+0.31", "−0.18"). */
  display?: string;
}

export interface DivergingRowsProps extends PlotBaseProps {
  rows: readonly DivergingRow[];
  /** The direction header; null hides it. */
  directions?: { less: string; more: string } | null;
  /** The smallest scale top, so small values stay small (default 0.48). */
  minDomain?: number;
}

export const DIVERGING_DIRECTIONS = { less: "Less than average", more: "More than average" } as const;

export function divergingDisplay(row: DivergingRow): string {
  if (row.value === null) return NO_DATA;
  return row.display ?? signed(row.value);
}

/** Each row's bar length as a share of the half-width left for bars. */
export function divergingShares(rows: readonly DivergingRow[], minDomain = 0.48): number[] {
  const top = Math.max(minDomain, ...rows.map((r) => Math.abs(r.value ?? 0)));
  return rows.map((r) => (r.value === null ? 0 : Math.min(1, Math.abs(r.value) / top)));
}

export function DivergingRows({
  rows,
  label,
  directions = DIVERGING_DIRECTIONS,
  minDomain = 0.48,
  emptyLabel,
  className,
}: DivergingRowsProps) {
  if (rows.length === 0) return <PlotEmpty label={emptyLabel} className={className} />;
  const shares = divergingShares(rows, minDomain);
  return (
    <PlotFigure label={label} plot="diverging" className={className}>
      <div className="relative">
        <span aria-hidden="true" className="absolute top-0 bottom-0 left-1/2 w-px -translate-x-1/2 bg-ink-3" />
        {directions ? (
          <div className="grid grid-cols-2 pb-1 type-caption text-ink-2">
            <span className="pr-3 text-right">{directions.less}</span>
            <span className="pl-3">{directions.more}</span>
          </div>
        ) : null}
        <ul className="flex flex-col">
          {rows.map((row, i) => {
            const v = row.value;
            const text = divergingDisplay(row);
            const width = `calc((100% - 60px) * ${shares[i]!.toFixed(4)})`;
            const less = v !== null && v < 0;
            return (
              <li
                key={row.key ?? row.label}
                data-row={row.key ?? row.label}
                data-side={v === null ? "none" : less ? "less" : "more"}
                className="grid min-h-9 grid-cols-2 items-center py-1"
              >
                <span className="flex min-w-0 items-center justify-end gap-2">
                  {less ? (
                    <>
                      <span className="font-mono text-[12px] leading-[18px] font-medium text-danger tabular-nums">{text}</span>
                      <span aria-hidden="true" data-bar="less" className="h-3 shrink-0 rounded-l-xs bg-danger" style={{ width }} />
                    </>
                  ) : v === null ? (
                    <NoDataMark className="mr-3" />
                  ) : (
                    <span className="min-w-0 pr-3 text-right type-body text-ink [overflow-wrap:anywhere]">{row.label}</span>
                  )}
                </span>
                <span className="flex min-w-0 items-center gap-2">
                  {v !== null && !less ? (
                    <>
                      <span aria-hidden="true" data-bar="more" className="h-3 shrink-0 rounded-r-xs bg-good" style={{ width }} />
                      <span className="font-mono text-[12px] leading-[18px] font-medium text-good tabular-nums">{text}</span>
                    </>
                  ) : (
                    <span className="min-w-0 pl-3 type-body text-ink [overflow-wrap:anywhere]">{row.label}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </PlotFigure>
  );
}

/** The Table view: Group | {valueHead}. */
export function divergingTable(rows: readonly DivergingRow[], heads: { label?: string; value?: string } = {}): PlotTable {
  return {
    columns: [{ label: heads.label ?? "Group" }, { label: heads.value ?? "vs average audience", numeric: true }],
    rows: rows.map((r) => [r.label, divergingDisplay(r)]),
  };
}
