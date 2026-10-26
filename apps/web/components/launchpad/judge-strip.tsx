import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "../ui/cx";
import { SectionHead } from "../ui/section-head";
import { AskFocusLink } from "./ask-focus-link";
import { ACTION_LINK, ASK_ANCHOR, noteHref, replayHref } from "./links";
import type { PinnedTile } from "./tiles";

export interface JudgeStripProps {
  /** The showcase steps 1 and 2 open (judgeTile); null while none is pinned, so those steps have no link yet. */
  showcase: PinnedTile | null;
  className?: string;
}

interface Step {
  n: number;
  title: string;
  /** When a judge gets there, from the moment the page opens. */
  at: string;
  text: string;
  action: ReactNode;
}

/** What steps 1 and 2 say while no showcase is pinned. */
export const JUDGE_NOT_PINNED = "Opens once a showcase is pinned.";

/**
 * JUDGE IN 60 SECONDS (PLAN §8.1): 1. open a finished note, 2. watch the agent's run replay, 3. ask a
 * question live. Three columns from 768 px, hairlines between them; no login anywhere.
 */
export function JudgeStrip({ showcase, className }: JudgeStripProps) {
  const runId = showcase?.card.runId ?? null;
  const missing = <span className="text-[12px] leading-4 text-dim">{JUDGE_NOT_PINNED}</span>;
  const steps: Step[] = [
    {
      n: 1,
      title: "Open a note",
      at: "0 s",
      text: "A finished brief, answer first. Every number is footnoted to the Qloo request behind it.",
      action:
        runId && showcase ? (
          <Link href={noteHref(runId)} className={ACTION_LINK} data-judge-step="note">
            Read “{showcase.showcase.label}”
          </Link>
        ) : (
          missing
        ),
    },
    {
      n: 2,
      title: "Watch a replay",
      at: "20 s",
      text: "The same run played back from its stored events: the plan, each Qloo call, the analyst’s pivot. No new requests, no cost.",
      action: runId ? (
        <Link href={replayHref(runId)} className={ACTION_LINK} data-judge-step="replay">
          Watch the replay
        </Link>
      ) : (
        missing
      ),
    },
    {
      n: 3,
      title: "Ask live",
      at: "~90 s",
      text: "Your own question, no login. It is read and its Qloo requests estimated before anything runs.",
      action: (
        <AskFocusLink target={ASK_ANCHOR} className={ACTION_LINK}>
          Ask a question
        </AskFocusLink>
      ),
    },
  ];
  return (
    <section aria-label="Judge in 60 seconds" className={cx("flex w-full flex-col", className)}>
      <SectionHead title="Judge in 60 seconds" aside="No login · replays make no Qloo requests" />
      <ol className="m-0 grid list-none grid-cols-1 gap-y-6 p-0 pt-5 md:grid-cols-3">
        {steps.map((step) => (
          <li
            key={step.n}
            className="flex min-w-0 flex-col gap-2 md:border-l md:border-line md:px-6 md:first:border-l-0 md:first:pl-0 md:last:pr-0"
          >
            <p className="m-0 flex items-baseline gap-3">
              <span className="type-key-figure text-ink" aria-hidden="true">
                {step.n}
              </span>
              <span className="text-[15px] leading-5 font-medium text-ink">
                <span className="sr-only">Step {step.n}: </span>
                {step.title}
              </span>
              <span className="ml-auto font-mono text-[11px] text-dim">{step.at}</span>
            </p>
            <p className="m-0 text-[13px] leading-[19px] text-text-2">{step.text}</p>
            <p className="m-0 mt-auto pt-1">{step.action}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}
