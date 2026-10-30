"use client";

import type { ScreenerColumnMeta, ScreenerResult, ScreenerRow } from "@ct/contracts";
import Link from "next/link";
import { SourceRow } from "../drawer/source-row";
import { methodHref } from "../figures/figure-frame";
import { DrawerShell } from "../ui/drawer-shell";
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
        <div className="flex flex-col gap-5" data-cell-drawer={column.key}>
          <div className="flex flex-col gap-2">
            <p className="type-body text-ink">{absenceText(column.key, cell) ?? COLUMN_HINT[column.key]}</p>
            <p className="type-label text-ink-2">
              {column.badge === "MEASURED" ? "Measured: Qloo's own value." : "Derived: computed in code from the requests below."}{" "}
              <Link href={methodHref(column.formulaId)} prefetch={false} className="font-medium text-accent hover:text-accent-hover">
                How it is computed
              </Link>
            </p>
          </div>
          {requests.length > 0 ? (
            <ul className="flex flex-col gap-3" aria-label="Requests behind this cell">
              {requests.map((entry) => {
                const { lookup, query } = requestLookup(entry, now);
                return (
                  <li key={entry.id} className="flex flex-col gap-1.5">
                    <span className="type-label text-ink-2">
                      {entry.id} · {PURPOSE_LABEL[entry.purpose]}
                      {entry.context ? ` · ${entry.context}` : ""}
                    </span>
                    {entry.error ? <span className="type-caption text-danger-ink">This request failed: {entry.error}</span> : null}
                    <ul>
                      <SourceRow lookup={lookup} query={query} defaultOpen={requests.length === 1} onCopied={onCopied} />
                    </ul>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="type-label text-ink-2">No Qloo request stands behind this cell.</p>
          )}
        </div>
      ) : null}
    </DrawerShell>
  );
}
