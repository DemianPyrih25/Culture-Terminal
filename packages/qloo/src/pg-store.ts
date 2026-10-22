import { QlooPath } from "@ct/contracts";
import {
  countQlooNetworkCalls,
  getKv,
  getQlooCacheEntry,
  getQlooUsage,
  incrementQlooUsage,
  insertQlooCalls,
  pinQlooCacheEntry,
  putQlooCacheEntry,
  type Queryable,
  recordQlooCacheHit,
  setKv,
} from "@ct/db";
import type { QlooStore, StoredQlooEntry } from "./store";

/** The Postgres QlooStore (D3): qloo_cache, qloo_calls, usage_daily and kv through the @ct/db repos. */
export function createPgQlooStore(db: Queryable): QlooStore {
  return {
    async getEntry(key) {
      const row = await getQlooCacheEntry(db, key);
      if (!row) return null;
      const path = QlooPath.safeParse(row.path);
      // A row from a path the client no longer serves is treated as absent.
      if (!path.success) return null;
      const entry: StoredQlooEntry = {
        key: row.key,
        path: path.data,
        params: row.params,
        status: row.status,
        body: new Uint8Array(row.body),
        requestId: row.requestId,
        fetchedAt: row.fetchedAt,
        expiresAt: row.expiresAt,
        pinned: row.pinned,
        originRunId: row.originRunId,
      };
      return entry;
    },
    async putEntry(entry) {
      await putQlooCacheEntry(db, { ...entry, body: Buffer.from(entry.body) });
    },
    async recordHit(key) {
      await recordQlooCacheHit(db, key);
    },
    pinEntry: (key) => pinQlooCacheEntry(db, key),
    async logCalls(rows) {
      if (rows.length > 0) await insertQlooCalls(db, rows.map((row) => ({ ...row, ms: Math.round(row.ms) })));
    },
    countNetworkCalls: (filter) => countQlooNetworkCalls(db, filter),
    addFreshCalls: ({ day, lanes, count }) => incrementQlooUsage(db, { day, lanes, by: count }),
    freshCalls: ({ day, lane }) => getQlooUsage(db, { day, lane }),
    getKv: (key) => getKv(db, key),
    setKv: (key, value) => setKv(db, key, value),
  };
}
