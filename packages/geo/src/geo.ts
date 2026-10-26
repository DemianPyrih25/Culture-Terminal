import { METRO_LABEL, MetroId, type GeoApi, type LatLon, type Neighbourhood } from "@ct/contracts";
import Flatbush from "flatbush";
import type { MultiPolygon, Polygon } from "geojson";
import ngeohash from "ngeohash";
import { GAZETTEERS, type Gazetteer, type GazetteerMetro } from "./gazetteer";
import { areaKm2, containsPoint } from "./measure";
import { normaliseAreaName } from "./names";
import { bboxOf, labelPoint, MAX_WKT_VERTICES, outline, outlineWkt, queryWkt } from "./shapes";

/**
 * The gazetteer (PLAN §10.1, D28): neighbourhoods per gazetteer metro, name matching for CLERK's
 * area text, polygons for signal.location and point-in-polygon for geohash cells. Skills reach it
 * only through SkillCtx.geo.
 */

export interface GeoOptions {
  /**
   * Defaults to the gazetteers this build ships (GAZETTEERS). Only MetroId metros are served: a
   * gazetteer for a reserved id waits until contracts MetroId takes it.
   */
  gazetteers?: Readonly<Partial<Record<GazetteerMetro, Gazetteer>>>;
}

/** Neighbourhood ids are the `ref` of an `{kind: "nbhd"}` area, so they follow AreaArg's pattern. */
const AREA_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

interface MetroIndex {
  source: string | null;
  list: readonly Neighbourhood[];
  byId: ReadonlyMap<string, Neighbourhood>;
  byName: ReadonlyMap<string, Neighbourhood>;
  shapes: ReadonlyMap<string, Polygon | MultiPolygon>;
  /** signal.location WKT per neighbourhood, written once at start-up. */
  wkt: ReadonlyMap<string, string>;
  /** Bounding boxes in list order; null without neighbourhoods (Flatbush needs at least one item). */
  boxes: Flatbush | null;
}

const EMPTY: MetroIndex = { source: null, list: [], byId: new Map(), byName: new Map(), shapes: new Map(), wkt: new Map(), boxes: null };

/** Builds one metro's index. Gazetteer data is ours, so a malformed module fails loudly at start-up. */
function indexGazetteer(metro: MetroId, gazetteer: Gazetteer): MetroIndex {
  if (gazetteer.metro !== metro) throw new Error(`gazetteer for ${metro} declares metro ${gazetteer.metro}`);
  const list: Neighbourhood[] = [];
  const byId = new Map<string, Neighbourhood>();
  const byName = new Map<string, Neighbourhood>();
  const shapes = new Map<string, Polygon | MultiPolygon>();
  const wkt = new Map<string, string>();
  for (const a of gazetteer.areas) {
    if (!AREA_ID.test(a.id)) throw new Error(`${metro} gazetteer: "${a.id}" is not a valid neighbourhood id`);
    if (byId.has(a.id)) throw new Error(`${metro} gazetteer: neighbourhood id "${a.id}" repeats`);
    const ring = outline(a.geometry);
    if (ring.length < 4) throw new Error(`${metro} gazetteer: ${a.id} has no usable outline`);
    const queryRing = a.query?.coordinates[0];
    if (a.query !== undefined && (queryRing === undefined || queryRing.length < 4 || queryRing.length > MAX_WKT_VERTICES)) {
      throw new Error(`${metro} gazetteer: ${a.id} has a query polygon outside 4–${MAX_WKT_VERTICES} points`);
    }
    const n: Neighbourhood = {
      id: a.id,
      name: a.name,
      metro,
      centroid: a.centroid ?? labelPoint(a.geometry),
      areaKm2: a.areaKm2 ?? areaKm2(a.geometry),
    };
    list.push(n);
    byId.set(a.id, n);
    shapes.set(a.id, a.geometry);
    wkt.set(a.id, a.query === undefined ? outlineWkt(a.geometry) : queryWkt(a.query));
    for (const name of [a.name, ...(a.aliases ?? []), ...(a.approximateAliases ?? [])]) {
      const key = normaliseAreaName(name);
      const taken = byName.get(key);
      if (taken !== undefined && taken.id !== a.id) {
        throw new Error(`${metro} gazetteer: "${name}" names both ${taken.id} and ${a.id}`);
      }
      byName.set(key, n);
    }
  }
  let boxes: Flatbush | null = null;
  if (list.length > 0) {
    boxes = new Flatbush(list.length);
    for (const n of list) {
      const b = bboxOf(shapes.get(n.id) as Polygon | MultiPolygon);
      boxes.add(b.minLon, b.minLat, b.maxLon, b.maxLat);
    }
    boxes.finish();
  }
  return { source: gazetteer.source, list, byId, byName, shapes, wkt, boxes };
}

export function createGeo(options: GeoOptions = {}): GeoApi {
  const gazetteers = options.gazetteers ?? GAZETTEERS;
  const index = new Map<MetroId, MetroIndex>(
    MetroId.options.map((metro) => {
      const g = gazetteers[metro];
      return [metro, g === undefined ? EMPTY : indexGazetteer(metro, g)];
    }),
  );
  const of = (metro: MetroId): MetroIndex => index.get(metro) ?? EMPTY;

  return {
    metros: () => MetroId.options,
    neighbourhoods: (metro) => of(metro).list,
    neighbourhood: (metro, id) => of(metro).byId.get(id) ?? null,
    matchNeighbourhood: (metro, text) => of(metro).byName.get(normaliseAreaName(text)) ?? null,
    polygonWkt: (metro, id) => of(metro).wkt.get(id) ?? null,
    locate(metro, point: LatLon) {
      const m = of(metro);
      if (m.boxes === null) return null;
      for (const i of m.boxes.search(point.lon, point.lat, point.lon, point.lat)) {
        const n = m.list[i];
        const shape = n === undefined ? undefined : m.shapes.get(n.id);
        if (n !== undefined && shape !== undefined && containsPoint(shape, point)) return n.id;
      }
      return null;
    },
    geohashCentroid(geohash) {
      if (!/^[0-9b-hjkmnp-z]{1,12}$/.test(geohash)) throw new RangeError(`geohashCentroid: "${geohash}" is not a geohash`);
      const { latitude, longitude } = ngeohash.decode(geohash);
      return { lat: latitude, lon: longitude };
    },
    boundarySource: (metro) =>
      of(metro).source ?? `No neighbourhood boundaries for ${METRO_LABEL[metro]} in this build; area exhibits are unavailable.`,
  };
}
