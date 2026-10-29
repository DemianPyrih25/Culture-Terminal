import { isId, type FindingKind, type RunLimits, type SubmitPlanInput, type SubmitPlanInputShape } from "@ct/contracts";
import type { FollowupLead } from "../analyst";

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
/**
 * After a response cut at a tool input that was not valid JSON: that call was answered with
 * INVALID_JSON. The guide or nudge that follows says which calls are still open.
 */
export const NOTICE_INVALID_JSON =
  "A tool call in your last response was not valid JSON, so it did not run and nothing after it was received; the calls before it were handled as usual.";

/**
 * The guide that closes turn 1 when turn 2 follows. With FOLLOW-UPS WORTH RUNNING listed it asks for
 * at least one of them, an ANALYST PIVOT, and still leaves the model free to report without one, with
 * an open question that names the leads' findings: a report that declines them so takes no follow-up
 * nudge. While a plan step is still to run (`stepsPending`), it says the two share the follow-up
 * calls, so a step that spends them all leaves nothing for a follow-up on what it finds.
 */
export function turn2Guide(limits: RunLimits, listed: { followups?: boolean; stepsPending?: boolean } = {}): string {
  const rules =
    "TURN 2: run planned steps that needed wave-1 results (their own tool and step_id, no trigger); every other call cites the finding behind it as trigger_finding_id " +
    `(up to ${limits.followupCalls} Qloo calls in all)`;
  if (!listed.followups) {
    const room = listed.stepsPending
      ? ` Planned steps share those ${limits.followupCalls} calls with any follow-up on what they find, so leave room for one.`
      : "";
    return `${rules}, or call submit_report if the hypotheses are resolved.${room}`;
  }
  const share = listed.stepsPending
    ? ` Planned steps and follow-ups share those ${limits.followupCalls} calls, so keep the follow-up narrow (fewer entities, ages or markets).`
    : "";
  return (
    `${rules}. Run at least one of the FOLLOW-UPS WORTH RUNNING before submit_report, citing its finding; ` +
    `call submit_report now only if none of them could change the signal or decide a prior, and say why in open_questions, naming their F#.${share}`
  );
}

/** Finding kinds in plain words, for the FOLLOW-UPS WORTH RUNNING line. */
const FINDING_KIND_WORDS: Readonly<Record<FindingKind, string>> = {
  TASTE_ISLAND: "taste island",
  NEAR_SUBSTITUTES: "near substitutes",
  OUTSIDE_CATEGORY_NEIGHBOUR: "outside-category neighbour",
  GENERATIONAL_SPLIT: "generational split",
  METRO_OUTLIER: "metro outlier",
  HIDDEN_POCKET: "hidden pocket",
  LATENT_DEMAND: "latent demand",
  BLOCK_NEW_TAGS: "new block tags",
  EMPTY_RESULT: "empty result",
  DROPPED_CANDIDATES: "dropped candidates",
  NO_TREND_SIGNAL: "no trend signal",
  POPULARITY_DOMINANCE: "popularity dominance",
  LOCATION_FALLBACK: "location fallback",
  WEAK_CATEGORY_FIT: "weak category fit",
  TWIN_FOUND: "taste twin found",
  ANALOG_VETOED: "analog vetoed",
  TASTE_FINANCIALS_SPLIT: "taste and financials split",
};

/**
 * The line that lists follow-ups worth running when turn 1 closes, e.g. "F2 (outside-category
 * neighbour) suggests peer_landscape on R6 (the test tool of H1)"; tag refs read as what the call
 * runs with ("suggests rank_candidates with T10, T11"). When a plan step still to run (`pending`)
 * plans the same tool, the item names it, so the finding-driven call replaces the step instead of
 * repeating it; when an earlier call already read the subjects, it says what to change. Ids and code
 * words only: names and other Qloo text stay inside <qloo_data>.
 */
export function followupsLine(
  leads: readonly FollowupLead[],
  plan: Pick<SubmitPlanInputShape, "hypotheses"> | null,
  pending: readonly { id: string; tool: string }[] = [],
): string {
  const items = leads.map((lead) => {
    const tags = lead.subjects.filter((s) => isId("T", s));
    const about = lead.subjects.filter((s) => !isId("T", s));
    const on = `${about.length === 0 ? "" : ` on ${about.join(", ")}`}${tags.length === 0 ? "" : ` with ${tags.join(", ")}`}`;
    const tests = (plan?.hypotheses ?? []).filter((h) => h.test_tool === lead.tool && isId("H", h.id)).map((h) => h.id);
    const step = pending.find((s) => s.tool === lead.tool && isId("S", s.id));
    const notes = [
      ...(tests.length === 0 ? [] : [`the test tool of ${tests.join(", ")}`]),
      ...(lead.vary === undefined ? [] : [`already run on these: change the ${lead.vary}`]),
      ...(step === undefined
        ? []
        : [`${step.id} plans ${lead.tool}: run it on this finding's subjects instead, citing ${lead.findingId} with step_id null`]),
    ];
    const noted = notes.length === 0 ? "" : ` (${notes.join("; ")})`;
    return `${lead.findingId} (${FINDING_KIND_WORDS[lead.kind]}) suggests ${lead.tool}${on}${noted}`;
  });
  return `FOLLOW-UPS WORTH RUNNING: ${items.join("; ")}. A follow-up on one of them could change the signal or decide a prior.`;
}

/**
 * The follow-up nudge: the answer to a turn-2 submit_report sent while FOLLOW-UPS WORTH RUNNING were
 * listed and no follow-up ran, once per run, with the leads (followupsLine) between the two lines.
 * The choice stays the model's: run the lead it judges most likely to matter, or say why none could.
 */
export const FOLLOWUP_NUDGE = "no follow-up ran in turn 2, so this report was not taken yet.";
export const FOLLOWUP_NUDGE_ASK =
  "Run the one you judge most likely to change the signal or decide a prior, citing its finding as trigger_finding_id, in a response without submit_report. " +
  "If none of them could, call submit_report again and say why in one line in open_questions, naming their F#. Your next submit_report is reviewed either way.";
/** Calls made together with a submit_report the follow-up nudge answered. */
export const FOLLOWUP_NUDGE_COMPANION = "calls made together with submit_report are not run; make the call again in a response without submit_report.";

/**
 * After a turn-2 response that ran only planned steps while follow-ups are worth running (those turn 1
 * listed, or ones the steps just raised), with no ANALYST PIVOT yet: turn 2 stays open once, with the
 * leads (followupsLine) before this notice. It is the follow-up nudge, sent at most once per run, and
 * the choice stays the model's.
 */
export const NOTICE_FOLLOWUP_OPEN =
  "TURN 2 stays open for one response, since no follow-up has run yet: run the FOLLOW-UPS WORTH RUNNING item you judge most likely to change the signal or decide a prior, citing its finding as trigger_finding_id. " +
  "If none of them could, call submit_report and say why in one line in open_questions, naming their F#.";

/** After a turn-2 response whose calls were all refused for their input: turn 2 stays open once. */
export const NOTICE_TURN2_OPEN = "None of your turn-2 calls ran. Turn 2 stays open for one response: send the calls again corrected, or call submit_report.";

/** At most this many findings are named in an UNTRIGGERED_FOLLOWUP answer. */
const CITABLE_MAX = 8;

/** The findings a refused follow-up could cite, e.g. " Findings you can cite: F1 (near substitutes)." */
export function citableLine(findings: readonly { id: string; kind: FindingKind }[]): string {
  if (findings.length === 0) return " This run has no findings to cite yet.";
  const named = findings.slice(0, CITABLE_MAX).map((f) => `${f.id} (${FINDING_KIND_WORDS[f.kind]})`);
  const more = findings.length > CITABLE_MAX ? ` and ${findings.length - CITABLE_MAX} more` : "";
  return ` Findings you can cite: ${named.join(", ")}${more}.`;
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
  "FOLLOWUP_EXPECTED",
  "INVESTIGATION_BUDGET_EXHAUSTED",
  "REPORT_SUBMITTED",
  "TOOL_INPUT_TRUNCATED",
  "INVALID_JSON",
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
