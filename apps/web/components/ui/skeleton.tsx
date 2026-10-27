import { cx } from "./cx";

/** A loading placeholder: a sunken block that pulses when motion is allowed. Size it with classes. */
export function Skeleton({ className }: { className?: string }) {
  return <span aria-hidden="true" className={cx("block rounded-sm bg-sunken motion-safe:animate-pulse", className)} />;
}

export interface HatchProps {
  /** The pill's words: "No data" (default) or "No data after Sep 2025". */
  label?: string;
  className?: string;
}

/**
 * Missing data: a hatched panel (r12) with a centred surface pill. Missing data reads "No data", never
 * zero. Size it with classes (it fills its box by default).
 */
export function Hatch({ label = "No data", className }: HatchProps) {
  return (
    <div className={cx("flex h-full min-h-16 w-full items-center justify-center rounded-tile bg-hatch", className)}>
      <span className="rounded-chip bg-surface px-2.5 py-1 type-caption whitespace-nowrap text-ink-2">{label}</span>
    </div>
  );
}
