import type { CacheStatus } from "@ct/contracts";
import { QLOO_NETWORK_CACHE_STATUSES } from "@ct/db";
import type { QlooPath } from "./allowlist";

/**
 * Persistence behind the client: the L2 response cache, the call log, the daily fresh-call counters
 * and the quota snapshot. Postgres in the app (createPgQlooStore), memory in tests and scripts.
 */

export type QlooEnv = "dev" | "prod" | "mock";

/** One L2 cache row. Bodies are stored gzip-compressed. */
export interface StoredQlooEntry {
  key: string;
  path: QlooPath;
  /** Canonical query, one string per parameter. */
  params: Record<string, string>;
  /** HTTP status of the stored answer: 2xx data or a 4xx kept for a day. */
  status: number;
  /** gzip-compressed response body. */
  body: Uint8Array;
  requestId: string | null;
  fetchedAt: Date;
  /** Null for pinned entries. */
  expiresAt: Date | null;
  pinned: boolean;
  originRunId: string | null;
}

/** One qloo_calls row: every network or cache event the client serves. */
export interface QlooCallLogRow {
  /** The qlooCallId. */
  id: string;
  ts: Date;
  env: QlooEnv;
  tag: string;
  runId: string | null;
  path: QlooPath;
  filterType: string | null;
  /** Canonical query. */
  params: Record<string, string>;
  cacheKey: string;
  cacheStatus: CacheStatus;
  /** Null when the call never reached the network or no response arrived. */
  httpStatus: number | null;
  ms: number;
  requestId: string | null;
  monthRemaining: number | null;
  error: string | null;
}

export interface QlooStore {
  /** The entry for a key, expired or not; null when absent. */
  getEntry(key: string): Promise<StoredQlooEntry | null>;
  /**
   * Inserts or refreshes an entry. A pinned entry stays pinned; an older fetch never replaces a newer
   * one, and a non-2xx answer never replaces a pinned entry ({@link supersedes}).
   */
  putEntry(entry: StoredQlooEntry): Promise<void>;
  recordHit(key: string): Promise<void>;
  /** Pins an entry so it never expires; false when the key is absent. */
  pinEntry(key: string): Promise<boolean>;
  logCalls(rows: readonly QlooCallLogRow[]): Promise<void>;
  /** Network calls (miss and stale rows) ever logged for this tag in this environment. */
  countNetworkCalls(filter: { env: QlooEnv; tag: string }): Promise<number>;
  /** Adds fresh network calls to the day's counters for each lane (and "all" when listed). */
  addFreshCalls(input: { day: string; lanes: readonly string[]; count: number }): Promise<void>;
  freshCalls(input: { day: string; lane: string }): Promise<number>;
  getKv(key: string): Promise<unknown>;
  setKv(key: string, value: unknown): Promise<void>;
}

const NETWORK_STATUSES: ReadonlySet<CacheStatus> = new Set(QLOO_NETWORK_CACHE_STATUSES);

/** True when a call-log status spent a network call. */
export function isNetworkCacheStatus(status: CacheStatus): boolean {
  return NETWORK_STATUSES.has(status);
}

/**
 * Whether a fetch may replace the stored copy of its key: it must be at least as new, and a non-2xx
 * answer never displaces a pinned one (a pin is permanent, and pin() refuses to repair a cached 4xx).
 * Both stores and the L1 lookup follow this rule.
 */
export function supersedes(
  next: { fetchedAt: Date | number; status: number },
  current: { fetchedAt: Date | number; pinned: boolean },
): boolean {
  if (epochMs(next.fetchedAt) < epochMs(current.fetchedAt)) return false;
  return (next.status >= 200 && next.status < 300) || !current.pinned;
}

const epochMs = (t: Date | number): number => (typeof t === "number" ? t : t.getTime());

/** In-memory store with read access to its contents, for tests and scripts. */
export interface MemoryQlooStore extends QlooStore {
  readonly entries: ReadonlyMap<string, StoredQlooEntry & { hits: number }>;
  readonly calls: readonly QlooCallLogRow[];
  readonly kv: ReadonlyMap<string, unknown>;
}

const copyEntry = (e: StoredQlooEntry): StoredQlooEntry => ({
  ...e,
  params: { ...e.params },
  body: e.body.slice(),
  fetchedAt: new Date(e.fetchedAt),
  expiresAt: e.expiresAt === null ? null : new Date(e.expiresAt),
});

export function createMemoryQlooStore(): MemoryQlooStore {
  const entries = new Map<string, StoredQlooEntry & { hits: number }>();
  const calls: QlooCallLogRow[] = [];
  const usage = new Map<string, number>();
  const kv = new Map<string, unknown>();
  const usageKey = (day: string, lane: string) => `${day}|${lane}`;

  return {
    entries,
    calls,
    kv,
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
    async countNetworkCalls({ env, tag }) {
      return calls.filter((c) => c.env === env && c.tag === tag && isNetworkCacheStatus(c.cacheStatus)).length;
    },
    async addFreshCalls({ day, lanes, count }) {
      for (const lane of new Set(lanes)) usage.set(usageKey(day, lane), (usage.get(usageKey(day, lane)) ?? 0) + count);
    },
    async freshCalls({ day, lane }) {
      return usage.get(usageKey(day, lane)) ?? 0;
    },
    async getKv(key) {
      return kv.has(key) ? structuredClone(kv.get(key)) : undefined;
    },
    async setKv(key, value) {
      kv.set(key, structuredClone(value));
    },
  };
}
