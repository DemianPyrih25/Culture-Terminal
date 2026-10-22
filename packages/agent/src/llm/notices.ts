import type { RunLimits, SubmitPlanInput } from "@ct/contracts";

/**
 * The text the ANALYST loop itself sends (PLAN §4.2 guards). It lives in user messages, never in the
 * system prompt, so the cached prefix stays frozen.
 */

/** SPEC §4.2, verbatim. */
export const NUDGE_PLAN = "Call submit_plan first, together with any wave-1 tools.";
export const NUDGE_REPORT =
  "Your turn ended without submit_report. Call submit_report now; no further tool calls are available.";
export const NOTICE_TIME = "Time budget nearly exhausted: call submit_report now.";
export const NOTICE_COST = "Cost budget nearly exhausted: call submit_report now.";
export const TURN3_NOTICE = "TURN 3: follow-ups are complete. Call submit_report now; it is the only call left.";
/** After a response cut off by max_tokens: its calls were answered with TOOL_INPUT_TRUNCATED. */
export const NOTICE_TRUNCATED =
  "Your last response hit the output limit before its tool calls were complete, so none of them ran. Make the calls again, more concisely.";

export function turn2Guide(limits: RunLimits): string {
  return (
    "TURN 2: run planned steps that needed wave-1 results (their own tool and step_id, no trigger); every other call cites the finding behind it as trigger_finding_id " +
    `(up to ${limits.followupCalls} Qloo calls in all), or call submit_report if the hypotheses are resolved.`
  );
}

export function planAck(plan: SubmitPlanInput): string {
  const hypotheses = plan.hypotheses.map((h) => h.id).join(", ");
  const steps = plan.steps.map((s) => s.id).join(", ");
  return `PLAN_ACCEPTED: hypotheses ${hypotheses}; steps ${steps}. Opening-scan and wave-1 digests follow.`;
}

/**
 * Codes that open every `is_error` tool result the loop writes itself, so the model and the trace
 * can tell why a call was not run.
 */
export const ANALYST_TOOL_ERROR_CODES = [
  "UNKNOWN_TOOL",
  "INVALID_INPUT",
  "INVALID_PLAN",
  "INVALID_REPORT",
  "REPORT_REJECTED",
  "PLAN_REQUIRED",
  "WRONG_TURN",
  "DUPLICATE_SUBMISSION",
  "UNTRIGGERED_FOLLOWUP",
  "INVESTIGATION_BUDGET_EXHAUSTED",
  "REPORT_SUBMITTED",
  "TOOL_INPUT_TRUNCATED",
  "TOOL_FAILED",
] as const;
export type AnalystToolErrorCode = (typeof ANALYST_TOOL_ERROR_CODES)[number];

/** The issue lines of a parseToolInput error, without its INVALID_INPUT header line. */
export function issueLines(error: string): string[] {
  return error.split("\n").filter((line) => line !== "" && line !== "INVALID_INPUT");
}

export function errorText(code: AnalystToolErrorCode, message: string, issues: readonly string[] = []): string {
  return [`${code}: ${message}`, ...issues].join("\n");
}
