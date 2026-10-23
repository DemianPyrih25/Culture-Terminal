import { cx } from "./cx";

/** over: above the comparator (▲ accent). under: below it (▼ negative). flat: equal. unavailable: no value. */
export type DeltaDirection = "over" | "under" | "flat" | "unavailable";

export interface DeltaProps {
  /** The signed difference, or null when the metric is UNAVAILABLE; null is never drawn as 0. */
  value: number | null;
  /** What the difference is measured against, e.g. "vs category median". Required and never empty (§8.3). */
  comparator: string;
  /** The value as printed; defaults to a signed two-decimal number with a true minus sign. */
  display?: string;
  /** Printed in place of the value when it is null (default "Unavailable"). */
  unavailableText?: string;
  className?: string;
}

/** Over, under or flat from the sign; unavailable when there is no value. */
export function deltaDirection(value: number | null): DeltaDirection {
  if (value === null || Number.isNaN(value)) return "unavailable";
  if (value > 0) return "over";
  if (value < 0) return "under";
  return "flat";
}

/** "+0.27", "−0.12" (U+2212), "0.00". */
export function formatDelta(value: number, digits = 2): string {
  const text = Math.abs(value).toFixed(digits);
  if (Number(text) === 0) return text;
  return `${value > 0 ? "+" : "−"}${text}`;
}

const ARROW: Record<DeltaDirection, string | null> = { over: "▲", under: "▼", flat: null, unavailable: null };
const TONE: Record<DeltaDirection, string> = {
  over: "text-accent",
  under: "text-negative",
  flat: "text-text-2",
  unavailable: "text-dim",
};
const SPOKEN: Record<DeltaDirection, string> = { over: "up", under: "down", flat: "level", unavailable: "" };

/**
 * A/Delta: ▲ +0.27 vs category median. A Delta always names its comparator: an empty one throws outside
 * production and renders nothing in production, so a figure never shows a bare difference.
 */
export function Delta({ value, comparator, display, unavailableText = "Unavailable", className }: DeltaProps) {
  const against = comparator.trim();
  if (against === "") {
    if (process.env.NODE_ENV !== "production") throw new Error("Delta: a comparator is required (PLAN §8.3)");
    return null;
  }
  const direction = deltaDirection(value);
  const arrow = ARROW[direction];
  const text = value === null || direction === "unavailable" ? unavailableText : (display ?? formatDelta(value));
  return (
    <span
      data-direction={direction}
      className={cx("inline-flex items-center gap-1 text-[12px] leading-none whitespace-nowrap", className)}
    >
      {arrow ? (
        <span aria-hidden="true" className={cx("text-[8px]", TONE[direction])}>
          {arrow}
        </span>
      ) : null}
      {SPOKEN[direction] ? <span className="sr-only">{SPOKEN[direction]}</span> : null}
      <span className={cx("font-semibold tabular-nums", TONE[direction], direction === "unavailable" && "font-normal")}>
        {text}
      </span>
      <span className="text-dim">{against}</span>
    </span>
  );
}
