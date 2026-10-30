import {
  OSM_QUERY_LIMITS,
  type OsmCountQuery,
  type OsmFilter,
  type OsmPlacesQuery,
  type OsmShape,
  type OsmTypeQuery,
} from "@ct/contracts";
import { PublicDataError, type OsmRequestPlan } from "../api";
import { polyText, simplifyRing } from "./simplify";

/**
 * The Overpass QL builder (Part 11 design §3.1). Every query is built here, in one canonical form, so the
 * same question always produces the same text (and the same cache key): shapes sorted by id, types by
 * key, no line breaks, coordinates at 5 decimals. Tag keys and values come from config/osm_tags.json and
 * are still checked and escaped; shapes come from the gazetteer, config/metros.json and the metro county
 * list. Nothing a person types reaches a query.
 *
 * - Counts: for each shape and type, `(<group 1>;<group 2>;);out count;`, answered in order. A `poly:`
 *   shape first collects the elements carrying the values its types need into a named set
 *   (`(nwr["amenity"~"^(bar|cafe)$"](poly:"…");…)->.s0;`), so the polygon text appears once per key instead
 *   of once per type; each type then filters that set (`nwr.s0["amenity"="cafe"]`). A circle (`around:`) or county
 *   union (`area.a0`) is short and filters each statement directly.
 * - Places: `(nwr<group>["name"](<shape>);…);out center tags <limit>;`: named elements only, so the limit
 *   applies to places that can be listed.
 */

/**
 * Neighbourhood polygons and circles. 128 MB, not 32: a polygon test loads the ways around it, and live a
 * dense city ZIP area (about 15 km² of Chicago) ran out of memory at 32 MB and needed 64 MB or more. Still a
 * quarter of Overpass's own default.
 */
export const OSM_QL_HEADER = "[out:json][timeout:25][maxsize:134217728];";
/**
 * A county union (the city reference) holds tens of thousands of elements: Overpass needs its default
 * 512 MB and longer than 25 s (a large county took over two minutes live). Inside a run the query gets
 * 40 s; the warm-up (`tools/dev/osm-tags.ts warm`) gives it 180 s. The settings statement is not part
 * of the cache key (canonical.ts), so a warmed answer serves runs.
 */
export const OSM_QL_HEADER_ADMIN = "[out:json][timeout:40][maxsize:536870912];";
export const OSM_QL_HEADER_ADMIN_LONG = "[out:json][timeout:180][maxsize:536870912];";

export interface OsmQueryOptions {
  /** The warm-up's longer server-side limit for county unions. */
  long?: boolean;
}

const headerFor = (shapes: readonly OsmShape[], options: OsmQueryOptions): string =>
  shapes.some((s) => s.kind === "admin") ? (options.long ? OSM_QL_HEADER_ADMIN_LONG : OSM_QL_HEADER_ADMIN) : OSM_QL_HEADER;
/** The longest circle a market read uses is 5 km; anything past 50 km is refused as a mistake. */
export const OSM_MAX_RADIUS_M = 50_000;

const KEY_RE = /^[a-z][a-z0-9_:]*$/;
const SHAPE_ID_RE = /^[A-Za-z0-9_.:-]{1,64}$/;
const WIKIDATA_RE = /^Q[1-9]\d{0,11}$/;
const MAX_VALUE_CHARS = 200;
const MAX_WIKIDATA_PER_SHAPE = 10;

const bad = (message: string): PublicDataError => new PublicDataError("bad_request", message, { source: "osm" });

/** A QL string literal: double quotes, with backslash and quote escaped. */
export function qlString(text: string): string {
  return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function checkFilter(f: OsmFilter): void {
  if (!KEY_RE.test(f.key)) throw bad(`"${f.key.slice(0, 40)}" is not an OpenStreetMap tag key`);
  if (f.op === "exists") {
    if (f.value !== null) throw bad(`the exists filter on ${f.key} takes no value`);
    return;
  }
  if (typeof f.value !== "string" || f.value === "" || f.value.length > MAX_VALUE_CHARS || /[\u0000-\u001f]/.test(f.value)) {
    throw bad(`the ${f.op} filter on ${f.key} needs a value of 1 to ${MAX_VALUE_CHARS} printable characters`);
  }
  if (f.op === "regex") {
    try {
      new RegExp(f.value);
    } catch {
      throw bad(`the regex filter on ${f.key} is not a valid pattern`);
    }
  }
}

export function checkType(t: OsmTypeQuery): void {
  if (!KEY_RE.test(t.key)) throw bad(`"${t.key.slice(0, 40)}" is not a place type key`);
  if (t.groups.length === 0) throw bad(`place type ${t.key} has no filter group`);
  for (const group of t.groups) {
    if (group.length === 0) throw bad(`place type ${t.key} has an empty filter group`);
    for (const f of group) checkFilter(f);
  }
}

/** The shape, checked, with a `poly` ring simplified to at most 48 vertices. */
export function canonicalShape(shape: OsmShape): OsmShape {
  if (!SHAPE_ID_RE.test(shape.id)) throw bad(`"${shape.id.slice(0, 40)}" is not a shape id`);
  switch (shape.kind) {
    case "poly": {
      let ring: [number, number][];
      try {
        ring = simplifyRing(shape.ring, OSM_QUERY_LIMITS.polyVertices);
      } catch (err) {
        throw bad(`shape ${shape.id}: ${(err as Error).message}`);
      }
      return { kind: "poly", id: shape.id, ring };
    }
    case "around": {
      const { lat, lon, radiusM } = shape;
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
        throw bad(`shape ${shape.id}: [${lat}, ${lon}] is not a [lat, lon] coordinate`);
      }
      if (!(radiusM > 0) || radiusM > OSM_MAX_RADIUS_M) throw bad(`shape ${shape.id}: radius must be in (0, ${OSM_MAX_RADIUS_M}] m`);
      return { kind: "around", id: shape.id, lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)), radiusM: Math.round(radiusM) };
    }
    case "admin": {
      const wikidata = [...new Set(shape.wikidata)].sort();
      if (wikidata.length === 0 || wikidata.length > MAX_WIKIDATA_PER_SHAPE) {
        throw bad(`shape ${shape.id}: 1 to ${MAX_WIKIDATA_PER_SHAPE} Wikidata ids, got ${wikidata.length}`);
      }
      const wrong = wikidata.find((q) => !WIKIDATA_RE.test(q));
      if (wrong !== undefined) throw bad(`shape ${shape.id}: "${wrong.slice(0, 20)}" is not a Wikidata id`);
      return { kind: "admin", id: shape.id, wikidata };
    }
  }
}

function canonicalTypes(types: readonly OsmTypeQuery[], max: number): OsmTypeQuery[] {
  if (types.length === 0) throw bad("no place type to read");
  if (types.length > max) throw bad(`at most ${max} place types per request, got ${types.length}`);
  for (const t of types) checkType(t);
  const keys = new Set(types.map((t) => t.key));
  if (keys.size !== types.length) throw bad("a place type is listed twice");
  return [...types].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

export const filterQl = (f: OsmFilter): string =>
  f.op === "exists" ? `[${qlString(f.key)}]` : `[${qlString(f.key)}${f.op === "eq" ? "=" : "~"}${qlString(f.value ?? "")}]`;

export const groupQl = (group: readonly OsmFilter[]): string => group.map(filterQl).join("");

/** The spatial filter of a circle or a polygon (a county union uses a named area set instead). */
function spatial(shape: Extract<OsmShape, { kind: "poly" | "around" }>): string {
  return shape.kind === "poly" ? `(poly:${qlString(polyText(shape.ring))})` : `(around:${shape.radiusM},${shape.lat},${shape.lon})`;
}

/** `(area["wikidata"="Q1"]["boundary"="administrative"];…)->.a<i>;` */
function adminPrelude(shape: Extract<OsmShape, { kind: "admin" }>, set: string): string {
  return `(${shape.wikidata.map((q) => `area[${qlString("wikidata")}=${qlString(q)}][${qlString("boundary")}=${qlString("administrative")}];`).join("")})->.${set};`;
}

/** A literal tag value inside an Overpass (POSIX extended) regex. */
const regexLiteral = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The filters a poly shape's named set collects: one per first key of the groups (every filter in a group
 * must hold, so the first one bounds it). A key some group needs with `exists` is collected whole; otherwise
 * only the values the groups ask for, as one regex (`^(bar|cafe)$|<pattern>`), so a dense area never loads
 * every parking lot and bench carrying `amenity` (Overpass ran out of memory on that in a city ZIP area).
 */
function setFilters(types: readonly OsmTypeQuery[]): OsmFilter[] {
  const byKey = new Map<string, { exists: boolean; values: Set<string>; patterns: Set<string> }>();
  for (const t of types) {
    for (const g of t.groups) {
      const f = g[0] as OsmFilter;
      const entry = byKey.get(f.key) ?? { exists: false, values: new Set<string>(), patterns: new Set<string>() };
      byKey.set(f.key, entry);
      if (f.op === "exists") entry.exists = true;
      else if (f.op === "eq") entry.values.add(f.value ?? "");
      else entry.patterns.add(f.value ?? "");
    }
  }
  return [...byKey.keys()].sort().map((key): OsmFilter => {
    const e = byKey.get(key) as { exists: boolean; values: Set<string>; patterns: Set<string> };
    if (e.exists) return { key, value: null, op: "exists" };
    const literal = [...e.values].sort().map(regexLiteral);
    const parts = [...(literal.length === 0 ? [] : [`^(${literal.join("|")})$`]), ...[...e.patterns].sort()];
    return { key, value: parts.join("|"), op: "regex" };
  });
}

export interface BuiltOsmQuery {
  ql: string;
  plan: OsmRequestPlan;
  /** For the trace and call log (no coordinates). */
  trace: Record<string, string>;
}

const listTrace = (items: readonly string[], shown = 4): string =>
  items.length > shown ? `${items.slice(0, shown).join(",")},… (+${items.length - shown})` : items.join(",");

/** One counts request: every shape × type, in shape-major order (the order Overpass answers in). */
export function countsQuery(q: OsmCountQuery, options: OsmQueryOptions = {}): BuiltOsmQuery {
  if (q.shapes.length === 0) throw bad("no shape to count in");
  if (q.shapes.length > OSM_QUERY_LIMITS.shapes) throw bad(`at most ${OSM_QUERY_LIMITS.shapes} shapes per request, got ${q.shapes.length}`);
  const shapes = q.shapes.map(canonicalShape).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (new Set(shapes.map((s) => s.id)).size !== shapes.length) throw bad("a shape id is listed twice");
  const types = canonicalTypes(q.types, OSM_QUERY_LIMITS.types);

  const parts: string[] = [headerFor(shapes, options)];
  const pairs: { shape: OsmShape; typeKey: string }[] = [];
  shapes.forEach((shape, i) => {
    let statement: (group: readonly OsmFilter[]) => string;
    if (shape.kind === "poly") {
      const where = spatial(shape);
      parts.push(`(${setFilters(types).map((f) => `nwr${filterQl(f)}${where};`).join("")})->.s${i};`);
      statement = (group) => `nwr.s${i}${groupQl(group)};`;
    } else if (shape.kind === "around") {
      const where = spatial(shape);
      statement = (group) => `nwr${groupQl(group)}${where};`;
    } else {
      parts.push(adminPrelude(shape, `a${i}`));
      statement = (group) => `nwr${groupQl(group)}(area.a${i});`;
    }
    for (const t of types) {
      parts.push(`(${t.groups.map(statement).join("")});out count;`);
      pairs.push({ shape, typeKey: t.key });
    }
  });
  return {
    ql: parts.join(""),
    plan: { kind: "counts", pairs },
    trace: { kind: "counts", shapes: listTrace(shapes.map((s) => s.id)), types: listTrace(types.map((t) => t.key), 6) },
  };
}

/** One names request: named places of up to 4 types in one shape, at most 80. */
export function placesQuery(q: OsmPlacesQuery, options: OsmQueryOptions = {}): BuiltOsmQuery {
  const shape = canonicalShape(q.shape);
  const types = canonicalTypes(q.types, OSM_QUERY_LIMITS.placeTypes);
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > OSM_QUERY_LIMITS.places) {
    throw bad(`the place limit must be a whole number from 1 to ${OSM_QUERY_LIMITS.places}`);
  }
  const parts: string[] = [headerFor([shape], options)];
  let where: string;
  if (shape.kind === "admin") {
    parts.push(adminPrelude(shape, "a0"));
    where = "(area.a0)";
  } else {
    where = spatial(shape);
  }
  const named = `[${qlString("name")}]`;
  parts.push(`(${types.flatMap((t) => t.groups.map((g) => `nwr${groupQl(g)}${named}${where};`)).join("")});out center tags ${q.limit};`);
  return {
    ql: parts.join(""),
    plan: { kind: "places", shape, types, limit: q.limit },
    trace: { kind: "places", shape: shape.id, types: listTrace(types.map((t) => t.key), 6), limit: String(q.limit) },
  };
}

// Local matching (which type a returned element is) ---------------------------------------------------------

const regexCache = new Map<string, RegExp>();

/** Overpass regexes are case-sensitive extended regexes; the config's patterns read the same in JavaScript. */
function regex(pattern: string): RegExp {
  let re = regexCache.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    regexCache.set(pattern, re);
  }
  return re;
}

export function matchesFilter(tags: Readonly<Record<string, string>>, f: OsmFilter): boolean {
  const value = tags[f.key];
  if (value === undefined) return false;
  if (f.op === "exists") return true;
  if (f.op === "eq") return value === f.value;
  return regex(f.value ?? "").test(value);
}

export const matchesType = (tags: Readonly<Record<string, string>>, t: OsmTypeQuery): boolean =>
  t.groups.some((group) => group.every((f) => matchesFilter(tags, f)));
