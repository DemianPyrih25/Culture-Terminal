// The WebGL LiftMap before and after the basemap loads: nothing of the canvas shows (no tiles without
// their attribution, no second copy of the cells over the schematic) until MapLibre's 'load'; a style
// that errors or hangs keeps the schematic; the controls inside the map keep their roles. MapLibre and
// deck.gl are mocked: the server render never runs their code, and the load watch is pure.
import { afterEach, describe, expect, it, vi } from "vitest";
import LiftMapCanvas, { BASEMAP_ATTRIBUTION, MapAttribution } from "../../components/figures/lift-map-canvas";
import { MAP_LOAD_TIMEOUT_MS, watchMapLoad, type LoadEvents } from "../../components/figures/lift-map-load";
import { liftLabels } from "../../components/figures/lift-scale";
import { austinLiftMap } from "../../components/figures/fixtures";
import { render, text } from "./markup";

vi.mock("maplibre-gl", () => ({ Map: class {}, NavigationControl: class {}, ScaleControl: class {}, setWorkerUrl: () => undefined }));
vi.mock("@deck.gl/maplibre", () => ({ MapLibreOverlay: class {} }));
vi.mock("@deck.gl/geo-layers", () => ({ GeohashLayer: class {} }));
vi.mock("@deck.gl/layers", () => ({ GeoJsonLayer: class {}, ScatterplotLayer: class {} }));

/** A map that fires the events the test asks for. */
function fakeMap() {
  const listeners = { load: [] as (() => void)[], error: [] as ((e: unknown) => void)[] };
  const map: LoadEvents & { fire: (type: "load" | "error", event?: unknown) => void } = {
    once: (_type, listener) => listeners.load.push(listener),
    on: (_type, listener) => listeners.error.push(listener),
    fire: (type, event) => {
      if (type === "load") listeners.load.splice(0).forEach((l) => l());
      else listeners.error.forEach((l) => l(event));
    },
  };
  return map;
}

describe("LiftMapCanvas · before the basemap loads", () => {
  const data = austinLiftMap.payload;
  const html = render(
    <LiftMapCanvas
      data={data}
      mode="LIFT"
      labels={liftLabels(data)}
      label="Figure 1. The fit sits east"
      outlinesUrl={null}
      reducedMotion={false}
      onReady={() => undefined}
      onError={() => undefined}
    />,
  );

  it("stays invisible, so the schematic is all that shows", () => {
    expect(html).toMatch(/^<div class="absolute inset-0 invisible"/);
    expect(html).toContain('data-map-loaded="false"');
  });

  it("shows no attribution and no chips until the basemap it credits is drawn", () => {
    expect(html).not.toContain('data-attribution="basemap"');
    expect(text(html)).not.toContain("OpenFreeMap");
    expect(text(html)).toBe("");
  });

  it("is a labelled group, not an image, so the map controls inside keep their roles", () => {
    expect(html).not.toContain('role="img"');
    expect(html).toContain('role="group" aria-label="Figure 1. The fit sits east (interactive map; the table view lists every value)"');
  });
});

describe("MapAttribution", () => {
  it("credits OpenFreeMap, OpenMapTiles and OpenStreetMap, each linked", () => {
    const html = render(<MapAttribution />);
    expect(text(html)).toBe("© OpenFreeMap © OpenMapTiles © OpenStreetMap contributors");
    for (const a of BASEMAP_ATTRIBUTION) expect(html).toContain(`href="${a.href}"`);
    expect([...html.matchAll(/<a /g)]).toHaveLength(3);
  });
});

describe("watchMapLoad", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const watch = (timeout = MAP_LOAD_TIMEOUT_MS) => {
    vi.useFakeTimers();
    const map = fakeMap();
    const onLoad = vi.fn();
    const onFail = vi.fn();
    const dispose = watchMapLoad(map, { onLoad, onFail }, timeout);
    return { map, onLoad, onFail, dispose };
  };

  it("is ready on 'load', once", () => {
    const { map, onLoad, onFail } = watch();
    map.fire("load");
    map.fire("error", {});
    vi.advanceTimersByTime(MAP_LOAD_TIMEOUT_MS * 2);
    expect(onLoad).toHaveBeenCalledOnce();
    expect(onFail).not.toHaveBeenCalled();
  });

  it("fails when the style errors before it loads", () => {
    const { map, onLoad, onFail } = watch();
    map.fire("error", { error: new Error("style unreachable") });
    map.fire("load");
    expect(onFail).toHaveBeenCalledOnce();
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("leaves tile and source errors to the basemap", () => {
    const { map, onLoad, onFail } = watch();
    map.fire("error", { sourceId: "openmaptiles" });
    map.fire("error", { tile: {} });
    expect(onFail).not.toHaveBeenCalled();
    map.fire("load");
    expect(onLoad).toHaveBeenCalledOnce();
  });

  it("gives up when 'load' has not fired by the timeout, and ignores a late load", () => {
    expect(MAP_LOAD_TIMEOUT_MS).toBe(10_000);
    const { map, onLoad, onFail } = watch();
    vi.advanceTimersByTime(MAP_LOAD_TIMEOUT_MS - 1);
    expect(onFail).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onFail).toHaveBeenCalledOnce();
    map.fire("load");
    expect(onLoad).not.toHaveBeenCalled();
  });

  it("does nothing after it is disposed", () => {
    const { map, onLoad, onFail, dispose } = watch();
    dispose();
    vi.advanceTimersByTime(MAP_LOAD_TIMEOUT_MS * 2);
    map.fire("load");
    expect(onLoad).not.toHaveBeenCalled();
    expect(onFail).not.toHaveBeenCalled();
  });
});
