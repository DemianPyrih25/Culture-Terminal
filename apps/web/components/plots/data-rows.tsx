import { cx } from "../ui/cx";
import { PlotEmpty } from "./parts";
import type { PlotBaseProps, PlotTable } from "./types";

/**
 * Figures that read best as a table (SEC financials by period, Census figures by area): a name column
 * with an optional sublabel ("10-K filed 2025-02-14"), then one right-aligned column per measure. A
 * comparison row (the whole city) sits under a rule in ink-2, so it reads as the yardstick, not a pick.
 * Names wrap, never cut; the table scrolls sideways inside its card on a narrow phone.
 */

export interface DataRow {
  key?: string;
  label: string;
  sublabel?: string | null;
  /** One printed cell per column ("$1.2B", "38.4%", "Withheld by the Census"). */
  cells: readonly string[];
  comparison?: boolean;
}

export interface DataRowsProps extends PlotBaseProps {
  columns: readonly { label: string }[];
  rows: readonly DataRow[];
}

export function DataRows({ columns, rows, label, emptyLabel, className }: DataRowsProps) {
  if (rows.length === 0) return <PlotEmpty label={emptyLabel} className={className} />;
  return (
    <div data-plot="rows" className={cx("min-w-0 overflow-x-auto", className)}>
      <table aria-label={label} className="w-full border-collapse text-left tabular-nums">
        <thead>
          <tr className="h-8 border-b border-line">
            <th scope="col" className="pr-4 text-[12px] leading-4 font-semibold text-ink-2">
              <span className="sr-only">Name</span>
            </th>
            {columns.map((c) => (
              <th key={c.label} scope="col" className="px-2 text-right text-[12px] leading-4 font-semibold text-ink-2">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr
              key={r.key ?? `${r.label}-${i}`}
              data-row={r.key ?? r.label}
              data-comparison={r.comparison ? "true" : undefined}
              className={cx("border-b border-line", r.comparison && "border-t-2 border-t-line-strong")}
            >
              <th scope="row" className="min-w-36 py-2 pr-4 text-left align-top font-normal">
                <span className={cx("block type-body break-words", r.comparison ? "text-ink-2" : "text-ink")}>{r.label}</span>
                {r.sublabel ? <span className="block type-caption break-words text-ink-2">{r.sublabel}</span> : null}
              </th>
              {r.cells.map((cell, c) => (
                <td key={c} className={cx("px-2 py-2 text-right align-top type-body whitespace-nowrap", r.comparison ? "text-ink-2" : "text-ink")}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The Table view of DataRows: the same rows, the sublabel in brackets after the name. */
export function dataRowsTable(columns: readonly { label: string }[], rows: readonly DataRow[]): PlotTable {
  return {
    columns: [{ label: "Name" }, ...columns.map((c) => ({ label: c.label, numeric: true }))],
    rows: rows.map((r) => [r.sublabel ? `${r.label} (${r.sublabel})` : r.label, ...r.cells]),
  };
}
