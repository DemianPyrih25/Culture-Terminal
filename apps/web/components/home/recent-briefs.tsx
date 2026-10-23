"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { BriefListHeader, BriefRowView } from "../library/brief-rows";
import { BriefsError, fetchBriefs, type BriefList } from "../library/briefs-client";
import { cx } from "../ui/cx";
import { ArrowRightIcon } from "../ui/icons";

/** What the recent list shows: the first page, or why there is none yet. */
export type RecentBriefsState =
  | { kind: "loading" }
  | { kind: "ready"; list: BriefList; year: number }
  | { kind: "error"; message: string; retry: boolean };

export interface RecentBriefsViewProps {
  state: RecentBriefsState;
  /** Rows the list holds while loading. */
  rows?: number;
  /** What an empty list says; by default, that this browser's own briefs are listed here. */
  empty?: ReactNode;
  onRetry?: () => void;
  className?: string;
}

const HEADING_ID = "recent-briefs";

/** The empty list's default words. */
export const RECENT_BRIEFS_EMPTY = "No briefs yet. The briefs you run in this browser are listed here.";

/**
 * RECENT BRIEFS (A01, A02): the A/List header and the newest A/Brief rows, the showcases and this
 * browser's own briefs, with "All N briefs" to the library. Presentational: RecentBriefs fetches.
 */
export function RecentBriefsView({ state, rows = 5, empty = RECENT_BRIEFS_EMPTY, onRetry, className }: RecentBriefsViewProps) {
  const total = state.kind === "ready" ? state.list.total : null;
  return (
    <section aria-labelledby={HEADING_ID} aria-busy={state.kind === "loading"} className={cx("flex w-full flex-col", className)}>
      <div className="flex items-center gap-[10px] border-t border-line-strong pt-[10px] pb-4">
        <h2 id={HEADING_ID} className="text-[11px] leading-4 font-semibold tracking-[1.3px] text-ink uppercase">
          Recent briefs
        </h2>
        {total !== null && total > 0 ? (
          <Link
            href="/briefs"
            className="ml-auto inline-flex items-center gap-[6px] text-[12px] leading-4 font-medium text-accent hover:underline hover:underline-offset-4"
          >
            All {total.toLocaleString("en-US")} {total === 1 ? "brief" : "briefs"}
            <ArrowRightIcon size={12} />
          </Link>
        ) : null}
      </div>
      <BriefListHeader columns="home" />
      {state.kind === "loading" ? (
        <ul aria-label="Loading recent briefs">
          {Array.from({ length: rows }, (_, i) => (
            <li key={i} className="flex h-[60px] items-center gap-4 border-b border-line">
              <span className="flex flex-1 flex-col gap-[7px]">
                <span className="block h-[14px] w-[46%] rounded-brief bg-canvas motion-safe:animate-pulse" />
                <span className="block h-[9px] w-[22%] rounded-brief bg-canvas motion-safe:animate-pulse" />
              </span>
            </li>
          ))}
        </ul>
      ) : state.kind === "error" ? (
        <p role="alert" className="flex items-center gap-3 border-b border-line py-5 text-[13px] text-dim">
          {state.message}
          {state.retry && onRetry ? (
            <button type="button" onClick={onRetry} className="font-medium text-accent hover:underline hover:underline-offset-4">
              Try again
            </button>
          ) : null}
        </p>
      ) : state.list.runs.length === 0 ? (
        <div className="flex flex-col items-start gap-3 border-b border-line py-5 text-[13px] leading-5 text-dim">{empty}</div>
      ) : (
        <ul>
          {state.list.runs.map((brief) => (
            <li key={brief.runId}>
              <BriefRowView brief={brief} columns="home" year={state.year} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export interface RecentBriefsProps {
  /** How many briefs to show (5 on Home, 3 under the Ask panel). */
  limit?: number;
  /** What an empty list says (RecentBriefsView's `empty`). */
  empty?: ReactNode;
  className?: string;
}

/** The recent list, fetched in the browser: it names this browser's own runs, which only it knows. */
export function RecentBriefs({ limit = 5, empty, className }: RecentBriefsProps) {
  const [state, setState] = useState<RecentBriefsState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    fetchBriefs({ limit }, { signal: controller.signal })
      .then((list) => setState({ kind: "ready", list, year: new Date().getUTCFullYear() }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const retry = err instanceof BriefsError ? err.retry : true;
        const message = err instanceof BriefsError ? err.message : "The recent briefs could not be loaded.";
        setState({ kind: "error", message, retry });
      });
    return () => controller.abort();
  }, [limit, attempt]);

  return (
    <RecentBriefsView
      state={state}
      rows={limit}
      empty={empty}
      className={className}
      onRetry={() => {
        setState({ kind: "loading" });
        setAttempt((n) => n + 1);
      }}
    />
  );
}
