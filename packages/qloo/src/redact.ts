import { looksLikeWkt, parseLatLon } from "./geometry";

/**
 * Qloo entity ids stay on the server (R8, D51). The browser gets endpoint, filter type, request id and
 * readable parameters, never an id: these helpers turn every id a value carries into the entity's name
 * («Brand Alpha»), or «entity» when the name is unknown. Postgres (qloo_calls, evidence provenance,
 * caches, showcase pins, picker key maps) keeps the ids; this runs where data leaves for a browser: at
 * emission in the agent, and again at every server read boundary (runs stored before Part 11).
 */

/** A UUID-shaped Qloo entity id anywhere in a string. Global: use with `replace`, never with `test`. */
export const ENTITY_ID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

/**
 * Qloo parameters whose values are entity ids (comma-separated lists, or one locality id). Every item
 * of these is replaced whatever its shape, since ids need not be UUIDs (mock ids are not); taxonomy
 * URNs (`urn:tag:…`, `urn:audience:…`, `urn:entity:<type>`) stay. Any other `*.entities` key counts too.
 */
export const ENTITY_ID_PARAMS: readonly string[] = [
  "signal.interests.entities",
  "filter.results.entities",
  "filter.exclude.entities",
  "signal.location",
  "filter.location",
  "entity_ids",
];

const LOCATION_PARAMS: ReadonlySet<string> = new Set(["signal.location", "filter.location"]);

/**
 * Keys whose values are never entity ids though they may be UUID-shaped: run ids, Qloo request ids (the
 * receipt's handle on a call), call ids and public-data references. Their values pass through unchanged.
 * A bare `id` is not here: some payloads key an entity by `id`, so a caller that must keep a record's own
 * id (a follow's, a run's) scrubs around it.
 */
export const SCRUB_KEEP_KEYS: ReadonlySet<string> = new Set([
  "runId",
  "originRunId",
  "parentRunId",
  "childRunId",
  "latestRunId",
  "pendingRunId",
  "requestId",
  "requestIds",
  "qlooCallId",
  "qlooCallIds",
  "publicCallId",
  "reference",
]);

/** The marker that stands in for an id in what the browser sees. */
export const entityMarker = (name: string | null): string => `«${name === null || name.trim() === "" ? "entity" : name.trim()}»`;

const isEntityIdKey = (key: string): boolean => ENTITY_ID_PARAMS.includes(key) || /(^|\.)entities$/.test(key);

/** The "… (+3)" tail the call log writes for a shortened id list (canonical.ts redactParams). */
const LIST_TAIL = /^…\s*\(\+\d+\)$/;

/** The name of an id, tried as given and in either case (Qloo ids are case-insensitive hex). */
const nameFor = (nameOf: (id: string) => string | null, id: string): string | null =>
  nameOf(id) ?? nameOf(id.toLowerCase()) ?? nameOf(id.toUpperCase());

function scrubItem(item: string, nameOf: (id: string) => string | null): string {
  const trimmed = item.trim();
  if (trimmed === "" || trimmed.startsWith("urn:") || LIST_TAIL.test(trimmed)) return item;
  return entityMarker(nameFor(nameOf, trimmed));
}

/** One parameter value with its ids replaced: locations keep WKT and lat,lon; lists are scrubbed item by item. */
export function scrubParamValue(key: string, value: string, nameOf: (id: string) => string | null): string {
  if (LOCATION_PARAMS.has(key)) {
    if (looksLikeWkt(value) || parseLatLon(value.trim()) !== null) return value;
    return scrubItem(value, nameOf);
  }
  if (!isEntityIdKey(key)) return scrubString(value, nameOf);
  return value
    .split(",")
    .map((item) => scrubItem(item, nameOf))
    .join(",");
}

/** A string with every UUID-shaped id replaced by its marker. */
export function scrubString(value: string, nameOf: (id: string) => string | null): string {
  return value.replace(ENTITY_ID_RE, (id) => entityMarker(nameFor(nameOf, id)));
}

/**
 * A deep copy of JSON `value` with every entity id replaced by «name» (or «entity»): every UUID-shaped
 * id inside every string, and every item of an entity-id parameter (ENTITY_ID_PARAMS, any `*.entities`
 * key) whatever its shape. Values under SCRUB_KEEP_KEYS (run ids, request ids) pass unchanged, so a
 * receipt can still open every number's request by its request id. Non-JSON values (functions,
 * undefined) are dropped from objects as JSON.stringify would.
 */
export function scrubEntityIds(value: unknown, nameOf: (id: string) => string | null): unknown {
  return scrub(value, nameOf, null);
}

function scrub(value: unknown, nameOf: (id: string) => string | null, key: string | null): unknown {
  if (typeof value === "string") {
    if (key !== null && SCRUB_KEEP_KEYS.has(key)) return value;
    return key !== null ? scrubParamValue(key, value, nameOf) : scrubString(value, nameOf);
  }
  if (Array.isArray(value)) {
    // An array keeps its parent's key: `requestIds: [...]` stays, `entity_ids: [...]` is scrubbed per item.
    return value.map((item) => scrub(item, nameOf, key));
  }
  if (value !== null && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined || typeof v === "function") continue;
      out[k] = scrub(v, nameOf, k);
    }
    return out;
  }
  return value;
}

/** True when `text` holds a UUID-shaped id (the guard and tests use it). */
export function hasEntityId(text: string): boolean {
  ENTITY_ID_RE.lastIndex = 0;
  const found = ENTITY_ID_RE.test(text);
  ENTITY_ID_RE.lastIndex = 0;
  return found;
}
