import type { PeerRank, PositionAxisRow, PositionPayload } from "@ct/contracts";
import { BADGE_LABEL } from "@/lib/brief/format";
import { NoSignal } from "./no-signal";
import { FigureFrame, figureLabel, type FigureMeta } from "./figure-frame";
import { FigureTable, type TableCell, type TableRow } from "./figure-table";
import { formatNumber, reasonLabel } from "./format";
import { px } from "./scale";

/**
 * PositionCard (kind Position: the Taste Position card, SPEC §5.4). Five axes in a fixed order,
 * each with what was measured, where the subject sits among its peers (k of n, drawn as a strip of
 * n slots with the subject's filled), its evidence badge, a note such as "nearest: …" and a link to
 * the exhibit behind it. There is no composite score (D14): the axes are never summed or averaged.
 * An axis without a value says why; momentum without signal shows the NO SIGNAL hatch.
 */

export interface PositionCardOptions {
  /** Where each axis's exhibit is, by dataset id, e.g. { D8: "#figure-3" }. An unknown id prints no link. */
  figureHrefs?: Readonly<Record<string, string>>;
  /** Tighter rows, for a narrow column. */
  compact?: boolean;
}

export type PositionCardProps = FigureMeta & PositionCardOptions & { data: PositionPayload };

/** Above this many peers the strip becomes a track with a marker. */
const MAX_SLOTS = 12;

export function PositionCard(props: PositionCardProps) {
  const label = figureLabel(props);
  const compact = props.compact ?? false;
  return (
    <FigureFrame
      meta={props}
      plot={<PositionRows data={props.data} label={label} hrefs={props.figureHrefs ?? {}} compact={compact} />}
      table={<FigureTable spec={positionTableSpec(props.data, label)} />}
      htmlPlot
    />
  );
}

/** "rank 2 of 7 among peers". */
function rankWords(rank: PeerRank): string {
  return `rank ${rank.rank} of ${rank.of} among peers`;
}

/** The peer strip: one slot per entity in the peer set, the subject's filled; 1 is on the left. */
export function PeerStrip({ rank }: { rank: PeerRank }) {
  if (rank.of > MAX_SLOTS) {
    const w = 96;
    const at = rank.of === 1 ? 0 : ((rank.rank - 1) / (rank.of - 1)) * (w - 8) + 4;
    return (
      <svg viewBox={`0 0 ${w} 10`} width={w} height={10} role="img" aria-label={rankWords(rank)} className="block shrink-0">
        <rect x={0} y={4.5} width={w} height={1} className="fill-line-strong" />
        <circle cx={px(at)} cy={5} r={3.5} className="fill-accent" />
      </svg>
    );
  }
  const step = 10;
  const w = rank.of * step;
  return (
    <svg viewBox={`0 0 ${w} 10`} width={w} height={10} role="img" aria-label={rankWords(rank)} className="block shrink-0" data-rank={rank.rank} data-of={rank.of}>
      {Array.from({ length: rank.of }, (_, i) =>
        i + 1 === rank.rank ? (
          <circle key={i} cx={i * step + 5} cy={5} r={3.75} className="fill-accent" data-subject="true" />
        ) : (
          <circle key={i} cx={i * step + 5} cy={5} r={2.5} className="fill-surface stroke-line-strong" />
        ),
      )}
    </svg>
  );
}

function BadgeWord({ badge }: { badge: PositionAxisRow["badge"] }) {
  return (
    <span
      className={`text-[12px] leading-4 font-medium whitespace-nowrap ${
        badge === "UNAVAILABLE" ? "text-ink-2 italic" : "text-ink-2"
      }`}
      data-badge={badge}
    >
      {BADGE_LABEL[badge]}
    </span>
  );
}

function PositionRows({
  data,
  label,
  hrefs,
  compact,
}: {
  data: PositionPayload;
  label: string;
  hrefs: Readonly<Record<string, string>>;
  compact: boolean;
}) {
  const head = "pb-1.5 text-[12px] leading-4 font-medium text-ink-2";
  return (
    <div className="pt-2 pb-1">
      <table className="w-full border-collapse font-sans" aria-label={label}>
        <thead>
          <tr className="border-b border-line-strong">
            <th scope="col" className={`${head} text-left`}>
              {data.subject.label}
            </th>
            <th scope="col" className={`${head} text-left`}>
              Position
            </th>
            {compact ? null : (
              <th scope="col" className={`${head} text-left`}>
                {`Among ${data.peerCount + 1}`}
              </th>
            )}
            <th scope="col" className={`${head} text-right`}>
              Evidence
            </th>
          </tr>
        </thead>
        <tbody>
          {data.axes.map((a) => {
            const href = a.datasetId ? hrefs[a.datasetId] : undefined;
            const missing = a.value === null;
            return (
              <tr key={a.axis} className="border-b border-line align-top" data-axis={a.axis} data-badge={a.badge}>
                <th scope="row" className="py-2 pr-3 text-left font-normal">
                  <span className="block text-[13px] leading-[18px] font-medium text-ink">{a.label}</span>
                  {a.note ? <span className="block type-caption text-ink-2">{a.note}</span> : null}
                </th>
                <td className="py-2 pr-3">
                  {missing ? (
                    a.axis === "momentum" && a.reason === "no_signal" ? (
                      <NoSignal label={a.display || "No signal"} className="pt-1 whitespace-nowrap" />
                    ) : (
                      <span className="block pt-0.5 text-[12.5px] text-ink-2 italic" data-missing="true">
                        {a.display || reasonLabel(a.reason)}
                      </span>
                    )
                  ) : (
                    <span
                      className={`block font-display font-medium whitespace-nowrap text-ink tabular-nums ${
                        compact ? "text-[15px] leading-[20px]" : "text-[18px] leading-[22px]"
                      }`}
                    >
                      {a.display}
                    </span>
                  )}
                  {compact && a.peerRank ? (
                    <span className="block pt-1.5">
                      <PeerStrip rank={a.peerRank} />
                    </span>
                  ) : null}
                </td>
                {compact ? null : (
                  <td className="py-2 pr-3">
                    {a.peerRank ? (
                      <span className="flex items-center gap-2 pt-1.5">
                        <PeerStrip rank={a.peerRank} />
                        {/* The words repeat only when the display says something else, e.g. "Rising". */}
                        {a.display.trim() === `${a.peerRank.rank} of ${a.peerRank.of}` ? null : (
                          <span className="text-[12px] text-ink-2 tabular-nums">{`${a.peerRank.rank} of ${a.peerRank.of}`}</span>
                        )}
                      </span>
                    ) : (
                      <span className="block pt-1 text-[12px] text-ink-2">—</span>
                    )}
                  </td>
                )}
                <td className="py-2 text-right">
                  <span className="flex flex-col items-end gap-1 pt-1">
                    <BadgeWord badge={a.badge} />
                    {href ? (
                      <a href={href} className="text-[12px] text-ink-2 underline-offset-2 hover:text-accent hover:underline">
                        Figure →
                      </a>
                    ) : null}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** The table view: each axis with what is shown, the raw value or its reason, the peer rank, badge and note. */
export function positionTableSpec(data: PositionPayload, caption: string) {
  const rows: TableRow[] = data.axes.map((a) => {
    const value: TableCell =
      a.value === null ? { kind: "missing", reason: reasonLabel(a.reason) } : { kind: "value", text: formatNumber(a.value, "stat", { digits: Number.isInteger(a.value) ? 0 : 2 }) };
    return {
      key: a.axis,
      cells: [a.label, a.display, value, a.peerRank ? `${a.peerRank.rank} of ${a.peerRank.of}` : "—", BADGE_LABEL[a.badge], a.note ?? ""],
    };
  });
  return {
    caption: `${caption} · ${data.subject.label} among ${data.peerCount} peers`,
    columns: [
      { label: "Axis" },
      { label: "Shown" },
      { label: "Value", numeric: true },
      { label: "Peer rank", numeric: true },
      { label: "Badge" },
      { label: "Note" },
    ],
    rows,
  };
}
