import { cx } from "./cx";

export interface NoSignalProps {
  /** The last date with data, e.g. "Jun 2026"; the label reads NO SIGNAL AFTER JUN 2026. */
  after?: string;
  /** Replaces the label, e.g. "No signal" for a series with too few points. */
  label?: string;
  className?: string;
}

/** A/No signal: a hatched swatch and a small caps label. Marks a window with no data; never a zero. */
export function NoSignal({ after, label, className }: NoSignalProps) {
  const text = label ?? (after ? `No signal after ${after}` : "No signal");
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <svg
        aria-hidden="true"
        focusable="false"
        width="28"
        height="12"
        viewBox="0 0 28 12"
        preserveAspectRatio="none"
        className="shrink-0 overflow-hidden border border-line-strong text-faint"
      >
        <path
          d="M-6 12 L6 0 M0 12 L12 0 M6 12 L18 0 M12 12 L24 0 M18 12 L30 0 M24 12 L36 0"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <span className="text-[9.5px] leading-none font-semibold tracking-[1px] text-dim uppercase">{text}</span>
    </span>
  );
}
