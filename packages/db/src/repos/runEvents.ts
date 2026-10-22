import { and, asc, eq, gt, max } from "drizzle-orm";
import type { Queryable } from "../client";
import { type RunEventRow, runEvents } from "../schema";

export interface RunEventInput {
  /** Caller-assigned, unique per run; SSE uses it as the event id for resume. */
  seq: number;
  type: string;
  payload: unknown;
  /** When the event happened; defaults to the database time of the insert. */
  ts?: Date;
}

// Postgres caps a statement at 65,535 bind parameters; five per row leaves ample headroom.
const INSERT_CHUNK = 1000;

/**
 * Appends events. A (run_id, seq) that already exists is skipped, so a retried flush never
 * duplicates or overwrites an event. Returns how many rows were inserted.
 */
export async function appendEvents(
  db: Queryable,
  runId: string,
  events: readonly RunEventInput[],
): Promise<number> {
  for (const e of events) {
    if (!Number.isSafeInteger(e.seq) || e.seq < 0 || e.seq > 2_147_483_647) {
      throw new RangeError(`appendEvents: seq must be a non-negative int4, got ${e.seq}`);
    }
  }
  let inserted = 0;
  for (let i = 0; i < events.length; i += INSERT_CHUNK) {
    const rows = events.slice(i, i + INSERT_CHUNK).map((e) => ({
      runId,
      seq: e.seq,
      type: e.type,
      payload: e.payload,
      ts: e.ts,
    }));
    const result = await db
      .insert(runEvents)
      .values(rows)
      .onConflictDoNothing({ target: [runEvents.runId, runEvents.seq] })
      .returning({ seq: runEvents.seq });
    inserted += result.length;
  }
  return inserted;
}

export const DEFAULT_EVENT_PAGE = 1000;

/**
 * Events with seq greater than `afterSeq` (all events when omitted), in seq order.
 * SSE resume passes the Last-Event-ID; replays page through with the last seq they saw.
 */
export async function listEvents(
  db: Queryable,
  runId: string,
  afterSeq?: number,
  limit: number = DEFAULT_EVENT_PAGE,
): Promise<RunEventRow[]> {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`listEvents: limit must be a positive integer, got ${limit}`);
  }
  const where =
    afterSeq === undefined ? eq(runEvents.runId, runId) : and(eq(runEvents.runId, runId), gt(runEvents.seq, afterSeq));
  return db.select().from(runEvents).where(where).orderBy(asc(runEvents.seq)).limit(limit);
}

/** Highest stored seq for the run, or null when it has no events. */
export async function lastSeq(db: Queryable, runId: string): Promise<number | null> {
  const [row] = await db
    .select({ seq: max(runEvents.seq) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId));
  return row?.seq ?? null;
}
