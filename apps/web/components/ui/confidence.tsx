"use client";

import type { ConfidenceBand } from "@ct/contracts";
import { cx } from "./cx";
import { Icon } from "./icons";
import { Popover } from "./popover";

/** A conviction band, or "not enough data" (signal insufficient_evidence), which has no popover. */
export type ConfidenceLevel = ConfidenceBand | "insufficient_evidence";

export const CONFIDENCE_LABEL: Readonly<Record<ConfidenceLevel, string>> = {
  HIGH: "High confidence",
  MED: "Medium confidence",
  LOW: "Low confidence",
  insufficient_evidence: "Not enough data",
};

const DOT: Readonly<Record<ConfidenceLevel, string>> = {
  HIGH: "bg-good",
  MED: "bg-caution",
  LOW: "bg-ink-3",
  insufficient_evidence: "bg-ink-3",
};

/** The fixed explainer: confidence rates the data, set by rules, not by the AI. */
export const CONFIDENCE_EXPLAINER =
  "Scored by fixed rules from how complete and fresh the data is, not by the AI. It rates the data, not the chance the answer is right.";

/** "Lowered by: a; b." or null when nothing lowered it. */
export function loweredByText(reasons: readonly string[]): string | null {
  const kept = reasons.map((r) => r.trim().replace(/[.;]+$/u, "")).filter((r) => r !== "");
  return kept.length === 0 ? null : `Lowered by: ${kept.join("; ")}.`;
}

const CHIP =
  "inline-flex h-8 shrink-0 items-center gap-2 rounded-chip border border-line-strong bg-surface px-3 text-[14px] leading-5 font-medium text-ink";

export interface ConfidencePopoverBodyProps {
  level: ConfidenceBand;
  /** The labels of the conviction penalties (`conviction.why`). */
  lowered?: readonly string[];
  /** Opens the drawer's Method tab. Without it the link is left out. */
  onFullBreakdown?: () => void;
}

/** The popover's content: title, explainer, what lowered it, and the link to the full breakdown. */
export function ConfidencePopoverBody({ level, lowered = [], onFullBreakdown }: ConfidencePopoverBodyProps) {
  const loweredLine = loweredByText(lowered);
  return (
    <div className="flex flex-col gap-2">
      <p className="text-[15px] leading-6 font-semibold text-ink">{CONFIDENCE_LABEL[level]}</p>
      <p className="type-body text-ink-2">{CONFIDENCE_EXPLAINER}</p>
      {loweredLine ? <p className="type-body text-ink">{loweredLine}</p> : null}
      {onFullBreakdown ? (
        <button
          type="button"
          onClick={onFullBreakdown}
          className="inline-flex items-center gap-1.5 self-start rounded-sm text-[15px] leading-6 font-medium text-accent hover:underline hover:underline-offset-4"
        >
          Full breakdown in How we know
          <Icon name="arrow-right" size={14} />
        </button>
      ) : null}
    </div>
  );
}

export interface ConfidenceChipProps {
  level: ConfidenceLevel;
  lowered?: readonly string[];
  onFullBreakdown?: () => void;
  className?: string;
}

/**
 * C/ConfidenceChip: 32 tall, a coloured dot and the band's words, with a chevron that opens the
 * ConfidencePopover. "Not enough data" is a plain chip: nothing to explain.
 */
export function ConfidenceChip({ level, lowered, onFullBreakdown, className }: ConfidenceChipProps) {
  const dot = <span aria-hidden="true" className={cx("size-2 shrink-0 rounded-full", DOT[level])} />;
  if (level === "insufficient_evidence") {
    return (
      <span data-confidence={level} className={cx(CHIP, className)}>
        {dot}
        {CONFIDENCE_LABEL[level]}
      </span>
    );
  }
  return (
    <Popover
      label={CONFIDENCE_LABEL[level]}
      triggerClassName={cx(CHIP, "transition-colors hover:border-ink-3", className)}
      trigger={
        <>
          {dot}
          <span data-confidence={level}>{CONFIDENCE_LABEL[level]}</span>
          <Icon name="chevron-down" size={14} className="text-ink-2" />
        </>
      }
    >
      {(close) => (
        <ConfidencePopoverBody
          level={level}
          lowered={lowered}
          onFullBreakdown={
            onFullBreakdown
              ? () => {
                  close();
                  onFullBreakdown();
                }
              : undefined
          }
        />
      )}
    </Popover>
  );
}
