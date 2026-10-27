// @ct/geo public API: the neighbourhood gazetteer behind SkillCtx.geo (PLAN §10.1, D28).
export { createGeo, GeoNotLoadedError, type Geo, type GeoOptions } from "./geo";
export { ensureMetros, ensureMetrosIn, metrosIn } from "./ensure";
export { GAZETTEER_CATALOG } from "./catalog";
export {
  GAZETTEER_LOADERS,
  loadGazetteer,
  loadGazetteers,
  type CatalogArea,
  type CatalogMetro,
  type Gazetteer,
  type GazetteerArea,
  type GazetteerCatalog,
  type GazetteerLoader,
  type GazetteerMetro,
} from "./gazetteer";
export { normaliseAreaName } from "./names";
export { MAX_WKT_VERTICES } from "./shapes";
