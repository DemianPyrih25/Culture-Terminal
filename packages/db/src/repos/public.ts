import { and, between, eq, max, sql } from "drizzle-orm";
import type { Queryable } from "../client";
import { type PublicCacheRow, type PublicSourceName, publicCache, publicCalls } from "../schema";

/**
 * Plain persistence for the public-data client (PLAN §5.2): the L2 cache of SEC EDGAR and US Census
 * responses and their call log. The client in @ct/publicdata wraps these in its PublicStore; this
 * package never imports it. Public calls have no quota, so there is no usage counter here.
 */

export type PublicCacheEntryInput = Omit<typeof publicCache.$inferInsert, "hits" | "lastHitAt">;
export type PublicCallInput = typeof publicCalls.$inferInsert;

// Postgres caps a statement at 65,535 bind parameters; 14 per call row leaves ample headroom.
const INSERT_CHUNK = 1000;

/** The cached response for a key, expired or not (stale-on-error reads expired rows too). */
export async function getPublicCacheEntry(db: Queryable, key: string): Promise<PublicCacheRow | undefined> {
  const [row] = await db.select().from(publicCache).where(eq(publicCache.key, key)).limit(1);
  return row;
}

/**
 * Inserts or refreshes a cached response, with the rules of putQlooCacheEntry: a pinned row stays
 * pinned with no expiry, an older fetch never overwrites a newer one, a non-2xx answer never replaces
 * a pinned row, and the hit counter survives refreshes.
 */
export async function putPublicCacheEntry(db: Queryable, entry: PublicCacheEntryInput): Promise<void> {
  await db
    .insert(publicCache)
    .values({ ...entry, expiresAt: entry.pinned ? null : entry.expiresAt })
    .onConflictDoUpdate({
      target: publicCache.key,
      set: {
        source: sql`excluded.source`,
        path: sql`excluded.path`,
        params: sql`excluded.params`,
        status: sql`excluded.status`,
        body: sql`excluded.body`,
        reference: sql`excluded.reference`,
        fetchedAt: sql`excluded.fetched_at`,
        pinned: sql`${publicCache.pinned} or excluded.pinned`,
        expiresAt: sql`case when ${publicCache.pinned} or excluded.pinned then null else excluded.expires_at end`,
        originRunId: sql`excluded.origin_run_id`,
      },
      setWhere: sql`excluded.fetched_at >= ${publicCache.fetchedAt} and (excluded.status between 200 and 299 or not ${publicCache.pinned})`,
    });
}

/** Counts a cache hit on the row (hits, last_hit_at). Unknown keys are ignored. */
export async function recordPublicCacheHit(db: Queryable, key: string): Promise<void> {
  await db
    .update(publicCache)
    .set({ hits: sql`${publicCache.hits} + 1`, lastHitAt: sql`now()` })
    .where(eq(publicCache.key, key));
}

/** Pins a cached row so it never expires (a Census vintage). Returns false when no row has this key. */
export async function pinPublicCacheEntry(db: Queryable, key: string): Promise<boolean> {
  const rows = await db
    .update(publicCache)
    .set({ pinned: true, expiresAt: null })
    .where(eq(publicCache.key, key))
    .returning({ key: publicCache.key });
  return rows.length > 0;
}

/** Appends call-log rows. A row whose id already exists is skipped, so a retried write never duplicates. */
export async function insertPublicCalls(db: Queryable, rows: readonly PublicCallInput[]): Promise<number> {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const result = await db
      .insert(publicCalls)
      .values(rows.slice(i, i + INSERT_CHUNK))
      .onConflictDoNothing({ target: publicCalls.id })
      .returning({ id: publicCalls.id });
    inserted += result.length;
  }
  return inserted;
}

/**
 * When a source last answered a network call with a 2xx in an environment, or null when it never did
 * (`/api/health` publicdata.sec_last_success and census_last_success). Cache hits do not count.
 */
export async function lastPublicSuccess(
  db: Queryable,
  filter: { env: string; source: PublicSourceName },
): Promise<Date | null> {
  const [row] = await db
    .select({ at: max(publicCalls.ts) })
    .from(publicCalls)
    .where(
      and(
        eq(publicCalls.env, filter.env),
        eq(publicCalls.source, filter.source),
        between(publicCalls.httpStatus, 200, 299),
      ),
    );
  return row?.at ?? null;
}
