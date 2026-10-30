import Link from "next/link";
import { cx } from "../ui/cx";
import { Icon, type IconName } from "../ui/icons";
import { PlotEmpty } from "./parts";
import type { PlotBaseProps, PlotTable } from "./types";

/**
 * The concept check (S12, launch_test): the AI's guesses for a new product checked against the data, in
 * groups. Kept and "found in the data" names read as picks (ink, a check or a search mark); dropped names
 * are muted and struck through with a ban mark, so a veto never reads as a recommendation; names that
 * could not be scored say so. Each row prints why in words ("0.04 above the bar"). Names wrap, never cut.
 */

/** category (R2, D48): measured against the concept's broader category only, so it carries no keep or veto. */
export type VerdictTone = "keep" | "add" | "veto" | "unscored" | "category";

export interface VerdictItem {
  key?: string;
  name: string;
  /** Why, in words: "0.04 above the bar", "#3 for the concept". */
  note: string;
  /** The name's profile page; never given for a dropped name. */
  href?: string | null;
}

export interface VerdictGroup {
  verdict: VerdictTone;
  title: string;
  items: readonly VerdictItem[];
}

export interface VerdictListProps extends PlotBaseProps {
  groups: readonly VerdictGroup[];
}

const MARK: Readonly<Record<VerdictTone, { icon: IconName; className: string }>> = {
  keep: { icon: "check", className: "text-good" },
  add: { icon: "search", className: "text-accent" },
  veto: { icon: "ban", className: "text-ink-2" },
  unscored: { icon: "circle-dashed", className: "text-ink-2" },
  category: { icon: "circle-dot", className: "text-ink-2" },
};

function Name({ item, verdict }: { item: VerdictItem; verdict: VerdictTone }) {
  const struck = verdict === "veto";
  const text = <span className={cx("type-body break-words", struck ? "text-ink-2 line-through decoration-ink-3" : "text-ink")}>{item.name}</span>;
  if (!item.href || struck) return text;
  return (
    <Link href={item.href} className="inline-flex min-w-0 items-center gap-1 hover:underline">
      {text}
      <Icon name="arrow-up-right" size={12} className="shrink-0 text-ink-2" />
    </Link>
  );
}

export function VerdictList({ groups, label, emptyLabel, className }: VerdictListProps) {
  if (groups.every((g) => g.items.length === 0)) return <PlotEmpty label={emptyLabel} className={className} />;
  return (
    <div role="group" aria-label={label} data-plot="verdicts" className={cx("grid gap-x-10 gap-y-6 md:grid-cols-2", className)}>
      {groups
        .filter((g) => g.items.length > 0)
        .map((g) => (
          <section key={g.verdict} data-verdict={g.verdict} aria-label={g.title} className="flex min-w-0 flex-col gap-2">
            <h3 className="inline-flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-ink-2">
              <Icon name={MARK[g.verdict].icon} size={14} className={MARK[g.verdict].className} />
              {g.title}
            </h3>
            <ul className="flex flex-col gap-1.5">
              {g.items.map((item) => (
                <li key={item.key ?? item.name} data-row={item.key ?? item.name} className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                  <Name item={item} verdict={g.verdict} />
                  <span className="type-label text-ink-2 tabular-nums">{item.note}</span>
                </li>
              ))}
            </ul>
          </section>
        ))}
    </div>
  );
}

/** The Table view of a VerdictList: Name | Verdict | Why. */
export function verdictListTable(groups: readonly VerdictGroup[]): PlotTable {
  return {
    columns: [{ label: "Name" }, { label: "Verdict" }, { label: "Why" }],
    rows: groups.flatMap((g) => g.items.map((i) => [i.name, g.title, i.note])),
  };
}
