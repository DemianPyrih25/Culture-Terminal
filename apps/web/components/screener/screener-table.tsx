"use client";

import type { ScreenerColumn, ScreenerColumnMeta, ScreenerRow } from "@ct/contracts";
import Link from "next/link";
import { ScrollRegion } from "../figures/scroll-region";
import { methodHref } from "../figures/figure-frame";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { Tag } from "../ui/tag";
import { cellText, COLUMN_HINT, sortRows, type SortKey, type SortState } from "./model";

/**
 * The screen as a sortable table (RankedTable's table look, PLAN §8.3): rank, brand, then the six
 * columns. Every head sorts (aria-sort); every cell is a button that opens the requests behind it, an
 * empty one with its reason in words, never a 0. Wide on a phone, so it scrolls sideways.
 */

export interface ScreenerTableProps {
  caption: string;
  columns: readonly ScreenerColumnMeta[];
  rows: readonly ScreenerRow[];
  sort: SortState;
  onSort: (key: SortKey) => void;
  /** A cell was opened. */
  onCell: (rowKey: string, column: ScreenerColumn) => void;
  /** The cell open in the drawer, highlighted. */
  selected: { rowKey: string; column: ScreenerColumn } | null;
}

function ariaSort(sort: SortState, key: SortKey): "ascending" | "descending" | "none" {
  return sort.key !== key ? "none" : sort.dir === "asc" ? "ascending" : "descending";
}

function SortHead({ label, sortKey, sort, onSort, numeric, hint, formulaId }: { label: string; sortKey: SortKey; sort: SortState; onSort: (key: SortKey) => void; numeric?: boolean; hint?: string; formulaId?: string }) {
  const active = sort.key === sortKey;
  return (
    <th scope="col" aria-sort={ariaSort(sort, sortKey)} className={cx("px-2 py-2 align-bottom first:pl-0 last:pr-0", numeric ? "text-right" : "text-left")}>
      <span className={cx("inline-flex items-center gap-1", numeric && "flex-row-reverse")}>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          title={hint}
          className={cx(
            "inline-flex items-center gap-1 rounded-sm text-[12px] leading-4 font-semibold whitespace-nowrap hover:text-ink",
            active ? "text-ink" : "text-ink-2",
          )}
          data-sort-key={sortKey}
        >
          {label}
          <Icon name={active ? (sort.dir === "asc" ? "chevron-up" : "chevron-down") : "chevron-down"} size={12} className={active ? "text-ink" : "text-ink-3"} />
        </button>
        {formulaId ? (
          <Link href={methodHref(formulaId)} prefetch={false} className="text-ink-3 hover:text-accent" aria-label={`How ${label} is computed`}>
            <Icon name="circle-question-mark" size={12} />
          </Link>
        ) : null}
      </span>
    </th>
  );
}

export function ScreenerTable({ caption, columns, rows, sort, onSort, onCell, selected }: ScreenerTableProps) {
  const sorted = sortRows(rows, sort);
  return (
    <ScrollRegion label={caption}>
      <table className="w-full min-w-[880px] border-collapse text-left tabular-nums" data-screener-table="true">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line">
            <th scope="col" className="w-8 px-2 py-2 pl-0 text-left text-[12px] leading-4 font-semibold text-ink-2">
              #
            </th>
            <SortHead label="Brand" sortKey="label" sort={sort} onSort={onSort} />
            {columns.map((c) => (
              <SortHead key={c.key} label={c.label} sortKey={c.key} sort={sort} onSort={onSort} numeric hint={COLUMN_HINT[c.key]} formulaId={c.formulaId} />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const seed = row.flags.includes("SEED");
            return (
              <tr key={row.key} className={cx("h-11 border-b border-line", seed && "bg-sunken")} data-row={row.key}>
                <td className="px-2 pl-0 font-mono text-[12px] text-ink-2">{row.rank}</td>
                <th scope="row" className="px-2 py-1.5 text-left font-normal">
                  <span className="flex flex-col">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className={cx("type-body text-ink", seed && "font-semibold")}>{row.label}</span>
                      {seed ? <Tag tone="accent">Seed</Tag> : null}
                      {row.flags.includes("UTR") ? <Tag tone="second">Under the radar</Tag> : null}
                    </span>
                    {row.disambiguation ? <span className="type-caption text-ink-2">{row.disambiguation}</span> : null}
                  </span>
                </th>
                {columns.map((c) => {
                  const cell = row.cells[c.key];
                  const { text, missing } = cellText(cell);
                  const on = selected?.rowKey === row.key && selected.column === c.key;
                  return (
                    <td key={c.key} className="px-1 py-1 text-right last:pr-0">
                      <button
                        type="button"
                        onClick={() => onCell(row.key, c.key)}
                        aria-label={`${row.label}, ${c.label}: ${text}. Show the requests behind it`}
                        aria-pressed={on}
                        data-cell={c.key}
                        data-missing={missing || undefined}
                        className={cx(
                          "w-full rounded-sm px-1.5 py-1 text-right whitespace-nowrap transition-colors hover:bg-sunken",
                          missing ? "text-[13px] text-ink-2 italic" : "type-body text-ink",
                          on && "bg-accent-soft ring-1 ring-accent",
                        )}
                      >
                        {text}
                      </button>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </ScrollRegion>
  );
}
