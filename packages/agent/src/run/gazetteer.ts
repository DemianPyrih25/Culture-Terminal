import { createGeo, type Geo } from "@ct/geo";

/**
 * The gazetteer is static data: indexed once per process, shared by every run, scan plan and preview.
 * Names answer at once; a metro's polygons load when a tool first names it (tools.ts).
 */
let sharedGeo: Geo | null = null;

export function gazetteer(): Geo {
  return (sharedGeo ??= createGeo());
}
