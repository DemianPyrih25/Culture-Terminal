import { publicDataErrorCode } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { normaliseBody, publicCacheKey } from "../../src/canonical";
import { overpassTarget } from "../../src/osm/client";
import { osmCountsSpec } from "../../src/osm/client";
import {
  countsQuery,
  matchesType,
  OSM_QL_HEADER,
  OSM_QL_HEADER_ADMIN,
  OSM_QL_HEADER_ADMIN_LONG,
  placesQuery,
  qlString,
} from "../../src/osm/query";
import { ACTIVITY, BAR, CAFE, CIRCLE, COUNTIES, PIZZA, SQUARE } from "./support";

const err = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return null;
};

describe("counts query", () => {
  it("is canonical: shapes by id, types by key, one statement per pair, no line breaks", () => {
    const a = countsQuery({ shapes: [SQUARE, CIRCLE], types: [CAFE, BAR] });
    const b = countsQuery({ shapes: [CIRCLE, SQUARE], types: [BAR, CAFE] });
    expect(a.ql).toBe(b.ql);
    expect(a.ql.startsWith(OSM_QL_HEADER)).toBe(true);
    expect(a.ql).not.toMatch(/\n/);
    expect(a.plan.kind === "counts" && a.plan.pairs.map((p) => `${p.shape.id}/${p.typeKey}`)).toEqual([
      "area-a/bar",
      "area-a/cafe",
      "area-b/bar",
      "area-b/cafe",
    ]);
    expect(a.ql.match(/out count;/g)).toHaveLength(4);
    expect(a.trace).toEqual({ kind: "counts", shapes: "area-a,area-b", types: "bar,cafe" });
  });

  it("filters a circle directly and a polygon through a named set of the keys it needs", () => {
    const { ql } = countsQuery({ shapes: [CIRCLE, SQUARE], types: [BAR, PIZZA] });
    expect(ql).toContain('(nwr["amenity"="bar"](around:5000,10.15,20.15);nwr["amenity"="pub"](around:5000,10.15,20.15););out count;');
    expect(ql).toContain('(nwr["amenity"~"^(bar|pub)$|^(restaurant|fast_food)$"](poly:"10.1 20.1 10.2 20.1 10.2 20.2 10.1 20.2");)->.s1;');
    expect(ql).toContain('(nwr.s1["amenity"~"^(restaurant|fast_food)$"]["cuisine"~"(^|;) *(pizza) *(;|$)"];);out count;');
  });

  it("collects only the values a polygon's types need, and a key some type needs whole (activity's shop) whole", () => {
    const { ql } = countsQuery({ shapes: [SQUARE], types: [ACTIVITY, CAFE] });
    expect(ql).toContain(
      '(nwr["amenity"~"^(cafe)$|^(restaurant|cafe|bar)$"](poly:"10.1 20.1 10.2 20.1 10.2 20.2 10.1 20.2");nwr["shop"](poly:"10.1 20.1 10.2 20.1 10.2 20.2 10.1 20.2");)->.s0;',
    );
    expect(ql).toContain('(nwr.s0["amenity"~"^(restaurant|cafe|bar)$"];nwr.s0["shop"];);out count;');
  });

  it("reads a county union as a named area set with the larger limits", () => {
    const run = countsQuery({ shapes: [COUNTIES], types: [CAFE] });
    expect(run.ql.startsWith(OSM_QL_HEADER_ADMIN)).toBe(true);
    expect(run.ql).toContain(
      '(area["wikidata"="Q900001"]["boundary"="administrative"];area["wikidata"="Q900002"]["boundary"="administrative"];)->.a0;(nwr["amenity"="cafe"](area.a0););out count;',
    );
    const warm = countsQuery({ shapes: [COUNTIES], types: [CAFE] }, { long: true });
    expect(warm.ql.startsWith(OSM_QL_HEADER_ADMIN_LONG)).toBe(true);
    // The settings line is not keyed: the warm-up's answer serves a run.
    expect(normaliseBody(warm.ql)).toBe(normaliseBody(run.ql));
    const target = overpassTarget();
    const key = (long: boolean) => publicCacheKey(osmCountsSpec(target, { shapes: [COUNTIES], types: [CAFE] }, { long }).request, "pd-v1");
    expect(key(true)).toBe(key(false));
    expect(publicCacheKey(osmCountsSpec(target, { shapes: [COUNTIES], types: [BAR] }).request, "pd-v1")).not.toBe(key(false));
    expect(key(false)).not.toBe(publicCacheKey(osmCountsSpec(target, { shapes: [COUNTIES], types: [CAFE] }).request, "mock-pd-v1"));
  });

  it("simplifies a long ring to at most 48 vertices", () => {
    const ring: [number, number][] = Array.from({ length: 400 }, (_, i) => {
      const a = (i / 400) * 2 * Math.PI;
      return [10 + 0.05 * Math.sin(a), 20 + 0.05 * Math.cos(a)];
    });
    const { plan, ql } = countsQuery({ shapes: [{ kind: "poly", id: "round", ring }], types: [CAFE] });
    const shape = plan.kind === "counts" ? plan.pairs[0]?.shape : null;
    expect(shape?.kind === "poly" && shape.ring.length).toBeLessThanOrEqual(48);
    const poly = /poly:"([^"]+)"/.exec(ql)?.[1] ?? "";
    expect(poly.split(" ").length / 2).toBeLessThanOrEqual(48);
  });

  it("refuses limits, duplicates and malformed input with bad_request", () => {
    const shapes = Array.from({ length: 9 }, (_, i) => ({ ...CIRCLE, id: `s${i}` }));
    expect(publicDataErrorCode(err(() => countsQuery({ shapes, types: [CAFE] })))).toBe("bad_request");
    const types = Array.from({ length: 25 }, (_, i) => ({ ...CAFE, key: `t${i}` }));
    expect(publicDataErrorCode(err(() => countsQuery({ shapes: [CIRCLE], types })))).toBe("bad_request");
    expect(publicDataErrorCode(err(() => countsQuery({ shapes: [CIRCLE, CIRCLE], types: [CAFE] })))).toBe("bad_request");
    expect(publicDataErrorCode(err(() => countsQuery({ shapes: [CIRCLE], types: [CAFE, CAFE] })))).toBe("bad_request");
    expect(publicDataErrorCode(err(() => countsQuery({ shapes: [{ ...CIRCLE, radiusM: 60_000 }], types: [CAFE] })))).toBe("bad_request");
    expect(publicDataErrorCode(err(() => countsQuery({ shapes: [{ ...COUNTIES, wikidata: ["Q1; out;"] }], types: [CAFE] })))).toBe("bad_request");
    expect(publicDataErrorCode(err(() => countsQuery({ shapes: [{ ...CIRCLE, id: 'x"];' }], types: [CAFE] })))).toBe("bad_request");
    const badKey = { key: "cafe", groups: [[{ key: 'amenity"]', value: "cafe", op: "eq" as const }]] };
    expect(publicDataErrorCode(err(() => countsQuery({ shapes: [CIRCLE], types: [badKey] })))).toBe("bad_request");
    const badRegex = { key: "cafe", groups: [[{ key: "amenity", value: "(", op: "regex" as const }]] };
    expect(publicDataErrorCode(err(() => countsQuery({ shapes: [CIRCLE], types: [badRegex] })))).toBe("bad_request");
  });

  it("escapes quotes and backslashes in values", () => {
    expect(qlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    const t = { key: "named", groups: [[{ key: "name", value: 'Joe\'s "Place"', op: "eq" as const }]] };
    expect(countsQuery({ shapes: [CIRCLE], types: [t] }).ql).toContain('["name"="Joe\'s \\"Place\\""]');
  });
});

describe("places query", () => {
  it("asks for named elements only, with centres and a limit", () => {
    const { ql, trace } = placesQuery({ shape: CIRCLE, types: [BAR], limit: 60 });
    expect(ql).toBe(
      `${OSM_QL_HEADER}(nwr["amenity"="bar"]["name"](around:5000,10.15,20.15);nwr["amenity"="pub"]["name"](around:5000,10.15,20.15););out center tags 60;`,
    );
    expect(trace).toEqual({ kind: "places", shape: "area-a", types: "bar", limit: "60" });
  });

  it("refuses more than 4 types or 80 places", () => {
    const types = ["a", "b", "c", "d", "e"].map((k) => ({ ...CAFE, key: k }));
    expect(publicDataErrorCode(err(() => placesQuery({ shape: CIRCLE, types, limit: 10 })))).toBe("bad_request");
    expect(publicDataErrorCode(err(() => placesQuery({ shape: CIRCLE, types: [CAFE], limit: 81 })))).toBe("bad_request");
    expect(publicDataErrorCode(err(() => placesQuery({ shape: CIRCLE, types: [CAFE], limit: 0 })))).toBe("bad_request");
  });
});

describe("local type matching", () => {
  it("reads eq, exists and the list-form regex the way Overpass does", () => {
    expect(matchesType({ amenity: "pub" }, BAR)).toBe(true);
    expect(matchesType({ amenity: "cafe" }, BAR)).toBe(false);
    expect(matchesType({ shop: "books" }, ACTIVITY)).toBe(true);
    expect(matchesType({ amenity: "restaurant", cuisine: "italian;pizza" }, PIZZA)).toBe(true);
    expect(matchesType({ amenity: "restaurant", cuisine: "pizza_hut_style" }, PIZZA)).toBe(false);
    expect(matchesType({ amenity: "cafe", cuisine: "pizza" }, PIZZA)).toBe(false);
  });
});
