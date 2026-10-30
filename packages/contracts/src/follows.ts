import { z } from "zod";
import { IsoDateTime, Job, MarketId, RunStatus, Signal } from "./enums";
import { QUESTION_MAX_CHARS } from "./limits";
import { FOLLOW_KIND_VALUES, FOLLOW_LABEL_MAX, FOLLOW_SUBJECT_KEY_MAX, FOLLOWS_PER_VISITOR_MAX } from "./values/follows";

export * from "./values/follows";

/**
 * Following (PLAN Part 10, §2.4, §8.1): a visitor's followed brands, places and questions, each with
 * its latest note and a re-run. No ticks, no "vs yesterday", no alerts: a follow never claims that
 * something changed. The API is GET, POST and DELETE /api/follows; POST is behind Turnstile (§10.3),
 * so the route extends FollowCreate with its `turnstileToken`.
 */

export const FollowKind = z.enum(FOLLOW_KIND_VALUES);
export type FollowKind = z.infer<typeof FollowKind>;

/** Run ids are database UUIDs today; the check stays loose like apps/web/lib/run-id.ts. */
const RunIdLike = z.string().regex(/^[A-Za-z0-9-]{8,64}$/, { message: "expected a run id" });
const FollowId = z.string().min(1).max(64);

/** What a re-run starts: the question, and the job and metro the followed note was read as. */
export const FollowRerun = z.object({
  question: z.string().trim().min(1).max(QUESTION_MAX_CHARS),
  job: Job.nullable(),
  metro: MarketId.nullable(),
});
export type FollowRerun = z.infer<typeof FollowRerun>;

/** The follow's latest note as a row shows it; the tag falls back to the signal label when null. */
export const FollowLatest = z.object({
  runId: z.string().min(1),
  status: RunStatus,
  createdAt: IsoDateTime,
  headline: z.string().nullable(),
  tag: z.string().nullable(),
  signal: Signal.nullable(),
});
export type FollowLatest = z.infer<typeof FollowLatest>;

export const Follow = z.object({
  id: FollowId,
  kind: FollowKind,
  subjectKey: z.string().min(1).max(FOLLOW_SUBJECT_KEY_MAX),
  label: z.string().min(1).max(FOLLOW_LABEL_MAX),
  rerun: FollowRerun,
  /** Null before the first run, or once that run was deleted by retention. */
  latest: FollowLatest.nullable(),
  /**
   * A re-run that stopped at the picker (needs_input) and waits for the visitor's pick: the page shows
   * FOLLOW_PENDING_LABEL with a link to that run. When the picked run completes, `latest` moves to it and
   * this clears. Null when nothing waits; absent from servers before Part 11.
   */
  pending: z.object({ runId: z.string().min(1) }).nullable().optional(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Follow = z.infer<typeof Follow>;

/** GET /api/follows: the visitor's follows, newest first. */
export const FollowList = z.object({
  follows: z.array(Follow).max(FOLLOWS_PER_VISITOR_MAX),
  max: z.int().positive(),
});
export type FollowList = z.infer<typeof FollowList>;

/**
 * POST /api/follows. From a note (`run`): the server reads the subject, label and re-run from that run
 * (its question for a question follow, its resolved main entity for a brand, its metro or area for a
 * place) and refuses with 422 when the run has none of that kind. From a profile (`profile`): a brand
 * by its name, re-run with brandFollowQuestion. The client never sends a subject key or a Qloo id.
 */
export const FollowCreate = z.discriminatedUnion("from", [
  z.object({ from: z.literal("run"), runId: RunIdLike, kind: FollowKind }),
  z.object({ from: z.literal("profile"), name: z.string().trim().min(1).max(FOLLOW_LABEL_MAX) }),
]);
export type FollowCreate = z.infer<typeof FollowCreate>;

/** POST answer: the follow, and whether it is new (false: the visitor already followed it, now refreshed). */
export const FollowCreated = z.object({ follow: Follow, created: z.boolean() });
export type FollowCreated = z.infer<typeof FollowCreated>;

/** DELETE /api/follows?id=… (or JSON `{id}`): 200 `{removed: true}`, 404 when the visitor has no such follow. */
export const FollowDelete = z.object({ id: FollowId });
export type FollowDelete = z.infer<typeof FollowDelete>;
export const FollowDeleted = z.object({ removed: z.boolean() });
export type FollowDeleted = z.infer<typeof FollowDeleted>;

/** A refused follow request, as every API error reads: a plain message the page shows as is. */
export const FollowError = z.object({
  error: z.string(),
  /** limit: FOLLOWS_PER_VISITOR_MAX reached; no_subject: the run has no subject of that kind. */
  code: z.enum(["limit", "no_subject", "not_found", "invalid"]).optional(),
});
export type FollowError = z.infer<typeof FollowError>;

/**
 * PATCH /api/follows: after [Re-run] started a run through POST /api/runs (with its own Turnstile,
 * queue and visitor limits, and `fresh: true` so the answer cache does not hand back the old note), the
 * page points the follow at it. The server checks the run exists before it writes.
 */
export const FollowSetLatest = z.object({ id: FollowId, runId: RunIdLike });
export type FollowSetLatest = z.infer<typeof FollowSetLatest>;

/** PATCH /api/follows: 200 with the follow, now pointing at the run's note. */
export const FollowUpdated = z.object({ follow: Follow });
export type FollowUpdated = z.infer<typeof FollowUpdated>;
