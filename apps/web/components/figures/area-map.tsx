"use client";

import type { MetroId } from "@ct/contracts";
import { useEffect, useId, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { cardClassName } from "../ui/card";
import { cx } from "../ui/cx";
import { Button } from "../ui/button";
import { Icon } from "../ui/icons";
import { Skeleton } from "../ui/skeleton";
import type { AreaMapCanvasProps } from "./area-map-canvas";
import { CORNER_LABEL, areaMapCaption, fitProjection, outlineBounds, outlinePath, type GeoPoint } from "./area-map-shape";
import { outlinesUrl as defaultOutlinesUrl, fetchOutlines, findOutline, type OutlineFeature } from "./lift-outlines";

/**
 * The area map card (N09 tenant_mix "Your corner, East Nashville"; area_profile): the area's boundary
 * from the metro gazetteer (accent dashed 1.5 px, accent-soft fill), a sample of venues as ink-3 dots,
 * the corner pin (32 px accent, white map-pin) with its "Your corner" flag, and the zoom buttons; under
 * the map, the footer: the place in 13/600 and the caption. No chart header. A static SVG of the same
 * outline draws first and stays where WebGL is missing; the MapLibre basemap loads when the card nears
 * the viewport. An area without a boundary shows the "No map for this area" hatch; a request that failed
 * says "Map could not load" with a retry. The caption about the outline shows only while one is drawn.
 */

export interface AreaMapProps {
  metro: MetroId;
  /** The area: a gazetteer id when known, else its name ("East Nashville"). */
  area: { id?: string | null; name: string };
  /** The pin; omitted: the area's centroid. null: no pin (area_profile). */
  corner?: GeoPoint | null;
  /** The pin's flag (default "Your corner"); null: no flag. */
  cornerLabel?: string | null;
  /** A sample of venues nearby, drawn as dots. */
  venues?: readonly GeoPoint[];
  /** Footer title; default "Your corner, {area}" with a pin, "{area}" without. */
  title?: string;
  /** Footer caption; default "Outline: {area} boundary. Dots: a sample of venues nearby." */
  caption?: string;
  /** Default /api/geo/<metro>. */
  outlinesUrl?: string;
  /** false keeps the static drawing (tests, print). */
  interactive?: boolean;
  /** The map's height in px (default 388; phones 280). */
  height?: number;
  className?: string;
}

function webglAvailable(): boolean {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}

const W = 552;
const H = 388;

/**
 * A hatched panel with a centred pill and an optional action. The hatch is an SVG pattern on a 6 px tile
 * (1 px ink-3 lines at 45 degrees), so a large panel shows no moire seam at DPR 1.
 */
function MapHatch({ label, action }: { label: string; action?: ReactNode }) {
  const id = useId();
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-sunken" data-map-state={action ? "error" : "missing"}>
      <svg aria-hidden="true" className="absolute inset-0 h-full w-full">
        <defs>
          <pattern id={id} width={6} height={6} patternUnits="userSpaceOnUse">
            <path d="M-1 1l2-2M0 6l6-6M5 7l2-2" className="stroke-ink-3" strokeWidth={1} />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill={`url(#${id})`} />
      </svg>
      <span className="relative rounded-chip bg-surface px-2.5 py-1 type-caption text-ink-2">{label}</span>
      {action ? <span className="relative">{action}</span> : null}
    </div>
  );
}

/** The static drawing: the outline, the venues and the pin on a sunken panel. */
export function AreaSchematic({
  outline,
  corner,
  cornerLabel,
  venues,
  label,
  hidden = false,
}: {
  outline: OutlineFeature;
  corner: GeoPoint | null;
  cornerLabel: string | null;
  venues: readonly GeoPoint[];
  label: string;
  hidden?: boolean;
}) {
  const bounds = outlineBounds(outline.geometry);
  if (!bounds) return null;
  const project = fitProjection(bounds, W, H);
  const pin = corner ? project(corner) : null;
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      role="img"
      aria-label={label}
      aria-hidden={hidden || undefined}
      preserveAspectRatio="xMidYMid meet"
      data-area-schematic={outline.properties.id}
      className={cx("absolute inset-0 h-full w-full", hidden ? "hidden" : "block")}
    >
      <rect width={W} height={H} className="fill-sunken" />
      <path d={outlinePath(outline.geometry, project)} className="fill-accent/12 stroke-accent" strokeWidth={1.5} strokeDasharray="5 3" />
      {venues.map((v, i) => {
        const at = project(v);
        return <circle key={i} cx={at.x.toFixed(1)} cy={at.y.toFixed(1)} r={3.5} className="fill-ink-3 stroke-surface" strokeWidth={1} />;
      })}
      {pin ? (
        <g data-corner-pin="true">
          <circle cx={pin.x.toFixed(1)} cy={pin.y.toFixed(1)} r={16} className="fill-accent" />
          <Icon name="map-pin" size={16} x={pin.x - 8} y={pin.y - 8} className="text-white" />
          {cornerLabel ? (
            <g>
              <rect x={pin.x + 24} y={pin.y - 16} width={cornerLabel.length * 7.6 + 20} height={32} rx={8} className="fill-surface" />
              <text x={pin.x + 34} y={pin.y + 5} fontSize={13} fontWeight={600} className="fill-ink">
                {cornerLabel}
              </text>
            </g>
          ) : null}
        </g>
      ) : null}
    </svg>
  );
}

export function AreaMap({
  metro,
  area,
  corner,
  cornerLabel = CORNER_LABEL,
  venues = [],
  title,
  caption,
  outlinesUrl,
  interactive = true,
  height = H,
  className,
}: AreaMapProps) {
  const url = outlinesUrl ?? defaultOutlinesUrl(metro);
  /** undefined while loading; null when the metro has no boundary for the area; "error" when the request failed. */
  const [outline, setOutline] = useState<OutlineFeature | null | "error" | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [Canvas, setCanvas] = useState<ComponentType<AreaMapCanvasProps> | null>(null);
  const [ready, setReady] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    void fetchOutlines(url).then((result) => {
      if (current) setOutline(result.ok ? findOutline(result.features, area) : "error");
    });
    return () => {
      current = false;
    };
  }, [url, area.id, area.name, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  const drawn = outline !== null && outline !== "error" ? outline : undefined;

  useEffect(() => {
    const node = box.current;
    if (!interactive || !node || !drawn) return;
    let cancelled = false;
    const load = () => {
      if (!webglAvailable()) return;
      void import("./area-map-canvas")
        .then((m) => {
          if (!cancelled) setCanvas(() => m.default);
        })
        .catch(() => undefined);
    };
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
  }, [interactive, drawn]);

  const pin = useMemo<GeoPoint | null>(() => {
    if (corner === null) return null;
    if (corner) return corner;
    const c = drawn?.properties.centroid;
    return c ? { lon: c[0], lat: c[1] } : null;
  }, [corner, drawn]);
  const flag = pin ? cornerLabel : null;
  const footTitle = title ?? (corner !== null && cornerLabel ? `${cornerLabel}, ${area.name}` : area.name);
  const label = `Map of ${area.name}`;

  return (
    <section aria-label={footTitle} data-area-map={area.name} className={cardClassName("none", cx("flex flex-col overflow-hidden", className))}>
      <div ref={box} className="@container relative w-full bg-sunken max-md:!h-[280px]" style={{ height }}>
        {outline === undefined ? (
          <Skeleton className="absolute inset-0 rounded-none" />
        ) : outline === "error" ? (
          <MapHatch
            label="Map could not load"
            action={
              <Button
                size="sm"
                icon="rotate-ccw"
                onClick={() => {
                  setOutline(undefined);
                  setAttempt((n) => n + 1);
                }}
              >
                Try again
              </Button>
            }
          />
        ) : outline === null ? (
          <MapHatch label="No map for this area" />
        ) : (
          <>
            <AreaSchematic outline={outline} corner={pin} cornerLabel={flag} venues={venues} label={label} hidden={ready} />
            {Canvas ? (
              <Canvas
                outline={outline}
                corner={pin}
                cornerLabel={flag}
                venues={venues}
                label={label}
                onReady={() => setReady(true)}
                onError={() => {
                  setReady(false);
                  setCanvas(null);
                }}
              />
            ) : null}
          </>
        )}
      </div>
      <div className="flex flex-col gap-1 px-4 py-4 md:px-4">
        <p className="m-0 text-[15px] leading-6 font-semibold text-ink">{footTitle}</p>
        {/* The caption describes the drawn outline, so it goes when no outline is drawn. */}
        {outline === null || outline === "error" ? null : (
          <p className="m-0 type-caption text-ink-2">{caption ?? areaMapCaption(area.name, venues.length > 0)}</p>
        )}
      </div>
    </section>
  );
}
