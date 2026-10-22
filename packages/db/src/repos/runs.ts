import { and, count, desc, eq, gte, inArray, like, lt, notInArray, sql } from "drizzle-orm";
import type { Queryable } from "../client";
import { type NewRun, type Run, type RunStatus, runs } from "../schema";

/** D26: a completed run answers the same question hash for 72 hours. */
export const ANSWER_CACHE_WINDOW_MS = 72 * 60 * 60 * 1000;

/** Columns a caller may change after creation. */
export type RunPatch = Partial<Omit<NewRun, "id" | "createdAt" | "updatedAt">>;

export async function createRun(db: Queryable, input: NewRun): Promise<Run> {
  const [row] = await db.insert(runs).values(input).returning();
  if (!row) throw new Error("createRun: insert returned no row");
  return row;
}

export async function getRun(db: Queryable, id: string): Promise<Run | undefined> {
  const [row] = await db.select().from(runs).where(eq(runs.id, id)).limit(1);
  return row;
}

/**
 * Reads a run and locks its row until the surrounding transaction ends, so callers that change a
 * run in several statements take turns. Call it inside `db.transaction`. The lock is FOR NO KEY
 * UPDATE: it does not block run_events inserts (their foreign-key check takes KEY SHARE).
 */
export async function lockRun(tx: Queryable, id: string): Promise<Run | undefined> {
  const [row] = await tx.select().from(runs).where(eq(runs.id, id)).limit(1).for("no key update");
  return row;
}

/** Updates the given columns and bumps updated_at. Returns the updated row, or undefined if none. */
export async function updateRun(db: Queryable, id: string, patch: RunPatch): Promise<Run | undefined> {
  const [row] = await db
    .update(runs)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(runs.id, id))
    .returning();
  return row;
}

export interface SetStatusOptions {
  /** Compare-and-set: only update when the current status is one of these. */
  from?: readonly RunStatus[];
  /** Extra columns written in the same statement (e.g. error, wall_ms). */
  patch?: RunPatch;
}

/** Sets the status. Returns false when the run does not exist or `from` did not match. */
export async function setStatus(
  db: Queryable,
  id: string,
  status: RunStatus,
  options: SetStatusOptions = {},
): Promise<boolean> {
  const { from, patch } = options;
  if (from && from.length === 0) return false;
  const where = from ? and(eq(runs.id, id), inArray(runs.status, [...from])) : eq(runs.id, id);
  const rows = await db
    .update(runs)
    .set({ ...patch, status, updatedAt: sql`now()` })
    .where(where)
    .returning({ id: runs.id });
  return rows.length > 0;
}

/** Raises the cancel flag the run loop polls. Keeps the first request time. False if no such run. */
export async function requestCancel(db: Queryable, id: string): Promise<boolean> {
  const rows = await db
    .update(runs)
    .set({ cancelRequestedAt: sql`coalesce(${runs.cancelRequestedAt}, now())`, updatedAt: sql`now()` })
    .where(eq(runs.id, id))
    .returning({ id: runs.id });
  return rows.length > 0;
}

export async function isCancelRequested(db: Queryable, id: string): Promise<boolean> {
  const [row] = await db
    .select({ at: runs.cancelRequestedAt })
    .from(runs)
    .where(eq(runs.id, id))
    .limit(1);
  return row?.at != null;
}

// Escapes LIKE wildcards so the prefix matches literally (backslash is Postgres' default escape).
const likePrefix = (prefix: string) => `${prefix.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

function checkWindow(what: string, ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) throw new RangeError(`${what}: window must be a positive number of ms, got ${ms}`);
}

export interface CountRunsSinceOptions {
  /** Only runs whose question_hash starts with this, e.g. "fake:". */
  hashPrefix: string;
  /** Window length, measured back from the database clock. */
  sinceMs: number;
}

/** How many runs with this question-hash prefix were created within the window, whatever their status. */
export async function countRunsSince(db: Queryable, options: CountRunsSinceOptions): Promise<number> {
  const { hashPrefix, sinceMs } = options;
  checkWindow("countRunsSince", sinceMs);
  const [row] = await db
    .select({ n: count() })
    .from(runs)
    .where(
      and(
        like(runs.questionHash, likePrefix(hashPrefix)),
        gte(runs.createdAt, sql`now() - make_interval(secs => ${sinceMs / 1000})`),
      ),
    );
  return row?.n ?? 0;
}

export interface PurgeRunsOptions {
  /** Only runs whose question_hash starts with this. Required, so a purge can never take every run. */
  hashPrefix: string;
  /** Runs created longer ago than this (database clock) are deleted. */
  olderThanMs: number;
  /** Statuses that are never deleted, e.g. runs still in progress. */
  keepStatuses?: readonly RunStatus[];
}

/**
 * Deletes old runs with this question-hash prefix. Their run_events, evidence, metrics, datasets and
 * findings go with them (on delete cascade); child runs stay, with parent_run_id cleared. Returns
 * how many runs were deleted.
 */
export async function purgeRuns(db: Queryable, options: PurgeRunsOptions): Promise<number> {
  const { hashPrefix, olderThanMs, keepStatuses = [] } = options;
  if (hashPrefix === "") throw new RangeError("purgeRuns: hashPrefix must not be empty");
  checkWindow("purgeRuns", olderThanMs);
  const conditions = [
    like(runs.questionHash, likePrefix(hashPrefix)),
    lt(runs.createdAt, sql`now() - make_interval(secs => ${olderThanMs / 1000})`),
  ];
  if (keepStatuses.length > 0) conditions.push(notInArray(runs.status, [...keepStatuses]));
  const rows = await db
    .delete(runs)
    .where(and(...conditions))
    .returning({ id: runs.id });
  return rows.length;
}

/**
 * The newest completed run for this question hash created within the window (D26), or undefined.
 * The cutoff uses the database clock, the same clock that stamped created_at.
 */
export async function findAnswerCache(
  db: Queryable,
  questionHash: string,
  windowMs: number = ANSWER_CACHE_WINDOW_MS,
): Promise<Run | undefined> {
  const [row] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.questionHash, questionHash),
        eq(runs.status, "completed"),
        gte(runs.createdAt, sql`now() - make_interval(secs => ${windowMs / 1000})`),
      ),
    )
    .orderBy(desc(runs.createdAt))
    .limit(1);
  return row;
}
