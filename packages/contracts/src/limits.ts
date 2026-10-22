import { z } from "zod";

/** Per-run limits (D24, PLAN §4.2). Carried on `run.created` so the budget meter and replays show them. */
export const RunLimits = z.object({
  /** Hard cap on Qloo network calls per run. */
  qlooCalls: z.int().positive(),
  /** The budget meter warns from this many network calls. */
  qlooWarnAt: z.int().positive(),
  /** Network calls allowed for finding-triggered follow-ups (turn 2). */
  followupCalls: z.int().nonnegative(),
  followupMs: z.int().positive(),
  /** Wall clock: soft nudge to submit_report, then a hard stop with a partial report. */
  softMs: z.int().positive(),
  hardMs: z.int().positive(),
  /** LLM USD per run: wrap-up nudge, then hard stop. */
  usdNudge: z.number().positive(),
  usdHard: z.number().positive(),
  /** At most this many model responses per run, including one nudge (D4). */
  modelResponses: z.int().positive(),
});
export type RunLimits = z.infer<typeof RunLimits>;

export const DEFAULT_RUN_LIMITS: RunLimits = {
  qlooCalls: 40,
  qlooWarnAt: 30,
  followupCalls: 8,
  followupMs: 40_000,
  softMs: 120_000,
  hardMs: 180_000,
  usdNudge: 0.4,
  usdHard: 0.6,
  modelResponses: 5,
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
