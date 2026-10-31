import { cx } from "../ui/cx";

/** C/LogoMark: four rounded squares in the topic colours (brands, places / tours, audiences). */
export function LogoMark({ size = 22, className }: { size?: 20 | 22; className?: string }) {
  const square = size === 22 ? 10 : 9;
  const r = 3;
  const gap = size - 2 * square;
  return (
    <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={cx("shrink-0", className)}>
      <rect x={0} y={0} width={square} height={square} rx={r} fill="var(--color-topic-brands)" />
      <rect x={square + gap} y={0} width={square} height={square} rx={r} fill="var(--color-topic-places)" />
      <rect x={0} y={square + gap} width={square} height={square} rx={r} fill="var(--color-topic-tours)" />
      <rect x={square + gap} y={square + gap} width={square} height={square} rx={r} fill="var(--color-topic-audiences)" />
    </svg>
  );
}

/** The Ledger app mark (BACDa): an ink tile with a serif "C" on paper, beside the wordmark. */
export function InitialMark({ size = 22, className }: { size?: 22 | 24; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx(
        "inline-flex shrink-0 items-center justify-center bg-ink font-display font-semibold text-canvas",
        size === 24 ? "size-6 rounded-sm text-[14px] leading-none" : "size-[22px] rounded-[3px] text-[13px] leading-none",
        className,
      )}
    >
      C
    </span>
  );
}
