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

/** The tag that carries the note's words, tinted by its status. */
const NOTE_TAG: Readonly<Record<NoteStatus, string>> = {
  done: "bg-good-soft text-good-ink",
  partial: "bg-caution-soft text-caution-ink",
  working: "bg-accent-soft text-accent-ink",
  stopped: "bg-sunken text-ink-2",
};

/** Section labels: small caps, tracked, ink-3. */
const SECTION_LABEL = "text-[11px] leading-4 font-semibold tracking-[0.1em] uppercase text-ink-3";

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
    <div data-follow-row={row.id} className={cx("flex flex-col gap-4 py-5 md:flex-row md:items-start md:gap-6", className)}>
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <span className={SECTION_LABEL}>
          {row.kindLabel}
          {row.jobLabel ? ` · ${row.jobLabel}` : ""}
        </span>
        <span className="line-clamp-2 font-display text-[20px] leading-7 font-medium tracking-[-0.01em] text-ink max-md:text-[18px] max-md:leading-6">
          {row.label}
        </span>
        {note && look ? (
          <Link
            href={note.href}
            className="group mt-1 flex min-w-0 items-center gap-2 rounded-sm border border-line bg-surface px-2.5 py-1.5 transition-colors hover:border-line-strong"
            data-note-status={note.status}
          >
            <span className={cx("flex shrink-0 items-center", look.className)}>
              {note.status === "working" ? <Spinner size={14} /> : <Icon name={look.icon} size={14} />}
              <span className="sr-only">{look.label}: </span>
            </span>
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className={cx("max-w-full shrink-0 truncate rounded-xs px-1.5 py-0.5 text-[12px] leading-4 font-semibold", NOTE_TAG[note.status])}>
                {note.text}
              </span>
              {note.headline ? <span className="min-w-0 truncate type-label font-normal text-ink-2 max-md:hidden"> · {note.headline}</span> : null}
            </span>
            <time dateTime={note.createdAt} className="shrink-0 font-mono text-[11px] leading-4 text-ink-3 tabular-nums">
              · {note.day}
            </time>
            <Icon name="chevron-right" size={14} className="shrink-0 text-ink-3 transition-colors group-hover:text-ink" />
          </Link>
        ) : (
          <span className="type-label font-normal text-ink-3">No note yet. Run it to get the first one.</span>
        )}
        {row.pending && rerun.kind !== "running" ? (
          <Link
            href={row.pending.href}
            className="flex items-center gap-2 self-start rounded-sm bg-caution-soft px-2.5 py-1.5 type-label font-semibold text-caution-ink hover:underline"
            data-follow-pending="true"
          >
            <Icon name="triangle-alert" size={14} className="shrink-0 text-caution" />
            {row.pending.label}: choose which name the re-run means
          </Link>
        ) : null}
        {rerun.kind === "running" ? (
          <Link
            href={`/run/${encodeURIComponent(rerun.runId)}`}
            className="flex items-center gap-2 self-start type-label font-semibold text-accent hover:underline"
            data-rerun="running"
          >
            <Spinner size={14} />
            Re-running. Watch it
          </Link>
        ) : null}
        {rerun.kind === "error" ? (
          <p role="alert" className="m-0 flex items-start gap-2 type-label font-normal text-ink-2" data-rerun="error">
            <Icon name="circle-x" size={14} className="mt-0.5 shrink-0 text-danger" />
            <span>{rerun.message}</span>
          </p>
        ) : null}
        {rerun.kind === "ended" ? (
          <p className="m-0 flex items-start gap-2 type-label font-normal text-ink-2" data-rerun="ended">
            <Icon name="triangle-alert" size={14} className="mt-0.5 shrink-0 text-caution" />
            <span>
              {rerun.message}{" "}
              <Link href={`/run/${encodeURIComponent(rerun.runId)}`} className="font-semibold text-accent hover:underline">
                Open the re-run
              </Link>
            </span>
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 md:pt-6">
        <Button variant="secondary" size="sm" icon="rotate-ccw" loading={working} loadingLabel="Re-running…" disabled={working} onClick={onRerun}>
          {row.rerunLabel}
        </Button>
        <Button variant="quiet" size="sm" icon="x" disabled={working} onClick={onUnfollow} aria-label={`Unfollow ${row.label}`} title="Unfollow">
          <span className="md:sr-only">Unfollow</span>
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
 * The Following list: two skeleton rows while loading, a calm error with Try again when it cannot be
 * read, the empty panel explaining how to follow, else one ruled row per follow. The cap is not shown
 * as a count; only a full list says so, in one line.
 * Presentational: Following loads and acts.
 */
export function FollowingView({ state, reruns = {}, now, timeZone, onRerun, onUnfollow, onRetry, className }: FollowingViewProps) {
  if (state.kind === "loading") {
    return (
      <ul aria-label="Loading what you follow" className={cx("m-0 flex list-none flex-col border-t border-ink p-0", className)}>
        {[0, 1].map((i) => (
          <li key={i} className="flex items-start gap-6 border-b border-line py-5">
            <div className="flex flex-1 flex-col gap-2.5">
              <Skeleton className="h-3 w-28" />
              <Skeleton className="h-5 w-[52%]" />
              <Skeleton className="h-8 w-full" />
            </div>
            <Skeleton className="mt-6 h-8 w-24 max-md:hidden" />
          </li>
        ))}
      </ul>
    );
  }
  if (state.kind === "error") {
    return (
      <InlineState
        role="alert"
        tone="danger"
        icon="triangle-alert"
        className={className}
        action={
          state.retry && onRetry ? (
            <Button size="sm" icon="rotate-ccw" onClick={onRetry}>
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
      <div className={cx("flex flex-col items-start gap-5 rounded-md border border-line bg-surface p-8 max-md:p-6", className)}>
        <span className="flex size-10 items-center justify-center rounded-sm bg-sunken text-ink-2">
          <Icon name="list-checks" size={20} />
        </span>
        <p className="m-0 max-w-[520px] type-body text-ink-2">{EMPTY_TEXT}</p>
        <ButtonLink variant="primary" size="sm" href={NEW_QUESTION_HREF}>
          Ask a question
        </ButtonLink>
      </div>
    );
  }
  const full = state.follows.length >= state.max;
  return (
    <div className={cx("flex flex-col", className)}>
      <div className="flex items-baseline justify-between gap-4 border-b border-ink pb-2.5">
        <p className="m-0 type-caption text-ink-3" data-follow-count={state.follows.length}>
          {state.follows.length} followed · kept on this browser only
        </p>
        <span className={cx(SECTION_LABEL, "max-md:hidden")} aria-hidden="true">
          Latest note · actions
        </span>
      </div>
      {full ? (
        <p className="m-0 mt-4 type-label font-normal text-ink-2" data-follow-full="true">
          This browser follows as many as it can keep. Unfollow one to follow something new.
        </p>
      ) : null}
      <ul className="m-0 flex list-none flex-col divide-y divide-line border-b border-line p-0">
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
      <p className="m-0 mt-4 max-w-[640px] type-caption text-ink-3">
        Notes are what each run found on the day shown. Nothing here says a note changed; open two answers side by side to
        compare them yourself.
      </p>
    </div>
  );
}

const NOTES: ReadonlyArray<{ icon: IconName; title: string; text: string }> = [
  { icon: "user-round", title: "Kept on this browser", text: "Follows live in this browser's cookie. Another browser, or a cleared cookie, starts empty." },
  { icon: "circle-pause", title: "Nothing updates by itself", text: "No alerts, change markers or scheduled refreshes. A note is what the last run found, on the day shown." },
  { icon: "rotate-ccw", title: "A re-run reads today's data", text: "It is a fresh run, not a saved answer." },
  { icon: "file-text", title: "Your last note stays", text: "If a re-run is stopped, declined or needs your pick, the note you had is kept until a re-run finishes." },
  { icon: "list-checks", title: "One follow per subject", text: "Following again refreshes it and keeps the newer note." },
];

/** The margin notes beside the list: how following behaves, in five short facts. */
export function FollowingNotes({ className }: { className?: string }) {
  return (
    <aside aria-label="How following works" className={cx("flex flex-col gap-6", className)}>
      <h2 className={cx("m-0", SECTION_LABEL)}>How following works</h2>
      {NOTES.map((n) => (
        <div key={n.title} className="flex flex-col gap-1">
          <span className="flex items-center gap-2 type-label font-semibold text-ink">
            <Icon name={n.icon} size={14} className="shrink-0 text-ink-2" />
            {n.title}
          </span>
          <p className="m-0 type-label font-normal text-ink-3">{n.text}</p>
        </div>
      ))}
    </aside>
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
    <div className={cx("flex flex-col gap-4", className)}>
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
