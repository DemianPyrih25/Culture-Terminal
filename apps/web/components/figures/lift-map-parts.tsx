import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import { LIFT_ABOVE, LIFT_BELOW, MAP_RAMP, rgbHex, type LiftLabel, type LiftMode } from "./lift-scale";

/**
 * The map's HTML marks, shared by the WebGL map, the area map and the map card: the numbered ink pin
 * (28 px, white 13/600 numeral) with the few-rivals ring (40 px, 2 px second), the corner pin (32 px
 * accent with a white map-pin), the flag, and the ramp legend (the sequential blue ramp, or the diverging
 * red-paper-green lift ramp on the LIFT layer).
 */

/** A numbered pin centred on (x, y) in px. */
export function MapPinMark({ label, x, y }: { label: Pick<LiftLabel, "rank" | "fewRivals" | "id" | "named" | "popular" | "hidden">; x: number; y: number }) {
  // R7: a hidden pocket the numbered pins do not mark: a second-colour pin.
  if (label.hidden && label.rank === undefined && !label.named) {
    return (
      <span className="absolute" style={{ left: x, top: y }} data-pin="" data-hidden-pin={label.id}>
        <span className="absolute -top-3 -left-3 size-6 rounded-full border-2 border-surface bg-second shadow-xs" />
      </span>
    );
  }
  // R7: an area where the concept is already popular: an outlined ink ring with a dot.
  if (label.popular) {
    return (
      <span className="absolute" style={{ left: x, top: y }} data-pin="" data-popular-pin={label.id}>
        <span className="absolute -top-3.5 -left-3.5 flex size-7 items-center justify-center rounded-full border-[2.5px] border-ink bg-surface shadow-xs">
          <span className="size-2 rounded-full bg-ink" />
        </span>
      </span>
    );
  }
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
        <span className="absolute top-[-17px] left-6 rounded-sm border border-line-strong bg-surface px-2.5 py-1.5 text-[13px] leading-[18px] font-semibold whitespace-nowrap text-ink shadow-xs">
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

/** R7: what the two kinds of pin mean, under the map card's list and in the figure caption. */
export const PIN_KEY_TEXT =
  "Numbered pins: most extra interest for an area's size. Orange pins and \"hidden pocket\" flags: high extra interest but little interest overall, so small or early. Ringed pins: where it's already popular, with the most interest overall.";

/** The legend's swatches: the diverging lift ramp (less, 1.0×, more) or the sequential ramp's four upper steps. */
const LEGEND_SWATCHES: Readonly<Record<"LIFT" | "HEAT", readonly string[]>> = {
  LIFT: [...LIFT_BELOW.slice(1).reverse(), ...LIFT_ABOVE].map(rgbHex),
  HEAT: MAP_RAMP.slice(1).map(rgbHex),
};

/** The ramp legend: a hairline surface pill with the ramp's swatches, the 1.0× ends in mono, and the words. */
export function MapLegend({ mode, className }: { mode: LiftMode; className?: string }) {
  const lift = mode === "LIFT";
  return (
    <span
      data-map-legend={mode}
      className={cx("inline-flex items-center gap-2.5 rounded-md border border-line bg-surface px-3 py-2 type-caption text-ink-2", className)}
    >
      <span aria-hidden="true" className="flex items-center gap-1.5">
        {lift ? <span className="font-mono text-[11px] leading-none text-ink-3">less</span> : null}
        <span className="flex gap-px">
          {LEGEND_SWATCHES[lift ? "LIFT" : "HEAT"].map((c, i) => (
            <span key={i} className="h-2 w-3.5 first:rounded-l-[2px] last:rounded-r-[2px]" style={{ backgroundColor: c }} />
          ))}
        </span>
        {lift ? <span className="font-mono text-[11px] leading-none text-ink-3">more</span> : null}
      </span>
      {MAP_LEGEND_TEXT[mode]}
    </span>
  );
}
