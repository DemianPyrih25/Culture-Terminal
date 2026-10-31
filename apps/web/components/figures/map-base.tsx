"use client";

import { setWorkerUrl, type Map as MapLibreMap } from "maplibre-gl";
import { Icon } from "../ui/icons";

/**
 * What the WebGL maps share (the LiftMap and the area map): the OpenFreeMap basemap and its required
 * credits, MapLibre's worker routing and the zoom buttons. Only the map canvases
 * import this, and they are loaded on demand, so MapLibre stays out of every other bundle.
 */

/** The basemap: OpenFreeMap's Positron style (OpenMapTiles schema, OpenStreetMap data). */
export const BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron";
/** Shown on the map whenever the basemap is: required by OpenFreeMap, OpenMapTiles and OpenStreetMap. */
export const BASEMAP_ATTRIBUTION = [
  { text: "© OpenFreeMap", href: "https://openfreemap.org" },
  { text: "© OpenMapTiles", href: "https://www.openmaptiles.org/" },
  { text: "© OpenStreetMap contributors", href: "https://www.openstreetmap.org/copyright" },
] as const;

/**
 * A design token's value from app/globals.css (`@theme static` emits every variable), or the fallback
 * when it is missing or there is no document; MapLibre paint needs plain colour strings.
 */
export function cssToken(name: string, fallback: string): string {
  if (typeof document === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`).trim();
  return v || fallback;
}

/**
 * Re-tints the Positron basemap to the Ledger map (design a-map-land, a-map-water): warm paper land and
 * pale blue water, so the data layers carry the colour. Layers the style lacks are skipped; a failure
 * leaves Positron's own colours, which stay readable.
 */
export function paintLedgerBasemap(map: MapLibreMap): void {
  const land = cssToken("color-map-land", "#f1ede6");
  const water = cssToken("color-map-water", "#d5e0e6");
  const road = cssToken("color-surface", "#ffffff");
  try {
    for (const layer of map.getStyle().layers ?? []) {
      const id = layer.id.toLowerCase();
      if (layer.type === "background") map.setPaintProperty(layer.id, "background-color", land);
      else if (layer.type === "fill" && id.includes("water")) map.setPaintProperty(layer.id, "fill-color", water);
      else if (layer.type === "line" && id.includes("waterway")) map.setPaintProperty(layer.id, "line-color", water);
      else if (layer.type === "fill" && (id.includes("landuse") || id.includes("landcover") || id.includes("park"))) {
        map.setPaintProperty(layer.id, "fill-color", land);
      } else if (layer.type === "line" && (id.includes("highway") || id.includes("road"))) map.setPaintProperty(layer.id, "line-color", road);
    }
  } catch {
    // Keep the basemap's own paint.
  }
}

/** The worker URL MapLibre is given; routeMapWorker starts the bundled worker entry for it. */
const WORKER_SENTINEL = "/_lift-map/maplibre-worker.js";

/**
 * MapLibre 6 builds its worker URL from its own module location, which the bundler does not keep.
 * It gets a sentinel URL instead, and the Worker constructor starts lift-map-worker.ts (a bundled
 * module worker) for that one URL; every other worker passes through untouched. Installed once.
 */
export function routeMapWorker(): void {
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

/** The zoom buttons: a 36 x 72 hairline surface box (r6) with plus over minus. */
export function ZoomButtons({ onZoom }: { onZoom: (direction: 1 | -1) => void }) {
  const btn = "flex h-9 w-9 items-center justify-center text-ink-2 hover:bg-sunken hover:text-ink";
  return (
    <div className="absolute right-3 bottom-8 flex flex-col overflow-hidden rounded-md border border-line-strong bg-surface">
      <button type="button" aria-label="Zoom in" className={btn} onClick={() => onZoom(1)}>
        <Icon name="plus" size={16} />
      </button>
      <span aria-hidden="true" className="mx-2 h-px bg-line" />
      <button type="button" aria-label="Zoom out" className={btn} onClick={() => onZoom(-1)}>
        <Icon name="minus" size={16} />
      </button>
    </div>
  );
}

function Credits() {
  return BASEMAP_ATTRIBUTION.map((a, i) => (
    <span key={a.href}>
      {i > 0 ? " " : ""}
      <a href={a.href} target="_blank" rel="noreferrer" className="hover:text-accent">
        {a.text}
      </a>
    </span>
  ));
}

/**
 * The basemap credits, shown whenever the canvas is: one line on a wide map; on a map narrower than
 * 640 px (the map box is a size container) a small "©" button that opens them, so they never wrap
 * over the pins.
 */
export function MapAttribution() {
  return (
    <>
      <p
        className="absolute right-14 bottom-1.5 m-0 hidden rounded-sm bg-surface/80 px-1.5 py-px text-[11px] leading-4 whitespace-nowrap text-ink-3 @min-[640px]:block"
        data-attribution="basemap"
      >
        <Credits />
      </p>
      <details className="group absolute right-14 bottom-1.5 @min-[640px]:hidden" data-attribution="basemap-compact">
        <summary
          aria-label="Map credits"
          className="flex size-6 cursor-pointer list-none items-center justify-center rounded-full bg-surface/90 text-[13px] leading-none text-ink-2 shadow-xs hover:text-ink [&::-webkit-details-marker]:hidden"
        >
          ©
        </summary>
        <p className="absolute right-0 bottom-8 m-0 w-max max-w-[240px] rounded-sm bg-surface px-2 py-1 text-[12px] leading-4 text-ink-2 shadow-xs">
          <Credits />
        </p>
      </details>
    </>
  );
}
