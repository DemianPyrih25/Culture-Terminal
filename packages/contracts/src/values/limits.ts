/** Zod-free limits (D24, PLAN §4.2, §4.3, §10.4); ../limits.ts holds the RunLimits schema. */

/**
 * Per-question limits (D24, R9; the Part 10 eval's busiest run used 22 network calls and 7 follow-up
 * calls). Typed structurally here so this file stays zod-free; ../limits.ts checks it against RunLimits.
 */
export interface RunLimitsValues {
  qlooCalls: number;
  qlooWarnAt: number;
  followupCalls: number;
  followupMs: number;
  softMs: number;
  hardMs: number;
  usdNudge: number;
  usdHard: number;
  modelResponses: number;
  conceptReserveCalls: number;
}

export const DEFAULT_RUN_LIMITS: RunLimitsValues = {
  qlooCalls: 40,
  qlooWarnAt: 30,
  followupCalls: 8,
  followupMs: 40_000,
  softMs: 120_000,
  hardMs: 180_000,
  usdNudge: 0.4,
  usdHard: 0.6,
  modelResponses: 5,
  conceptReserveCalls: 3,
};

/** Tool results sent to the model stay within this many tokens (PLAN §4.3). */
export const MODEL_DIGEST_MAX_TOKENS = 1500;
/** Rows of data a digest may show the model. */
export const MODEL_DIGEST_MAX_ROWS = 12;
/** Questions are capped and wrapped in <user_question> (§4.6). */
export const QUESTION_MAX_CHARS = 400;
/** Qloo descriptions are cut to this length before the model sees them (§4.6). */
export const QLOO_DESCRIPTION_MAX_CHARS = 160;
/** Case summary handed to a child run launched from next_moves (§7.3). */
export const CASE_SUMMARY_MAX_TOKENS = 600;

/**
 * The global run queue (D24, PLAN §10.4): agent runs one process holds at once, runs that may wait for a
 * slot, and how long one waits before it ends unrun. Defaults only: apps/web/server/config.ts reads
 * AGENT_RUN_MAX_ACTIVE, RUN_QUEUE_MAX and RUN_QUEUE_WAIT_S over them.
 */
export const RUN_QUEUE_DEFAULTS = { maxActive: 6, queueMax: 12, waitS: 120 } as const;

/** run.end reason of a run that waited its whole RUN_QUEUE_WAIT_S without a slot (status failed, code queue_timeout). */
export function queueTimeoutReason(waitS: number): string {
  return `The server was busy: this question waited ${Math.round(waitS)} s for a free slot and did not start. Nothing was spent; ask again in a minute.`;
}

/** What POST /api/runs answers (503 with Retry-After) when every slot is busy and the queue is full. */
export const RUN_QUEUE_FULL_MESSAGE =
  "The server is at capacity: every run slot is busy and the queue is full. Nothing was started; try again in a minute.";
