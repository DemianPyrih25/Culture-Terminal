import { cx } from "../ui/cx";
import { Monogram } from "../ui/monogram";
import { PlotEmpty } from "./parts";
import type { PlotBaseProps, PlotTable } from "./types";

/**
 * head_to_head (N07 "Who wins where"): the Scoreboard (a sunken panel with both names, monograms and the
 * score, the subject's count in accent and the second's in second) and WinnerTables (label + one 64 px
 * column per side; the winner a filled 12 px dot, the other a 1.5 px line-strong ring). Real tables, so
 * the winner reads in words too ("leads"). Below md the side names leave the panel (the monograms stay)
 * and screen readers read the score as one sentence.
 */

export interface Side {
  name: string;
}

export interface ScoreboardProps {
  a: Side & { score: number };
  b: Side & { score: number };
  /** Under the score: "cities where each ranks first". */
  caption: string;
  className?: string;
}

export function Scoreboard({ a, b, caption, className }: ScoreboardProps) {
  return (
    <div
      data-plot="scoreboard"
      className={cx("grid grid-cols-[1fr_auto_1fr] items-center gap-3 rounded-tile bg-sunken px-6 py-5 max-md:px-4", className)}
    >
      <span className="flex min-w-0 items-center gap-3">
        <Monogram name={a.name} size={48} palette="subject" className="max-md:size-8 max-md:rounded-sm max-md:text-[13.5px]" />
        <span className="truncate text-[15px] leading-6 font-semibold text-ink max-md:hidden">{a.name}</span>
      </span>
      <span className="flex flex-col items-center gap-1">
        <span className="sr-only">{`${a.name} ${a.score}, ${b.name} ${b.score}`}</span>
        <span aria-hidden="true" className="flex items-center gap-3 type-score max-md:text-[44px] max-md:leading-[44px]">
          <span className="text-accent tabular-nums">{a.score}</span>
          <span className="flex flex-col gap-2">
            <span className="size-2.5 rounded-full bg-ink-3" />
            <span className="size-2.5 rounded-full bg-ink-3" />
          </span>
          <span className="text-second tabular-nums">{b.score}</span>
        </span>
        <span className="text-center type-label text-ink-2">{caption}</span>
      </span>
      <span className="flex min-w-0 items-center justify-end gap-3">
        <span className="truncate text-right text-[15px] leading-6 font-semibold text-ink max-md:hidden">{b.name}</span>
        <Monogram name={b.name} size={48} palette="second" className="max-md:size-8 max-md:rounded-sm max-md:text-[13.5px]" />
      </span>
    </div>
  );
}

export interface WinnerRow {
  key?: string;
  label: string;
  /** Which side ranks first here; null when neither does (no data). */
  winner: "a" | "b" | null;
}

export interface WinnerTableProps extends PlotBaseProps {
  /** The group head: "Cities", "Age groups". */
  title: string;
  a: Side;
  b: Side;
  rows: readonly WinnerRow[];
}

function Mark({ won, tone }: { won: boolean; tone: "a" | "b" }) {
  return won ? (
    <span aria-hidden="true" className={cx("inline-block size-3 rounded-full", tone === "a" ? "bg-accent" : "bg-second")} />
  ) : (
    <span aria-hidden="true" className="inline-block size-3 rounded-full border-[1.5px] border-line-strong" />
  );
}

export function WinnerTable({ title, a, b, rows, label, emptyLabel, className }: WinnerTableProps) {
  if (rows.length === 0) return <PlotEmpty label={emptyLabel} className={className} />;
  return (
    <table aria-label={label} data-plot="winners" className={cx("w-full border-collapse", className)}>
      <thead>
        <tr className="h-7">
          <th scope="col" className="text-left text-[13px] leading-[18px] font-semibold text-ink-2">
            {title}
          </th>
          {[
            { side: a, palette: "subject" as const },
            { side: b, palette: "second" as const },
          ].map(({ side, palette }) => (
            <th key={palette} scope="col" className="w-16 text-center">
              <span className="sr-only">{side.name}</span>
              <Monogram name={side.name} size={20} palette={palette} />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key ?? row.label} data-row={row.key ?? row.label} className="h-7">
            <th scope="row" className="text-left type-body font-normal text-ink">
              {row.label}
            </th>
            {(["a", "b"] as const).map((side) => (
              <td key={side} className="w-16 text-center align-middle leading-none">
                <Mark won={row.winner === side} tone={side} />
                <span className="sr-only">{row.winner === side ? "leads" : row.winner === null ? "no data" : ""}</span>
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** The Table view of one WinnerTable: Group | Ranks first. */
export function winnerTable(title: string, a: Side, b: Side, rows: readonly WinnerRow[]): PlotTable {
  return {
    columns: [{ label: title }, { label: "Ranks first" }],
    rows: rows.map((r) => [r.label, r.winner === "a" ? a.name : r.winner === "b" ? b.name : "No data"]),
  };
}
