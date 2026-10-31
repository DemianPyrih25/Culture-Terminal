"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { readRecentRunIds } from "../../lib/recent-briefs";
import { ANSWERS_HREF } from "../chrome/links";
import { AnswerRow } from "../library/answer-row";
import { loadYourAnswers, relativeDay, type AnswerItem } from "../library/answers";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { Skeleton } from "../ui/skeleton";

/** How many of the visitor's answers Home lists; the rest are on Your answers. */
export const RECENT_ANSWERS_MAX = 5;

type RecentState = { kind: "none" } | { kind: "loading" } | { kind: "ready"; items: AnswerItem[]; now: number } | { kind: "error" };

/**
 * Your recent answers, under the question box: this browser's newest answers (only it knows which runs
 * it started), with a link to all of them. Nothing at all for a visitor with no answers yet, so a first
 * visit shows only the question; a quiet line when the list cannot be read.
 */
export function RecentAnswers({ className }: { className?: string }) {
  const [state, setState] = useState<RecentState>({ kind: "none" });

  useEffect(() => {
    const ids = readRecentRunIds();
    if (ids.length === 0) return;
    const controller = new AbortController();
    setState({ kind: "loading" });
    loadYourAnswers(ids, { signal: controller.signal })
      .then((items) => setState(items.length === 0 ? { kind: "none" } : { kind: "ready", items: items.slice(0, RECENT_ANSWERS_MAX), now: Date.now() }))
      .catch(() => {
        if (!controller.signal.aborted) setState({ kind: "error" });
      });
    return () => controller.abort();
  }, []);

  if (state.kind === "none") return null;
  return (
    <section aria-labelledby="recent-answers-title" className={cx("flex flex-col", className)}>
      <div className="flex items-end justify-between gap-4 border-b border-ink pb-3.5">
        <h2 id="recent-answers-title" className="m-0 type-title-l text-ink max-md:type-title-l-sm">
          Your recent answers
        </h2>
        <Link href={ANSWERS_HREF} className="inline-flex shrink-0 items-center gap-1 type-label text-accent hover:text-accent-hover">
          All your answers
          <Icon name="arrow-right" size={13} />
        </Link>
      </div>
      {state.kind === "loading" ? (
        <ul aria-label="Loading your answers" className="m-0 flex list-none flex-col p-0">
          {[0, 1].map((i) => (
            <li key={i} className="flex h-16 items-center gap-4 border-b border-line">
              <Skeleton className="h-4 w-[52%]" />
              <Skeleton className="ml-auto h-3 w-14" />
            </li>
          ))}
        </ul>
      ) : state.kind === "error" ? (
        <p className="m-0 py-4 type-body text-ink-2">Your answers couldn&apos;t be loaded here. They are still on Your answers.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0 pt-3">
          {state.items.map((item) => (
            <li key={item.runId}>
              <AnswerRow item={item} day={relativeDay(item.createdAt, state.now)} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
