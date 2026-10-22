// The gazetteer for CLI skill runs: @ct/geo's createGeo() once the geo workstream ships it, else a
// stub that names itself when a skill reaches for it. S0 and S1 never do (place searches use the
// metro centres in @ct/quant). @ct/geo is not a root dependency, so it is loaded by path at run time
// and its absence never breaks the tools typecheck.
import type { GeoApi } from "@ct/contracts";

const GEO_ENTRY = new URL("../../../packages/geo/src/index.ts", import.meta.url).href;

export interface LoadedGeo {
  geo: GeoApi;
  source: "@ct/geo" | "stub";
}

export function stubGeo(): GeoApi {
  const missing = (): never => {
    throw new Error("the gazetteer (@ct/geo createGeo) is not available in this build");
  };
  return {
    metros: missing,
    neighbourhoods: missing,
    neighbourhood: missing,
    matchNeighbourhood: missing,
    polygonWkt: missing,
    locate: missing,
    geohashCentroid: missing,
    boundarySource: missing,
  };
}

const isGeoApi = (x: unknown): x is GeoApi =>
  typeof x === "object" && x !== null && typeof (x as Record<string, unknown>).metros === "function";

export async function loadGeo(entry: string = GEO_ENTRY): Promise<LoadedGeo> {
  try {
    const mod = (await import(entry)) as Record<string, unknown>;
    if (typeof mod.createGeo === "function") {
      const geo: unknown = await (mod.createGeo as () => unknown)();
      if (isGeoApi(geo)) return { geo, source: "@ct/geo" };
    }
  } catch {
    // A geo package mid-build (or one that fails to load) leaves the stub in place.
  }
  return { geo: stubGeo(), source: "stub" };
}
