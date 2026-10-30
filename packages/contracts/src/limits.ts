import { z } from "zod";
import { DEFAULT_RUN_LIMITS as DEFAULTS } from "./values/limits";

export * from "./values/limits";

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
  /**
   * Follow-up calls held for a concept test (Part 9 open issue, D24): while the question has a concept part
   * with no exact tag and no concept-testing follow-up (find_tags, concept_vector, geo_lift) has run, other
   * follow-ups may not take the follow-up calls left below this. `run.created` events stored before Part 11
   * read as 3.
   */
  conceptReserveCalls: z.int().nonnegative().default(DEFAULTS.conceptReserveCalls),
});
export type RunLimits = z.infer<typeof RunLimits>;

/** DEFAULT_RUN_LIMITS (./values/limits.ts) always satisfies the schema. */
const _defaultsFit: RunLimits = DEFAULTS;
void _defaultsFit;
