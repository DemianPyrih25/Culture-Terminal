"use client";

import type { ScreenerColumnMeta, ScreenerResult, ScreenerRow } from "@ct/contracts";
import Link from "next/link";
import { SourceRow } from "../drawer/source-row";
import { methodHref } from "../figures/figure-frame";
import { DrawerShell } from "../ui/drawer-shell";
import { Icon } from "../ui/icons";
import { absenceText, cellRequests, cellText, COLUMN_HINT, PURPOSE_LABEL, requestLookup } from "./model";

/**
 * How we know, for one screener cell: what the number is (or why it is empty), how it is computed on
 * /method, then every request behind it as the note's source rows show them (endpoint, parameters,
 * freshness, request id, "Copy request"). An empty cell still lists the request that did not score it.
 */

export interface CellDrawerProps {
  screen: ScreenerResult;
  row: ScreenerRow | null;
  column: ScreenerColumnMeta | null;
  onClose: () => void;
  onCopied: (message: string) => void;
}

export function CellDrawer({ screen, row, column, onClose, onCopied }: CellDrawerProps) {
  const open = row !== null && column !== null;
  const cell = open ? row.cells[column.key] : null;
  const requests = cell ? cellRequests(screen, cell) : [];
  // A saved copy's age as of the screen, so the drawer reads the same on every render.
  const now = Date.parse(screen.createdAt);
  return (
    <DrawerShell
      open={open}
      onClose={onClose}
      title="How we know"
      subtitle={open && cell ? `${row.label} · ${column.label}: ${cellText(cell).text}` : undefined}
    >
      {open && cell ? (
        <div className="flex animate-rise flex-col gap-6" data-cell-drawer={column.key}>
          <div className="flex flex-col gap-3">
            <p className="type-body text-ink-2">{absenceText(column.key, cell) ?? COLUMN_HINT[column.key]}</p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 type-label text-ink-3">
              <span className="rounded-sm bg-sunken px-2 py-0.5 font-semibold text-ink">{column.badge === "MEASURED" ? "Measured" : "Derived"}</span>
              <Link href={methodHref(column.formulaId)} prefetch={false} className="inline-flex items-center gap-1 font-medium text-accent hover:text-accent-hover">
                How it is computed
                <Icon name="arrow-up-right" size={13} />
              </Link>
            </p>
          </div>
          {requests.length > 0 ? (
            <div className="flex flex-col gap-3">
              <h3 className="text-[11px] leading-4 font-semibold tracking-[0.08em] text-ink-3 uppercase">
                Qloo requests behind this cell · {requests.length}
              </h3>
              <ul className="flex flex-col gap-3" aria-label="Requests behind this cell">
                {requests.map((entry, i) => {
                  const { lookup, query } = requestLookup(entry, now);
                  return (
                    <li
                      key={entry.id}
                      className="flex animate-rise flex-col gap-2 rounded-control border border-line bg-surface p-3"
                      style={{ animationDelay: `${Math.min(60 + i * 40, 300)}ms` }}
                    >
                      <span className="flex flex-wrap items-baseline gap-x-2 type-label">
                        <span className="font-mono text-[12px] font-semibold text-accent">{entry.id}</span>
                        <span className="font-medium text-ink">{PURPOSE_LABEL[entry.purpose]}</span>
                        {entry.context ? <span className="text-ink-3">{entry.context}</span> : null}
                      </span>
                      {entry.error ? <span className="type-caption text-danger-ink">This request failed: {entry.error}</span> : null}
                      <ul>
                        <SourceRow lookup={lookup} query={query} defaultOpen={requests.length === 1} onCopied={onCopied} />
                      </ul>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : (
            <p className="type-label text-ink-3">No Qloo request stands behind this cell.</p>
          )}
        </div>
      ) : null}
    </DrawerShell>
  );
}
