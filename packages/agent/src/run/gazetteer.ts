import type { GeoApi } from "@ct/contracts";
import { createGeo } from "@ct/geo";

/** The gazetteer is static data: indexed once per process, shared by every run, scan plan and preview. */
let sharedGeo: GeoApi | null = null;

export function gazetteer(): GeoApi {
  return (sharedGeo ??= createGeo());
}
