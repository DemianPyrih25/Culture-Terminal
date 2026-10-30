import { FOLLOWS_PER_VISITOR_MAX } from "@ct/contracts";
import { and, desc, eq, sql } from "drizzle-orm";
import type { Queryable } from "../client";
import { type FollowKindName, type FollowRow, follows, type RunStatus, runs } from "../schema";

/**
 * Following (PLAN Part 10, §2.4): what one visitor follows. Every read and write is scoped to the
 * visitor's key, so one visitor can never see, change or remove another's follows. A subject is
 * followed once per visitor (visitor, kind, subject key); following it again refreshes the row.
 */

/** The latest note of a follow as the page lists it: the run's status and its stored verdict. */
export interface FollowLatest {
  runId: string;
  status: RunStatus;
  createdAt: Date;
  /** report.verdict.headline, or null without a report. */
  headline: string | null;
  /** report.verdict.tag, or null (absent in reports stored before it existed; callers validate it). */
  tag: string | null;
  /** report.verdict.signal, or null without a report. */
  signal: string | null;
}

export interface FollowListRow extends FollowRow {
  /** Null when the follow has no run yet, or its run was deleted. */
  latest: FollowLatest | null;
}

export interface NewFollow {
  visitorKey: string;
  kind: FollowKindName;
  subjectKey: string;
  label: string;
  question: string;
  job: string | null;
  metro: string | null;
  /** The run the follow was made from; null keeps the stored one on a refresh. */
  latestRunId: string | null;
}

export type AddFollowResult =
  | { ok: true; follow: FollowRow; created: boolean }
  /** The visitor already follows FOLLOWS_PER_VISITOR_MAX subjects; nothing was written. */
  | { ok: false; reason: "limit" };

/** A string at a constant path of the report, or null when it is missing or not a string. */
const reportText = (path: "headline" | "tag" | "signal") =>
  sql<string | null>`(case when jsonb_typeof(${runs.report} #> ${sql.raw(`'{verdict,${path}}'`)}) = 'string' then ${runs.report} #>> ${sql.raw(`'{verdict,${path}}'`)} end)`;

/** The visitor's follows, newest first, each with its latest note. At most FOLLOWS_PER_VISITOR_MAX. */
export async function listFollows(db: Queryable, visitorKey: string): Promise<FollowListRow[]> {
  const rows = await db
    .select({
      follow: follows,
      runId: runs.id,
      status: runs.status,
      runCreatedAt: runs.createdAt,
      headline: reportText("headline"),
      tag: reportText("tag"),
      signal: reportText("signal"),
    })
    .from(follows)
    .leftJoin(runs, eq(runs.id, follows.latestRunId))
    .where(eq(follows.visitorKey, visitorKey))
    .orderBy(desc(follows.createdAt), desc(follows.id))
    .limit(FOLLOWS_PER_VISITOR_MAX);
  return rows.map((r) => ({
    ...r.follow,
    latest:
      r.runId === null || r.status === null || r.runCreatedAt === null
        ? null
        : { runId: r.runId, status: r.status, createdAt: r.runCreatedAt, headline: r.headline, tag: r.tag, signal: r.signal },
  }));
}

/** One of the visitor's follows, or undefined (another visitor's id reads as absent). */
export async function getFollow(db: Queryable, visitorKey: string, id: string): Promise<FollowRow | undefined> {
  const [row] = await db
    .select()
    .from(follows)
    .where(and(eq(follows.visitorKey, visitorKey), eq(follows.id, id)))
    .limit(1);
  return row;
}

/**
 * Follows a subject, or refreshes the visitor's existing follow of it (label, re-run question, job,
 * metro and, when given, the latest run). A new follow beyond FOLLOWS_PER_VISITOR_MAX is refused.
 * The visitor's writes are serialised, so two concurrent adds cannot pass the limit together.
 */
export async function addFollow(db: Queryable, input: NewFollow): Promise<AddFollowResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`follows:${input.visitorKey}`}, 0))`);
    const [existing] = await tx
      .select({ id: follows.id })
      .from(follows)
      .where(and(eq(follows.visitorKey, input.visitorKey), eq(follows.kind, input.kind), eq(follows.subjectKey, input.subjectKey)))
      .limit(1);
    if (existing) {
      const [row] = await tx
        .update(follows)
        .set({
          label: input.label,
          question: input.question,
          job: input.job,
          metro: input.metro,
          ...(input.latestRunId === null ? {} : { latestRunId: input.latestRunId }),
          updatedAt: sql`now()`,
        })
        .where(eq(follows.id, existing.id))
        .returning();
      return { ok: true, follow: row as FollowRow, created: false };
    }
    const [count] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(follows)
      .where(eq(follows.visitorKey, input.visitorKey));
    if ((count?.n ?? 0) >= FOLLOWS_PER_VISITOR_MAX) return { ok: false, reason: "limit" };
    const [row] = await tx.insert(follows).values(input).returning();
    return { ok: true, follow: row as FollowRow, created: true };
  });
}

/** Unfollows. Returns whether the visitor had that follow. */
export async function removeFollow(db: Queryable, visitorKey: string, id: string): Promise<boolean> {
  const rows = await db
    .delete(follows)
    .where(and(eq(follows.visitorKey, visitorKey), eq(follows.id, id)))
    .returning({ id: follows.id });
  return rows.length > 0;
}

/** Points the follow at its newest run (a re-run started). Returns whether the visitor had that follow. */
export async function setFollowLatestRun(db: Queryable, visitorKey: string, id: string, runId: string): Promise<boolean> {
  const rows = await db
    .update(follows)
    .set({ latestRunId: runId, updatedAt: sql`now()` })
    .where(and(eq(follows.visitorKey, visitorKey), eq(follows.id, id)))
    .returning({ id: follows.id });
  return rows.length > 0;
}

/**
 * Marks the follow's re-run that stopped at the picker (needs_input) as waiting for the visitor's pick, or
 * clears it (null). Server-side only: the run manager calls it, so it is keyed by follow id alone. Returns
 * whether the follow exists.
 */
export async function setPending(db: Queryable, id: string, runId: string | null): Promise<boolean> {
  const rows = await db
    .update(follows)
    .set({ pendingRunId: runId, updatedAt: sql`now()` })
    .where(eq(follows.id, id))
    .returning({ id: follows.id });
  return rows.length > 0;
}
