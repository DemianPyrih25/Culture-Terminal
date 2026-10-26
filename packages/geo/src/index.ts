// @ct/geo public API: the neighbourhood gazetteer behind SkillCtx.geo (PLAN §10.1, D28).
export { createGeo, type GeoOptions } from "./geo";
export { GAZETTEERS, type Gazetteer, type GazetteerArea, type GazetteerMetro } from "./gazetteer";
export { normaliseAreaName } from "./names";
export { MAX_WKT_VERTICES } from "./shapes";
