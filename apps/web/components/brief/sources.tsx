"use client";

import { formatDuration, plural, type BriefSources } from "../../lib/brief";
import { SCROLL_ANCHOR_CLASS } from "../layout";
import { cx } from "../ui";
import { SourceTrigger } from "./note-ref";
import { RequestStamp } from "./stamp";

/** The age after a stamp: "cached 2h" → "2h", "live 20 Oct, 14:30" → "20 Oct, 14:30", "reused from #B7E2" → "from #B7E2". */
export function stampAge(cacheLabel: string): string {
  return cacheLabel.replace(/^(cached|live|stale cache|reused) ?/, "");
}

/**
 * 06 Sources: every Qloo request in arrival order, with its stamp and age, rows and latency, the notes
 * that cite it, and its id opening the inspector. The stamps stay still: they flashed in the margin as
 * their calls landed.
 */
export function SourcesList({ sources }: { sources: BriefSources }) {
  if (sources.items.length === 0) return <p className="m-0 text-[13px] text-dim">No Qloo request was made.</p>;
  return (
    <ol className="m-0 w-full list-none p-0" aria-label="Qloo requests">
      {sources.items.map((s) => (
        <li
          key={s.qlooCallId}
          id={`source-${s.n}`}
          data-source={s.n}
          className={cx(
            "grid grid-cols-[28px_minmax(0,1fr)] gap-x-3 gap-y-1 border-b border-line py-2 sm:grid-cols-[28px_minmax(0,1fr)_auto]",
            SCROLL_ANCHOR_CLASS,
          )}
        >
          <span className="font-mono text-[11px] leading-5 text-dim tabular-nums">{s.n}</span>
          <div className="flex min-w-0 flex-col gap-0.5">
            <p className="m-0 text-[13px] leading-5 text-ink [overflow-wrap:anywhere]">
              <span className="font-mono text-[12px]">{s.endpoint}</span>
              {s.filterLabel ? <span className="text-dim"> · {s.filterLabel}</span> : null}
              {s.refs.length > 0 ? <span className="text-dim"> ← {s.refs.join(", ")}</span> : null}
            </p>
            <p className="m-0 type-trace text-dim">
              {[
                s.rows === null ? null : plural(s.rows, "row"),
                s.cache === "miss" ? formatDuration(s.ms) : null,
                s.error ? `error: ${s.error}` : null,
                s.footnotes.length > 0 ? `notes ${s.footnotes.join(", ")}` : "not cited",
              ]
                .filter(Boolean)
                .join(" · ")}
            </p>
          </div>
          <div className="col-start-2 flex items-center gap-2 sm:col-start-3 sm:justify-end">
            <RequestStamp cache={s.cache} />
            <span className="text-[11px] text-dim">{stampAge(s.cacheLabel) || null}</span>
            <SourceTrigger source={s} className="type-trace text-dim">
              req {s.shortRequestId}
            </SourceTrigger>
          </div>
        </li>
      ))}
    </ol>
  );
}
