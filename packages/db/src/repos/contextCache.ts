import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Queryable } from "../client";
import { type ContextCacheRow, type ContextKind, contextCache } from "../schema";

/**
 * The side context blocks' cache (R4, R5, D25): "What AI knows (not verified)" for 7 days, "From the web"
 * for 24 hours. Bodies are untyped JSON: the agent validates them with the AiContextBlock / WebContextBlock
 * schemas before use. Only ok and empty blocks are written (the agent decides).
 */

export interface ContextCacheInput {
  key: string;
  kind: ContextKind;
  model: string;
  body: unknown;
  /** What producing the block cost, for the record; a hit costs nothing. */
  usd: number;
  expiresAt: Date;
}

/** The live entry for a key (expires_at after `now`), or undefined when absent or expired. */
export async function getContext(db: Queryable, key: string, now: Date): Promise<ContextCacheRow | undefined> {
  const [row] = await db
    .select()
    .from(contextCache)
    .where(and(eq(contextCache.key, key), gt(contextCache.expiresAt, now)))
    .limit(1);
  return row;
}

/** Inserts or replaces the entry for a key, restarting its lifetime. */
export async function putContext(db: Queryable, row: ContextCacheInput): Promise<void> {
  if (!Number.isFinite(row.usd) || row.usd < 0) throw new RangeError(`putContext: usd must be a non-negative number, got ${row.usd}`);
  if (row.body === undefined || row.body === null) throw new TypeError("putContext: body must be a JSON value");
  const values = { key: row.key, kind: row.kind, model: row.model, body: row.body, usd: row.usd, expiresAt: row.expiresAt };
  await db
    .insert(contextCache)
    .values(values)
    .onConflictDoUpdate({
      target: contextCache.key,
      set: { kind: row.kind, model: row.model, body: row.body, usd: row.usd, expiresAt: row.expiresAt, createdAt: sql`now()` },
    });
}

/** Deletes the entries that expired at or before `now`. Returns how many went. */
export async function pruneContext(db: Queryable, now: Date): Promise<number> {
  const rows = await db.delete(contextCache).where(lte(contextCache.expiresAt, now)).returning({ key: contextCache.key });
  return rows.length;
}
