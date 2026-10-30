import { OSM_ATTRIBUTION, OSM_LICENCE, OSM_QUERY_LIMITS, type OsmCountQuery, type OsmShape, type OsmTypeQuery } from "@ct/contracts";
import { z } from "zod";
import raw from "../../../../config/osm_tags.json";

/**
 * config/osm_tags.json (Part 11 design §3.2, D46): the OpenStreetMap place types local_supply counts, the
 * street-activity measure, and the counties each map city's city-level reference is counted over. Only
 * entries with `status: "verified"` are ever used (tools/dev/osm-tags.ts writes it after a live taginfo
 * and Overpass check; the config test fails on any other status, so an unverified entry never ships).
 */

export const OSM_ACTIVITY_KEY = "activity";
/** `mix: true` counts every tenant type plus activity in one request (≤ 24 types). */
export const OSM_TENANT_MAX = 22;

const Filter = z.discriminatedUnion("op", [
  z.object({ key: z.string().min(1), value: z.null(), op: z.literal("exists") }),
  z.object({ key: z.string().min(1), value: z.string().min(1), op: z.literal("eq") }),
  z.object({ key: z.string().min(1), value: z.string().min(1), op: z.literal("regex") }),
]);
const Groups = z.array(z.array(Filter).min(1)).min(1);
const Status = z.string();

export const OsmPlaceTypeEntry = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  aliases: z.array(z.string().min(1)),
  /** config/categories.json keys this type answers for. */
  concepts: z.array(z.string().min(1)),
  /** Per concept: why the count is broader than the concept ("all bars are counted"). */
  concept_notes: z.record(z.string(), z.string().min(1)).optional(),
  group: z.enum(["tenant", "specialty"]),
  groups: Groups,
  status: Status,
  verified_by: z.string(),
});
export type OsmPlaceTypeEntry = z.infer<typeof OsmPlaceTypeEntry>;

export const OsmCounty = z.object({
  name: z.string().min(1),
  fips: z.string().regex(/^\d{5}$/),
  wikidata: z.string().regex(/^Q[1-9]\d*$/),
  land_km2: z.number().positive(),
});
export type OsmCounty = z.infer<typeof OsmCounty>;

export const OsmMetroEntry = z.object({
  counties: z.array(OsmCounty).min(1),
  wikidata: z.array(z.string().regex(/^Q[1-9]\d*$/)).min(1),
  /** Sum of the counties' land area (Census 2020 Gazetteer, ALAND): the city reference's area. */
  land_km2: z.number().positive(),
  status: Status,
  verified_by: z.string(),
});
export type OsmMetroEntry = z.infer<typeof OsmMetroEntry>;

export const OsmTagsConfig = z.object({
  $comment: z.string().optional(),
  attribution: z.literal(OSM_ATTRIBUTION),
  licence: z.literal(OSM_LICENCE),
  activity: z.object({ key: z.literal(OSM_ACTIVITY_KEY), label: z.string().min(1), groups: Groups, status: Status, verified_by: z.string() }),
  place_types: z.array(OsmPlaceTypeEntry),
  metros: z.record(z.string(), OsmMetroEntry),
});
export type OsmTagsConfig = z.infer<typeof OsmTagsConfig>;

/** One usable place type: verified, with its query. */
export interface OsmPlaceType {
  key: string;
  label: string;
  aliases: readonly string[];
  concepts: readonly string[];
  conceptNotes: Readonly<Record<string, string>>;
  group: "tenant" | "specialty";
  query: OsmTypeQuery;
}

export interface OsmMetro {
  id: string;
  counties: readonly OsmCounty[];
  wikidata: readonly string[];
  landKm2: number;
}

export interface OsmTags {
  /** The whole file, as parsed (including any entry not yet verified). */
  config: OsmTagsConfig;
  /** Shops plus food and drink places; null when the activity entry is not verified. */
  activity: (OsmPlaceType & { group: "specialty" }) | null;
  /** Verified place types, in file order. */
  types: readonly OsmPlaceType[];
  metros: ReadonlyMap<string, OsmMetro>;
}

const isVerified = (e: { status: string; verified_by: string }): boolean => e.status === "verified" && e.verified_by.trim() !== "";

/** Builds the usable view of a parsed config (exported for tests and the checker). */
export function buildOsmTags(config: OsmTagsConfig): OsmTags {
  const types = config.place_types.filter(isVerified).map(
    (e): OsmPlaceType => ({
      key: e.key,
      label: e.label,
      aliases: e.aliases,
      concepts: e.concepts,
      conceptNotes: e.concept_notes ?? {},
      group: e.group,
      query: { key: e.key, groups: e.groups },
    }),
  );
  const activity = isVerified(config.activity)
    ? {
        key: OSM_ACTIVITY_KEY,
        label: config.activity.label,
        aliases: [],
        concepts: [],
        conceptNotes: {},
        group: "specialty" as const,
        query: { key: OSM_ACTIVITY_KEY, groups: config.activity.groups },
      }
    : null;
  const metros = new Map<string, OsmMetro>();
  for (const [id, m] of Object.entries(config.metros)) {
    if (isVerified(m)) metros.set(id, { id, counties: m.counties, wikidata: m.wikidata, landKm2: m.land_km2 });
  }
  return { config, activity, types, metros };
}

let memo: OsmTags | null = null;

/** The parsed config/osm_tags.json (once per process). Throws when the file does not match the schema. */
export function osmTags(): OsmTags {
  memo ??= buildOsmTags(OsmTagsConfig.parse(raw));
  return memo;
}

/** A verified place type by key, or the activity measure for "activity"; null otherwise. */
export function osmPlaceType(key: string): OsmPlaceType | null {
  const tags = osmTags();
  if (key === OSM_ACTIVITY_KEY) return tags.activity;
  return tags.types.find((t) => t.key === key) ?? null;
}

/** The storefront types `mix: true` counts. */
export function osmTenantTypes(): OsmPlaceType[] {
  return osmTags().types.filter((t) => t.group === "tenant");
}

/**
 * The place types a config/categories.json concept maps to (in file order) and, when the count is
 * broader than the concept, the note saying so. Empty when OpenStreetMap has no tag for it.
 */
export function osmTypesForConcept(concept: string): { types: OsmPlaceType[]; notes: string[] } {
  const types = osmTags().types.filter((t) => t.concepts.includes(concept));
  const notes = [...new Set(types.map((t) => t.conceptNotes[concept]).filter((n): n is string => n !== undefined))];
  return { types, notes };
}

/** A map city's verified county set, or null. */
export function osmMetro(metroId: string): OsmMetro | null {
  return osmTags().metros.get(metroId) ?? null;
}

/** The city-reference shape of a map city (its counties, by Wikidata id), or null when it has none. */
export function osmMetroShape(metroId: string): Extract<OsmShape, { kind: "admin" }> | null {
  const metro = osmMetro(metroId);
  return metro === null ? null : { kind: "admin", id: `city:${metroId}`, wikidata: metro.wikidata };
}

/** One fixed set of types a city reference is read in. */
export interface OsmCitySet {
  id: string;
  types: OsmTypeQuery[];
}

/**
 * The fixed type sets every city reference is read in: the tenant types, then the specialty types (in
 * chunks that fit one request), each with street activity. A county union is slow to count (minutes for
 * a large county), so runs never ask for an ad-hoc mix: they ask for whole sets, which the warm-up
 * (`tools/dev/osm-tags.ts warm`) has already cached and which stay cached 30 days (stale copies serve
 * up to 120 days when Overpass fails).
 */
export function osmCitySets(): OsmCitySet[] {
  const tags = osmTags();
  const activity = tags.activity === null ? [] : [tags.activity.query];
  const room = OSM_QUERY_LIMITS.types - activity.length;
  const sets: OsmCitySet[] = [];
  for (const group of ["tenant", "specialty"] as const) {
    const types = tags.types.filter((t) => t.group === group).map((t) => t.query);
    for (let i = 0; i < types.length; i += room) {
      sets.push({ id: i === 0 ? group : `${group}-${i / room + 1}`, types: [...types.slice(i, i + room), ...activity] });
    }
  }
  return sets;
}

/**
 * The city-reference requests that cover `typeKeys` (place type keys or "activity") for a map city: the
 * fewest fixed sets holding them, in set order. Empty when the city has no verified county set.
 */
export function osmCityQueries(metroId: string, typeKeys: readonly string[]): OsmCountQuery[] {
  const shape = osmMetroShape(metroId);
  if (shape === null) return [];
  const wanted = new Set(typeKeys);
  const out: OsmCountQuery[] = [];
  for (const set of osmCitySets()) {
    const keys = set.types.map((t) => t.key);
    if (!keys.some((k) => wanted.has(k))) continue;
    out.push({ shapes: [shape], types: set.types });
    for (const k of keys) wanted.delete(k);
    if (wanted.size === 0) break;
  }
  return out;
}
