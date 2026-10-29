import { cx } from "../ui/cx";
import { NO_DATA, share } from "./format";
import { NoDataMark, PlotEmpty, PlotFigure, PlotTagView, tagText } from "./parts";
import type { PlotBaseProps, PlotTable, PlotTag } from "./types";

/**
 * C/BarRow, stacked into a list (N05 "Closest audiences", N14 "Places their fans travel to"). Desktop:
 * a 200 px label column (name 15 ink, sublabel 12 ink-2), a 12 px sunken track with the bar from zero,
 * and the value (13/500 ink-2 on a surface wrap) right after the bar's end, then an optional tag.
 * Phones: a 136 px label column and the value in its own column at the right; the legend carries the tag.
 */

export interface BarListRow {
  /** Stable key; defaults to the label. */
  key?: string;
  label: string;
  sublabel?: string | null;
  /** The bar's length on the list's scale; null draws "No data". */
  value: number | null;
  /** The value as printed: "0.84", "#2", "1.42×". */
  display: string;
  /** accent for the subject or the point of the chart, muted (default) for the rest. */
  tone?: "accent" | "muted";
  tag?: PlotTag | null;
}

export interface BarListProps extends PlotBaseProps {
  rows: readonly BarListRow[];
  /** The scale's top; defaults to the largest value. */
  max?: number;
}

/** Room kept at the end of the track for the value (and the tag) on desktop. */
function reserve(rows: readonly BarListRow[]): number {
  return rows.some((r) => r.tag) ? 200 : 64;
}

export function BarList({ rows, max, label, emptyLabel, className }: BarListProps) {
  if (rows.length === 0) return <PlotEmpty label={emptyLabel} className={className} />;
  const top = max ?? Math.max(0, ...rows.map((r) => r.value ?? 0));
  const room = reserve(rows);
  return (
    <PlotFigure label={label} plot="bars" className={className}>
      <ul className="flex flex-col gap-2">
        {rows.map((row) => {
          const f = share(row.value, top);
          const accent = row.tone === "accent";
          return (
            <li
              key={row.key ?? row.label}
              data-row={row.key ?? row.label}
              data-tone={accent ? "accent" : "muted"}
              className="grid min-h-9 grid-cols-[136px_minmax(0,1fr)_40px] items-center gap-x-3 md:grid-cols-[200px_minmax(0,1fr)] md:gap-x-0"
            >
              <span className="flex min-w-0 flex-col">
                {/* Long names wrap; a card never cuts a name with an ellipsis (ANSWER_QUALITY §11). */}
                <span className="type-body text-ink [overflow-wrap:anywhere] max-md:text-[14px] max-md:leading-5">{row.label}</span>
                {row.sublabel ? <span className="type-caption text-ink-2 [overflow-wrap:anywhere]">{row.sublabel}</span> : null}
              </span>
              <span className="relative flex h-6 min-w-0 items-center">
                <span aria-hidden="true" className="absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 rounded-r-xs bg-sunken" />
                {row.value === null ? (
                  <NoDataMark className="relative" />
                ) : (
                  <>
                    <span
                      aria-hidden="true"
                      data-bar="true"
                      className={cx(
                        "relative h-3 w-[calc(100%*var(--f))] shrink-0 rounded-r-xs md:w-[calc((100%-var(--room))*var(--f))]",
                        accent ? "bg-accent" : "bg-chart-muted",
                      )}
                      style={{ ["--f" as string]: f.toFixed(4), ["--room" as string]: `${room}px` }}
                    />
                    <span className="relative hidden shrink-0 items-center gap-1.5 bg-surface pr-1.5 md:flex">
                      <span className="pl-1.5 type-label text-ink-2 tabular-nums">{row.display}</span>
                      <PlotTagView tag={row.tag} />
                    </span>
                  </>
                )}
              </span>
              <span className="text-right type-label text-ink-2 tabular-nums md:hidden">{row.value === null ? "" : row.display}</span>
            </li>
          );
        })}
      </ul>
    </PlotFigure>
  );
}

/** The Table view of a BarList: name, the sublabel column when any row has one, the value and the note. */
export function barListTable(
  rows: readonly BarListRow[],
  heads: { label: string; sublabel?: string; value: string; note?: string },
): PlotTable {
  const withSub = heads.sublabel !== undefined && rows.some((r) => r.sublabel);
  const withNote = rows.some((r) => r.tag);
  return {
    columns: [
      { label: heads.label },
      ...(withSub ? [{ label: heads.sublabel! }] : []),
      { label: heads.value, numeric: true },
      ...(withNote ? [{ label: heads.note ?? "Note" }] : []),
    ],
    rows: rows.map((r) => [
      r.label,
      ...(withSub ? [r.sublabel ?? ""] : []),
      r.value === null ? NO_DATA : r.display,
      ...(withNote ? [tagText(r.tag)] : []),
    ]),
  };
}

/** For tests and thumbnails: each row's bar share of the scale. */
export function barShares(rows: readonly BarListRow[], max?: number): number[] {
  const top = max ?? Math.max(0, ...rows.map((r) => r.value ?? 0));
  return rows.map((r) => share(r.value, top));
}
