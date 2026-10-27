import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import type { LiftLabel, LiftMode } from "./lift-scale";

/**
 * The map's HTML marks, shared by the WebGL map, the area map and the map card: the numbered ink pin
 * (28 px, white 13/600 numeral) with the few-rivals ring (40 px, 2 px second), the corner pin (32 px
 * accent with a white map-pin), the flag, and the ramp legend (four swatches map-2..5 at 70 %).
 */

/** A numbered pin centred on (x, y) in px. */
export function MapPinMark({ label, x, y }: { label: Pick<LiftLabel, "rank" | "fewRivals" | "id" | "named">; x: number; y: number }) {
  // An area the question names that is not among the numbered pins: the accent pin with a map-pin.
  if (label.named && label.rank === undefined) {
    return (
      <span className="absolute" style={{ left: x, top: y }} data-pin="" data-named-pin={label.id}>
        <span className="absolute -top-3.5 -left-3.5 flex size-7 items-center justify-center rounded-full bg-accent text-white shadow-xs">
          <Icon name="map-pin" size={14} />
        </span>
      </span>
    );
  }
  return (
    <span className="absolute" style={{ left: x, top: y }} data-pin={label.rank ?? ""}>
      {label.fewRivals ? (
        <span className="absolute -top-5 -left-5 size-10 rounded-full border-2 border-second bg-surface/50" />
      ) : null}
      <span className="absolute -top-3.5 -left-3.5 flex size-7 items-center justify-center rounded-full bg-ink text-[13px] leading-none font-semibold text-white">
        {label.rank ?? ""}
      </span>
    </span>
  );
}

/** The corner pin: a 32 px accent circle with a white map-pin, and its flag ("Your corner"). */
export function CornerPin({ x, y, flag }: { x: number | string; y: number | string; flag?: string | null }) {
  return (
    <span className="absolute" style={{ left: x, top: y }} data-corner-pin="true">
      <span className="absolute -top-4 -left-4 flex size-8 items-center justify-center rounded-full bg-accent text-white shadow-xs">
        <Icon name="map-pin" size={16} />
      </span>
      {flag ? (
        <span className="absolute top-[-17px] left-6 rounded-sm bg-surface px-2.5 py-1.5 text-[13px] leading-[18px] font-semibold whitespace-nowrap text-ink shadow-md">
          {flag}
        </span>
      ) : null}
    </span>
  );
}

/** The layer switch's words: extra interest is LIFT, all interest is RAW. */
export const MODE_TEXT: Readonly<Record<"LIFT" | "RAW", string>> = { LIFT: "Extra interest", RAW: "All interest" };

/** The map card's fixed kind line and title. */
export const MAP_CARD_KIND = "Where interest is highest";
export const MAP_CARD_TITLE = "Best areas for this concept";

/** What the map's colours mean, by layer. */
export const MAP_LEGEND_TEXT: Readonly<Record<LiftMode, string>> = {
  LIFT: "More interest than a typical area",
  RAW: "More interest",
  BASE: "More interest in a typical area",
};

/** The ramp legend: a surface pill (r12, shadow-xs) with four 16 x 8 swatches and the words. */
export function MapLegend({ mode, className }: { mode: LiftMode; className?: string }) {
  return (
    <span
      data-map-legend={mode}
      className={cx("inline-flex items-center gap-2.5 rounded-control bg-surface px-3 py-2 type-caption text-ink-2 shadow-xs", className)}
    >
      <span aria-hidden="true" className="flex gap-0.5 opacity-70">
        <span className="h-2 w-4 rounded-[2px] bg-map-2" />
        <span className="h-2 w-4 rounded-[2px] bg-map-3" />
        <span className="h-2 w-4 rounded-[2px] bg-map-4" />
        <span className="h-2 w-4 rounded-[2px] bg-map-5" />
      </span>
      {MAP_LEGEND_TEXT[mode]}
    </span>
  );
}
