import { supersedes } from "@ct/qloo";
import {
  getPublicCacheEntry,
  insertPublicCalls,
  pinPublicCacheEntry,
  PUBLIC_SOURCES,
  putPublicCacheEntry,
  type Queryable,
  recordPublicCacheHit,
} from "@ct/db";
import type { PublicCallLogRow, PublicStore, StoredPublicEntry } from "./api";

/** In-memory store with read access to its contents, for tests and scripts. */
export interface MemoryPublicStore extends PublicStore {
  readonly entries: ReadonlyMap<string, StoredPublicEntry & { hits: number }>;
  readonly calls: readonly PublicCallLogRow[];
}

const copyEntry = (e: StoredPublicEntry): StoredPublicEntry => ({
  ...e,
  params: { ...e.params },
  body: e.body.slice(),
  fetchedAt: new Date(e.fetchedAt),
  expiresAt: e.expiresAt === null ? null : new Date(e.expiresAt),
});

/** An in-memory PublicStore for tests, with the public_cache rules: pins stay, newer wins, a non-2xx never replaces a pin. */
export function createMemoryPublicStore(): MemoryPublicStore {
  const entries = new Map<string, StoredPublicEntry & { hits: number }>();
  const calls: PublicCallLogRow[] = [];
  return {
    entries,
    calls,
    async getEntry(key) {
      const e = entries.get(key);
      return e ? copyEntry(e) : null;
    },
    async putEntry(entry) {
      const prev = entries.get(entry.key);
      if (prev && !supersedes(entry, prev)) return;
      const pinned = entry.pinned || prev?.pinned === true;
      entries.set(entry.key, {
        ...copyEntry(entry),
        pinned,
        expiresAt: pinned ? null : entry.expiresAt === null ? null : new Date(entry.expiresAt),
        hits: prev?.hits ?? 0,
      });
    },
    async recordHit(key) {
      const e = entries.get(key);
      if (e) e.hits += 1;
    },
    async pinEntry(key) {
      const e = entries.get(key);
      if (!e) return false;
      e.pinned = true;
      e.expiresAt = null;
      return true;
    },
    async logCalls(rows) {
      for (const row of rows) {
        if (!calls.some((c) => c.id === row.id)) calls.push({ ...row, params: { ...row.params } });
      }
    },
  };
}

const isPublicSource = (s: string): s is (typeof PUBLIC_SOURCES)[number] => (PUBLIC_SOURCES as readonly string[]).includes(s);

/** The Postgres PublicStore: public_cache and public_calls through the @ct/db repos. */
export function createPgPublicStore(db: Queryable): PublicStore {
  return {
    async getEntry(key) {
      const row = await getPublicCacheEntry(db, key);
      // A row from a source the client no longer serves is treated as absent.
      if (!row || !isPublicSource(row.source)) return null;
      return {
        key: row.key,
        source: row.source,
        path: row.path,
        params: row.params,
        status: row.status,
        body: new Uint8Array(row.body),
        reference: row.reference,
        fetchedAt: row.fetchedAt,
        expiresAt: row.expiresAt,
        pinned: row.pinned,
        originRunId: row.originRunId,
      };
    },
    async putEntry(entry) {
      await putPublicCacheEntry(db, { ...entry, body: Buffer.from(entry.body) });
    },
    async recordHit(key) {
      await recordPublicCacheHit(db, key);
    },
    pinEntry: (key) => pinPublicCacheEntry(db, key),
    async logCalls(rows) {
      if (rows.length > 0) await insertPublicCalls(db, rows.map((row) => ({ ...row, ms: row.ms === null ? null : Math.round(row.ms) })));
    },
  };
}
