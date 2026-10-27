import { cx } from "../ui/cx";
import { NO_DATA } from "./format";
import { PlotEmpty, PlotFigure, PlotTagView, tagText } from "./parts";
import type { PlotBaseProps, PlotTable, PlotTag } from "./types";

/**
 * C/RankTrack (N11 "Where it out-draws other comedians"): n dots of 10 px (at most 7), gap 14, the dot
 * at the rank filled accent and the rest rings, then "#k of n". RankTrackList stacks one per market:
 * city 15/600 + state 12 ink-2, the track, an optional tag.
 */

/** Dots drawn at most. */
export const RANK_TRACK_CAP = 7;

export function rankText(rank: number | null, of: number): string {
  return rank === null ? NO_DATA : `#${rank} of ${of}`;
}

export function RankTrack({ rank, of, className }: { rank: number | null; of: number; className?: string }) {
  const dots = Math.max(0, Math.min(of, RANK_TRACK_CAP));
  return (
    <span data-plot="rank-track" className={cx("inline-flex items-center gap-3.5", className)}>
      <span aria-hidden="true" className="inline-flex items-center gap-3.5">
        {Array.from({ length: dots }, (_, i) => (
          <span
            key={i}
            data-on={rank === i + 1 ? "true" : undefined}
            className={cx(
              "inline-block size-2.5 rounded-full",
              rank === i + 1 ? "bg-accent" : "border-[1.5px] border-line-strong",
            )}
          />
        ))}
      </span>
      <span className="type-label whitespace-nowrap text-ink-2 tabular-nums">{rankText(rank, of)}</span>
    </span>
  );
}

export interface RankTrackRow {
  key?: string;
  /** "Chattanooga". */
  label: string;
  /** "TN". */
  sublabel?: string | null;
  rank: number | null;
  of: number;
  tag?: PlotTag | null;
}

export interface RankTrackListProps extends PlotBaseProps {
  rows: readonly RankTrackRow[];
}

export function RankTrackList({ rows, label, emptyLabel, className }: RankTrackListProps) {
  if (rows.length === 0) return <PlotEmpty label={emptyLabel} className={className} />;
  return (
    <PlotFigure label={label} plot="rank-tracks" className={className}>
      <ul className="flex flex-col">
        {rows.map((row) => (
          <li
            key={row.key ?? row.label}
            data-row={row.key ?? row.label}
            className="grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 py-1 md:grid-cols-[minmax(0,192px)_auto_minmax(0,1fr)]"
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-[15px] leading-6 font-semibold text-ink">{row.label}</span>
              {row.sublabel ? <span className="type-caption text-ink-2">{row.sublabel}</span> : null}
            </span>
            <RankTrack rank={row.rank} of={row.of} />
            {row.tag ? <PlotTagView tag={row.tag} className="max-md:col-span-2 md:ml-3" /> : <span className="max-md:hidden" />}
          </li>
        ))}
      </ul>
    </PlotFigure>
  );
}

/** The Table view: Market | Rank | Note. */
export function rankTrackTable(rows: readonly RankTrackRow[], heads: { label?: string } = {}): PlotTable {
  const withNote = rows.some((r) => r.tag);
  return {
    columns: [{ label: heads.label ?? "Market" }, { label: "Rank", numeric: true }, ...(withNote ? [{ label: "Note" }] : [])],
    rows: rows.map((r) => [
      r.sublabel ? `${r.label}, ${r.sublabel}` : r.label,
      rankText(r.rank, r.of),
      ...(withNote ? [tagText(r.tag)] : []),
    ]),
  };
}
