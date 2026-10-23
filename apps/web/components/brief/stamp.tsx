import type { CacheStatus } from "@ct/contracts";
import { cx } from "../ui";
import styles from "./brief.module.css";

/** The stamp word per cache status (PLAN §8.3): served from cache, reused from another run, fetched live. */
export const STAMP_WORD: Readonly<Record<CacheStatus, string>> = {
  hit: "CACHE",
  coalesced: "CACHE",
  reused: "REUSED",
  miss: "LIVE",
  stale: "STALE",
};

const TONE: Readonly<Record<CacheStatus, string>> = {
  hit: "border-line-strong text-dim",
  coalesced: "border-line-strong text-dim",
  reused: "border-accent-soft bg-accent-soft text-accent",
  miss: "border-accent text-accent",
  stale: "border-negative-soft bg-negative-soft text-negative",
};

/**
 * A request stamp: CACHE, REUSED, LIVE or STALE in mono small caps. `flash` plays the landing flash once
 * (a call that arrived while the page was open); reduced motion keeps it still.
 */
export function RequestStamp({ cache, flash = false, className }: { cache: CacheStatus; flash?: boolean; className?: string }) {
  return (
    <span
      data-stamp={STAMP_WORD[cache]}
      className={cx(
        "inline-flex h-[15px] shrink-0 items-center rounded-brief border px-1 font-mono text-[9.5px] leading-none font-medium tracking-[0.6px]",
        TONE[cache],
        flash && styles.flash,
        className,
      )}
    >
      {STAMP_WORD[cache]}
    </span>
  );
}
