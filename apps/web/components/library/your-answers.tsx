"use client";

import { useEffect, useState } from "react";
import { readRecentRunIds } from "../../lib/recent-briefs";
import { NEW_QUESTION_HREF } from "../chrome/links";
import { Button, ButtonLink } from "../ui/button";
import { cx } from "../ui/cx";
import { Icon, type IconName } from "../ui/icons";
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

/** Section labels: small caps, tracked, ink-3. */
const SECTION_LABEL = "text-[11px] leading-4 font-semibold tracking-[0.1em] uppercase text-ink-3";

/**
 * The rows of Your answers: two skeleton rows while loading, a calm error with Try again when the list
 * cannot be read, the empty panel with "Ask a question", else one ruled list of AnswerRows under a
 * column head. Presentational: YourAnswers loads.
 */
export function YourAnswersView({ state, onRetry, timeZone, className }: YourAnswersViewProps) {
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
      <div className={cx("flex flex-col items-center gap-5 rounded-md border border-line bg-surface px-6 py-16 text-center max-md:py-12", className)}>
        <span className="flex size-10 items-center justify-center rounded-sm bg-sunken text-ink-2">
          <Icon name="file-text" size={20} />
        </span>
        <p className="m-0 max-w-[420px] type-body text-ink-2">{EMPTY_TEXT}</p>
        <ButtonLink variant="primary" size="sm" href={NEW_QUESTION_HREF}>
          Ask a question
        </ButtonLink>
      </div>
    );
  }
  const count = state.items.length;
  return (
    <div className={cx("flex flex-col gap-3", className)}>
      <p className="m-0 font-mono text-[12px] leading-4 text-ink-3">
        {count} {count === 1 ? "answer" : "answers"} · newest first
      </p>
      <div className="overflow-hidden rounded-md border border-line bg-surface">
        <div aria-hidden="true" className="flex items-center gap-4 border-b border-line bg-canvas px-4 py-2 max-md:hidden">
          <span className="w-4 shrink-0" />
          <span className={cx("flex-1", SECTION_LABEL)}>Question</span>
          <span className={cx("w-[96px] shrink-0", SECTION_LABEL)}>Date</span>
          <span className="w-4 shrink-0" />
        </div>
        <ul className="m-0 flex list-none flex-col divide-y divide-line p-0">
          {state.items.map((item) => (
            <li key={item.runId}>
              <AnswerRow item={item} day={relativeDay(item.createdAt, state.now, timeZone)} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const STATUS_KEY: ReadonlyArray<{ icon: IconName; tone: string; title: string; text: string }> = [
  { icon: "circle-check", tone: "text-good", title: "Ready", text: "Finished. Open it to read the answer." },
  { icon: "triangle-alert", tone: "text-caution", title: "Partial", text: "Ended early. Some parts are missing." },
  { icon: "loader-circle", tone: "text-accent", title: "Working", text: "Still running. Open it to watch." },
  { icon: "circle-x", tone: "text-ink-3", title: "Stopped", text: "Stopped, declined, not finished or waiting for your input." },
];

/** The margin notes beside the list: what each status means and where the list lives. */
export function YourAnswersNotes({ className }: { className?: string }) {
  return (
    <aside aria-label="About this list" className={cx("flex flex-col gap-10", className)}>
      <section className="flex flex-col gap-3">
        <h2 className={cx("m-0", SECTION_LABEL)}>Status</h2>
        {STATUS_KEY.map((s) => (
          <div key={s.title} className="flex items-start gap-2.5">
            <Icon name={s.icon} size={14} className={cx("mt-0.5 shrink-0", s.tone)} />
            <div className="flex flex-col gap-0.5">
              <span className="type-label font-semibold text-ink">{s.title}</span>
              <span className="type-label font-normal text-ink-3">{s.text}</span>
            </div>
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-3">
        <h2 className={cx("m-0", SECTION_LABEL)}>Where this list lives</h2>
        <p className="m-0 type-label font-normal text-ink-3">
          On this browser only. Clearing site data empties it, and it does not follow you to another device. Other people never see this
          list.
        </p>
      </section>
    </aside>
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
