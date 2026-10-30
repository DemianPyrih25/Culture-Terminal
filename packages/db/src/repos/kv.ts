import { eq, sql } from "drizzle-orm";
import type { Queryable } from "../client";
import { type KvRow, kv } from "../schema";

/**
 * The stored value, or undefined when the key is absent. Values are untyped JSON: callers
 * validate them (e.g. with a zod schema from @ct/contracts).
 */
export async function getKv(db: Queryable, key: string): Promise<unknown> {
  const row = await getKvEntry(db, key);
  return row?.value;
}

/** The value together with when it was last written (e.g. to age a quota snapshot). */
export async function getKvEntry(db: Queryable, key: string): Promise<KvRow | undefined> {
  const [row] = await db.select().from(kv).where(eq(kv.key, key)).limit(1);
  return row;
}

/**
 * Inserts or replaces the value and stamps updated_at. null and undefined are refused (drizzle
 * would write SQL NULL, not JSON null); use {@link deleteKv} to unset a key.
 */
export async function setKv(db: Queryable, key: string, value: unknown): Promise<void> {
  if (value === undefined || value === null) {
    throw new TypeError(`setKv: value for "${key}" is ${String(value)}; use deleteKv to unset it`);
  }
  await db
    .insert(kv)
    .values({ key, value })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: sql`now()` } });
}

/** Removes the key. Returns whether it existed. */
export async function deleteKv(db: Queryable, key: string): Promise<boolean> {
  const rows = await db.delete(kv).where(eq(kv.key, key)).returning({ key: kv.key });
  return rows.length > 0;
}

/**
 * Adds `by` to a numeric counter at `key` (absent or non-numeric reads as 0) in one statement and returns
 * the new value: daily counters such as `screener.count.YYYY-MM-DD` and `osm.count.YYYY-MM-DD`.
 */
export async function incrementKvCounter(db: Queryable, key: string, by = 1): Promise<number> {
  if (!Number.isFinite(by)) throw new RangeError(`incrementKvCounter: by must be a finite number, got ${by}`);
  const [row] = await db
    .insert(kv)
    .values({ key, value: by })
    .onConflictDoUpdate({
      target: kv.key,
      set: {
        value: sql`to_jsonb((case when jsonb_typeof(${kv.value}) = 'number' then (${kv.value} #>> '{}')::numeric else 0 end) + ${by})`,
        updatedAt: sql`now()`,
      },
    })
    .returning({ value: kv.value });
  return Number(row?.value ?? 0);
}
