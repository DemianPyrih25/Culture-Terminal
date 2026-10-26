/**
 * How a new LiftMap settles: ready on MapLibre's 'load', failed when the style errors before it or
 * when 'load' has not fired within the timeout. Until it settles the canvas stays invisible and the
 * schematic stays on screen, so a style request that hangs keeps the clean schematic instead of a
 * blank basemap under a second copy of the cells. Pure of MapLibre itself, so it is tested without
 * a DOM or WebGL.
 */

/** How long the basemap may take to load before the map gives up and the schematic stays. */
export const MAP_LOAD_TIMEOUT_MS = 10_000;

/** The parts of a MapLibre map the watch listens to. */
export interface LoadEvents {
  once(type: "load", listener: () => void): unknown;
  on(type: "error", listener: (event: unknown) => void): unknown;
}

/**
 * Calls exactly one of onLoad or onFail. A tile or source error is the basemap's business and never
 * fails the map; neither does anything after it has settled. Returns a dispose that clears the timer.
 */
export function watchMapLoad(
  map: LoadEvents,
  handlers: { onLoad: () => void; onFail: () => void },
  timeoutMs = MAP_LOAD_TIMEOUT_MS,
): () => void {
  let settled = false;
  const settle = (ok: boolean) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (ok) handlers.onLoad();
    else handlers.onFail();
  };
  // settle only ever runs from a timer or map event, after this line.
  const timer = setTimeout(() => settle(false), timeoutMs);
  map.once("load", () => settle(true));
  map.on("error", (event) => {
    const detail = (event ?? {}) as { sourceId?: unknown; tile?: unknown };
    if (detail.sourceId !== undefined || detail.tile !== undefined) return;
    settle(false);
  });
  return () => {
    settled = true;
    clearTimeout(timer);
  };
}
