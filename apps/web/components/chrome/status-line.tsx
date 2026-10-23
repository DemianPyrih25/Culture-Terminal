import type { ReactNode } from "react";
import { PAGE_GUTTER } from "../layout/grid";
import { cx } from "../ui/cx";

/** The fixed honesty line (PLAN §2.4); the snapshot date is appended when known. */
export const HONESTY_LINE = "Analytics, not financial advice · Group-level taste data · No individuals";

/** The honesty line short enough for one line on a phone, where it stays in view. */
export const HONESTY_SHORT = "Not financial advice · Group-level · No individuals";

/** "Analytics, not financial advice · … · Snapshot 6 Jul 2026". */
export function honestyText(snapshot?: string | null): string {
  return snapshot ? `${HONESTY_LINE} · Snapshot ${snapshot}` : HONESTY_LINE;
}

/** "Qloo 12 req · 5 cached". */
export function qlooRequestsText(total: number, cached: number): string {
  return `Qloo ${total} req · ${cached} cached`;
}

export interface StatusLineProps {
  /** Snapshot date for the honesty line, e.g. "6 Jul 2026". */
  snapshot?: string | null;
  /** Trend window, e.g. "Jan–Jun 2026"; printed as "Trend window Jan–Jun 2026". */
  trendWindow?: string | null;
  /** Qloo requests: counts, or a ready string such as "Qloo 87 / 1,900 req today". Printed in mono. */
  requests?: { total: number; cached: number } | string | null;
  /** Replaces the left text (the honesty line). */
  left?: ReactNode;
  /** Replaces the right texts (trend window and requests). */
  right?: ReactNode;
  /**
   * The one line that stays in view below 768 px while the whole status line follows the page. Default
   * HONESTY_SHORT, or nothing when `left` replaces the honesty line.
   */
  compact?: ReactNode;
  /** Sticks to the viewport bottom (default true): the disclaimer stays in view. */
  sticky?: boolean;
  className?: string;
}

/** The compact line's height: one 15 px line and its padding over the hairline. */
const COMPACT_HEIGHT = "h-7";

/**
 * A/Status line: 32 px on canvas under a hairline. Left, the honesty line with the snapshot date; right,
 * the trend window and the Qloo request count in mono.
 *
 * Below 768 px the whole line wraps to three, too tall to pin over a phone's page: it follows the page
 * instead, and a one-line `compact` strip (HONESTY_SHORT) stays pinned in its place. At the end of the
 * page the status line slides over the strip, so the two never show at once.
 */
export function StatusLine({ snapshot, trendWindow, requests, left, right, compact, sticky = true, className }: StatusLineProps) {
  const requestText =
    requests === null || requests === undefined
      ? null
      : typeof requests === "string"
        ? requests
        : qlooRequestsText(requests.total, requests.cached);
  const rightContent =
    right ??
    (trendWindow || requestText ? (
      <>
        {trendWindow ? <span>Trend window {trendWindow}</span> : null}
        {requestText ? <span className="font-mono">{requestText}</span> : null}
      </>
    ) : null);
  const strip = sticky ? (compact ?? (left === undefined ? HONESTY_SHORT : null)) : null;
  return (
    <>
      {strip ? (
        // The status line below says all of this to a screen reader; the strip only keeps it in view.
        <div
          aria-hidden="true"
          className={cx(
            "sticky bottom-0 z-30 truncate border-t border-line bg-canvas py-1.5 text-[11px] leading-[15px] text-dim md:hidden",
            COMPACT_HEIGHT,
            PAGE_GUTTER,
            className,
          )}
          data-status-strip="true"
        >
          {strip}
        </div>
      ) : null}
      <footer
        className={cx(
          "z-30 flex w-full flex-col gap-x-6 gap-y-1 border-t border-line bg-canvas py-2 text-[11px] leading-[15px] text-dim",
          "md:min-h-8 md:flex-row md:items-center md:py-[7px]",
          PAGE_GUTTER,
          // With a strip, it rests over the strip's place at the end of the page (same layer, later, so on top).
          strip ? "relative -mt-7 md:sticky md:bottom-0 md:mt-0" : sticky && "sticky bottom-0",
          className,
        )}
      >
        <p className="min-w-0 flex-1">{left ?? honestyText(snapshot)}</p>
        {rightContent ? <p className="flex shrink-0 flex-wrap gap-x-6 gap-y-1">{rightContent}</p> : null}
      </footer>
    </>
  );
}
