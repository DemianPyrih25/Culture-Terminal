"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Pillar } from "@ct/contracts";
import { clearRecentRuns, forgetRun, readRecentRunIds, RECENT_BRIEFS_MAX, restoreRun } from "../../lib/recent-briefs";
import { NEW_QUESTION_HREF } from "../chrome/links";
import { Button, ButtonLink } from "../ui/button";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { InlineState } from "../ui/inline-state";
import { Popover } from "../ui/popover";
import { Skeleton } from "../ui/skeleton";
import { Toast } from "../ui/toast";
import { TOPIC_KEYS, TOPICS } from "../ui/topic";
import { AnswerRow } from "./answer-row";
import { BriefsError, loadYourAnswers, relativeDay, type AnswerItem, type AnswerStatus } from "./answers";

/** What the list shows: the rows, or why there are none yet. */
export type YourAnswersState =
  | { kind: "loading" }
  | { kind: "ready"; items: AnswerItem[]; now: number }
  | { kind: "error"; message: string; retry: boolean };

export const EMPTY_DETAIL = "Ask your first question and it will show up here.";
export const EMPTY_TEXT = `No answers yet. ${EMPTY_DETAIL}`;

export interface YourAnswersViewProps {
  state: YourAnswersState;
  onRetry?: () => void;
  /** Takes a row off this browser's list; without it rows have no Remove. */
  onRemove?: (runId: string) => void;
  /** Empties this browser's list; without it the list has no Clear history. */
  onClear?: () => void;
  /** The visitor's time zone by default; fixed in tests. */
  timeZone?: string;
  className?: string;
}

/** Section labels: small caps, tracked, ink-2. */
const SECTION_LABEL = "text-[11px] leading-4 font-semibold tracking-[0.1em] uppercase text-ink-2";

/**
 * The rows of Your answers: two skeleton rows while loading, a calm error with Try again when the list
 * cannot be read, the empty panel with "Ask a question", else one ruled list of AnswerRows under a
 * column head. Presentational: YourAnswers loads.
 */
export function YourAnswersView({ state, onRetry, onRemove, onClear, timeZone, className }: YourAnswersViewProps) {
  if (state.kind === "loading") {
    return (
      <ul
        aria-label="Loading your answers"
        className={cx("m-0 flex list-none flex-col divide-y divide-line overflow-hidden rounded-md border border-line bg-surface p-0", className)}
      >
        {[0, 1].map((i) => (
          <li key={i} className="flex items-center gap-4 px-4 py-4">
            <Skeleton className="size-4 rounded-full" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-[56%]" />
              <Skeleton className="h-3 w-[28%]" />
            </div>
            <Skeleton className="h-3 w-16 max-md:hidden" />
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
  if (state.items.length === 0) {
    return (
      <div className={cx("flex flex-col items-center gap-4 rounded-md border border-line bg-surface motion-safe:animate-rise px-12 pt-[72px] pb-16 text-center max-md:px-6 max-md:py-12", className)}>
        <span className="flex size-10 items-center justify-center rounded-full bg-sunken text-ink-2">
          <Icon name="file-text" size={18} />
        </span>
        <h2 className="m-0 font-display text-[24px] leading-8 font-medium tracking-[-0.3px] text-ink">No answers yet</h2>
        <p className="m-0 max-w-[420px] text-[15px] leading-6 text-ink-2">{EMPTY_DETAIL}</p>
        <ButtonLink variant="primary" size="md" icon="plus" trailing={null} href={NEW_QUESTION_HREF} className="mt-1.5">
          Ask a question
        </ButtonLink>
      </div>
    );
  }
  return <AnswerList items={state.items} now={state.now} timeZone={timeZone} onRemove={onRemove} onClear={onClear} className={className} />;
}

/** Rows shown at first, and added by each Show more. */
const PAGE_SIZE = 12;

const TABS: ReadonlyArray<{ key: AnswerStatus | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "done", label: "Ready" },
  { key: "partial", label: "Partial" },
  { key: "working", label: "Working" },
  { key: "stopped", label: "Stopped" },
];

/** How long a removed row takes to fold away, in ms. */
export const ROW_LEAVE_MS = 200;

/** True when the visitor asked for less motion (or there is no window to ask). */
function prefersReducedMotion(): boolean {
  try {
    return typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return true;
  }
}

/** Clear history: a quiet button whose small confirm says the shared links keep working. */
function ClearHistory({ onClear }: { onClear: () => void }) {
  return (
    <Popover
      label="Clear history"
      width={300}
      placement="bottom-end"
      trigger={(props) => (
        <Button {...props} variant="quiet" size="sm" icon="trash-2">
          Clear history
        </Button>
      )}
    >
      {(close) => (
        <div className="flex flex-col gap-3 p-4">
          <p className="m-0 text-[13px] leading-5 text-ink">Clear all your answers from this list? Shared links keep working.</p>
          <div className="flex justify-end gap-2">
            <Button size="sm" onClick={close}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="destructive"
              onClick={() => {
                close();
                onClear();
              }}
            >
              Clear all
            </Button>
          </div>
        </div>
      )}
    </Popover>
  );
}

const CONTROL = "h-9 rounded-sm border border-line-strong bg-surface text-[12px] leading-4 text-ink";

/** The ready list: search, desk and sort, status tabs with counts, the ruled rows and Show more. */
function AnswerList({
  items,
  now,
  timeZone,
  onRemove,
  onClear,
  className,
}: {
  items: AnswerItem[];
  now: number;
  timeZone?: string;
  onRemove?: (runId: string) => void;
  onClear?: () => void;
  className?: string;
}) {
  const [query, setQuery] = useState("");
  const [desk, setDesk] = useState<Pillar | "all">("all");
  const [oldest, setOldest] = useState(false);
  const [tab, setTab] = useState<AnswerStatus | "all">("all");
  const [shown, setShown] = useState(PAGE_SIZE);
  const [leaving, setLeaving] = useState<ReadonlySet<string>>(() => new Set());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  // The row folds away (opacity and height) before it leaves the list; at once with reduced motion.
  const remove = (runId: string) => {
    if (!onRemove || leaving.has(runId)) return;
    if (prefersReducedMotion()) return onRemove(runId);
    setLeaving((prev) => new Set(prev).add(runId));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      onRemove(runId);
      setLeaving((prev) => {
        const next = new Set(prev);
        next.delete(runId);
        return next;
      });
    }, ROW_LEAVE_MS);
    timers.current.add(timer);
  };

  const q = query.trim().toLowerCase();
  const matching = items.filter((i) => (desk === "all" || i.pillar === desk) && (q === "" || i.question.toLowerCase().includes(q)));
  const counts = (key: AnswerStatus | "all") => (key === "all" ? matching.length : matching.filter((i) => i.status === key).length);
  const inTab = matching.filter((i) => tab === "all" || i.status === tab);
  const ordered = oldest ? [...inTab].reverse() : inTab;
  const visible = ordered.slice(0, shown);
  const total = items.length;
  const desks = TOPIC_KEYS.map((k) => TOPICS[k]).filter((t) => items.some((i) => i.pillar === t.pillar));

  return (
    <div className={cx("flex flex-col gap-5 motion-safe:animate-rise", className)}>
      <div className="flex min-h-8 items-center justify-between gap-3">
        <p className="m-0 font-mono text-[12px] leading-4 text-ink-2 tabular-nums">
          {total} {total === 1 ? "answer" : "answers"}
        </p>
        {onClear ? <ClearHistory onClear={onClear} /> : null}
      </div>
      <div className="flex items-center gap-2 max-md:flex-wrap">
        <label className={cx(CONTROL, "flex min-w-0 flex-1 items-center gap-2 px-2.5 focus-within:border-accent max-md:basis-full")}>
          <Icon name="search" size={14} className="shrink-0 text-ink-2" />
          <span className="sr-only">Search your questions</span>
          <input
            type="search"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE_SIZE);
            }}
            placeholder="Search your questions"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-3"
          />
        </label>
        <label className={cx(CONTROL, "relative flex shrink-0 items-center gap-1.5 pr-2.5 pl-3 max-md:flex-1")}>
          <span className="text-ink-2">Desk</span>
          <select
            value={desk}
            onChange={(e) => {
              setDesk(e.target.value as Pillar | "all");
              setShown(PAGE_SIZE);
            }}
            className="min-w-0 flex-1 cursor-pointer appearance-none bg-transparent pr-5 font-medium text-ink outline-none"
          >
            <option value="all">All desks</option>
            {desks.map((t) => (
              <option key={t.key} value={t.pillar}>
                {t.label}
              </option>
            ))}
          </select>
          <Icon name="chevron-down" size={14} className="pointer-events-none absolute right-2.5 text-ink-2" />
        </label>
        <label className={cx(CONTROL, "relative flex shrink-0 items-center gap-1.5 pr-2.5 pl-3 max-md:flex-1")}>
          <span className="text-ink-2">Sort</span>
          <select
            value={oldest ? "oldest" : "newest"}
            onChange={(e) => setOldest(e.target.value === "oldest")}
            className="min-w-0 flex-1 cursor-pointer appearance-none bg-transparent pr-5 font-medium text-ink outline-none"
          >
            <option value="newest">Newest first</option>
            <option value="oldest">Oldest first</option>
          </select>
          <Icon name="chevron-down" size={14} className="pointer-events-none absolute right-2.5 text-ink-2" />
        </label>
      </div>
      <div role="tablist" aria-label="Status" className="flex items-center gap-6 overflow-x-auto border-b border-line">
        {TABS.map((t) => {
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => {
                setTab(t.key);
                setShown(PAGE_SIZE);
              }}
              className={cx(
                "-mb-px flex shrink-0 cursor-pointer items-center gap-1.5 border-b-2 py-2 text-[13px] leading-5 transition-colors duration-150",
                active ? "border-ink font-semibold text-ink" : "border-transparent font-medium text-ink-2 hover:text-ink",
              )}
            >
              {t.label}
              <span className="font-mono text-[11px] font-normal text-ink-3">{counts(t.key)}</span>
            </button>
          );
        })}
      </div>
      {visible.length === 0 ? (
        <p className="m-0 rounded-md border border-line bg-surface px-4 py-8 text-center text-[14px] text-ink-2 motion-safe:animate-rise">No answers match these filters.</p>
      ) : (
        <div className="overflow-hidden rounded-md border border-line bg-surface">
          <div aria-hidden="true" className="flex items-center gap-4 border-b border-line bg-canvas px-4 py-2 max-md:hidden">
            <span className="w-4 shrink-0" />
            <span className={cx("flex-1", SECTION_LABEL)}>Question</span>
            <span className={cx("w-[100px] shrink-0", SECTION_LABEL)}>Confidence</span>
            <span className={cx("w-[90px] shrink-0", SECTION_LABEL)}>Date</span>
            <span className="w-[108px] shrink-0" />
          </div>
          <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
            {visible.map((item, i) => {
              const gone = leaving.has(item.runId);
              return (
                <li
                  key={item.runId}
                  data-leaving={gone ? "true" : undefined}
                  className={cx(
                    "group/row grid transition-[grid-template-rows,opacity] duration-200 ease-out motion-reduce:transition-none",
                    gone ? "grid-rows-[0fr] opacity-0" : "grid-rows-[1fr] opacity-100",
                  )}
                >
                  <div className="relative min-h-0 overflow-hidden motion-safe:animate-rise" style={{ animationDelay: `${Math.min(i % PAGE_SIZE, 8) * 25}ms` }}>
                    <AnswerRow item={item} day={relativeDay(item.createdAt, now, timeZone)} className={onRemove ? "max-md:pr-[76px]" : undefined} />
                    {onRemove ? (
                      <button
                        type="button"
                        onClick={() => remove(item.runId)}
                        disabled={gone}
                        aria-label={`Remove from your answers: ${item.question}`}
                        title="Remove from your answers"
                        className={cx(
                          "absolute top-1/2 right-10 flex size-8 -translate-y-1/2 cursor-pointer items-center justify-center rounded-sm text-ink-3",
                          "transition-colors duration-150 hover:bg-sunken hover:text-danger active:bg-line max-md:top-2.5 max-md:right-8 max-md:size-9 max-md:translate-y-0",
                        )}
                      >
                        <Icon name="trash-2" size={15} />
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <div className="flex flex-col items-center gap-3 pt-2">
        <p className="m-0 font-mono text-[12px] leading-4 text-ink-2 tabular-nums">
          Showing {visible.length} of {ordered.length}
        </p>
        {ordered.length > visible.length ? (
          <Button size="sm" icon="chevron-down" onClick={() => setShown((n) => n + PAGE_SIZE)}>
            Show {Math.min(PAGE_SIZE, ordered.length - visible.length)} more
          </Button>
        ) : null}
        {total >= RECENT_BRIEFS_MAX ? (
          <p className="m-0 text-center text-[12px] leading-4 text-ink-3">Latest {RECENT_BRIEFS_MAX} only. Older answers stay at their links.</p>
        ) : null}
      </div>
    </div>
  );
}

/** How long the Removed toast (with its Undo) stays, in ms. */
export const UNDO_MS = 6000;

/** The last row removed, so Undo can put it back where it was. */
interface Removed {
  item: AnswerItem;
  /** Its place among the loaded rows. */
  at: number;
  /** Its place in this browser's stored list, or -1 when it was not stored. */
  storedAt: number;
}

/** Your answers, loaded in the browser: only it knows which runs it started. */
export function YourAnswers({ className }: { className?: string }) {
  const [state, setState] = useState<YourAnswersState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [removed, setRemoved] = useState<Removed | null>(null);
  // The rows as last rendered: a remove fires after the row's fold-away, from an older render.
  const current = useRef(state);
  useEffect(() => {
    current.current = state;
  }, [state]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setRemoved(null);
  }, []);
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    loadYourAnswers(readRecentRunIds(), { signal: controller.signal })
      .then((items) => setState({ kind: "ready", items, now: Date.now() }))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        const retry = err instanceof BriefsError ? err.retry : true;
        setState({ kind: "error", message: "Your answers couldn't be loaded.", retry });
      });
    return () => controller.abort();
  }, [attempt]);

  const undo = () => {
    if (!removed) return;
    const { item, at, storedAt } = removed;
    if (storedAt !== -1) restoreRun(item.runId, storedAt);
    setState((prev) => {
      if (prev.kind !== "ready" || prev.items.some((i) => i.runId === item.runId)) return prev;
      const items = [...prev.items];
      items.splice(Math.min(at, items.length), 0, item);
      return { ...prev, items };
    });
    dismiss();
  };

  return (
    <>
      <YourAnswersView
        state={state}
        className={className}
        onRemove={(runId) => {
          const now = current.current;
          if (now.kind !== "ready") return;
          const at = now.items.findIndex((i) => i.runId === runId);
          const item = now.items[at];
          if (item === undefined) return;
          const storedAt = forgetRun(runId);
          setState((prev) => (prev.kind === "ready" ? { ...prev, items: prev.items.filter((i) => i.runId !== runId) } : prev));
          setRemoved({ item, at, storedAt });
          if (timer.current) clearTimeout(timer.current);
          timer.current = setTimeout(() => {
            timer.current = null;
            setRemoved(null);
          }, UNDO_MS);
        }}
        onClear={() => {
          clearRecentRuns();
          dismiss();
          setState((prev) => (prev.kind === "ready" ? { ...prev, items: [] } : prev));
        }}
        onRetry={() => {
          setState({ kind: "loading" });
          setAttempt((n) => n + 1);
        }}
      />
      <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-6 z-[60] flex justify-center px-4">
        {removed ? (
          <Toast className="pointer-events-auto motion-safe:animate-rise">
            Removed from your answers
            <button
              type="button"
              onClick={undo}
              className="ml-3 cursor-pointer rounded-xs px-1.5 py-1 font-semibold text-white underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-white"
            >
              Undo
            </button>
          </Toast>
        ) : null}
      </div>
    </>
  );
}
