import type { RunStatus } from "@ct/contracts";
import { cx } from "../ui/cx";
import { outcomesText, STATUS_WORD, statusCounts } from "./format";

/**
 * One run's cell: solid accent for a brief written, a lighter accent for one cut short, negative for a
 * failure, greys for a refusal (dark) or a cancel (light), and outlines for runs still going or waiting.
 */
export const STATUS_CELL: Readonly<Record<RunStatus, string>> = {
  completed: "bg-accent",
  incomplete: "bg-accent/45",
  needs_input: "bg-paper ring-1 ring-accent ring-inset",
  refused: "bg-dim",
  cancelled: "bg-line-strong",
  failed: "bg-negative",
  running: "bg-accent-soft ring-1 ring-accent/50 ring-inset",
  queued: "bg-accent-soft ring-1 ring-accent/50 ring-inset",
};

export interface RunStripProps {
  /** Statuses, newest first. */
  statuses: readonly RunStatus[];
  /** Cells drawn: one per run read, the rest as empty slots. */
  slots: number;
  /** Accessible name, e.g. "Last 20 live runs". */
  label: string;
  className?: string;
}

/**
 * The latest runs' outcomes, one 10 px cell per run, newest on the left, then the counts. Statuses
 * only: a run's question never reaches this page (D31). Slots not yet filled are hairline squares.
 */
export function RunStrip({ statuses, slots, label, className }: RunStripProps) {
  const cells = Array.from({ length: Math.max(slots, statuses.length) }, (_, i) => statuses[i] ?? null);
  const counts = statusCounts(statuses);
  return (
    <span className={cx("flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5", className)}>
      <span
        role="img"
        aria-label={statuses.length === 0 ? `${label}: none yet` : `${label}, newest first: ${outcomesText(statuses)}`}
        className="flex w-[240px] shrink-0 gap-[2px] max-sm:w-auto"
        data-strip="runs"
      >
        {cells.map((status, i) => (
          <span
            key={i}
            title={status ? STATUS_WORD[status] : undefined}
            className={cx("size-[10px] shrink-0", status ? STATUS_CELL[status] : "ring-1 ring-line ring-inset")}
            data-status={status ?? "empty"}
          />
        ))}
      </span>
      {counts.length === 0 ? (
        <span className="text-dim">None yet</span>
      ) : (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {counts.map(({ status, n }) => (
            <span key={status} className="inline-flex items-center gap-1.5 whitespace-nowrap">
              <span aria-hidden="true" className={cx("size-2 shrink-0", STATUS_CELL[status])} />
              <span>
                <span className="font-medium text-ink tabular-nums">{n}</span> {STATUS_WORD[status]}
              </span>
            </span>
          ))}
        </span>
      )}
    </span>
  );
}
