// The MapLibre worker as a bundled Web Worker entry. MapLibre 6 looks for its worker file beside its
// own module, which the bundler moves, so LiftMapCanvas starts this entry instead (see routeMapWorker).
import MapLibreWorker from "maplibre-gl/dist/maplibre-gl-worker.mjs";

// The module starts itself when evaluated (self.worker = new Worker(self)), but maplibre-gl marks its
// dist files free of side effects, so a bare import would be dropped: using the export keeps it.
const scope = self as unknown as { worker?: unknown };
scope.worker ??= new MapLibreWorker(self);
