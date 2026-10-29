import { promisify } from "node:util";
import { gunzip, gzip } from "node:zlib";
import type { PublicSource } from "@ct/contracts";
import { type Now, STALE_TTL_MULTIPLE, supersedes } from "@ct/qloo";
import { LRUCache } from "lru-cache";
import type { PublicLogger, PublicStore, StoredPublicEntry } from "./api";

/**
 * Two-level response cache, the Qloo client's design: L1 is an in-process LRU (re-read from L2 after
 * 15 min so pins and refreshes by other processes show up); L2 is the store (public_cache), shared by
 * every process on the same database. Bodies are gzip-compressed in L2 only.
 */

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

export const PUBLIC_L1_MAX_ENTRIES = 200;
export const PUBLIC_L1_MAX_BYTES = 64 * 1024 * 1024;
export const PUBLIC_L1_TTL_MS = 15 * 60 * 1000;

/** A cached answer with its body decoded (UTF-8 bytes of the kept JSON). Times are epoch ms. */
export interface PublicCacheEntry {
  key: string;
  source: PublicSource;
  path: string;
  query: Record<string, string>;
  status: number;
  body: Uint8Array;
  reference: string | null;
  fetchedAt: number;
  /** Null when pinned. */
  expiresAt: number | null;
  pinned: boolean;
  originRunId: string | null;
}

export interface PublicCacheLookup {
  /** A live entry (unexpired or pinned): 2xx data or a cached 4xx. */
  fresh: PublicCacheEntry | null;
  /** An expired entry, kept for stale-on-error. */
  expired: PublicCacheEntry | null;
}

export const isFreshEntry = (entry: PublicCacheEntry, now: number): boolean =>
  entry.pinned || entry.expiresAt === null || now < entry.expiresAt;

export const isSuccessStatus = (status: number): boolean => status >= 200 && status < 300;

/** Stale-on-error: a pinned entry, or 2xx data younger than 4×TTL. */
export function canServeStale(entry: PublicCacheEntry, now: number): boolean {
  if (!isSuccessStatus(entry.status)) return false;
  if (entry.pinned || entry.expiresAt === null) return true;
  const ttl = entry.expiresAt - entry.fetchedAt;
  return ttl > 0 && now - entry.fetchedAt < STALE_TTL_MULTIPLE * ttl;
}

export interface PublicResponseCacheOptions {
  store: PublicStore;
  now: Now;
  logger: PublicLogger;
  track: (write: Promise<unknown>) => void;
  maxEntries?: number;
  maxBytes?: number;
  l1TtlMs?: number;
}

interface L1Slot {
  entry: PublicCacheEntry;
  storedAt: number;
}

export class PublicResponseCache {
  private readonly l1: LRUCache<string, L1Slot>;
  private readonly l1TtlMs: number;

  constructor(private readonly options: PublicResponseCacheOptions) {
    this.l1 = new LRUCache<string, L1Slot>({
      max: options.maxEntries ?? PUBLIC_L1_MAX_ENTRIES,
      maxSize: options.maxBytes ?? PUBLIC_L1_MAX_BYTES,
      sizeCalculation: (slot) => Math.max(1, slot.entry.body.byteLength),
    });
    this.l1TtlMs = options.l1TtlMs ?? PUBLIC_L1_TTL_MS;
  }

  /**
   * L1, then L2; the newer copy wins as the store decides it, and L2 wins a tie. An L1 copy past its
   * 15 minutes still counts when L2 has nothing newer. Store failures degrade to a miss.
   */
  async lookup(key: string): Promise<PublicCacheLookup> {
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
  store(entry: PublicCacheEntry): void {
    this.l1.set(entry.key, { entry, storedAt: this.options.now() });
    const write = this.encode(entry)
      .then((stored) => this.options.store.putEntry(stored))
      .catch((err: unknown) => {
        this.options.logger.warn({ err: String(err), source: entry.source, path: entry.path }, "public data L2 cache write failed");
      });
    this.options.track(write);
  }

  /** Counts a served hit on the L2 row. */
  recordHit(key: string): void {
    this.options.track(
      this.options.store.recordHit(key).catch((err: unknown) => {
        this.options.logger.debug({ err: String(err) }, "public data cache hit count not recorded");
      }),
    );
  }

  private async readL2(key: string): Promise<PublicCacheEntry | null> {
    try {
      const stored = await this.options.store.getEntry(key);
      return stored ? await this.decode(stored) : null;
    } catch (err) {
      this.options.logger.warn({ err: String(err) }, "public data L2 cache read failed; treating as a miss");
      return null;
    }
  }

  private async encode(entry: PublicCacheEntry): Promise<StoredPublicEntry> {
    return {
      key: entry.key,
      source: entry.source,
      path: entry.path,
      params: entry.query,
      status: entry.status,
      body: new Uint8Array(await gzipAsync(entry.body)),
      reference: entry.reference,
      fetchedAt: new Date(entry.fetchedAt),
      expiresAt: entry.expiresAt === null ? null : new Date(entry.expiresAt),
      pinned: entry.pinned,
      originRunId: entry.originRunId,
    };
  }

  private async decode(stored: StoredPublicEntry): Promise<PublicCacheEntry> {
    return {
      key: stored.key,
      source: stored.source,
      path: stored.path,
      query: stored.params,
      status: stored.status,
      body: new Uint8Array(await gunzipAsync(stored.body)),
      reference: stored.reference,
      fetchedAt: stored.fetchedAt.getTime(),
      expiresAt: stored.pinned || stored.expiresAt === null ? null : stored.expiresAt.getTime(),
      pinned: stored.pinned,
      originRunId: stored.originRunId,
    };
  }
}
