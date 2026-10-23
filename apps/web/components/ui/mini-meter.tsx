import { cx } from "./cx";

export interface MiniMeterProps {
  /** 0–100, clamped; a null value draws the empty track (pending, never 0). */
  value: number | null;
  /** Accessible name, e.g. "Conviction". */
  label: string;
  /** Track width in px (60 in the running head, 56 compact, 36 in a brief row). */
  width?: number;
  /** Marker height in px (12 in the running head, 9 compact); 0 draws no marker. */
  markerHeight?: number;
  className?: string;
}

/**
 * The small conviction meter of the running head and brief rows: a hairline track, a 3 px accent fill to
 * the score and a 2 px marker at its end.
 */
export function MiniMeter({ value, label, width = 60, markerHeight = 12, className }: MiniMeterProps) {
  const height = Math.max(markerHeight, 3);
  const mid = height / 2;
  const score = value === null ? null : Math.min(100, Math.max(0, value));
  const fill = score === null ? 0 : (width * score) / 100;
  return (
    <span
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={score ?? undefined}
      aria-valuetext={score === null ? "pending" : `${Math.round(score)} of 100`}
      className={cx("relative inline-block shrink-0", className)}
      style={{ width, height }}
    >
      <span className="absolute left-0 h-px w-full bg-line-strong" style={{ top: mid - 0.5 }} />
      {score === null ? null : (
        <>
          <span className="absolute left-0 h-[3px] bg-accent" style={{ top: mid - 1.5, width: fill }} />
          {markerHeight > 0 ? (
            <span
              className="absolute top-0 w-[2px] bg-accent"
              style={{ left: Math.min(Math.max(fill - 1, 0), width - 2), height: markerHeight }}
            />
          ) : null}
        </>
      )}
    </span>
  );
}
