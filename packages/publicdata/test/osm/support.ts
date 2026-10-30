// Invented OpenStreetMap fixtures: places, ids and counts here are made up; URLs use example.org.
import type { OsmShape, OsmTypeQuery } from "@ct/contracts";
import type { PublicRequest } from "../../src/api";

export const CAFE: OsmTypeQuery = { key: "cafe", groups: [[{ key: "amenity", value: "cafe", op: "eq" }]] };
export const BAR: OsmTypeQuery = { key: "bar", groups: [[{ key: "amenity", value: "bar", op: "eq" }], [{ key: "amenity", value: "pub", op: "eq" }]] };
export const PIZZA: OsmTypeQuery = {
  key: "pizza",
  groups: [
    [
      { key: "amenity", value: "^(restaurant|fast_food)$", op: "regex" },
      { key: "cuisine", value: "(^|;) *(pizza) *(;|$)", op: "regex" },
    ],
  ],
};
export const ACTIVITY: OsmTypeQuery = {
  key: "activity",
  groups: [[{ key: "amenity", value: "^(restaurant|cafe|bar)$", op: "regex" }], [{ key: "shop", value: null, op: "exists" }]],
};

export const SQUARE: Extract<OsmShape, { kind: "poly" }> = {
  kind: "poly",
  id: "area-b",
  ring: [
    [10.1, 20.1],
    [10.2, 20.1],
    [10.2, 20.2],
    [10.1, 20.2],
  ],
};
export const CIRCLE: Extract<OsmShape, { kind: "around" }> = { kind: "around", id: "area-a", lat: 10.15, lon: 20.15, radiusM: 5000 };
export const COUNTIES: Extract<OsmShape, { kind: "admin" }> = { kind: "admin", id: "city:testville", wikidata: ["Q900002", "Q900001"] };

export const OSM_BASE = "2026-10-01T12:00:00Z";

/** An Overpass `out count` answer with these totals, in order. */
export function countsBody(totals: readonly number[], extra: Record<string, unknown> = {}): unknown {
  return {
    version: 0.6,
    generator: "Overpass API test",
    osm3s: { timestamp_osm_base: OSM_BASE, copyright: "test" },
    ...extra,
    elements: totals.map((t) => ({ type: "count", id: 0, tags: { nodes: String(t), ways: "0", relations: "0", total: String(t) } })),
  };
}

/** An Overpass `out center tags` answer. */
export function placesBody(elements: readonly unknown[]): unknown {
  return { version: 0.6, osm3s: { timestamp_osm_base: OSM_BASE }, elements };
}

/** The answer a counts request expects: one count per planned pair, from `total(shape, type)`. */
export function answerCounts(request: PublicRequest, total: (shapeId: string, typeKey: string) => number = () => 3): unknown {
  const plan = request.osm;
  if (plan?.kind !== "counts") throw new Error("not a counts request");
  return countsBody(plan.pairs.map((p) => total(p.shape.id, p.typeKey)));
}
