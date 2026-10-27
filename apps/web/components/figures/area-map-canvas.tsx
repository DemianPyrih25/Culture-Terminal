"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import { Map as MapLibreMap } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { CornerPin } from "./lift-map-parts";
import { watchMapLoad } from "./lift-map-load";
import type { OutlineFeature } from "./lift-outlines";
import type { GeoPoint } from "./area-map-shape";
import { outlineBounds } from "./area-map-shape";
import { BASEMAP_STYLE, MapAttribution, ZoomButtons, routeMapWorker } from "./map-base";

/**
 * The WebGL area map: the OpenFreeMap basemap in MapLibre with the area's boundary (accent dashed 1.5 px
 * over an accent-soft fill), the venue sample as ink-3 dots, the corner pin and its flag, and the zoom
 * buttons. Loaded on demand by AreaMap, so MapLibre stays out of every other bundle; deck.gl is not used.
 */

export interface AreaMapCanvasProps {
  outline: OutlineFeature;
  corner: GeoPoint | null;
  cornerLabel: string | null;
  venues: readonly GeoPoint[];
  label: string;
  onReady: () => void;
  onError: () => void;
}

const ACCENT = "#5b3df5";
const INK_3 = "#8a93a3";

export default function AreaMapCanvas({ outline, corner, cornerLabel, venues, label, onReady, onError }: AreaMapCanvasProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [pin, setPin] = useState<{ x: number; y: number } | null>(null);
  const callbacks = useRef({ onReady, onError });
  useEffect(() => {
    callbacks.current = { onReady, onError };
  }, [onReady, onError]);

  useEffect(() => {
    const node = container.current;
    const bounds = outlineBounds(outline.geometry);
    if (!node || !bounds) return;
    let map: MapLibreMap;
    try {
      routeMapWorker();
      map = new MapLibreMap({
        container: node,
        style: BASEMAP_STYLE,
        bounds: [bounds[0], bounds[1], bounds[2], bounds[3]],
        fitBoundsOptions: { padding: { top: 32, bottom: 48, left: 32, right: 56 } },
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
    mapRef.current = map;
    const unwatch = watchMapLoad(map, {
      onLoad: () => {
        map.addSource("area", { type: "geojson", data: outline as never });
        map.addLayer({ id: "area-fill", type: "fill", source: "area", paint: { "fill-color": ACCENT, "fill-opacity": 0.12 } });
        map.addLayer({
          id: "area-line",
          type: "line",
          source: "area",
          paint: { "line-color": ACCENT, "line-width": 1.5, "line-dasharray": [3, 2] },
        });
        if (venues.length > 0) {
          map.addSource("venues", {
            type: "geojson",
            data: {
              type: "FeatureCollection",
              features: venues.map((v) => ({ type: "Feature", properties: {}, geometry: { type: "Point", coordinates: [v.lon, v.lat] } })),
            },
          });
          map.addLayer({
            id: "venues",
            type: "circle",
            source: "venues",
            paint: { "circle-radius": 3, "circle-color": INK_3, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1 },
          });
        }
        setLoaded(true);
        callbacks.current.onReady();
      },
      onFail: () => callbacks.current.onError(),
    });
    return () => {
      unwatch();
      mapRef.current = null;
      map.remove();
    };
  }, [outline, venues]);

  // The corner pin follows the camera.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !loaded || !corner) return;
    const place = () => {
      const p = map.project([corner.lon, corner.lat]);
      setPin({ x: p.x, y: p.y });
    };
    place();
    map.on("move", place);
    map.on("resize", place);
    return () => {
      map.off("move", place);
      map.off("resize", place);
    };
  }, [corner, loaded]);

  return (
    <div
      className={loaded ? "absolute inset-0" : "absolute inset-0 invisible"}
      role="group"
      aria-label={`${label} (interactive map)`}
      data-map-loaded={loaded}
    >
      <div className="absolute inset-0 isolate">
        <div ref={container} className="h-full w-full" />
      </div>
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        {pin ? <CornerPin x={pin.x} y={pin.y} flag={cornerLabel} /> : null}
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
