"use client";

import type { GeoLiftPayload } from "@ct/contracts";
import { useEffect, useRef, useState, type ComponentType, type KeyboardEvent } from "react";
import { isTextField, type ShortcutFocusTarget, type ShortcutKeyEvent } from "../ui/shortcut";
import type { LiftMapCanvasProps } from "./lift-map-canvas";
import { LiftSchematic } from "./lift-map-schematic";
import { cx } from "../ui/cx";
import { Segmented } from "../ui/segmented";
import { MODE_TEXT, MapLegend } from "./lift-map-parts";
import { LIFT_MODES, LIFT_MODE_KEY, precisionBadge, type LiftLabel, type LiftMode, type MapPlace } from "./lift-scale";

/**
 * The interactive part of a LiftMap: the "Extra interest | All interest" switch (LIFT and RAW; keys 1/2/3
 * still pick RAW, BASE and LIFT while the map has focus), the ramp legend over the map, a note when the
 * map is too coarse for area claims, the zoom buttons and the map itself. The server and a browser
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
  /** Controlled layer (the map card's panel switches it); omitted: the view keeps its own. */
  mode?: LiftMode;
  onModeChange?: (mode: LiftMode) => void;
  /** Show the layer switch over the map (default true; the map card puts it in its panel). */
  controls?: boolean;
  /** Fill the parent's height instead of keeping the layout box's aspect ratio (the map card). */
  fill?: boolean;
  /** Similar places from OpenStreetMap (R6) on their own layer; empty or omitted draws none. */
  places?: readonly MapPlace[];
  className?: string;
}


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

export function LiftMapView({
  data,
  labels,
  label,
  initialMode,
  width,
  height,
  outlinesUrl,
  interactive,
  mode: controlledMode,
  onModeChange,
  controls = true,
  fill = false,
  places = [],
  className,
}: LiftMapViewProps) {
  const [ownMode, setOwnMode] = useState<LiftMode>(initialMode);
  const mode = controlledMode ?? ownMode;
  const setMode = (next: LiftMode) => {
    if (controlledMode === undefined) setOwnMode(next);
    onModeChange?.(next);
  };
  const [Canvas, setCanvas] = useState<ComponentType<LiftMapCanvasProps> | null>(null);
  const [ready, setReady] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const badge = precisionBadge(data);
  // A map that fills its card draws the schematic at the box's own size, so pins and flags keep their size.
  const [dims, setDims] = useState({ w: width, h: height });
  useEffect(() => {
    const node = box.current;
    if (!fill || !node || typeof ResizeObserver === "undefined") return;
    const measure = () => {
      const w = Math.round(node.clientWidth);
      const h = Math.round(node.clientHeight);
      if (w > 0 && h > 0) setDims((d) => (d.w === w && d.h === h ? d : { w, h }));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [fill]);

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
    <div
      className={cx("flex min-w-0 flex-col gap-3", fill && "h-full", className)}
      onKeyDown={onKeyDown}
      data-lift-map={data.metro}
      data-mode={mode}
    >
      {controls ? (
        <Segmented
          label={`Map layer: ${label}`}
          options={[
            { value: "LIFT", label: MODE_TEXT.LIFT },
            { value: "RAW", label: MODE_TEXT.RAW },
          ]}
          value={mode === "RAW" ? "RAW" : "LIFT"}
          onChange={setMode}
          className="self-start"
        />
      ) : null}
      <div
        ref={box}
        className={cx("@container relative w-full overflow-hidden bg-sunken", fill ? "h-full min-h-[280px]" : "rounded-tile")}
        style={fill ? undefined : { aspectRatio: `${width} / ${height}`, maxHeight: height }}
      >
        <LiftSchematic data={data} mode={mode} labels={labels} width={dims.w} height={dims.h} label={label} hidden={ready} places={places} />
        {Canvas ? (
          <Canvas
            data={data}
            mode={mode}
            labels={labels}
            label={label}
            outlinesUrl={outlinesUrl}
            places={places}
            reducedMotion={reducedMotion}
            onReady={() => setReady(true)}
            onError={() => {
              setReady(false);
              setCanvas(null);
            }}
          />
        ) : null}
        <MapLegend mode={mode} className="pointer-events-none absolute bottom-3 left-3 max-sm:top-3 max-sm:bottom-auto" />
        {badge.coarse ? (
          <span
            data-precision={data.precision}
            className="pointer-events-none absolute top-3 right-3 left-3 w-fit rounded-chip bg-surface px-2.5 py-1 type-caption text-caution-ink shadow-xs max-sm:top-14"
          >
            Rough areas only: too coarse to compare neighbourhoods
          </span>
        ) : (
          <span data-precision={data.precision} hidden />
        )}
      </div>
    </div>
  );
}
