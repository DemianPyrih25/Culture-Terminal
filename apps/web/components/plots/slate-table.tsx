import Link from "next/link";
import { cx } from "../ui/cx";
import { Icon, type IconName } from "../ui/icons";
import { Monogram } from "../ui/monogram";
import { NO_DATA, share } from "./format";
import { NoDataMark, PlotEmpty, PlotTagView, tagText } from "./parts";
import type { PlotBaseProps, PlotTable, PlotTag } from "./types";

/**
 * C/SlateRow table (N10 sponsorship "Best fit per category"): Category (icon 16 ink-2 + 15 ink), Best
 * fit (monogram 24 + name 15/600 + arrow-up-right link to its profile), Fit (accent bar on a 160 sunken
 * track + "#1 of 12" 13/500) and Note (a tag). Phones stack each row: category over best fit, bar below.
 */

export interface SlateRow {
  key?: string;
  /** "Beer", "Outdoor retail". */
  category: string;
  /** Defaults to categoryIcon(category). */
  icon?: IconName;
  /** The category's best fit; null when the category came back empty. */
  name: string | null;
  /** The best fit's profile page. */
  href?: string | null;
  /** Bar length, 0–1 of the track (the fit score on its scale); null reads "No data". */
  fit: number | null;
  /** "#1 of 12". */
  display: string;
  tag?: PlotTag | null;
}

export interface SlateTableProps extends PlotBaseProps {
  rows: readonly SlateRow[];
  /** Column heads (default Category | Best fit | Fit | Note). */
  heads?: { category: string; name: string; fit: string; note: string };
}

export const SLATE_HEADS = { category: "Category", name: "Best fit", fit: "Fit", note: "Note" } as const;

const CATEGORY_ICONS: readonly (readonly [RegExp, IconName])[] = [
  [/beer|brew|lager/i, "beer"],
  [/spirit|wine|whisk|liquor|vodka|tequila|bourbon|cocktail/i, "wine"],
  [/outdoor|camp|hik/i, "tent"],
  [/apparel|cloth|boot|shoe|fashion|wear/i, "shirt"],
  [/food|restaurant|dining|snack|bbq|grill|quick-service/i, "utensils"],
  [/seltzer|water|soda|drink|beverage/i, "glass-water"],
];

/** The icon of a sponsor category; anything unknown is a shopping bag. */
export function categoryIcon(category: string): IconName {
  return CATEGORY_ICONS.find(([re]) => re.test(category))?.[1] ?? "shopping-bag";
}

function BestFit({ row }: { row: SlateRow }) {
  if (row.name === null) return <span className="type-body text-ink-2">{NO_DATA}</span>;
  const name = <span className="min-w-0 text-[15px] leading-6 font-semibold text-ink [overflow-wrap:anywhere]">{row.name}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2.5">
      <Monogram name={row.name} size={24} />
      {row.href ? (
        <Link href={row.href} className="group inline-flex min-w-0 items-center gap-1 hover:underline">
          {name}
          <Icon name="arrow-up-right" size={12} className="shrink-0 text-ink" />
        </Link>
      ) : (
        name
      )}
    </span>
  );
}

function Fit({ row }: { row: SlateRow }) {
  if (row.fit === null) return <NoDataMark />;
  return (
    <span className="flex items-center gap-3">
      <span className="relative h-3 w-40 shrink-0 overflow-hidden rounded-r-xs bg-sunken max-md:w-full max-md:shrink">
        <span
          aria-hidden="true"
          data-bar="accent"
          className="absolute inset-y-0 left-0 rounded-r-xs bg-accent"
          style={{ width: `${(share(row.fit, 1) * 100).toFixed(2)}%` }}
        />
      </span>
      <span className="font-mono text-[12px] leading-[18px] whitespace-nowrap text-ink-2 tabular-nums">{row.display}</span>
    </span>
  );
}

export function SlateTable({ rows, heads = SLATE_HEADS, label, emptyLabel, className }: SlateTableProps) {
  if (rows.length === 0) return <PlotEmpty label={emptyLabel} className={className} />;
  return (
    <div data-plot="slate" className={cx("min-w-0", className)}>
      <table aria-label={label} className="hidden w-full border-collapse md:table">
        <thead>
          <tr className="h-8">
            {[heads.category, heads.name, heads.fit, heads.note].map((h) => (
              <th key={h} scope="col" className="text-left text-[12px] leading-4 font-semibold text-ink-2">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key ?? row.category} data-row={row.key ?? row.category} className="h-11">
              <th scope="row" className="w-[30%] text-left font-normal">
                <span className="flex items-center gap-2.5 type-body text-ink-2">
                  <Icon name={row.icon ?? categoryIcon(row.category)} size={16} className="shrink-0 text-ink-2" />
                  {row.category}
                </span>
              </th>
              <td className="w-[30%] pr-4">
                <BestFit row={row} />
              </td>
              <td className="w-[25%] pr-4">
                <Fit row={row} />
              </td>
              <td>
                <PlotTagView tag={row.tag} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <ul aria-label={label} className="flex flex-col divide-y divide-line md:hidden">
        {rows.map((row) => (
          <li key={row.key ?? row.category} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
            <span className="flex items-center justify-between gap-2">
              <span className="flex items-center gap-2 type-label text-ink-2">
                <Icon name={row.icon ?? categoryIcon(row.category)} size={14} className="shrink-0" />
                {row.category}
              </span>
              <PlotTagView tag={row.tag} />
            </span>
            <BestFit row={row} />
            <Fit row={row} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The Table view: Category | Best fit | Fit | Note. */
export function slateTable(rows: readonly SlateRow[], heads = SLATE_HEADS): PlotTable {
  const withNote = rows.some((r) => r.tag);
  return {
    columns: [{ label: heads.category }, { label: heads.name }, { label: heads.fit, numeric: true }, ...(withNote ? [{ label: heads.note }] : [])],
    rows: rows.map((r) => [
      r.category,
      r.name ?? NO_DATA,
      r.fit === null ? NO_DATA : r.display,
      ...(withNote ? [tagText(r.tag)] : []),
    ]),
  };
}
