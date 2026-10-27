import { cx } from "../ui/cx";

export interface NoSignalProps {
  /** The last date with data, e.g. "Jun 2026"; the label reads "No data after Jun 2026". */
  after?: string;
  /** Replaces the label, e.g. "No signal" for a series with too few points. */
  label?: string;
  className?: string;
}

/** A small hatched swatch and its words: marks a window with no data, never a zero. */
export function NoSignal({ after, label, className }: NoSignalProps) {
  const text = label ?? (after ? `No data after ${after}` : "No signal");
  return (
    <span className={cx("inline-flex items-center gap-2", className)}>
      <span aria-hidden="true" className="h-3 w-7 shrink-0 rounded-xs border border-line-strong bg-hatch" />
      <span className="type-label text-ink-2">{text}</span>
    </span>
  );
}
