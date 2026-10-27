import Link from "next/link";
import { cx } from "../ui/cx";
import { Icon, type IconName } from "../ui/icons";
import { Monogram } from "../ui/monogram";
import { NO_DATA } from "./format";
import { PlotEmpty, PlotTagView, tagText } from "./parts";
import type { PlotBaseProps, PlotTable, PlotTag } from "./types";

/**
 * The ranked name lists. NumberedList (N10 "What else they love"): rank 13/500 ink-2, monogram 24, name 15,
 * an optional Hidden gem tag, in two columns read top to bottom. NeighbourColumns (N12, N14 "What else
 * their fans love"): one column per domain under an icon head (14 + 13/600 ink-2); items 52 tall with
 * rank, monogram 24, the name linking to its profile + arrow-up-right 12, and a tag under the name.
 * Four columns on desktop, 2 × 2 up to 1024, one on phones; an empty column says "No data".
 */

export interface NameItem {
  key?: string;
  name: string;
  href?: string | null;
  tag?: PlotTag | null;
}

function Name({ item, arrow }: { item: NameItem; arrow: boolean }) {
  const text = <span className="min-w-0 truncate type-body text-ink">{item.name}</span>;
  if (!item.href) return text;
  return (
    <Link href={item.href} className="inline-flex min-w-0 items-center gap-1 hover:underline">
      {text}
      {arrow ? <Icon name="arrow-up-right" size={12} className="shrink-0 text-ink-2" /> : null}
    </Link>
  );
}

export interface NumberedListProps extends PlotBaseProps {
  items: readonly NameItem[];
  /** Columns on desktop (default 2); phones always show one. */
  columns?: 1 | 2;
}

export function NumberedList({ items, columns = 2, label, emptyLabel, className }: NumberedListProps) {
  if (items.length === 0) return <PlotEmpty label={emptyLabel} className={className} />;
  const perColumn = Math.ceil(items.length / columns);
  return (
    <ol
      aria-label={label}
      data-plot="numbered"
      className={cx(
        "grid gap-x-12",
        columns === 2 && "md:grid-flow-col md:grid-cols-2 md:[grid-template-rows:repeat(var(--rows),auto)]",
        className,
      )}
      style={{ ["--rows" as string]: String(perColumn) }}
    >
      {items.map((item, i) => (
        <li
          key={item.key ?? item.name}
          data-row={item.key ?? item.name}
          className="flex h-10 min-w-0 items-center gap-3"
        >
          <span className="w-4 shrink-0 type-label text-ink-2 tabular-nums">{i + 1}</span>
          <Monogram name={item.name} size={24} />
          <Name item={item} arrow={false} />
          <PlotTagView tag={item.tag} className="ml-1" />
        </li>
      ))}
    </ol>
  );
}

/** The Table view of a NumberedList: Rank | Name | Note. */
export function numberedListTable(items: readonly NameItem[], heads: { name?: string } = {}): PlotTable {
  const withNote = items.some((i) => i.tag);
  return {
    columns: [{ label: heads.name ?? "Name" }, { label: "Rank", numeric: true }, ...(withNote ? [{ label: "Note" }] : [])],
    rows: items.map((item, i) => [item.name, String(i + 1), ...(withNote ? [tagText(item.tag)] : [])]),
  };
}

export interface NeighbourColumn {
  key?: string;
  /** "Music", "Podcasts". */
  label: string;
  icon: IconName;
  items: readonly NameItem[];
}

/** The domain heads the design uses. */
export const NEIGHBOUR_DOMAINS = {
  music: { label: "Music", icon: "music" },
  podcasts: { label: "Podcasts", icon: "mic" },
  tv: { label: "TV", icon: "tv" },
  brands: { label: "Brands", icon: "shopping-bag" },
} as const satisfies Record<string, { label: string; icon: IconName }>;

export interface NeighbourColumnsProps extends PlotBaseProps {
  columns: readonly NeighbourColumn[];
}

export function NeighbourColumns({ columns, label, emptyLabel, className }: NeighbourColumnsProps) {
  if (columns.length === 0 || columns.every((c) => c.items.length === 0)) return <PlotEmpty label={emptyLabel} className={className} />;
  return (
    <div
      role="group"
      aria-label={label}
      data-plot="neighbours"
      className={cx("grid gap-x-6 gap-y-6 sm:grid-cols-2 lg:grid-cols-4", className)}
    >
      {columns.map((col) => (
        <section key={col.key ?? col.label} data-column={col.key ?? col.label} className="flex min-w-0 flex-col gap-1">
          <h3 className="m-0 flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-ink-2">
            <Icon name={col.icon} size={14} />
            {col.label}
          </h3>
          {col.items.length === 0 ? (
            <p className="py-2 type-body text-ink-2">{NO_DATA}</p>
          ) : (
            <ol className="flex flex-col">
              {col.items.map((item, i) => (
                <li key={item.key ?? item.name} data-row={item.key ?? item.name} className="flex min-h-[52px] items-start gap-3 py-1.5">
                  <span className="w-3 shrink-0 pt-0.5 type-label text-ink-2 tabular-nums">{i + 1}</span>
                  <Monogram name={item.name} size={24} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <Name item={item} arrow />
                    <PlotTagView tag={item.tag} />
                  </span>
                </li>
              ))}
            </ol>
          )}
        </section>
      ))}
    </div>
  );
}

/** The Table view: Domain | Rank | Name | Note. */
export function neighbourTable(columns: readonly NeighbourColumn[]): PlotTable {
  const withNote = columns.some((c) => c.items.some((i) => i.tag));
  return {
    columns: [{ label: "Name" }, { label: "Domain" }, { label: "Rank", numeric: true }, ...(withNote ? [{ label: "Note" }] : [])],
    rows: columns.flatMap((c) =>
      c.items.length === 0
        ? [[NO_DATA, c.label, "", ...(withNote ? [""] : [])]]
        : c.items.map((item, i) => [item.name, c.label, String(i + 1), ...(withNote ? [tagText(item.tag)] : [])]),
    ),
  };
}
