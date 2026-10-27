import { cx } from "../ui/cx";

export interface MeterTick {
  /** Where the tick stands, in the meter's units. */
  at: number;
  /** What it marks, e.g. "Live runs stop": its tooltip. */
  label: string;
}

export interface UsageMeterProps {
  /** Used so far; null draws the empty track (not read, never 0). */
  value: number | null;
  /** The cap the meter is measured against. */
  max: number;
  /** Accessible name, e.g. "LLM spend today". */
  label: string;
  /** The spoken value, e.g. "$0.42 of $1.40"; with no value, why not (default "not read"). */
  valueText?: string;
  /** Marks inside the track, e.g. where a breaker trips. */
  ticks?: readonly MeterTick[];
  /** The fill turns danger once a breaker has tripped. */
  tripped?: boolean;
  className?: string;
}

const pct = (n: number, max: number) => `${Math.min(100, Math.max(0, max > 0 ? (n / max) * 100 : 0))}%`;

/**
 * A usage meter: a 240 px sunken track (8 tall, r3) with an accent fill to the share used, and ink-3
 * ticks where something trips. Below 640 px it takes the row's width, up to 240 px. A meter needs a
 * value, so an empty track is an image named for what is missing.
 */
export function UsageMeter({ value, max, label, valueText, ticks = [], tripped = false, className }: UsageMeterProps) {
  const now = value === null ? null : Math.min(Math.max(value, 0), Math.max(max, 0));
  const named =
    now === null
      ? ({ role: "img", "aria-label": `${label}: ${valueText ?? "not read"}` } as const)
      : ({
          role: "meter",
          "aria-label": label,
          "aria-valuemin": 0,
          "aria-valuemax": max,
          "aria-valuenow": now,
          "aria-valuetext": valueText,
        } as const);
  return (
    <span {...named} className={cx("relative block h-3 w-[240px] shrink-0 max-sm:w-full max-sm:max-w-[240px]", className)} data-meter="usage">
      <span className="absolute inset-x-0 top-0.5 h-2 overflow-hidden rounded-xs bg-sunken">
        {now === null ? null : (
          <span className={cx("absolute inset-y-0 left-0 rounded-xs", tripped ? "bg-danger" : "bg-accent")} style={{ width: pct(now, max) }} />
        )}
      </span>
      {ticks.map((tick) => (
        <span
          key={tick.label}
          title={tick.label}
          className="absolute top-0 h-3 w-0.5 -translate-x-1/2 rounded-full bg-ink-3"
          style={{ left: pct(tick.at, max) }}
          data-tick={tick.label}
        />
      ))}
    </span>
  );
}
