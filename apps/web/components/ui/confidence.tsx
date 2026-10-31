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

/** Badge tint and text, the meter's filled bar colour and how many of its three bars fill. */
const TONE: Readonly<Record<ConfidenceLevel, { badge: string; bar: string; filled: number }>> = {
  HIGH: { badge: "bg-good-soft text-good-ink", bar: "bg-good", filled: 3 },
  MED: { badge: "bg-caution-soft text-caution-ink", bar: "bg-caution", filled: 2 },
  LOW: { badge: "bg-sunken text-ink-2", bar: "bg-ink-2", filled: 1 },
  insufficient_evidence: { badge: "bg-sunken text-ink-3", bar: "bg-ink-3", filled: 0 },
};

/** The three-bar meter (6, 9, 12 px): it mirrors the band, so colour is never the only cue. */
function Meter({ level }: { level: ConfidenceLevel }) {
  const t = TONE[level];
  return (
    <span aria-hidden="true" className="inline-flex items-end gap-[2px]">
      {[6, 9, 12].map((h, i) => (
        <span
          key={h}
          style={{ height: h }}
          className={cx("w-[3px] rounded-[1px]", i < t.filled ? t.bar : "bg-line-strong")}
        />
      ))}
    </span>
  );
}

/** The fixed explainer: confidence rates the data, set by rules, not by the AI. */
export const CONFIDENCE_EXPLAINER =
  "Scored by fixed rules from how complete and fresh the data is, not by the AI. It rates the data, not the chance the answer is right.";

/** "Lowered by: a; b." or null when nothing lowered it. */
export function loweredByText(reasons: readonly string[]): string | null {
  const kept = reasons.map((r) => r.trim().replace(/[.;]+$/u, "")).filter((r) => r !== "");
  return kept.length === 0 ? null : `Lowered by: ${kept.join("; ")}.`;
}

const CHIP =
  "inline-flex h-7 shrink-0 items-center gap-2 rounded-sm px-2 text-[11px] leading-4 font-semibold tracking-[0.06em] whitespace-nowrap uppercase";

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
      <p className="flex items-center gap-2 type-body-strong text-ink">
        <Meter level={level} />
        {CONFIDENCE_LABEL[level]}
      </p>
      <p className="type-body text-ink-2">{CONFIDENCE_EXPLAINER}</p>
      {loweredLine ? <p className="type-body text-ink">{loweredLine}</p> : null}
      {onFullBreakdown ? (
        <button
          type="button"
          onClick={onFullBreakdown}
          className="mt-1 inline-flex items-center gap-1.5 self-start rounded-xs text-[14px] leading-5 font-medium text-accent hover:underline hover:underline-offset-4"
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
 * C/ConfidenceChip: a 28 px tinted badge (05 Status · Confidence): the three-bar meter and the band's words
 * in small caps, with a chevron that opens the ConfidencePopover. "Not enough data" is a plain badge:
 * nothing to explain.
 */
export function ConfidenceChip({ level, lowered, onFullBreakdown, className }: ConfidenceChipProps) {
  const dot = <Meter level={level} />;
  const tone = TONE[level].badge;
  if (level === "insufficient_evidence") {
    return (
      <span data-confidence={level} className={cx(CHIP, tone, className)}>
        {dot}
        {CONFIDENCE_LABEL[level]}
      </span>
    );
  }
  return (
    <Popover
      label={CONFIDENCE_LABEL[level]}
      triggerClassName={cx(CHIP, tone, "transition-shadow hover:shadow-[inset_0_0_0_1px_currentColor]", className)}
      trigger={
        <>
          {dot}
          <span data-confidence={level}>{CONFIDENCE_LABEL[level]}</span>
          <Icon name="chevron-down" size={12} className="opacity-70" />
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
