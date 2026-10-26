"use client";

import type { GeoLiftPayload } from "@ct/contracts";
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { isTextField, type ShortcutFocusTarget, type ShortcutKeyEvent } from "../ui/shortcut";
import type { LiftMapCanvasProps } from "./lift-map-canvas";
import { LiftSchematic } from "./lift-map-schematic";
import {
  LIFT_CLAMP,
  LIFT_MODES,
  LIFT_MODE_KEY,
  heatRgb,
  liftRgb,
  precisionBadge,
  rgbHex,
  type LiftLabel,
  type LiftMode,
} from "./lift-scale";

/**
 * The interactive part of a LiftMap: the RAW / BASE / LIFT control (keys 1/2/3 while the figure has
 * focus), the mode's legend, the precision badge, and the map itself. The server and a browser
 * without WebGL draw the static schematic; once the figure nears the viewport the map code
 * (MapLibre + deck.gl) is fetched with a dynamic import, so no other page carries it, and the
 * schematic steps aside when the basemap has loaded.
 */

export interface LiftMapViewProps {
  data: GeoLiftPayload;
  labels: readonly LiftLabel[];
  /** The figure's plain-text name. */
  label: string;
  initialMode: LiftMode;
  /** Layout box of the map in px; the map keeps this aspect ratio at narrower widths. */
  width: number;
  height: number;
  /** Where the neighbourhood outlines come from; null draws the map without them. */
  outlinesUrl: string | null;
  /** false keeps the static schematic (tests, thumbnails, print). */
  interactive: boolean;
}

const MODE_TEXT: Readonly<Record<LiftMode, string>> = { RAW: "Raw", BASE: "Base", LIFT: "Lift" };

/** The mode a 1/2/3 key press selects, or null for any other key. */
export function modeForKey(key: string): LiftMode | null {
  return LIFT_MODES.find((m) => LIFT_MODE_KEY[m] === key) ?? null;
}

/**
 * The mode a key press inside the figure switches to, or null: a bare 1/2/3, not typed into a text
 * field, not part of an IME composition and not already taken by another handler. Pure, so the rule
 * is tested without a DOM.
 */
export function modeForKeyEvent(event: ShortcutKeyEvent, target: ShortcutFocusTarget | null | undefined): LiftMode | null {
  if (event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return null;
  if (isTextField(target)) return null;
  return modeForKey(event.key);
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

export function LiftMapView({ data, labels, label, initialMode, width, height, outlinesUrl, interactive }: LiftMapViewProps) {
  const [mode, setMode] = useState<LiftMode>(initialMode);
  const [Canvas, setCanvas] = useState<ComponentType<LiftMapCanvasProps> | null>(null);
  const [ready, setReady] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const badge = precisionBadge(data);

  // Fetch the map code when the figure comes near the viewport, and only where WebGL works.
  useEffect(() => {
    const node = box.current;
    if (!interactive || !node || data.cells.length === 0) return;
    let cancelled = false;
    const load = () => {
      if (!webglAvailable()) return;
      void import("./lift-map-canvas")
        .then((m) => {
          if (!cancelled) setCanvas(() => m.default);
        })
        .catch(() => undefined);
    };
    setReducedMotion(window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false);
    if (typeof IntersectionObserver === "undefined") {
      load();
      return () => {
        cancelled = true;
      };
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          observer.disconnect();
          load();
        }
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(node);
    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [interactive, data.cells.length]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const next = modeForKeyEvent(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey, isComposing: e.nativeEvent.isComposing, defaultPrevented: e.defaultPrevented },
      e.target as HTMLElement,
    );
    if (next) {
      e.preventDefault();
      setMode(next);
    }
  };

  return (
    <div className="flex flex-col gap-2 pt-2" onKeyDown={onKeyDown} data-lift-map={data.metro} data-mode={mode}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <div role="group" aria-label={`Map layer: ${label}`} className="inline-flex rounded-brief border border-line-strong">
          {LIFT_MODES.map((m, i) => (
            <button
              key={m}
              type="button"
              aria-pressed={mode === m}
              aria-keyshortcuts={LIFT_MODE_KEY[m]}
              title={`${MODE_TEXT[m]} (key ${LIFT_MODE_KEY[m]})`}
              onClick={() => setMode(m)}
              className={`flex items-center gap-1.5 px-2 py-[3px] font-ui text-[10px] font-semibold tracking-[1px] uppercase ${
                i > 0 ? "border-l border-line-strong" : ""
              } ${mode === m ? "bg-ink text-on-ink" : "bg-paper text-dim hover:text-ink"}`}
            >
              {m}
              <span aria-hidden="true" className={`font-mono text-[9px] font-normal ${mode === m ? "text-on-ink/70" : "text-faint"}`}>
                {LIFT_MODE_KEY[m]}
              </span>
            </button>
          ))}
        </div>
        <ModeLegend mode={mode} data={data} />
        <span
          className={`ml-auto font-ui text-[10px] font-semibold tracking-[1px] uppercase ${badge.coarse ? "text-negative" : "text-dim"}`}
          data-precision={data.precision}
        >
          {badge.text}
        </span>
      </div>
      <div
        ref={box}
        className="relative w-full overflow-hidden rounded-brief border border-line bg-canvas"
        style={{ aspectRatio: `${width} / ${height}`, maxHeight: height }}
      >
        <LiftSchematic data={data} mode={mode} labels={labels} width={width} height={height} label={label} hidden={ready} />
        {Canvas ? (
          <Canvas
            data={data}
            mode={mode}
            labels={labels}
            label={label}
            outlinesUrl={outlinesUrl}
            reducedMotion={reducedMotion}
            onReady={() => setReady(true)}
            onError={() => {
              setReady(false);
              setCanvas(null);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** What the colours mean in the current mode. */
function ModeLegend({ mode, data }: { mode: LiftMode; data: GeoLiftPayload }) {
  const item = "flex items-center gap-1.5 font-ui text-[12px] text-text-2";
  if (mode === "LIFT") {
    const stops = [LIFT_CLAMP.min, 0.8, 1, 1.25, LIFT_CLAMP.max].map((l) => rgbHex(liftRgb(l)));
    return (
      <span className="flex flex-wrap items-center gap-x-[18px] gap-y-1">
        <span className={item}>
          <span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-data" />
          Above baseline
        </span>
        <span className={item}>
          <span aria-hidden="true" className="inline-block size-2.5 rounded-full bg-negative" />
          Below baseline
        </span>
        <span className="flex items-center gap-1.5 font-ui text-[10.5px] text-dim tabular-nums">
          {`${LIFT_CLAMP.min.toFixed(1)}×`}
          <span aria-hidden="true" className="inline-block h-2 w-16 rounded-[1px]" style={{ background: `linear-gradient(90deg, ${stops.join(", ")})` }} />
          {`${LIFT_CLAMP.max.toFixed(1)}×`}
        </span>
        {data.supply ? <SupplyKey capped={data.supply.capped} /> : null}
      </span>
    );
  }
  const what = mode === "RAW" ? `${data.concept.label} heat` : `${data.baseline.label} heat (baseline)`;
  return (
    <span className="flex flex-wrap items-center gap-x-[18px] gap-y-1">
      <span className="flex items-center gap-1.5 font-ui text-[12px] text-text-2">
        {what}
        <span className="font-ui text-[10.5px] text-dim">low</span>
        <span
          aria-hidden="true"
          className="inline-block h-2 w-12 rounded-[1px]"
          style={{ background: `linear-gradient(90deg, ${rgbHex(heatRgb(0))}, ${rgbHex(heatRgb(1))})` }}
        />
        <span className="font-ui text-[10.5px] text-dim">high</span>
      </span>
      {data.supply ? <SupplyKey capped={data.supply.capped} /> : null}
    </span>
  );
}

function SupplyKey({ capped }: { capped: boolean }) {
  return (
    <span className="flex items-center gap-1.5 font-ui text-[12px] text-text-2">
      <span aria-hidden="true" className="inline-block size-[5px] rounded-full bg-ink outline outline-1 outline-paper" />
      {capped ? "Venues (capped sample)" : "Venues (sample)"}
    </span>
  );
}
