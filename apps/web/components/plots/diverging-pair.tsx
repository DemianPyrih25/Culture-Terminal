import { cx } from "../ui/cx";
import { NO_DATA, distance, times } from "./format";
import { NoDataMark, PlotEmpty, PlotFigure } from "./parts";
import type { PlotBaseProps, PlotTable } from "./types";

/**
 * DivergingPair (N09 tenant_mix, area_profile: "What this area has more and less of"). One row per group:
 * a 112 px group label (13/600 ink-2), then the "less" side (label, value, second bar up to the zero line)
 * and the "more" side (accent bar, value, label). Bars are lengths on a log2 scale around the baseline, so
 * 0.5× is as long as 2×. The "Less here | More here" key sits over the zero line. Phones stack each group.
 */

export interface PairSide {
  label: string;
  /** The ratio vs the baseline (1 = as common as the metro); null reads "No data". */
  value: number | null;
  /** Printed value; defaults to "0.6×". */
  display?: string;
}

export interface PairGroup {
  key?: string;
  /** "Who goes", "The vibe". */
  label: string;
  less: PairSide | null;
  more: PairSide | null;
}

export interface DivergingPairProps extends PlotBaseProps {
  groups: readonly PairGroup[];
  /** The key's words (default "Less here" / "More here"); null hides the key. */
  keyLabels?: { less: string; more: string } | null;
  /** The ratio at the zero line (default 1). */
  baseline?: number;
}

export const PAIR_KEY = { less: "Less here", more: "More here" } as const;

export function pairDisplay(side: PairSide | null): string {
  if (!side || side.value === null) return NO_DATA;
  return side.display ?? times(side.value);
}

/** Each side's bar length as a share of the longest bar. */
export function pairShares(groups: readonly PairGroup[], baseline = 1): { less: number; more: number }[] {
  const d = (s: PairSide | null) => (s ? (distance(s.value, baseline) ?? 0) : 0);
  const top = Math.max(0, ...groups.flatMap((g) => [d(g.less), d(g.more)]));
  return groups.map((g) => ({ less: top > 0 ? d(g.less) / top : 0, more: top > 0 ? d(g.more) / top : 0 }));
}

const BAR = "min(120px, 40%)";

function Bar({ tone, share }: { tone: "less" | "more"; share: number }) {
  return (
    <span
      aria-hidden="true"
      data-bar={tone}
      className={cx("h-3 shrink-0", tone === "less" ? "rounded-l-xs bg-second" : "rounded-r-xs bg-accent")}
      style={{ width: `calc(${BAR} * ${share.toFixed(4)})` }}
    />
  );
}

function KeyDot({ tone, children }: { tone: "less" | "more"; children: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 type-label text-ink-2">
      <span aria-hidden="true" className={cx("size-2 rounded-full", tone === "less" ? "bg-second" : "bg-accent")} />
      {children}
    </span>
  );
}

export function DivergingPair({ groups, keyLabels = PAIR_KEY, baseline = 1, label, emptyLabel, className }: DivergingPairProps) {
  if (groups.length === 0) return <PlotEmpty label={emptyLabel} className={className} />;
  const shares = pairShares(groups, baseline);
  return (
    <PlotFigure label={label} plot="pair" className={className}>
      {/* Desktop and tablet: one row per group around a shared zero line. */}
      <div className="relative hidden md:block">
        <span aria-hidden="true" className="absolute top-0 bottom-0 left-[calc(56px+50%)] w-px bg-ink-3" />
        {keyLabels ? (
          <div className="grid grid-cols-[112px_1fr_1fr] pb-3">
            <span />
            <span className="flex justify-end pr-3">
              <KeyDot tone="less">{keyLabels.less}</KeyDot>
            </span>
            <span className="pl-3">
              <KeyDot tone="more">{keyLabels.more}</KeyDot>
            </span>
          </div>
        ) : null}
        <ul className="flex flex-col">
          {groups.map((g, i) => (
            <li key={g.key ?? g.label} data-row={g.key ?? g.label} className="grid min-h-10 grid-cols-[112px_1fr_1fr] items-center py-1">
              <span className="text-[13px] leading-[18px] font-semibold text-ink-2">{g.label}</span>
              <span className="flex min-w-0 items-center justify-end gap-2">
                {g.less ? (
                  <>
                    <span className="min-w-0 text-right type-body text-ink [overflow-wrap:anywhere]">{g.less.label}</span>
                    {g.less.value === null ? (
                      <NoDataMark />
                    ) : (
                      <>
                        <span className="font-mono text-[12px] leading-[18px] text-ink-2 tabular-nums">{pairDisplay(g.less)}</span>
                        <Bar tone="less" share={shares[i]!.less} />
                      </>
                    )}
                  </>
                ) : null}
              </span>
              <span className="flex min-w-0 items-center gap-2">
                {g.more ? (
                  <>
                    {g.more.value === null ? (
                      <NoDataMark />
                    ) : (
                      <>
                        <Bar tone="more" share={shares[i]!.more} />
                        <span className="font-mono text-[12px] leading-[18px] text-ink-2 tabular-nums">{pairDisplay(g.more)}</span>
                      </>
                    )}
                    <span className="min-w-0 type-body text-ink [overflow-wrap:anywhere]">{g.more.label}</span>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {/* Phones: each group stacks its less and more side. */}
      <div className="flex flex-col gap-4 md:hidden">
        {keyLabels ? (
          <div className="flex gap-5">
            <KeyDot tone="less">{keyLabels.less}</KeyDot>
            <KeyDot tone="more">{keyLabels.more}</KeyDot>
          </div>
        ) : null}
        {groups.map((g, i) => (
          <div key={g.key ?? g.label} className="flex flex-col gap-1.5">
            <span className="text-[13px] leading-[18px] font-semibold text-ink-2">{g.label}</span>
            {(["more", "less"] as const).map((side) => {
              const s = g[side];
              if (!s) return null;
              return (
                <div key={side} className="flex flex-col gap-1">
                  <span className="flex items-baseline gap-1.5">
                    <span className="min-w-0 type-body text-ink [overflow-wrap:anywhere]">{s.label}</span>
                    <span className="font-mono text-[12px] leading-[18px] text-ink-2 tabular-nums">{pairDisplay(s)}</span>
                  </span>
                  <span className="relative h-2 w-full overflow-hidden rounded-xs bg-sunken">
                    <span
                      aria-hidden="true"
                      className={cx("absolute inset-y-0 left-0 rounded-xs", side === "less" ? "bg-second" : "bg-accent")}
                      style={{ width: `${(shares[i]![side] * 100).toFixed(2)}%` }}
                    />
                  </span>
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </PlotFigure>
  );
}

/** The Table view: Group | Less here | Ratio | More here | Ratio. */
export function divergingPairTable(groups: readonly PairGroup[], keyLabels: { less: string; more: string } = PAIR_KEY): PlotTable {
  return {
    columns: [
      { label: "Group" },
      { label: keyLabels.less },
      { label: "Ratio", numeric: true },
      { label: keyLabels.more },
      { label: "Ratio", numeric: true },
    ],
    rows: groups.map((g) => [g.label, g.less?.label ?? "", pairDisplay(g.less), g.more?.label ?? "", pairDisplay(g.more)]),
  };
}
