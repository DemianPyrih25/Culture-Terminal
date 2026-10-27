"use client";

import { useEffect, useState } from "react";
import { readRecentRunIds } from "../../lib/recent-briefs";
import { NEW_QUESTION_HREF } from "../chrome/links";
import { Button, ButtonLink } from "../ui/button";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { InlineState } from "../ui/inline-state";
import { Skeleton } from "../ui/skeleton";
import { AnswerRow } from "./answer-row";
import { BriefsError, loadYourAnswers, relativeDay, type AnswerItem } from "./answers";

/** What the list shows: the rows, or why there are none yet. */
export type YourAnswersState =
  | { kind: "loading" }
  | { kind: "ready"; items: AnswerItem[]; now: number }
  | { kind: "error"; message: string; retry: boolean };

export const EMPTY_TEXT = "No answers yet. Ask your first question and it will show up here.";

export interface YourAnswersViewProps {
  state: YourAnswersState;
  onRetry?: () => void;
  /** The visitor's time zone by default; fixed in tests. */
  timeZone?: string;
  className?: string;
}

/**
 * The rows of Your answers (N13, N16 tile 8): two skeleton rows while loading, a neutral state with Try
 * again when the list cannot be read, the empty well with "Ask a question", else the AnswerRows.
 * Presentational: YourAnswers loads.
 */
export function YourAnswersView({ state, onRetry, timeZone, className }: YourAnswersViewProps) {
  if (state.kind === "loading") {
    return (
      <ul aria-label="Loading your answers" className={cx("m-0 flex list-none flex-col gap-2 p-0", className)}>
        {[0, 1].map((i) => (
          <li key={i} className="flex h-16 items-center gap-4 rounded-control border border-line bg-surface px-5 shadow-xs">
            <Skeleton className="size-[18px] rounded-full" />
            <Skeleton className="h-4 w-[46%]" />
            <Skeleton className="ml-auto h-3 w-16" />
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
  if (state.items.length === 0) {
    return (
      <div className={cx("flex flex-col items-center gap-4 rounded-tile bg-sunken p-6 py-12 text-center", className)}>
        <Icon name="file-text" size={32} className="text-ink-3" />
        <p className="m-0 type-body text-ink-2">{EMPTY_TEXT}</p>
        <ButtonLink variant="primary" href={NEW_QUESTION_HREF}>
          Ask a question
        </ButtonLink>
      </div>
    );
  }
  return (
    <ul className={cx("m-0 flex list-none flex-col gap-2 p-0", className)}>
      {state.items.map((item) => (
        <li key={item.runId}>
          <AnswerRow item={item} day={relativeDay(item.createdAt, state.now, timeZone)} />
        </li>
      ))}
    </ul>
  );
}

/** Your answers, loaded in the browser: only it knows which runs it started. */
export function YourAnswers({ className }: { className?: string }) {
  const [state, setState] = useState<YourAnswersState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

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

  return (
    <YourAnswersView
      state={state}
      className={className}
      onRetry={() => {
        setState({ kind: "loading" });
        setAttempt((n) => n + 1);
      }}
    />
  );
}
