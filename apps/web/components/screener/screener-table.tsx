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

/** Columns on a 0–1 scale that carry a small bar beside the number (Ledger table). */
const BAR_COLUMNS: ReadonlySet<ScreenerColumn> = new Set(["fit", "popularity"]);

/** A quiet 0–1 bar beside a value; decoration only, the number says it. */
function ValueBar({ value }: { value: number }) {
  const w = Math.max(0, Math.min(1, value)) * 100;
  return (
    <span aria-hidden="true" className="relative inline-block h-1 w-10 shrink-0 overflow-hidden rounded-full bg-sunken max-md:hidden">
      <span className="absolute inset-y-0 left-0 rounded-full bg-accent" style={{ width: `${w}%` }} />
    </span>
  );
}

function SortHead({ label, sortKey, sort, onSort, numeric, hint, formulaId }: { label: string; sortKey: SortKey; sort: SortState; onSort: (key: SortKey) => void; numeric?: boolean; hint?: string; formulaId?: string }) {
  const active = sort.key === sortKey;
  return (
    <th scope="col" aria-sort={ariaSort(sort, sortKey)} className={cx("px-3 py-2.5 align-bottom last:pr-4", numeric ? "text-right" : "text-left")}>
      <span className={cx("inline-flex items-center gap-1", numeric && "flex-row-reverse")}>
        <button
          type="button"
          onClick={() => onSort(sortKey)}
          title={hint}
          className={cx(
            "inline-flex items-center gap-1 rounded-sm text-[11px] leading-4 font-semibold tracking-[0.06em] whitespace-nowrap uppercase hover:text-ink",
            active ? "text-ink" : "text-ink-3",
          )}
          data-sort-key={sortKey}
        >
          {label}
          <Icon name={active ? (sort.dir === "asc" ? "chevron-up" : "chevron-down") : "chevron-down"} size={12} className={active ? "text-accent" : "text-ink-3/60"} />
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
    <ScrollRegion label={caption} className="rounded-control border border-line bg-surface">
      <table className="w-full min-w-[880px] border-collapse text-left tabular-nums" data-screener-table="true">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="border-b border-line bg-sunken/60">
            <th scope="col" className="w-10 py-2.5 pr-2 pl-4 text-left text-[11px] leading-4 font-semibold text-ink-3">
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
              <tr key={row.key} className={cx("h-12 border-b border-line last:border-b-0", seed ? "bg-accent-soft/40" : "hover:bg-canvas/60")} data-row={row.key}>
                <td className="py-2 pr-2 pl-4 font-mono text-[12px] text-ink-3">{row.rank}</td>
                <th scope="row" className="px-3 py-2 text-left font-normal">
                  <span className="flex flex-col">
                    <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className={cx("type-body font-medium text-ink", seed && "font-semibold")}>{row.label}</span>
                      {seed ? <Tag tone="accent">Seed</Tag> : null}
                      {row.flags.includes("UTR") ? <Tag tone="second">Under the radar</Tag> : null}
                    </span>
                    {row.disambiguation ? <span className="type-caption text-ink-3">{row.disambiguation}</span> : null}
                  </span>
                </th>
                {columns.map((c) => {
                  const cell = row.cells[c.key];
                  const { text, missing } = cellText(cell);
                  const on = selected?.rowKey === row.key && selected.column === c.key;
                  return (
                    <td key={c.key} className="px-1.5 py-1 text-right last:pr-2.5">
                      <button
                        type="button"
                        onClick={() => onCell(row.key, c.key)}
                        aria-label={`${row.label}, ${c.label}: ${text}. Show the requests behind it`}
                        aria-pressed={on}
                        data-cell={c.key}
                        data-missing={missing || undefined}
                        className={cx(
                          "inline-flex w-full items-center justify-end gap-2.5 rounded-sm px-1.5 py-1 text-right whitespace-nowrap transition-colors hover:bg-sunken",
                          missing ? "text-[13px] text-ink-3 italic" : "font-mono text-[13px] leading-5 text-ink",
                          on && "bg-accent-soft ring-1 ring-accent",
                        )}
                      >
                        {!missing && cell.value !== null && BAR_COLUMNS.has(c.key) ? <ValueBar value={cell.value} /> : null}
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
