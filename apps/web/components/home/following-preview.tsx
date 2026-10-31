"use client";

import Link from "next/link";
import { useSyncExternalStore } from "react";
import { FOLLOWING_HREF } from "../chrome/links";
import { useFollows } from "../following/follow-button";
import { followRowModel, RERUN_IDLE } from "../following/model";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";

const noSubscription = () => () => {};
const currentMinute = () => Math.floor(Date.now() / 60_000) * 60_000;
const noClock = () => null;

/** How many follows Home lists; the rest are on Following. */
export const FOLLOWING_PREVIEW_MAX = 3;

/**
 * Following, under the recent answers: this browser's newest follows with their latest note, and a link
 * to the page. Nothing for a visitor who follows nothing (or whose follows cannot be read here: Following
 * says why), so a first visit shows only the question.
 */
export function FollowingPreview({ className }: { className?: string }) {
  const state = useFollows();
  // The clock is read on the client only (null on the server), to the minute so the snapshot stays stable.
  const now = useSyncExternalStore(noSubscription, currentMinute, noClock);

  if (state.kind !== "ready" || state.follows.length === 0 || now === null) return null;
  const rows = state.follows.slice(0, FOLLOWING_PREVIEW_MAX).map((follow) => followRowModel(follow, RERUN_IDLE, now));
  return (
    <section aria-labelledby="following-preview-title" className={cx("flex animate-rise flex-col", className)}>
      <div className="flex items-end justify-between gap-4 border-b border-ink pb-3.5">
        <h2 id="following-preview-title" className="m-0 font-display text-[28px] leading-9 font-normal text-ink max-md:text-[24px] max-md:leading-8">
          Following
        </h2>
        <Link href={FOLLOWING_HREF} className="inline-flex shrink-0 items-center gap-1 text-[12px] leading-4 font-medium text-accent transition-colors duration-150 hover:text-accent-hover">
          Open Following
          <Icon name="arrow-right" size={13} />
        </Link>
      </div>
      <ul className="m-0 flex list-none flex-col p-0">
        {rows.map((row, i) => {
          const kind = row.jobLabel ? `${row.kindLabel} · ${row.jobLabel}` : row.kindLabel;
          const reading = row.note ? (row.note.headline ?? row.note.text) : "No note yet";
          const body = (
            <>
              <span className="flex w-[220px] shrink-0 flex-col gap-0.5 max-md:w-full">
                <span className="truncate text-[13px] leading-5 font-semibold text-ink">{row.label}</span>
                <span className="text-[12px] leading-4 text-ink-2">{kind}</span>
              </span>
              <span className="min-w-0 flex-1 text-[13px] leading-5 text-ink-2 max-md:line-clamp-2">{reading}</span>
              {row.note ? <span className="shrink-0 font-mono text-[12px] leading-4 text-ink-2">read {row.note.day}</span> : null}
            </>
          );
          return (
            <li key={row.id} className="animate-rise border-b border-line" style={{ animationDelay: `${i * 40}ms` }}>
              {row.note ? (
                <Link href={row.note.href} className="flex items-center gap-4 py-3 transition-colors duration-150 hover:bg-surface active:bg-sunken/60 max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-1">
                  {body}
                </Link>
              ) : (
                <div className="flex items-center gap-4 py-3 max-md:flex-wrap max-md:gap-x-3 max-md:gap-y-1">{body}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
