import type { ReactNode } from "react";
import { cx } from "./cx";

export interface SectionHeadProps {
  /** "02"; numbers are zero-padded to two digits. */
  number?: number | string;
  /** "Conviction": printed in small caps. */
  title: string;
  /** The right note, e.g. "Computed, not chosen". */
  aside?: ReactNode;
  /** Heading level (default h2). */
  as?: "h2" | "h3";
  /** Anchor id for the outline; pair it with SCROLL_ANCHOR_CLASS so it clears the sticky chrome. */
  id?: string;
  className?: string;
}

/** A/Section head: a strong hairline, then 02 CONVICTION ············ Computed, not chosen. */
export function SectionHead({ number, title, aside, as: Heading = "h2", id, className }: SectionHeadProps) {
  const numberText = typeof number === "number" ? String(number).padStart(2, "0") : number;
  return (
    <div
      id={id}
      className={cx("flex w-full items-center gap-[10px] border-t border-line-strong pt-[10px] leading-[14px]", className)}
    >
      <Heading className="flex items-center gap-[10px] text-[11px] font-semibold tracking-[1.3px] uppercase">
        {numberText ? <span className="text-dim">{numberText}</span> : null}
        <span className="text-ink">{title}</span>
      </Heading>
      {aside ? <span className="ml-auto text-right text-[12px] text-dim">{aside}</span> : null}
    </div>
  );
}
