import { CITIES, type City, cityNamed, cityNear } from "./cities";
import { geohashEncode, type LatLon, offsetKm } from "./geo";
import { clamp, intBetween, pick, round, unit } from "./hash";
import { entityId, metroCodeOfId, typeOfId } from "./ids";
import type { Json, JsonObject } from "./json";
import { DEFAULT_METRO, type Metro, METROS, metroByCode, metroInName, type Neighborhood, nearestNeighborhood } from "./metros";
import { BRAND_FAMILIES, type BrandFamily, brandName, nameCapacity, nameForId, normalizeName, STREET_KINDS, STREETS, universeName } from "./names";
import { genreOptions, type MockTag, SEARCH_FACETS } from "./tags";

/**
 * Synthetic entities. Each type has a fixed, generated universe that open insights calls rank;
 * any other id (a searched name, a fixture id) is described deterministically from its hash.
 */

export interface Geocode {
  name: string | null;
  city: string | null;
  metro: string | null;
  admin1_region: string | null;
  admin2_region: string | null;
  country: string | null;
  country_code: string | null;
}

export interface EntityGeo {
  at: LatLon;
  geocode: Geocode | null;
  place: { address: string; neighborhood: string | null; priceLevel: number } | null;
}

export interface EntityRecord {
  id: string;
  type: string;
  name: string;
  disambiguation: string | null;
  popularity: number;
  /** Taxonomy tags the entity carries; the first one is its genre. */
  tags: readonly MockTag[];
  geo: EntityGeo | null;
}

export const PLACE = "urn:entity:place";
export const LOCALITY = "urn:entity:locality";
export const DESTINATION = "urn:entity:destination";
const BRAND = "urn:entity:brand";

const UNIVERSE_SIZE: Readonly<Record<string, number>> = {
  [BRAND]: 240,
  "urn:entity:artist": 160,
  "urn:entity:podcast": 120,
  "urn:entity:tv_show": 120,
  "urn:entity:movie": 120,
  "urn:entity:person": 120,
  [DESTINATION]: 300,
  [PLACE]: 400,
};

/** Popularity in (0, 1), skewed high like Qloo's catalogue. */
function popularityOf(id: string): number {
  return round(0.12 + 0.87 * unit("popularity", id) ** 0.6, 4);
}

interface Region {
  admin1: string;
  country: string;
  code: string;
  at: LatLon;
}

const us = (admin1: string, lat: number, lon: number): Region => ({ admin1, country: "United States", code: "US", at: { lat, lon } });

const US_REGIONS: readonly Region[] = [
  us("California", 37.2, -119.5), us("Colorado", 39.0, -105.5), us("Florida", 28.6, -82.4), us("New York", 42.9, -75.5),
  us("Tennessee", 35.86, -86.35), us("Texas", 31.0, -99.3), us("Louisiana", 31.0, -92.0), us("Washington", 47.4, -120.5),
  us("Oregon", 44.0, -120.5), us("Arizona", 34.3, -111.7), us("Utah", 39.3, -111.7), us("North Carolina", 35.5, -79.4),
  us("Georgia", 32.7, -83.4), us("Michigan", 44.3, -85.4), us("Maine", 45.3, -69.2), us("Montana", 47.0, -109.6),
  us("Illinois", 40.0, -89.2), us("Massachusetts", 42.3, -71.8),
];

const WORLD_REGIONS: readonly Region[] = [
  { admin1: "British Columbia", country: "Canada", code: "CA", at: { lat: 50.5, lon: -123.5 } },
  { admin1: "Quintana Roo", country: "Mexico", code: "MX", at: { lat: 19.6, lon: -88.0 } },
  { admin1: "England", country: "United Kingdom", code: "GB", at: { lat: 52.4, lon: -1.5 } },
  { admin1: "Provence", country: "France", code: "FR", at: { lat: 43.9, lon: 6.0 } },
  { admin1: "Kyoto", country: "Japan", code: "JP", at: { lat: 35.0, lon: 135.8 } },
  { admin1: "Tuscany", country: "Italy", code: "IT", at: { lat: 43.4, lon: 11.0 } },
  { admin1: "Catalonia", country: "Spain", code: "ES", at: { lat: 41.8, lon: 1.5 } },
  { admin1: "Lisbon", country: "Portugal", code: "PT", at: { lat: 38.8, lon: -9.1 } },
];

/** About three destinations in four are in the US; one named after a mock metro or market city sits on it. */
function destinationGeo(id: string, name: string): EntityGeo {
  const metro = metroInName(name);
  const city = metro ?? cityNamed(name);
  if (city) {
    const geocode = { name, city: city.name, metro: city.name, admin1_region: city.state, admin2_region: metro?.county ?? null, country: "United States", country_code: "US" };
    return { at: city.center, geocode, place: null };
  }
  const region = unit("dest-us", id) < 0.75 ? pick(US_REGIONS, "dest-region", id) : pick(WORLD_REGIONS, "dest-region", id);
  const at = offsetKm(region.at, (unit("dest-n", id) * 2 - 1) * 150, (unit("dest-e", id) * 2 - 1) * 150);
  const county = `${name.split(/\s+/)[0] ?? name} County`;
  return {
    at,
    geocode: { name, city: null, metro: null, admin1_region: region.admin1, admin2_region: county, country: region.country, country_code: region.code },
    place: null,
  };
}

/** A place's position: up to `spreadKm` from `from` on each axis, fixed by the id. */
function placeAt(id: string, from: LatLon, spreadKm: number): LatLon {
  return offsetKm(from, (unit("place-n", id) * 2 - 1) * spreadKm, (unit("place-e", id) * 2 - 1) * spreadKm);
}

function placeDetails(id: string, neighborhood: string | null): NonNullable<EntityGeo["place"]> {
  const address = `${intBetween(100, 2999, "place-no", id)} ${pick(STREETS, "place-street", id)} ${pick(STREET_KINDS, "place-kind", id)}`;
  return { address, neighborhood, priceLevel: intBetween(1, 4, "place-price", id) };
}

function placeGeo(id: string, metro: Metro, options: { near?: LatLon; hood?: Neighborhood } = {}): EntityGeo {
  const hood = options.hood ?? (options.near ? nearestNeighborhood(metro, options.near) : pick(metro.neighborhoods, "place-hood", id));
  const at = options.near ? placeAt(id, options.near, 0.5) : placeAt(id, hood.at, 1.4);
  return {
    at,
    geocode: {
      // Many live place rows carry a null geocode name or metro (G10).
      name: unit("geo-name", id) < 0.35 ? null : hood.name,
      city: metro.name,
      metro: unit("geo-metro", id) < 0.25 ? null : metro.name,
      admin1_region: metro.state,
      admin2_region: metro.county,
      country: "United States",
      country_code: "US",
    },
    place: placeDetails(id, hood.name),
  };
}

/**
 * A place a located /search found away from every mock metro: it sits at the point and names the
 * market city around it, or no city and no country when the point is near none of them.
 */
function strayPlaceGeo(id: string, near: LatLon, city: City | null): EntityGeo {
  return {
    at: placeAt(id, near, 0.5),
    geocode: {
      name: null,
      city: city?.name ?? null,
      metro: city?.name ?? null,
      admin1_region: city?.state ?? null,
      admin2_region: null,
      country: city ? "United States" : null,
      country_code: city ? "US" : null,
    },
    place: placeDetails(id, null),
  };
}

/** A metro or market city locality sits on its centre; any other name somewhere in the US. */
function localityGeo(id: string, city: City | null): EntityGeo {
  const at = city?.center ?? { lat: 33 + unit("loc-lat", id) * 12, lon: -118 + unit("loc-lon", id) * 40 };
  return { at, geocode: null, place: null };
}

function tagsFor(type: string, id: string, family: BrandFamily = pick(BRAND_FAMILIES, "family", id)): MockTag[] {
  const options = genreOptions(type);
  if (options.length === 0) return [];
  if (type === BRAND) return [options[BRAND_FAMILIES.indexOf(family)] ?? (options[0] as MockTag)];
  const first = pick(options, "genre", id);
  if (type !== PLACE) return [first];
  return [first, pick(options.filter((t) => t.id !== first.id), "genre-2", id)];
}

interface SynthesizeOptions {
  name?: string;
  /** Undefined: the type's default (places name their metro, localities their state). */
  disambiguation?: string;
  /** Places found by a located /search sit near this point. */
  near?: LatLon;
}

/** Describes an id the universes do not hold: a searched name or an id issued elsewhere. */
export function synthesize(id: string, type: string, options: SynthesizeOptions = {}): EntityRecord {
  const name = options.name ?? nameForId(type, id);
  const metroFromId = metroByCode(metroCodeOfId(id));
  let geo: EntityGeo | null = null;
  let disambiguation = options.disambiguation ?? null;
  if (type === PLACE && !metroFromId && options.near) {
    const city = cityNear(options.near);
    geo = strayPlaceGeo(id, options.near, city);
    if (city) disambiguation ??= `${city.name}, ${city.stateCode}`;
  } else if (type === PLACE) {
    // Unlocated place ids carry no metro digit and stay in the default metro.
    const metro = metroFromId ?? DEFAULT_METRO;
    geo = placeGeo(id, metro, { near: options.near });
    disambiguation ??= `${metro.name}, ${metro.stateCode}`;
  } else if (type === DESTINATION) {
    geo = destinationGeo(id, name);
  } else if (type === LOCALITY) {
    // config/metros.json resolves a market by an exact name whose disambiguation names the state.
    const city = metroFromId ?? metroInName(name) ?? cityNamed(name);
    geo = localityGeo(id, city);
    if (city) disambiguation ??= `${city.state}, United States`;
  }
  return { id, type, name, disambiguation, popularity: popularityOf(id), tags: tagsFor(type, id), geo };
}

/**
 * The localities of every mock metro and market city. Holding them in a universe lets their ids
 * describe themselves in any process, as locality ids pinned in the database are reused after a restart.
 */
function localityUniverse(): EntityRecord[] {
  const named = (c: City, metroCode?: string): EntityRecord =>
    synthesize(entityId(LOCALITY, normalizeName(c.name), { metroCode }), LOCALITY, { name: c.name });
  return [...METROS.map((m) => named(m, m.code)), ...CITIES.map((c) => named(c))];
}

function buildUniverse(type: string, metro: Metro): EntityRecord[] {
  if (type === LOCALITY) return localityUniverse();
  const size = UNIVERSE_SIZE[type] ?? 0;
  const records: EntityRecord[] = [];
  for (let i = 0; i < size; i++) {
    if (type === BRAND) {
      const { name, family } = brandName(i);
      const id = entityId(type, normalizeName(name));
      records.push({ id, type, name, disambiguation: null, popularity: popularityOf(id), tags: tagsFor(type, id, family), geo: null });
    } else if (type === PLACE) {
      // Past the name capacity a base name repeats with its neighbourhood, like a second branch.
      const cap = nameCapacity(PLACE);
      const base = universeName(PLACE, i % cap);
      const branch = i < cap ? undefined : pick(metro.neighborhoods, "branch", metro.key, i);
      const name = branch ? `${base} ${branch.name}` : base;
      const id = entityId(PLACE, normalizeName(name), { metroCode: metro.code });
      const record = synthesize(id, type, { name });
      records.push(branch ? { ...record, geo: placeGeo(id, metro, { hood: branch }) } : record);
    } else {
      const name = universeName(type, i);
      records.push(synthesize(entityId(type, normalizeName(name)), type, { name }));
    }
  }
  return records;
}

const universes = new Map<string, { list: EntityRecord[]; byId: Map<string, EntityRecord> }>();

function universeEntry(type: string, metro: Metro): { list: EntityRecord[]; byId: Map<string, EntityRecord> } {
  const key = type === PLACE ? `${type}|${metro.key}` : type;
  let entry = universes.get(key);
  if (!entry) {
    const list = buildUniverse(type, metro);
    entry = { list, byId: new Map(list.map((r) => [r.id, r])) };
    universes.set(key, entry);
  }
  return entry;
}

/** The ranked pool of an open insights call: the type's universe (places: the metro's). */
export function universe(type: string, metro: Metro = DEFAULT_METRO): readonly EntityRecord[] {
  return universeEntry(type, metro).list;
}

/**
 * Records /search handed out in this process, shared by every transport, so later rows for those
 * ids show the searched name (and a located place's position). An id is a one-way hash, so a new
 * process describes a searched id with an invented name until it is searched again; consumers
 * label rows with the name they resolved, never the row name. Scores never read this memory:
 * popularity and tags derive from the id alone.
 */
const searched = new Map<string, EntityRecord>();
const SEARCHED_MAX = 5_000;

export function remember(records: readonly EntityRecord[]): void {
  for (const record of records) {
    searched.delete(record.id);
    searched.set(record.id, record);
  }
  for (const oldest of searched.keys()) {
    if (searched.size <= SEARCHED_MAX) break;
    searched.delete(oldest);
  }
}

/** The record behind any id, from the id alone (what scores use); ids the mock did not issue take `fallbackType`. */
export function lookupRecord(id: string, fallbackType: string): EntityRecord {
  const type = typeOfId(id) ?? fallbackType;
  const metro = metroByCode(metroCodeOfId(id)) ?? DEFAULT_METRO;
  return universeEntry(type, metro).byId.get(id) ?? synthesize(id, type);
}

/** The record a response row shows: what /search handed out for the id in this process, else lookupRecord. */
export function describeRecord(id: string, fallbackType: string): EntityRecord {
  return searched.get(id) ?? lookupRecord(id, fallbackType);
}

/** The record /search returns for a name: the universe entity when the name is one, else a new one. */
export function recordForName(type: string, name: string, options: { disambiguation?: string; metro?: Metro | null; near?: LatLon } = {}): EntityRecord {
  const metro = options.metro ?? (type === LOCALITY ? metroInName(name) : null);
  const id = entityId(type, normalizeName(name), { metroCode: metro?.code, disambiguation: options.disambiguation });
  const known = options.disambiguation === undefined ? universeEntry(type, metro ?? DEFAULT_METRO).byId.get(id) : undefined;
  return known ?? synthesize(id, type, { name, disambiguation: options.disambiguation, near: options.near });
}

function label(rec: EntityRecord): string {
  const genre = rec.tags[0]?.name.toLowerCase();
  switch (rec.type) {
    case BRAND:
      return `${genre ?? "consumer"} brand`;
    case "urn:entity:artist":
      return `${genre ?? "music"} artist`;
    case "urn:entity:podcast":
      return `${genre ?? "general"} podcast`;
    case "urn:entity:tv_show":
      return `${genre ?? "drama"} TV series`;
    case "urn:entity:movie":
      return `${genre ?? "drama"} film`;
    case "urn:entity:person":
      return "performer";
    case DESTINATION:
      return "travel destination";
    case PLACE:
      return `${genre ?? "venue"} in ${rec.geo?.place?.neighborhood ?? rec.geo?.geocode?.city ?? "town"}`;
    default:
      return "locality";
  }
}

function properties(rec: EntityRecord, withGeocode: boolean): JsonObject {
  const props: JsonObject = {
    description: `An invented ${label(rec)} used by Culture Terminal's offline mode.`,
    short_description: `Synthetic ${label(rec)}`,
  };
  if (withGeocode && rec.geo?.geocode) props.geocode = { ...rec.geo.geocode };
  if (rec.geo?.place) {
    props.address = rec.geo.place.address;
    if (rec.geo.place.neighborhood !== null) props.neighborhood = rec.geo.place.neighborhood;
    props.price_level = rec.geo.place.priceLevel;
  }
  return props;
}

function location(rec: EntityRecord): JsonObject | null {
  if (!rec.geo || rec.type === LOCALITY) return null;
  const { lat, lon } = rec.geo.at;
  return { lat: round(lat, 6), lon: round(lon, 6), geohash: geohashEncode(lat, lon, 9) };
}

export interface ExplainShare {
  entity_id: string;
  score: number;
}

/** An insights entity row (PROBE "Response shapes"): `type` is urn:entity and the kind sits in `subtype`. */
export function toInsightsEntity(rec: EntityRecord, extra: { affinity: number | null; tags: readonly MockTag[]; explain: readonly ExplainShare[] | null }): JsonObject {
  const tags: Json[] = [...rec.tags, ...extra.tags].map((t) => ({ id: t.id, name: t.name, type: t.type }));
  // A few live artist tags carry only a type (G15).
  if (rec.type === "urn:entity:artist" && unit("type-only-tag", rec.id) < 1 / 6) tags.push({ type: "urn:tag:genre:music" });
  const row: JsonObject = {
    name: rec.name,
    entity_id: rec.id,
    type: "urn:entity",
    subtype: rec.type,
    properties: properties(rec, true),
    // Some live tv_show insight rows carry popularity: null (P5).
    popularity: rec.type === "urn:entity:tv_show" && unit("null-popularity", rec.id) < 1 / 15 ? null : rec.popularity,
    tags,
    disambiguation: rec.disambiguation,
  };
  const loc = location(rec);
  if (loc) row.location = loc;
  if (extra.affinity !== null) {
    const query: JsonObject = { affinity: extra.affinity };
    if (extra.explain) query.explainability = { "signal.interests.entities": extra.explain.map((s) => ({ ...s })) };
    row.query = query;
  }
  return row;
}

/** Descriptive facet tags /search attaches (G13): `count` distinct names per namespace. */
function facetTags(rec: EntityRecord): MockTag[] {
  if (rec.type === LOCALITY) return [];
  return SEARCH_FACETS.filter((f) => !f.brandOnly || rec.type === BRAND).flatMap((facet) =>
    [...facet.names]
      .sort((a, b) => unit("facet", facet.type, rec.id, a) - unit("facet", facet.type, rec.id, b))
      .slice(0, facet.count)
      .map((name) => ({ id: `${facet.type}:mock_${normalizeName(name).replace(/\s+/g, "_")}`, name, type: facet.type })),
  );
}

/**
 * A /search or /entities result (PROBE "Response shapes"). Destination results carry no geocode or
 * location, as live destination search returned none (sweep); insights rows do carry them (G5).
 */
export function toSearchEntity(rec: EntityRecord): JsonObject {
  const located = rec.type !== DESTINATION;
  const row: JsonObject = {
    name: rec.name,
    entity_id: rec.id,
    types: [rec.type],
    properties: properties(rec, located),
    popularity: rec.popularity,
    disambiguation: rec.disambiguation,
    tags: [...rec.tags, ...facetTags(rec)].map((t) => ({ tag_id: t.id, name: t.name, type: t.type })),
  };
  if (located && rec.geo) row.location = { lat: round(rec.geo.at.lat, 6), lon: round(rec.geo.at.lon, 6) };
  return row;
}

/** Clamped affinity rounding shared by every scored row. */
export function affinityValue(x: number): number {
  return round(clamp(x, 0, 0.999), 6);
}
