"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import type { PickingInfo } from "@deck.gl/core";
import { GeohashLayer } from "@deck.gl/geo-layers";
import { GeoJsonLayer, ScatterplotLayer } from "@deck.gl/layers";
import { MapLibreOverlay } from "@deck.gl/maplibre";
import type { GeoLiftCell, GeoLiftPayload } from "@ct/contracts";
import { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { watchMapLoad } from "./lift-map-load";
import { loadOutlines, type OutlineFeature } from "./lift-outlines";
import { BASEMAP_STYLE, MapAttribution, ZoomButtons, routeMapWorker } from "./map-base";

export { BASEMAP_ATTRIBUTION, BASEMAP_STYLE, MapAttribution } from "./map-base";
export { fitPadding, overlayBoxes } from "./lift-scale";
import { MapPinMark } from "./lift-map-parts";
import { TOKEN_RGB, cellFills, fitPadding, flagName, flagSize, flagText, focusBounds, formatLift, overlayBoxes, pinRadius, placeChips, type LiftLabel, type LiftMode, type MapPlace, type Rgb } from "./lift-scale";

/**
 * The WebGL LiftMap (PLAN §8.4): a light OpenFreeMap basemap in MapLibre with deck.gl on top
 * (interleaved: false): the geohash cells on the mode's ramp with confidence as alpha, the gazetteer
 * outlines of the pinned areas, numbered ink pins with their flags, the venue sample, and the zoom buttons.
 * This module is only ever loaded with a dynamic import from LiftMapView, so MapLibre and deck.gl
 * stay out of every other bundle.
 */

export interface LiftMapCanvasProps {
  data: GeoLiftPayload;
  mode: LiftMode;
  labels: readonly LiftLabel[];
  label: string;
  outlinesUrl: string | null;
  /** Similar places from OpenStreetMap (R6), drawn when the layer is on; empty draws none. */
  places?: readonly MapPlace[];
  reducedMotion: boolean;
  /** The basemap and layers have drawn: the schematic underneath can step aside. */
  onReady: () => void;
  /** The map could not start (no WebGL, style unreachable): keep the schematic. */
  onError: () => void;
}

const rgba = (rgb: Rgb, alpha: number): [number, number, number, number] => [rgb[0], rgb[1], rgb[2], Math.round(alpha * 255)];
interface Marker {
  label: LiftLabel;
  position: [number, number];
}

export default function LiftMapCanvas({ data, mode, labels, label, outlinesUrl, places = [], reducedMotion, onReady, onError }: LiftMapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const [outlines, setOutlines] = useState<OutlineFeature[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [chips, setChips] = useState<{ marker: Marker; px: number; py: number; flag: { x: number; y: number } | null }[]>([]);
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
        fitBoundsOptions: { padding: fitPadding(node.clientWidth) },
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
    const pinned = new Set(labels.map((l) => l.id));
    const shown = outlines.filter((f) => pinned.has(f.properties.id));
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
          // The pinned areas: an accent outline, filled softly on the extra-interest layer.
          getFillColor: rgba(TOKEN_RGB.accent, lift ? 0.18 : 0),
          getLineColor: rgba(TOKEN_RGB.accent, 0.85),
          getLineWidth: 1.5,
          lineWidthUnits: "pixels",
          pickable: true,
          updateTriggers: { getFillColor: [mode] },
        }),
        ...(data.supply
          ? [
              new ScatterplotLayer<{ lat: number; lon: number; label: string }>({
                id: "lift-supply",
                data: data.supply.points,
                getPosition: (p) => [p.lon, p.lat],
                getRadius: 3,
                radiusUnits: "pixels",
                getFillColor: rgba(TOKEN_RGB.ink3, 1),
                getLineColor: rgba(TOKEN_RGB.surface, 1),
                lineWidthUnits: "pixels",
                getLineWidth: 1,
                stroked: true,
                pickable: true,
              }),
            ]
          : []),
        ...(places.length > 0
          ? [
              new ScatterplotLayer<MapPlace>({
                id: "lift-osm",
                data: places as MapPlace[],
                getPosition: (p) => [p.lon, p.lat],
                getRadius: 4,
                radiusUnits: "pixels",
                getFillColor: rgba(TOKEN_RGB.second, 1),
                getLineColor: rgba(TOKEN_RGB.surface, 1),
                lineWidthUnits: "pixels",
                getLineWidth: 1,
                stroked: true,
                pickable: true,
              }),
            ]
          : []),
      ],
      getTooltip: (info: PickingInfo) => tooltip(info, data),
    });
  }, [data, mode, outlines, labels, places, reducedMotion, loaded]);

  // Label chips follow the camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded) return;
    let frame = 0;
    const place = () => {
      frame = 0;
      const w = map.getContainer().clientWidth;
      const h = map.getContainer().clientHeight;
      const points = markers.map((m) => ({ m, p: map.project(m.position) }));
      const at = placeChips(
        points.map(({ m, p }) => ({ id: m.label.id, x: p.x, y: p.y, r: pinRadius(m.label), ...flagSize(m.label) })),
        { w, h },
        8,
        overlayBoxes(w, h),
      );
      setChips(points.map(({ m, p }) => ({ marker: m, px: p.x, py: p.y, flag: at.get(m.label.id) ?? null })));
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
  }, [markers, loaded]);

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
          wrapper isolates deck.gl stacking so the pins and the attribution stay on top. */}
      <div className="absolute inset-0 isolate">
        <div ref={container} className="h-full w-full" />
      </div>
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {chips.map(({ marker, px, py, flag }) => (
          <span key={marker.label.id}>
            <MapPinMark label={marker.label} x={px} y={py} />
            {flag ? (
              <span
                className="absolute flex flex-col rounded-sm bg-surface px-2.5 py-1.5 whitespace-nowrap shadow-md"
                style={{ left: flag.x, top: flag.y }}
              >
                <span className="text-[13px] leading-[18px] font-semibold text-ink">{flagName(marker.label.name)}</span>
                <span className="text-[12px] leading-4 text-ink-2">{flagText(marker.label)}</span>
              </span>
            ) : null}
          </span>
        ))}
      </div>
      {loaded ? (
        <>
          <ZoomButtons onZoom={(d) => (d > 0 ? mapRef.current?.zoomIn() : mapRef.current?.zoomOut())} />
          <MapAttribution />
        </>
      ) : null}
    </div>
  );
}

const TOOLTIP_STYLE = {
  backgroundColor: "#ffffff",
  color: "#0e1116",
  border: "1px solid #e6e8ec",
  borderRadius: "8px",
  boxShadow: "0 6px 18px #10182824",
  fontFamily: "Geist Variable, Geist, system-ui, sans-serif",
  fontSize: "12px",
  lineHeight: "16px",
  padding: "6px 10px",
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
  if (id === "lift-osm") {
    const p = object as MapPlace;
    return { text: `${p.name}\n${p.type} · © OpenStreetMap contributors`, style: TOOLTIP_STYLE };
  }
  if (id === "lift-supply") {
    const p = object as { label: string };
    return { text: `${p.label}\nvenue in the places sample`, style: TOOLTIP_STYLE };
  }
  return null;
}
