import { readFileSync } from "node:fs";
import { OSM_QUERY_LIMITS } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { checkType } from "../../src/osm/query";
import {
  buildOsmTags,
  OSM_ACTIVITY_KEY,
  OSM_TENANT_MAX,
  osmCityQueries,
  osmCitySets,
  osmMetro,
  osmTags,
  OsmTagsConfig,
  osmTenantTypes,
  osmTypesForConcept,
} from "../../src/osm/config";

const read = (path: string): unknown => JSON.parse(readFileSync(new URL(`../../../../config/${path}`, import.meta.url), "utf8"));
const raw = OsmTagsConfig.parse(read("osm_tags.json"));
const categories = (read("categories.json") as { categories: { key: string }[] }).categories.map((c) => c.key);
const mapCities = (read("metros.json") as { gazetteer: { id: string }[] }).gazetteer.map((g) => g.id);

describe("config/osm_tags.json", () => {
  it("lists only verified entries, each with a dated verification", () => {
    const entries = [raw.activity, ...raw.place_types, ...Object.values(raw.metros)];
    for (const e of entries) {
      expect(e.status).toBe("verified");
      expect(e.verified_by).toMatch(/^(taginfo|overpass) \d{4}-\d{2}-\d{2}: /);
    }
    for (const t of raw.place_types) expect(t.verified_by).toMatch(/wiki pages present$/);
  });

  it("has no key or alias collision, and every filter is one the query builder accepts", () => {
    const keys = raw.place_types.map((t) => t.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(OSM_ACTIVITY_KEY);
    const aliases = raw.place_types.flatMap((t) => t.aliases.map((a) => a.toLowerCase()));
    expect(new Set(aliases).size).toBe(aliases.length);
    for (const t of raw.place_types) expect(() => checkType({ key: t.key, groups: t.groups })).not.toThrow();
    expect(() => checkType({ key: OSM_ACTIVITY_KEY, groups: raw.activity.groups })).not.toThrow();
  });

  it("links concepts only to config/categories.json keys, and notes only concepts a type lists", () => {
    for (const t of raw.place_types) {
      for (const c of t.concepts) expect(categories).toContain(c);
      for (const c of Object.keys(t.concept_notes ?? {})) expect(t.concepts).toContain(c);
    }
    expect(osmTypesForConcept("wine_bar")).toEqual({
      types: [expect.objectContaining({ key: "bar" })],
      notes: ["OpenStreetMap does not mark wine bars reliably: all bars are counted"],
    });
    expect(osmTypesForConcept("no_such_concept")).toEqual({ types: [], notes: [] });
  });

  it("keeps mix inside one request: at most 22 tenant types, plus activity", () => {
    const tenants = osmTenantTypes();
    expect(tenants.length).toBeGreaterThan(0);
    expect(tenants.length).toBeLessThanOrEqual(OSM_TENANT_MAX);
    expect(tenants.length + 1).toBeLessThanOrEqual(OSM_QUERY_LIMITS.types);
  });

  it("gives every map city a verified county set whose land area adds up", () => {
    for (const id of mapCities) {
      const metro = osmMetro(id);
      expect(metro, id).not.toBeNull();
      const m = raw.metros[id];
      expect(m?.wikidata).toEqual(m?.counties.map((c) => c.wikidata));
      const sum = (m?.counties ?? []).reduce((s, c) => s + c.land_km2, 0);
      expect(Math.abs(sum - (m?.land_km2 ?? 0))).toBeLessThan(0.05);
    }
    expect(Object.keys(raw.metros).every((id) => mapCities.includes(id))).toBe(true);
  });

  it("reads city references in fixed sets that cover every type", () => {
    const sets = osmCitySets();
    const covered = new Set(sets.flatMap((s) => s.types.map((t) => t.key)));
    for (const t of osmTags().types) expect(covered.has(t.key)).toBe(true);
    for (const s of sets) {
      expect(s.types.length).toBeLessThanOrEqual(OSM_QUERY_LIMITS.types);
      expect(s.types.at(-1)?.key).toBe(OSM_ACTIVITY_KEY);
    }
    const tenantKey = osmTenantTypes()[0]?.key ?? "";
    expect(osmCityQueries("nashville", [tenantKey])).toHaveLength(1);
    expect(osmCityQueries("nashville", [OSM_ACTIVITY_KEY])).toHaveLength(1);
    expect(osmCityQueries("not_a_city", [tenantKey])).toEqual([]);
  });

  it("never uses an entry that is not verified", () => {
    const config = structuredClone(raw);
    const first = config.place_types[0];
    if (first) first.status = "candidate";
    config.activity.status = "candidate";
    const nashville = config.metros.nashville;
    if (nashville) nashville.verified_by = "";
    const tags = buildOsmTags(config);
    expect(tags.types.some((t) => t.key === first?.key)).toBe(false);
    expect(tags.activity).toBeNull();
    expect(tags.metros.has("nashville")).toBe(false);
  });
});
