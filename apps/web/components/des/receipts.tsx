import { Fragment } from "react";
import { formatDuration, plural, shortRequestId } from "../../lib/brief/format";
// Straight from its file: the brief barrel is a client module.
import { RequestStamp } from "../brief/stamp";
import { SCROLL_ANCHOR_CLASS } from "../layout/grid";
import { cx } from "../ui/cx";
import type { DesReceipt } from "./model";

/** The anchor of a request in Receipts, which figure sources and key figures link to. */
export const receiptId = (n: number): string => `receipt-${n}`;

/** "cached 2h" → "2h", "live" → "" (the stamp already says it). */
function ageOf(label: string): string {
  return label.replace(/^(cached|live|stale cache) ?/, "");
}

/** A receipt's trace line: what it was for, rows, latency, error; a count or a duration never breaks inside. */
function traceParts(r: DesReceipt): { text: string; keep: boolean }[] {
  const parts: { text: string; keep: boolean }[] = [];
  if (r.purpose) parts.push({ text: r.purpose, keep: false });
  if (r.rows !== null) parts.push({ text: plural(r.rows, "row"), keep: true });
  if (r.cache === "miss") parts.push({ text: formatDuration(r.ms), keep: true });
  if (r.error) parts.push({ text: `error: ${r.error}`, keep: false });
  return parts;
}

/**
 * 05 Receipts: every Qloo request behind the tearsheet in the order it was made: what it was for, its
 * stamp (CACHE, LIVE, STALE) and age, rows and latency, and its request id. No request parameters
 * are shown: they hold Qloo entity ids.
 */
export function Receipts({ receipts }: { receipts: readonly DesReceipt[] }) {
  if (receipts.length === 0) return <p className="m-0 text-[13px] text-dim">No Qloo request was made.</p>;
  return (
    <ol className="m-0 w-full list-none border-t border-line p-0" aria-label="Qloo requests">
      {receipts.map((r) => (
        <li
          key={r.n}
          id={receiptId(r.n)}
          data-receipt={r.n}
          data-cache={r.cache}
          className={cx(
            "grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-line py-2 sm:grid-cols-[28px_minmax(0,1fr)_auto]",
            SCROLL_ANCHOR_CLASS,
          )}
        >
          <span className="font-mono text-[11px] leading-5 text-dim tabular-nums">{r.n}</span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="m-0 text-[13px] leading-5 text-ink [overflow-wrap:anywhere]">
              <span className="font-mono text-[12px]">{r.endpoint}</span>
              {r.filterLabel ? <span className="text-dim"> · {r.filterLabel}</span> : null}
            </p>
            <p className="m-0 type-trace text-dim">
              {traceParts(r).map((part, i) => (
                <Fragment key={part.text}>
                  {i > 0 ? " · " : null}
                  <span className={part.keep ? "whitespace-nowrap" : undefined}>{part.text}</span>
                </Fragment>
              ))}
            </p>
          </div>
          <div className="col-start-2 flex items-center gap-2 sm:col-start-3 sm:justify-end">
            <RequestStamp cache={r.cache} />
            {ageOf(r.cacheLabel) ? <span className="text-[11px] text-dim">{ageOf(r.cacheLabel)}</span> : null}
            <span className="type-trace text-dim" title={r.requestId ? `Request ${r.requestId}` : undefined}>
              req {shortRequestId(r.requestId)}
            </span>
          </div>
        </li>
      ))}
    </ol>
  );
}
