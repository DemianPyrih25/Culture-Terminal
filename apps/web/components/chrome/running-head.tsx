import type { ReactNode } from "react";
import { GRID_COLUMNS_XL } from "../layout/grid";
import { cx } from "../ui/cx";
import { MiniMeter } from "../ui/mini-meter";

export interface RunningHeadProps {
  /** The desk (pillar), e.g. "Investment". */
  desk: string;
  /** The job, e.g. "Competitors". */
  job: string;
  /** The question, in serif. */
  question: string;
  /** The finding tag in accent small caps, e.g. the signal or the one-line finding. */
  finding?: string;
  /** The sidenote-column slot: conviction, export and share. */
  right?: ReactNode;
  /** Sticks under the top bar (default true): 56 px down from 768 px, at the top below. */
  sticky?: boolean;
  className?: string;
}

/**
 * The brief bar: a 44 px sticky band under the top bar that keeps the question in view. Its three parts
 * sit on the brief grid at ≥1280 px: desk · job over the outline, the question and the finding tag over
 * the reading column, and the right slot over the sidenotes. Below 768 px only the question and the slot
 * remain.
 */
export function RunningHead({ desk, job, question, finding, right, sticky = true, className }: RunningHeadProps) {
  return (
    <div
      className={cx(
        "z-20 flex h-11 w-full items-center gap-4 border-b border-line bg-paper px-4",
        // 768–1279: desk over the outline (200), the question from the reading column on, the slot last.
        "md:grid md:grid-cols-[200px_minmax(0,1fr)_auto] md:gap-x-[60px] md:px-[max(24px,calc((100%-940px)/2))]",
        "xl:gap-x-0 xl:px-0",
        GRID_COLUMNS_XL,
        sticky && "sticky top-0 md:top-14",
        className,
      )}
    >
      <p className="hidden truncate pl-[14px] text-[10px] leading-none font-semibold tracking-[1.2px] text-dim uppercase md:block xl:col-start-2">
        {desk} · {job}
      </p>
      <div className="flex min-w-0 flex-1 items-center gap-3 xl:col-start-4">
        <p className="min-w-0 truncate font-serif text-[16px] leading-tight font-medium text-ink" title={question}>
          {question}
        </p>
        {finding ? (
          <p
            className="ml-auto hidden max-w-[260px] shrink-0 truncate text-[11px] leading-[14px] font-semibold tracking-[1.3px] text-accent uppercase md:block"
            title={finding}
          >
            {finding}
          </p>
        ) : null}
      </div>
      {right ? <div className="flex shrink-0 items-center gap-2 xl:col-start-6 xl:w-full">{right}</div> : null}
    </div>
  );
}

export interface ConvictionMarkProps {
  /** "High", "Medium" or "Low"; null while pending. */
  band: string | null;
  /** 0–100; null while pending (the meter stays empty, never 0). */
  score: number | null;
  /** Hides the CONVICTION label and the meter below 1280 px (default true), so the question keeps the room. */
  compact?: boolean;
  className?: string;
}

/** The running head's conviction: CONVICTION High · 72 and a 60 px meter. */
export function ConvictionMark({ band, score, compact = true, className }: ConvictionMarkProps) {
  return (
    <span className={cx("inline-flex items-center gap-2 whitespace-nowrap", className)}>
      <span
        className={cx(
          "text-[11px] leading-none font-semibold tracking-[1.3px] text-dim uppercase",
          compact && "max-xl:sr-only",
        )}
      >
        Conviction
      </span>
      <span className="text-[13px] leading-none font-medium text-ink">
        {band === null || score === null ? "Pending" : `${band} · ${score}`}
      </span>
      <MiniMeter value={score} label="Conviction" className={compact ? "max-xl:hidden" : "max-md:hidden"} />
    </span>
  );
}
