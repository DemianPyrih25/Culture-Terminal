import { and, count, eq, gte, inArray, sql } from "drizzle-orm";
import type { Queryable } from "../client";
import { type CacheStatus, type QlooCacheRow, qlooCache, qlooCalls, usageDaily } from "../schema";

/**
 * Plain persistence for the Qloo client (PLAN §5.1): the L2 response cache, the call log and the
 * daily fresh-call counter. The client in @ct/qloo wraps these in its QlooStore; this package never
 * imports it.
 */

export type QlooCacheEntryInput = Omit<typeof qlooCache.$inferInsert, "hits" | "lastHitAt">;
export type QlooCallInput = typeof qlooCalls.$inferInsert;

/**
 * Call-log statuses that spent a network call: a miss went to Qloo, and a stale row is a network
 * call that failed and was answered from an expired entry. Hits, reuses and coalesced waits are free.
 */
export const QLOO_NETWORK_CACHE_STATUSES = ["miss", "stale"] as const satisfies readonly CacheStatus[];

/** The usage_daily metric counting fresh Qloo network calls, per lane and under lane "all". */
export const QLOO_FRESH_METRIC = "qloo_fresh";

// Postgres caps a statement at 65,535 bind parameters; 15 per call row leaves ample headroom.
const INSERT_CHUNK = 1000;

/** The cached response for a key, expired or not (stale-on-error reads expired rows too). */
export async function getQlooCacheEntry(db: Queryable, key: string): Promise<QlooCacheRow | undefined> {
  const [row] = await db.select().from(qlooCache).where(eq(qlooCache.key, key)).limit(1);
  return row;
}

/**
 * Inserts or refreshes a cached response. A pinned row stays pinned with no expiry, and an older
 * fetch never overwrites a newer one (two processes refreshing the same key in either order). A
 * non-2xx answer never replaces a pinned row, since a pin is permanent and could not be repaired.
 * The hit counter survives refreshes.
 */
export async function putQlooCacheEntry(db: Queryable, entry: QlooCacheEntryInput): Promise<void> {
  await db
    .insert(qlooCache)
    .values({ ...entry, expiresAt: entry.pinned ? null : entry.expiresAt })
    .onConflictDoUpdate({
      target: qlooCache.key,
      set: {
        path: sql`excluded.path`,
        params: sql`excluded.params`,
        status: sql`excluded.status`,
        body: sql`excluded.body`,
        requestId: sql`excluded.request_id`,
        fetchedAt: sql`excluded.fetched_at`,
        pinned: sql`${qlooCache.pinned} or excluded.pinned`,
        expiresAt: sql`case when ${qlooCache.pinned} or excluded.pinned then null else excluded.expires_at end`,
        originRunId: sql`excluded.origin_run_id`,
      },
      setWhere: sql`excluded.fetched_at >= ${qlooCache.fetchedAt} and (excluded.status between 200 and 299 or not ${qlooCache.pinned})`,
    });
}

/** Counts a cache hit on the row (hits, last_hit_at). Unknown keys are ignored. */
export async function recordQlooCacheHit(db: Queryable, key: string): Promise<void> {
  await db
    .update(qlooCache)
    .set({ hits: sql`${qlooCache.hits} + 1`, lastHitAt: sql`now()` })
    .where(eq(qlooCache.key, key));
}

/** Pins a cached row so it never expires (D25). Returns false when no row has this key. */
export async function pinQlooCacheEntry(db: Queryable, key: string): Promise<boolean> {
  const rows = await db
    .update(qlooCache)
    .set({ pinned: true, expiresAt: null })
    .where(eq(qlooCache.key, key))
    .returning({ key: qlooCache.key });
  return rows.length > 0;
}

/** Appends call-log rows. A row whose id already exists is skipped, so a retried write never duplicates. */
export async function insertQlooCalls(db: Queryable, rows: readonly QlooCallInput[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const result = await db
      .insert(qlooCalls)
      .values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoNothing({ target: qlooCalls.id })
      .returning({ id: qlooCalls.id });
    inserted += result.length;
  }
  return inserted;
}

export interface QlooNetworkCallFilter {
  env: string;
  tag: string;
}

/** Network calls logged for a tag in an environment, over all time: the per-tag dev cap (§11.4). */
export async function countQlooNetworkCalls(db: Queryable, filter: QlooNetworkCallFilter): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(qlooCalls)
    .where(
      and(
        eq(qlooCalls.env, filter.env),
        eq(qlooCalls.tag, filter.tag),
        inArray(qlooCalls.cacheStatus, [...QLOO_NETWORK_CACHE_STATUSES]),
      ),
    );
  return row?.n ?? 0;
}

export interface QlooUsageIncrement {
  /** UTC day, YYYY-MM-DD. */
  day: string;
  /** Every lane counter to bump, usually the run's lane and "all". */
  lanes: readonly string[];
  by?: number;
  metric?: string;
}

/** Adds to the daily counters, creating them at zero first. */
export async function incrementQlooUsage(db: Queryable, input: QlooUsageIncrement): Promise<void> {
  const { day, lanes, by = 1, metric = QLOO_FRESH_METRIC } = input;
  if (lanes.length === 0) return;
  await db
    .insert(usageDaily)
    .values([...new Set(lanes)].map((lane) => ({ day, metric, lane, value: by })))
    .onConflictDoUpdate({
      target: [usageDaily.day, usageDaily.metric, usageDaily.lane],
      set: { value: sql`${usageDaily.value} + excluded.value`, updatedAt: sql`now()` },
    });
}

export interface QlooUsageQuery {
  day: string;
  lane: string;
  metric?: string;
}

/** The counter's value for the day and lane; 0 when it was never written. */
export async function getQlooUsage(db: Queryable, query: QlooUsageQuery): Promise<number> {
  const { day, lane, metric = QLOO_FRESH_METRIC } = query;
  const [row] = await db
    .select({ value: usageDaily.value })
    .from(usageDaily)
    .where(and(eq(usageDaily.day, day), eq(usageDaily.metric, metric), eq(usageDaily.lane, lane)))
    .limit(1);
  return row?.value ?? 0;
}

/** Calls logged in an environment since a time, and how many of them reached the network (/status). */
export async function countQlooCallsByCache(db: Queryable, filter: { env: string; since: Date }): Promise<{ total: number; network: number }> {
  const [row] = await db
    .select({
      total: count(),
      network: sql<number>`count(*) filter (where ${inArray(qlooCalls.cacheStatus, [...QLOO_NETWORK_CACHE_STATUSES])})`.mapWith(Number),
    })
    .from(qlooCalls)
    .where(and(eq(qlooCalls.env, filter.env), gte(qlooCalls.ts, filter.since)));
  return { total: row?.total ?? 0, network: row?.network ?? 0 };
}
