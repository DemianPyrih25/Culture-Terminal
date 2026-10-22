import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import { LRUCache } from "lru-cache";
import type { QlooPath } from "./allowlist";
import type { Now } from "./limiter";
import type { QlooLogger } from "./logger";
import { type QlooStore, type StoredQlooEntry, supersedes } from "./store";
import { STALE_TTL_MULTIPLE } from "./ttl";

/**
 * Two-level response cache (PLAN §5.1 step 3). L1 is an in-process LRU (300 entries, 64 MB of body,
 * re-read from L2 after 15 min so pins and refreshes by other processes show up); L2 is the store,
 * shared by every process on the same database. Bodies are gzip-compressed in L2 only.
 */

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const L1_MAX_ENTRIES = 300;
export const L1_MAX_BYTES = 64 * 1024 * 1024;
export const L1_TTL_MS = 15 * 60 * 1000;

/** A cached answer with its body decoded (raw JSON bytes). Times are epoch ms. */
export interface CacheEntry {
  key: string;
  path: QlooPath;
  query: Record<string, string>;
  status: number;
  body: Uint8Array;
  requestId: string | null;
  fetchedAt: number;
  /** Null when pinned. */
  expiresAt: number | null;
  pinned: boolean;
  originRunId: string | null;
}

export interface CacheLookup {
  /** A live entry (unexpired or pinned), 2xx data or a cached 4xx. */
  fresh: CacheEntry | null;
  /** An expired entry, kept for stale-on-error. */
  expired: CacheEntry | null;
}

export const isFreshEntry = (entry: CacheEntry, now: number): boolean =>
  entry.pinned || entry.expiresAt === null || now < entry.expiresAt;

export const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300;

/** Stale-on-error (SPEC §5.1 step 10): a pinned entry, or 2xx data younger than 4×TTL. */
export function canServeStale(entry: CacheEntry, now: number): boolean {
  if (!isSuccessStatus(entry.status)) return false;
  if (entry.pinned || entry.expiresAt === null) return true;
  const ttl = entry.expiresAt - entry.fetchedAt;
  return ttl > 0 && now - entry.fetchedAt < STALE_TTL_MULTIPLE * ttl;
}

export interface ResponseCacheOptions {
  store: QlooStore;
  now: Now;
  logger: QlooLogger;
  track: (write: Promise<unknown>) => void;
  maxEntries?: number;
  maxBytes?: number;
  l1TtlMs?: number;
}

interface L1Slot {
  entry: CacheEntry;
  storedAt: number;
}

export class ResponseCache {
  private readonly l1: LRUCache<string, L1Slot>;
  private readonly l1TtlMs: number;
  /** L2 writes in flight by key, so a pin never races the write it pins. */
  private readonly puts = new Map<string, Promise<void>>();

  constructor(private readonly options: ResponseCacheOptions) {
    this.l1 = new LRUCache<string, L1Slot>({
      max: options.maxEntries ?? L1_MAX_ENTRIES,
      maxSize: options.maxBytes ?? L1_MAX_BYTES,
      sizeCalculation: (slot) => Math.max(1, slot.entry.body.byteLength),
    });
    this.l1TtlMs = options.l1TtlMs ?? L1_TTL_MS;
  }

  /**
   * L1, then L2; the newer of the two copies wins as the store decides it ({@link supersedes}), and
   * L2 wins a tie, since it carries pins made by other processes. An L1 copy past its 15 minutes
   * still counts when L2 has nothing newer, e.g. while its own L2 write is pending or the database
   * is down. Store failures degrade to a miss.
   */
  async lookup(key: string): Promise<CacheLookup> {
    const slot = this.l1.get(key);
    if (slot && this.options.now() - slot.storedAt <= this.l1TtlMs && isFreshEntry(slot.entry, this.options.now())) {
      return { fresh: slot.entry, expired: null };
    }
    const stored = await this.readL2(key);
    const local = slot?.entry ?? null;
    const best =
      local !== null && (stored === null || (local.fetchedAt > stored.fetchedAt && supersedes(local, stored))) ? local : stored;
    if (best === null) return { fresh: null, expired: null };
    const now = this.options.now();
    if (isFreshEntry(best, now)) {
      this.l1.set(key, { entry: best, storedAt: now });
      return { fresh: best, expired: null };
    }
    return { fresh: null, expired: best };
  }

  /** Stores a new answer: L1 at once (so an identical request never goes out again), L2 in the background. */
  store(entry: CacheEntry): void {
    this.l1.set(entry.key, { entry, storedAt: this.options.now() });
    this.writeL2(entry);
  }

  /** Counts a served hit on the L2 row. */
  recordHit(key: string): void {
    this.options.track(
      this.options.store.recordHit(key).catch((err: unknown) => {
        this.options.logger.debug({ err: String(err) }, "qloo cache hit count not recorded");
      }),
    );
  }

  /** Pins an entry so it never expires, in L1 and L2. */
  async pin(entry: CacheEntry): Promise<void> {
    const pinned: CacheEntry = { ...entry, pinned: true, expiresAt: null };
    this.l1.set(entry.key, { entry: pinned, storedAt: this.options.now() });
    await this.puts.get(entry.key);
    if (!(await this.options.store.pinEntry(entry.key))) await this.options.store.putEntry(await this.encode(pinned));
  }

  private writeL2(entry: CacheEntry): void {
    const write = this.encode(entry)
      .then((stored) => this.options.store.putEntry(stored))
      .catch((err: unknown) => {
        this.options.logger.warn({ err: String(err), path: entry.path }, "qloo L2 cache write failed");
      });
    this.puts.set(entry.key, write);
    void write.then(() => {
      if (this.puts.get(entry.key) === write) this.puts.delete(entry.key);
    });
    this.options.track(write);
  }

  private async readL2(key: string): Promise<CacheEntry | null> {
    try {
      const stored = await this.options.store.getEntry(key);
      return stored ? await this.decode(stored) : null;
    } catch (err) {
      this.options.logger.warn({ err: String(err) }, "qloo L2 cache read failed; treating as a miss");
      return null;
    }
  }

  private async encode(entry: CacheEntry): Promise<StoredQlooEntry> {
    return {
      key: entry.key,
      path: entry.path,
      params: entry.query,
      status: entry.status,
      body: new Uint8Array(await gzipAsync(entry.body)),
      requestId: entry.requestId,
      fetchedAt: new Date(entry.fetchedAt),
      expiresAt: entry.expiresAt === null ? null : new Date(entry.expiresAt),
      pinned: entry.pinned,
      originRunId: entry.originRunId,
    };
  }

  private async decode(stored: StoredQlooEntry): Promise<CacheEntry> {
    return {
      key: stored.key,
      path: stored.path,
      query: stored.params,
      status: stored.status,
      body: new Uint8Array(await gunzipAsync(stored.body)),
      requestId: stored.requestId,
      fetchedAt: stored.fetchedAt.getTime(),
      expiresAt: stored.pinned || stored.expiresAt === null ? null : stored.expiresAt.getTime(),
      pinned: stored.pinned,
      originRunId: stored.originRunId,
    };
  }
}
