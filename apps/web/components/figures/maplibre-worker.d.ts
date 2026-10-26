// MapLibre's worker module ships without types; lift-map-worker.ts only constructs it.
declare module "maplibre-gl/dist/maplibre-gl-worker.mjs" {
  export default class MapLibreWorker {
    constructor(self: unknown);
  }
}
