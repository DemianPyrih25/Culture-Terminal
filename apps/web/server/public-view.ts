import "server-only";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { RunEvent, RunState } from "@ct/contracts";
import { getKv, type Queryable } from "@ct/db";
import { scrubEntityIds } from "@ct/qloo";
import { localitiesKvKey } from "./localities";
import { log } from "./log";

/**
 * R8 (D51): Qloo entity ids stay on the server. Everything a browser reads about a run passes through
 * here at the server's read boundary: the snapshot (and so the /run/[id] and /r/[id] pages that load it),
 * the SSE stream, the datasets route and the OG card. The agent scrubs its events as it emits them, so
 * runs stored since Part 11 are clean already; this second pass covers runs stored before, and anything
 * an emission missed. Each id becomes «name» when the run's own data names it, else «entity». Request ids,
 * run ids and the rest of a receipt stay, so every number still opens its request.
 *
 * Names come from what the server already holds for the run, never from a new Qloo call: the pinned
 * localities in kv (a metro's locality id → its label) and the run's cached Qloo responses (every
 * `entity_id` with a `name` in the bodies its qloo_calls rows point at). An id neither names stays «entity».
 */

const gunzipAsync = promisify(gunzip);

/** The run's id → name lookup; `misses` counts ids it could not name since it was built. */
export interface NameIndex {
  nameOf(id: string): string | null;
  readonly size: number;
  readonly builtAt: number;
  misses: number;
}

/** Cached responses read per run for names: a run makes at most 40 network calls plus its cache hits. */
const MAX_BODIES = 120;
/** Runs whose index is kept in memory, least recently built dropped first. */
const MAX_INDEXES = 300;
/** An index older than this is rebuilt on its next use (a live run gains entities as it goes). */
export const NAME_INDEX_TTL_MS = 10 * 60_000;
/** A stream that meets an unknown id rebuilds its index at most this often. */
export const NAME_INDEX_REFRESH_MS = 10_000;

const indexes = new Map<string, NameIndex>();

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

/** Every `{entity_id, name}` pair inside a Qloo response body (results, nested entities), into `names`. */
export function collectEntityNames(body: unknown, names: Map<string, string>, depth = 0): void {
  if (depth > 6) return;
  if (Array.isArray(body)) {
    for (const item of body) collectEntityNames(item, names, depth + 1);
    return;
  }
  if (!isRecord(body)) return;
  const id = body.entity_id;
  const name = body.name;
  if (typeof id === "string" && typeof name === "string" && id.trim() !== "" && name.trim() !== "") {
    names.set(id.trim().toLowerCase(), name.trim());
  }
  for (const value of Object.values(body)) if (typeof value === "object" && value !== null) collectEntityNames(value, names, depth + 1);
}

/** The pinned localities' id → label ("Austin"), from kv; empty when unset or unreadable. */
export function localityNames(raw: unknown): Map<string, string> {
  const names = new Map<string, string>();
  if (!isRecord(raw)) return names;
  for (const pin of Object.values(raw)) {
    if (isRecord(pin) && typeof pin.entityId === "string" && typeof pin.label === "string") {
      names.set(pin.entityId.trim().toLowerCase(), pin.label.trim());
    }
  }
  return names;
}

/** An index over a name map, counting misses. */
export function nameIndexOf(names: ReadonlyMap<string, string>, builtAt: number = Date.now()): NameIndex {
  const index: NameIndex = {
    nameOf: (id) => {
      const name = names.get(id.trim().toLowerCase()) ?? null;
      if (name === null) index.misses += 1;
      return name;
    },
    size: names.size,
    builtAt,
    misses: 0,
  };
  return index;
}

/** The names the server holds for a run (kv localities and the run's cached Qloo bodies). Never throws. */
async function buildIndex(db: Queryable, runId: string): Promise<NameIndex> {
  const names = new Map<string, string>();
  try {
    for (const [id, name] of localityNames(await getKv(db, localitiesKvKey()))) names.set(id, name);
  } catch (err) {
    log.warn({ err, runId }, "entity names: the locality pins could not be read");
  }
  try {
    const calls = await db.query.qlooCalls.findMany({
      columns: { cacheKey: true },
      where: (call, { and, eq, isNotNull }) => and(eq(call.runId, runId), isNotNull(call.cacheKey)),
      limit: MAX_BODIES * 4,
    });
    const keys = [...new Set(calls.flatMap((c) => (c.cacheKey ? [c.cacheKey] : [])))].slice(0, MAX_BODIES);
    if (keys.length > 0) {
      const rows = await db.query.qlooCache.findMany({
        columns: { key: true, body: true },
        where: (entry, { inArray }) => inArray(entry.key, keys),
      });
      for (const row of rows) {
        try {
          const text = (await gunzipAsync(row.body)).toString("utf8");
          collectEntityNames(JSON.parse(text) as unknown, names);
        } catch {
          // A body that does not decode names nothing; its ids stay «entity».
        }
      }
    }
  } catch (err) {
    log.warn({ err, runId }, "entity names: the run's cached responses could not be read");
  }
  return nameIndexOf(names);
}

/**
 * The run's name index, built once and reused for NAME_INDEX_TTL_MS (or `maxAgeMs`). Never throws: a read
 * that fails leaves fewer names, and their ids read «entity».
 */
export async function runNameIndex(db: Queryable, runId: string, maxAgeMs: number = NAME_INDEX_TTL_MS): Promise<NameIndex> {
  const cached = indexes.get(runId);
  if (cached && Date.now() - cached.builtAt < maxAgeMs) return cached;
  const index = await buildIndex(db, runId);
  indexes.delete(runId);
  indexes.set(runId, index);
  while (indexes.size > MAX_INDEXES) {
    const oldest = indexes.keys().next().value;
    if (oldest === undefined) break;
    indexes.delete(oldest);
  }
  return index;
}

/** Forgets every index (tests). */
export function clearNameIndexes(): void {
  indexes.clear();
}

/** One event as a browser may see it: ids replaced, seq, ts, runId and type unchanged. */
export function publicEvent(event: RunEvent, nameOf: (id: string) => string | null): RunEvent {
  return scrubEntityIds(event, nameOf) as RunEvent;
}

/** Events as a browser may see them. */
export function publicEvents(events: readonly RunEvent[], nameOf: (id: string) => string | null): RunEvent[] {
  return events.map((event) => publicEvent(event, nameOf));
}

/** A reduced run state as a browser may see it (the snapshot and the pages that load it). */
export function publicRunState(state: RunState, nameOf: (id: string) => string | null): RunState {
  const scrubbed = scrubEntityIds(state, nameOf) as RunState;
  // The run's own id is a key, never an entity: kept as is.
  return { ...scrubbed, runId: state.runId };
}

/** Any JSON payload for a browser (a dataset envelope, a follow) with its ids replaced. */
export function publicJson<T>(value: T, nameOf: (id: string) => string | null): T {
  return scrubEntityIds(value, nameOf) as T;
}

/**
 * A run's event stream as a browser may see it. The index is rebuilt (at most every NAME_INDEX_REFRESH_MS)
 * when an event held an id it could not name, since a live run gains entities as it goes.
 */
export async function* publicEventStream(
  db: Queryable,
  runId: string,
  source: AsyncIterable<RunEvent>,
): AsyncGenerator<RunEvent, void, undefined> {
  let index = await runNameIndex(db, runId);
  for await (const event of source) {
    const before = index.misses;
    yield publicEvent(event, index.nameOf);
    if (index.misses > before && Date.now() - index.builtAt >= NAME_INDEX_REFRESH_MS) {
      index = await runNameIndex(db, runId, NAME_INDEX_REFRESH_MS);
    }
  }
}
