"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import type { PickingInfo } from "@deck.gl/core";
import { GeohashLayer } from "@deck.gl/geo-layers";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import type { GeoLiftCell, GeoLiftPayload } from "@ct/contracts";
import { Map as MapLibreMap, NavigationControl, ScaleControl, setWorkerUrl } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { watchMapLoad } from "./lift-map-load";
import type { OutlineCollection, OutlineFeature } from "./lift-outlines";
import { TOKEN_RGB, cellFills, chipSize, focusBounds, formatLift, liftRadius, placeChips, type LiftLabel, type LiftMode, type Rgb } from "./lift-scale";

/**
 * The WebGL LiftMap (PLAN §8.4): a light OpenFreeMap basemap in MapLibre with deck.gl on top
 * (interleaved: false): the geohash cells on the mode's ramp with confidence as alpha, the gazetteer
 * outlines, the neighbourhood markers sized by lift with their label chips, and the venue sample.
 * This module is only ever loaded with a dynamic import from LiftMapView, so MapLibre and deck.gl
 * stay out of every other bundle.
 */

/** The basemap: OpenFreeMap's Positron style (OpenMapTiles schema, OpenStreetMap data). */
export const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
/** Shown on the map whenever the basemap is: required by OpenFreeMap, OpenMapTiles and OpenStreetMap. */
export const BASEMAP_ATTRIBUTION = [
  { text: "© OpenFreeMap", href: "https://openfreemap.org" },
  { text: "© OpenMapTiles", href: "https://www.openmaptiles.org/" },
  { text: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
] as const;

export interface LiftMapCanvasProps {
  data: GeoLiftPayload;
  mode: LiftMode;
  labels: readonly LiftLabel[];
  label: string;
  outlinesUrl: string | null;
  reducedMotion: boolean;
  /** The basemap and layers have drawn: the schematic underneath can step aside. */
  onReady: () => void;
  /** The map could not start (no WebGL, style unreachable): keep the schematic. */
  onError: () => void;
}

/** The worker URL MapLibre is given; routeMapWorker starts the bundled worker entry for it. */
const WORKER_SENTINEL = "/_lift-map/maplibre-worker.js";

/**
 * MapLibre 6 builds its worker URL from its own module location, which the bundler does not keep.
 * It gets a sentinel URL instead, and the Worker constructor starts lift-map-worker.ts (a bundled
 * module worker) for that one URL; every other worker passes through untouched. Installed once.
 */
function routeMapWorker(): void {
  const scope = globalThis as typeof globalThis & { __liftMapWorker?: true };
  if (scope.__liftMapWorker || typeof Worker === "undefined") return;
  scope.__liftMapWorker = true;
  const Native = globalThis.Worker;
  globalThis.Worker = new Proxy(Native, {
    construct(target, args: [string | URL, WorkerOptions?]) {
      if (String(args[0]).endsWith(WORKER_SENTINEL)) {
        return new Worker(new URL("./lift-map-worker.ts", import.meta.url), { type: "module" });
      }
      return Reflect.construct(target, args) as Worker;
    },
  });
  setWorkerUrl(WORKER_SENTINEL);
}

const rgba = (rgb: Rgb, alpha: number): [number, number, number, number] => [rgb[0], rgb[1], rgb[2], Math.round(alpha * 255)];
const outlinesCache = new Map<string, Promise<OutlineFeature[]>>();

function loadOutlines(url: string): Promise<OutlineFeature[]> {
  const known = outlinesCache.get(url);
  if (known) return known;
  const load = fetch(url)
    .then((res) => (res.ok ? (res.json() as Promise<OutlineCollection>) : null))
    .then((json) => (Array.isArray(json?.features) ? json.features : []))
    .catch(() => {
      outlinesCache.delete(url);
      return [];
    });
  outlinesCache.set(url, load);
  return load;
}

interface Marker {
  label: LiftLabel;
  position: [number, number];
}

export default function LiftMapCanvas({ data, mode, labels, label, outlinesUrl, reducedMotion, onReady, onError }: LiftMapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const [outlines, setOutlines] = useState<OutlineFeature[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [chips, setChips] = useState<{ marker: Marker; x: number; y: number }[]>([]);
  // The map's events call the latest callbacks without re-creating the map.
  const callbacks = useRef({ onReady, onError });
  useEffect(() => {
    callbacks.current = { onReady, onError };
  }, [onReady, onError]);

  useEffect(() => {
    if (!outlinesUrl) return;
    let current = true;
    void loadOutlines(outlinesUrl).then((features) => {
      if (current) setOutlines(features);
    });
    return () => {
      current = false;
    };
  }, [outlinesUrl]);

  // One map per mount; deck.gl rides on it as a control.
  useEffect(() => {
    const node = container.current;
    const bounds = focusBounds(data);
    if (!node || !bounds) return;
    let map: MapLibreMap;
    try {
      routeMapWorker();
      map = new MapLibreMap({
        container: node,
        style: BASEMAP_STYLE,
        bounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
        fitBoundsOptions: { padding: 12 },
        attributionControl: false,
        dragRotate: false,
        pitchWithRotate: false,
        touchPitch: false,
        cooperativeGestures: true,
        maxPitch: 0,
      });
    } catch {
      callbacks.current.onError();
      return;
    }
    map.touchZoomRotate.disableRotation();
    map.addControl(new NavigationControl({ showCompass: false }), "top-right");
    // The scale bar shares the bottom edge with the attribution; a half-width map keeps the attribution.
    if (node.clientWidth >= 480) map.addControl(new ScaleControl({ maxWidth: 72, unit: "metric" }), "bottom-right");
    const overlay = new MapLibreOverlay({ interleaved: false, layers: [] });
    map.addControl(overlay);
    mapRef.current = map;
    overlayRef.current = overlay;
    // A style that cannot load, or one that hangs past the timeout, keeps the schematic.
    const unwatch = watchMapLoad(map, {
      onLoad: () => {
        setLoaded(true);
        callbacks.current.onReady();
      },
      onFail: () => callbacks.current.onError(),
    });
    return () => {
      unwatch();
      overlayRef.current = null;
      mapRef.current = null;
      map.remove();
    };
    // The map is created once per dataset; mode and layers update below.
  }, [data]);

  const centroids = useMemo(() => new Map(outlines.map((f) => [f.properties.id, f.properties.centroid] as const)), [outlines]);
  const markers = useMemo<Marker[]>(
    () =>
      labels.flatMap((l) => {
        const c = centroids.get(l.id);
        if (c) return [{ label: l, position: [c[0], c[1]] as [number, number] }];
        return l.at ? [{ label: l, position: [l.at.lon, l.at.lat] as [number, number] }] : [];
      }),
    [labels, centroids],
  );

  // deck.gl layers for the mode, once the basemap has loaded and the schematic has stepped aside.
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !loaded) return;
    const fills = cellFills(data, mode);
    const cells = data.cells.filter((c) => fills.has(c.geohash));
    const lifted = new Map(data.neighbourhoods.map((n) => [n.id, n.lift] as const));
    const shown = outlines.filter((f) => lifted.has(f.properties.id));
    const lift = mode === "LIFT";
    const transitions = reducedMotion ? undefined : { getFillColor: 600 };
    overlay.setProps({
      layers: [
        new GeohashLayer<GeoLiftCell>({
          id: "lift-cells",
          data: cells,
          getGeohash: (c) => c.geohash,
          getFillColor: (c) => {
            const f = fills.get(c.geohash);
            return f ? rgba(f.rgb, f.alpha) : [0, 0, 0, 0];
          },
          filled: true,
          stroked: false,
          extruded: false,
          pickable: true,
          transitions,
          updateTriggers: { getFillColor: [mode] },
        }),
        new GeoJsonLayer<OutlineFeature["properties"]>({
          id: "lift-outlines",
          data: shown as never,
          filled: true,
          stroked: true,
          getFillColor: [0, 0, 0, 0],
          // Outlines take the lift colours only on the LIFT layer; RAW and BASE outline every area in dim.
          getLineColor: (f) => {
            const l = lifted.get((f as OutlineFeature).properties.id);
            if (!lift) return rgba(TOKEN_RGB.dim, 0.7);
            return l == null ? rgba(TOKEN_RGB.lineStrong, 1) : rgba(l >= 1 ? TOKEN_RGB.data : TOKEN_RGB.negative, 0.75);
          },
          getLineWidth: (f) => (lifted.get((f as OutlineFeature).properties.id) == null ? 0.75 : 1.25),
          lineWidthUnits: "pixels",
          pickable: true,
          updateTriggers: { getLineColor: [mode] },
        }),
        ...(data.supply
          ? [
              new ScatterplotLayer<{ lat: number; lon: number; label: string }>({
                id: "lift-supply",
                data: data.supply.points,
                getPosition: (p) => [p.lon, p.lat],
                getRadius: 2.5,
                radiusUnits: "pixels",
                getFillColor: rgba(TOKEN_RGB.ink, 0.9),
                getLineColor: rgba(TOKEN_RGB.paper, 1),
                lineWidthUnits: "pixels",
                getLineWidth: 1,
                stroked: true,
                pickable: true,
              }),
            ]
          : []),
        ...(lift
          ? [
              new ScatterplotLayer<Marker>({
                id: "lift-markers",
                data: markers,
                getPosition: (m) => m.position,
                getRadius: (m) => liftRadius(m.label.lift),
                radiusUnits: "pixels",
                getFillColor: (m) => rgba(m.label.lift >= 1 ? TOKEN_RGB.data : TOKEN_RGB.negative, 0.35),
                getLineColor: (m) => rgba(m.label.lift >= 1 ? TOKEN_RGB.data : TOKEN_RGB.negative, 1),
                lineWidthUnits: "pixels",
                getLineWidth: 1.5,
                stroked: true,
                pickable: false,
              }),
              new ScatterplotLayer<Marker>({
                id: "lift-halo",
                data: markers.filter((m) => m.label.top),
                getPosition: (m) => m.position,
                getRadius: (m) => liftRadius(m.label.lift) + 5,
                radiusUnits: "pixels",
                filled: false,
                stroked: true,
                getLineColor: rgba(TOKEN_RGB.data, 1),
                lineWidthUnits: "pixels",
                getLineWidth: 1,
              }),
            ]
          : []),
      ],
      getTooltip: (info: PickingInfo) => tooltip(info, data),
    });
  }, [data, mode, outlines, markers, reducedMotion, loaded]);

  // Label chips follow the camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const w = map.getContainer().clientWidth;
      const h = map.getContainer().clientHeight;
      const withLift = mode === "LIFT";
      const points = markers.map((m) => ({ m, p: map.project(m.position) }));
      const at = placeChips(
        points.map(({ m, p }) => ({ id: m.label.id, x: p.x, y: p.y, r: withLift ? liftRadius(m.label.lift) : 3, ...chipSize(m.label, withLift) })),
        { w, h },
      );
      setChips(points.flatMap(({ m }) => (at.has(m.label.id) ? [{ marker: m, ...at.get(m.label.id)! }] : [])));
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(place);
    };
    place();
    map.on("move", schedule);
    map.on("resize", schedule);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      map.off("move", schedule);
      map.off("resize", schedule);
    };
  }, [markers, mode, loaded]);

  const withLift = mode === "LIFT";
  // Invisible (and out of the accessibility tree) until the basemap has loaded: the schematic shows
  // meanwhile, so neither tiles without their attribution nor a second copy of the cells ever paint.
  // A labelled group, not role="img": the map canvas, the zoom buttons and the attribution links
  // inside keep their roles and names.
  return (
    <div
      className={loaded ? "absolute inset-0" : "absolute inset-0 invisible"}
      role="group"
      aria-label={`${label} (interactive map; the table view lists every value)`}
      data-map-loaded={loaded}
    >
      {/* MapLibre makes its container position: relative, so it fills an absolute wrapper instead; the
          wrapper isolates deck.gl's stacking so the chips and the attribution stay on top. */}
      <div className="absolute inset-0 isolate">
        <div ref={container} className="h-full w-full" />
      </div>
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {chips.map(({ marker, x, y }) => (
          <span
            key={marker.label.id}
            className="absolute flex items-center gap-[5px] rounded-brief border border-line bg-paper/90 px-1.5 py-[2px] font-ui text-[11px] leading-[13px] whitespace-nowrap text-ink"
            style={{ left: x, top: y }}
          >
            <span className={marker.label.top ? "font-semibold" : "font-medium"}>{marker.label.name}</span>
            {withLift ? (
              <span className={`font-medium ${marker.label.lift >= 1 ? "text-data" : "text-negative"}`}>{formatLift(marker.label.lift)}</span>
            ) : null}
          </span>
        ))}
      </div>
      {loaded ? <MapAttribution /> : null}
    </div>
  );
}

/** The basemap credits, shown whenever the canvas is. */
export function MapAttribution() {
  return (
    <p className="absolute bottom-1 left-1 m-0 rounded-brief bg-paper/85 px-1.5 py-px font-mono text-[9px] leading-[13px] text-dim" data-attribution="basemap">
      {BASEMAP_ATTRIBUTION.map((a, i) => (
        <span key={a.href}>
          {i > 0 ? " " : ""}
          <a href={a.href} target="_blank" rel="noreferrer" className="hover:text-accent">
            {a.text}
          </a>
        </span>
      ))}
    </p>
  );
}

const TOOLTIP_STYLE = {
  backgroundColor: "#ffffff",
  color: "#121416",
  border: "1px solid #e6e7e9",
  borderRadius: "2px",
  fontFamily: "Inter Variable, Inter, system-ui, sans-serif",
  fontSize: "11px",
  lineHeight: "15px",
  padding: "4px 6px",
};

function tooltip(info: PickingInfo, data: GeoLiftPayload): { text: string; style: Record<string, string> } | null {
  const object = info.object as unknown;
  if (!object || !info.layer) return null;
  const id = info.layer.id;
  if (id.startsWith("lift-cells")) {
    const c = object as GeoLiftCell;
    const lift = c.lift === null ? "lift not computable" : `lift ${formatLift(c.lift)}${c.gated ? "" : " (below the u ≥ 0.5 gate)"}`;
    const n = c.neighbourhood ? data.neighbourhoods.find((x) => x.id === c.neighbourhood)?.name : null;
    return { text: `Cell ${c.geohash}${n ? ` · ${n}` : ""}\n${lift}`, style: TOOLTIP_STYLE };
  }
  if (id === "lift-outlines") {
    const f = object as OutlineFeature;
    const n = data.neighbourhoods.find((x) => x.id === f.properties.id);
    if (!n) return null;
    const what = n.lift === null ? "no lift: too few cells or too coarse" : `lift ${formatLift(n.lift)} · ${n.n} gated cells`;
    return { text: `${n.name}\n${what}`, style: TOOLTIP_STYLE };
  }
  if (id === "lift-supply") {
    const p = object as { label: string };
    return { text: `${p.label}\nvenue in the places sample`, style: TOOLTIP_STYLE };
  }
  return null;
}
