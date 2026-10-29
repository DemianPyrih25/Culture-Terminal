import Link from "next/link";
import type { CSSProperties } from "react";
import { ChartTable } from "../ui/chart-card";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { Monogram } from "../ui/monogram";
import { Tag } from "../ui/tag";
import { NO_DATA, signed, type FanRow, type NeighbourColumn, type TagFamily, type TravelRow } from "./profile-model";

/**
 * The profile's plots (N14): diverging rows for who the fans are, tag families, the neighbour columns
 * and the travel bars, each with its table. Presentational only, so the client view can hold them.
 */

/** The smallest scale a diverging plot draws to, so small indices stay small. */
const DIVERGING_MIN_SCALE = 0.48;

const barWidth = (ratio: number, room: number): CSSProperties => ({ width: `calc((100% - ${room}px) * ${Math.max(0, Math.min(1, ratio))})` });

/** DivergingRows: a zero line at the centre; more than average to the right (accent), less to the left (second). */
export function DivergingRows({ rows, label }: { rows: readonly FanRow[]; label: string }) {
  const max = Math.max(DIVERGING_MIN_SCALE, ...rows.map((r) => Math.abs(r.value ?? 0)));
  return (
    <div role="img" aria-label={label} className="relative mx-auto w-full max-w-[504px] py-1" data-plot="diverging">
      <span aria-hidden="true" className="absolute inset-y-0 left-1/2 w-px bg-ink-3" />
      {rows.map((row) => {
        const v = row.value;
        const name = <span className="min-w-0 type-body text-ink [overflow-wrap:anywhere]">{row.label}</span>;
        const value = v === null ? null : <span className="shrink-0 type-label text-ink-2 tabular-nums">{signed(v)}</span>;
        return (
          <div key={row.key} className="grid min-h-9 grid-cols-2 items-center py-1" data-row={row.label} aria-hidden="true">
            {v === null ? (
              <>
                <span className="flex min-w-0 justify-end pr-3">{name}</span>
                <span className="pl-3 type-label text-ink-2">{NO_DATA}</span>
              </>
            ) : v >= 0 ? (
              <>
                <span className="flex min-w-0 justify-end pr-3">{name}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <span className="h-3 flex-none rounded-r-xs bg-accent" style={barWidth(v / max, 60)} />
                  {value}
                </span>
              </>
            ) : (
              <>
                <span className="flex min-w-0 items-center justify-end gap-2">
                  {value}
                  <span className="h-3 flex-none rounded-l-xs bg-second" style={barWidth(-v / max, 60)} />
                </span>
                <span className="flex min-w-0 pl-3">{name}</span>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function FansTable({ rows, label }: { rows: readonly FanRow[]; label: string }) {
  return (
    <ChartTable
      label={label}
      columns={[{ label: "Group" }, { label: "vs average audience", numeric: true }]}
      rows={rows.map((r) => [r.label, r.value === null ? NO_DATA : signed(r.value)])}
      className="[&_td:last-child]:w-44"
    />
  );
}

/** Tag families: a 13/600 label over up to three tags joined by middle dots. */
export function TagGroups({ families }: { families: readonly TagFamily[] }) {
  return (
    <dl className="flex flex-col gap-7 max-md:gap-5">
      {families.map((family) => (
        <div key={family.label} className="flex flex-col gap-1" data-tag-family={family.label}>
          <dt className="text-[13px] leading-[18px] font-semibold text-ink-2">{family.label}</dt>
          <dd className="text-[18px] leading-7 text-ink max-md:text-[16px] max-md:leading-6">{family.tags.join(" · ")}</dd>
        </div>
      ))}
    </dl>
  );
}

/** NeighbourColumns: one column per domain, five names each, linked to their own profile. */
export function NeighbourColumns({ columns }: { columns: readonly NeighbourColumn[] }) {
  return (
    <div className="grid grid-cols-4 gap-6 max-lg:grid-cols-2 max-sm:grid-cols-1" data-plot="neighbours">
      {columns.map((column) => (
        <section key={column.key} aria-label={column.label} className="flex min-w-0 flex-col gap-1" data-domain={column.key}>
          <h3 className="m-0 flex items-center gap-1.5 text-[13px] leading-[18px] font-semibold text-ink-2">
            <Icon name={column.icon} size={14} className="shrink-0" />
            {column.label}
          </h3>
          {column.rows.length === 0 ? (
            <p className="py-3 type-label text-ink-2">{NO_DATA}</p>
          ) : (
            <ol className="flex flex-col">
              {column.rows.map((row) => (
                <li key={`${row.rank}-${row.name}`} className="flex min-h-[52px] items-start gap-3 py-2">
                  <span className="w-4 shrink-0 pt-0.5 type-label text-ink-2 tabular-nums">{row.rank}</span>
                  <Monogram name={row.name} size={24} />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    {row.href ? (
                      <Link href={row.href} prefetch={false} className="group inline-flex min-w-0 items-center gap-1 rounded-sm type-body text-ink hover:text-accent">
                        <span className="min-w-0 [overflow-wrap:anywhere]">{row.name}</span>
                        <Icon name="arrow-up-right" size={12} className="shrink-0 text-ink-3 group-hover:text-accent" />
                      </Link>
                    ) : (
                      <span className="min-w-0 type-body text-ink [overflow-wrap:anywhere]">{row.name}</span>
                    )}
                    {row.gem ? <Tag preset="hidden-gem" /> : null}
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

export function NeighboursTable({ columns, label }: { columns: readonly NeighbourColumn[]; label: string }) {
  return (
    <ChartTable
      label={label}
      columns={[{ label: "Name" }, { label: "Category" }, { label: "Rank", numeric: true }, { label: "Fit", numeric: true }]}
      rows={columns.flatMap((c) =>
        c.rows.map((r) => [r.gem ? `${r.name} (hidden gem)` : r.name, c.label, `#${r.rank}`, r.fit === null ? NO_DATA : r.fit.toFixed(2)]),
      )}
    />
  );
}

/** Travel bars: fit within the set as the bar, #1 in accent; the rank sits just past the bar's end. */
export function TravelBars({ rows, label }: { rows: readonly TravelRow[]; label: string }) {
  // The room kept past the longest bar: the rank and the Hidden gem tag on desktop, the rank alone on phones.
  const end = (fit: number) => `calc((100% - var(--room)) * ${Math.max(0, Math.min(1, fit))})`;
  return (
    <div role="img" aria-label={label} data-plot="travel">
      <ol aria-hidden="true" className="flex flex-col [--room:132px] max-md:[--room:44px]">
        {rows.map((row) => (
          <li key={row.label} className="flex min-h-11 items-center gap-4 max-md:gap-3">
            <span className="flex w-[200px] shrink-0 flex-col max-md:w-[148px]">
              <span className="min-w-0 type-body text-ink [overflow-wrap:anywhere]">{row.label}</span>
              {row.gem ? <Tag preset="hidden-gem" className="md:hidden" /> : null}
            </span>
            <span className="relative h-3 min-w-0 flex-1 rounded-xs bg-sunken">
              <span
                className={cx("absolute inset-y-0 left-0 rounded-xs", row.rank === 1 ? "bg-accent" : "bg-chart-muted")}
                style={{ width: end(row.fit) }}
              />
              <span
                className="absolute top-1/2 flex -translate-y-1/2 items-center gap-2 bg-surface px-1.5 whitespace-nowrap"
                style={{ left: `calc(${end(row.fit)} + 2px)` }}
              >
                <span className="type-label text-ink-2 tabular-nums">#{row.rank}</span>
                {row.gem ? <Tag preset="hidden-gem" className="max-md:hidden" /> : null}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function TravelTable({ rows, label }: { rows: readonly TravelRow[]; label: string }) {
  return (
    <ChartTable
      label={label}
      columns={[{ label: "Place" }, { label: "Rank", numeric: true }, { label: "Fit", numeric: true }]}
      rows={rows.map((r) => [r.gem ? `${r.label} (hidden gem)` : r.label, `#${r.rank}`, r.fit.toFixed(2)])}
    />
  );
}
