"use client";

import type { Follow } from "@ct/contracts";
import { TERMINAL_RUN_STATUS_VALUES } from "@ct/contracts/values";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { rememberRun } from "../../lib/recent-briefs";
import { startRun } from "../../lib/start-run";
import { NEW_QUESTION_HREF } from "../chrome/links";
import { HumanCheckPanel, sharedHumanFetch, useHumanCheck } from "../protection/human-check-panel";
import { Button, ButtonLink } from "../ui/button";
import { cx } from "../ui/cx";
import { Icon, Spinner, type IconName } from "../ui/icons";
import { InlineState } from "../ui/inline-state";
import { Skeleton } from "../ui/skeleton";
import { FollowsError, pointFollow, readPendingReruns, runStatus, sharedFollows, writePendingRerun, type FollowsState } from "./client";
import { useFollows } from "./follow-button";
import { EMPTY_TEXT, followRowModel, RERUN_IDLE, rerunEndedMessage, type FollowRowModel, type NoteStatus, type RerunState } from "./model";

/** How often a running re-run is looked at. */
export const RERUN_POLL_MS = 5000;

const STATUS_ICON: Readonly<Record<NoteStatus, { icon: IconName; className: string; label: string }>> = {
  done: { icon: "circle-check", className: "text-good", label: "Done" },
  partial: { icon: "triangle-alert", className: "text-caution", label: "Partial" },
  working: { icon: "loader-circle", className: "text-accent", label: "Working" },
  stopped: { icon: "circle-x", className: "text-ink-3", label: "Stopped" },
};

export interface FollowRowProps {
  row: FollowRowModel;
  onRerun?: () => void;
  onUnfollow?: () => void;
  className?: string;
}

/** One follow: kind and job, the subject, its latest note (a link) and day, then Re-run and Unfollow. */
export function FollowRow({ row, onRerun, onUnfollow, className }: FollowRowProps) {
  const { note, rerun } = row;
  const look = note ? STATUS_ICON[note.status] : null;
  const working = rerun.kind === "starting" || rerun.kind === "running";
  return (
    <div
      data-follow-row={row.id}
      className={cx(
        "flex flex-col gap-3 rounded-control border border-line bg-surface px-5 py-4 shadow-xs md:flex-row md:items-center md:gap-4",
        "max-md:px-4",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="type-label text-ink-2">
          {row.kindLabel}
          {row.jobLabel ? ` · ${row.jobLabel}` : ""}
        </span>
        <span className="line-clamp-2 type-body-strong text-ink">{row.label}</span>
        {note && look ? (
          <Link href={note.href} className="group flex min-w-0 items-center gap-2 type-label text-ink-2 hover:text-ink" data-note-status={note.status}>
            <span className={cx("flex shrink-0 items-center", look.className)}>
              {note.status === "working" ? <Spinner size={14} /> : <Icon name={look.icon} size={14} />}
              <span className="sr-only">{look.label}: </span>
            </span>
            <span className="min-w-0 [overflow-wrap:anywhere]">
              <span className="text-ink">{note.text}</span>
              {note.headline ? <span className="max-md:hidden"> · {note.headline}</span> : null}
            </span>
            <time dateTime={note.createdAt} className="shrink-0 tabular-nums">
              · {note.day}
            </time>
            <Icon name="chevron-right" size={14} className="shrink-0 text-ink-3" />
          </Link>
        ) : (
          <span className="type-label text-ink-3">No note yet. Run it to get the first one.</span>
        )}
        {row.pending && rerun.kind !== "running" ? (
          <Link href={row.pending.href} className="flex items-center gap-2 type-label font-medium text-caution-ink hover:underline" data-follow-pending="true">
            <Icon name="triangle-alert" size={14} className="shrink-0 text-caution" />
            {row.pending.label}: choose which name the re-run means
          </Link>
        ) : null}
        {rerun.kind === "running" ? (
          <Link href={`/run/${encodeURIComponent(rerun.runId)}`} className="flex items-center gap-2 type-label text-accent hover:underline" data-rerun="running">
            <Spinner size={14} />
            Re-running. Watch it
          </Link>
        ) : null}
        {rerun.kind === "error" ? (
          <p role="alert" className="m-0 type-label text-danger-ink" data-rerun="error">
            {rerun.message}
          </p>
        ) : null}
        {rerun.kind === "ended" ? (
          <p className="m-0 type-label text-caution-ink" data-rerun="ended">
            {rerun.message}{" "}
            <Link href={`/run/${encodeURIComponent(rerun.runId)}`} className="text-accent hover:underline">
              Open the re-run
            </Link>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <Button variant="secondary" size="sm" icon="rotate-ccw" loading={working} loadingLabel="Re-running…" disabled={working} onClick={onRerun}>
          {row.rerunLabel}
        </Button>
        <Button variant="quiet" size="sm" icon="x" disabled={working} onClick={onUnfollow} aria-label={`Unfollow ${row.label}`}>
          Unfollow
        </Button>
      </div>
    </div>
  );
}

export interface FollowingViewProps {
  state: FollowsState;
  reruns?: Readonly<Record<string, RerunState>>;
  now: number;
  /** The visitor's time zone by default; fixed in tests. */
  timeZone?: string;
  onRerun?: (follow: Follow) => void;
  onUnfollow?: (follow: Follow) => void;
  onRetry?: () => void;
  className?: string;
}

/**
 * The Following list: two skeleton rows while loading, a neutral state with Try again when it cannot be
 * read, the empty well explaining how to follow, else one row per follow with the count against the limit.
 * Presentational: Following loads and acts.
 */
export function FollowingView({ state, reruns = {}, now, timeZone, onRerun, onUnfollow, onRetry, className }: FollowingViewProps) {
  if (state.kind === "loading") {
    return (
      <ul aria-label="Loading what you follow" className={cx("m-0 flex list-none flex-col gap-2 p-0", className)}>
        {[0, 1].map((i) => (
          <li key={i} className="flex h-[88px] items-center gap-4 rounded-control border border-line bg-surface px-5 shadow-xs">
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-4 w-[46%]" />
            </div>
            <Skeleton className="h-8 w-24" />
          </li>
        ))}
      </ul>
    );
  }
  if (state.kind === "error") {
    return (
      <InlineState
        role="alert"
        icon="triangle-alert"
        className={className}
        action={
          state.retry && onRetry ? (
            <Button icon="rotate-ccw" onClick={onRetry}>
              Try again
            </Button>
          ) : null
        }
      >
        {state.message}
      </InlineState>
    );
  }
  if (state.follows.length === 0) {
    return (
      <div className={cx("flex flex-col items-center gap-4 rounded-tile bg-sunken p-6 py-12 text-center", className)}>
        <Icon name="list-checks" size={32} className="text-ink-3" />
        <p className="m-0 max-w-[560px] type-body text-ink-2">{EMPTY_TEXT}</p>
        <ButtonLink variant="primary" href={NEW_QUESTION_HREF}>
          Ask a question
        </ButtonLink>
      </div>
    );
  }
  return (
    <div className={cx("flex flex-col gap-3", className)}>
      <p className="m-0 type-label text-ink-2" data-follow-count={state.follows.length}>
        {state.follows.length} of {state.max} · kept on this browser only
      </p>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {state.follows.map((follow) => (
          <li key={follow.id}>
            <FollowRow
              row={followRowModel(follow, reruns[follow.id] ?? RERUN_IDLE, now, timeZone)}
              onRerun={onRerun ? () => onRerun(follow) : undefined}
              onUnfollow={onUnfollow ? () => onUnfollow(follow) : undefined}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

const isTerminal = (status: string): boolean => (TERMINAL_RUN_STATUS_VALUES as readonly string[]).includes(status);

/**
 * Following, in the browser: the follows from the shared copy, [Re-run] through POST /api/runs with
 * `fresh: true` (the human check, the queue and every limit apply as for any question), and the re-run
 * watched until it ends: with a note, the follow points at it; without one, the last note stays and the
 * row says why.
 */
export function Following({ className }: { className?: string }) {
  const store = sharedFollows();
  const state = useFollows(store, true);
  const human = useHumanCheck();
  // Re-runs started earlier on this browser that had not ended when the page was left (none on the server).
  const [reruns, setReruns] = useState<Record<string, RerunState>>(() =>
    Object.fromEntries(Object.entries(readPendingReruns()).map(([id, runId]) => [id, { kind: "running", runId } satisfies RerunState])),
  );
  const [now, setNow] = useState(() => Date.now());

  const setRerun = useCallback((id: string, next: RerunState) => setReruns((all) => ({ ...all, [id]: next })), []);

  const settle = useCallback(
    async (followId: string, runId: string) => {
      const status = await runStatus(runId);
      if (status === undefined || (status !== null && !isTerminal(status))) return;
      writePendingRerun(followId, null);
      if (status === "completed" || status === "incomplete") {
        try {
          store.upsert(await pointFollow(followId, runId));
          setRerun(followId, RERUN_IDLE);
        } catch (err) {
          setRerun(followId, { kind: "ended", runId, message: err instanceof FollowsError ? err.message : rerunEndedMessage("failed") });
        }
        setNow(Date.now());
        return;
      }
      setRerun(followId, { kind: "ended", runId, message: rerunEndedMessage(status) });
    },
    [setRerun, store],
  );

  // Only re-runs of follows the list still has are watched; one unfollowed elsewhere is forgotten.
  const known = state.kind === "ready" ? new Set(state.follows.map((f) => f.id)) : null;
  const runningKey = Object.entries(reruns)
    .flatMap(([id, r]) => (r.kind === "running" && known?.has(id) ? [`${id}:${r.runId}`] : []))
    .join(",");
  useEffect(() => {
    if (runningKey === "") return;
    const watch = runningKey.split(",").map((pair) => pair.split(":") as [string, string]);
    const tick = () => {
      for (const [id, runId] of watch) void settle(id, runId);
    };
    tick();
    const timer = setInterval(tick, RERUN_POLL_MS);
    return () => clearInterval(timer);
  }, [runningKey, settle]);

  const onRerun = async (follow: Follow) => {
    setRerun(follow.id, { kind: "starting" });
    const outcome = await startRun({ question: follow.rerun.question, fresh: true }, { fetch: sharedHumanFetch() });
    if (!outcome.ok) {
      setRerun(follow.id, { kind: "error", message: outcome.error });
      return;
    }
    rememberRun(outcome.runId);
    writePendingRerun(follow.id, outcome.runId);
    setRerun(follow.id, { kind: "running", runId: outcome.runId });
  };

  const onUnfollow = async (follow: Follow) => {
    try {
      await store.unfollow(follow.id);
      writePendingRerun(follow.id, null);
    } catch (err) {
      setRerun(follow.id, { kind: "error", message: err instanceof FollowsError ? err.message : "Could not unfollow. Try again." });
    }
  };

  return (
    <div className={cx("flex flex-col gap-3", className)}>
      <HumanCheckPanel check={human} />
      <FollowingView
        state={state}
        reruns={reruns}
        now={now}
        onRerun={(f) => void onRerun(f)}
        onUnfollow={(f) => void onUnfollow(f)}
        onRetry={() => void store.load(true)}
      />
    </div>
  );
}
