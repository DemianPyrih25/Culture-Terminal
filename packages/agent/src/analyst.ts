import type {
  FindingId,
  ReportDraftShape,
  RunLimits,
  SkillId,
  SubmitPlanInput,
  SubmitPlanInputShape,
  TokenUsage,
} from "@ct/contracts";
import type { AnalystMode, AnthropicLike, LlmModel } from "./anthropic";
import type { LlmErrorInfo } from "./llm/errors";
import { AnalystLoop } from "./llm/loop";
import type { AnalystToolErrorCode } from "./llm/notices";
import type { LlmRefusal } from "./llm/stop";

export { ANALYST_TOOL_ERROR_CODES, type AnalystToolErrorCode } from "./llm/notices";
export { ANALYST_MIN_MAX_TOKENS } from "./llm/loop";
export type { LlmErrorInfo } from "./llm/errors";
export type { LlmRefusal } from "./llm/stop";

/**
 * The ANALYST tool loop (PLAN §4.1 D–F, §4.2 guards, D4). Turn 1: submit_plan plus wave-1 tools;
 * turn 2: finding-triggered follow-ups, planned steps that need wave-1 results, or submit_report;
 * turn 3: submit_report only. At most `limits.modelResponses` model responses, nudges, repairs and
 * continuations included.
 */

/** The logical turn a request serves: plan (1), follow-ups and late planned steps (2) or report (3). */
export type AnalystTurn = 1 | 2 | 3;

/** A tool_use block as the model wrote it; `name` may even be a tool that does not exist. */
export interface AnalystToolUse {
  id: string;
  name: string;
  input: unknown;
}

/** A call handed to executeTools: a known skill whose input passed the contracts' zod schema. */
export interface AnalystToolCall {
  /** The tool_use id; the matching result must carry it as `tool_use_id`. */
  id: string;
  name: SkillId;
  /** The parsed input, of type ToolInput<typeof name>. */
  input: unknown;
}

/** One answer from executeTools, in the Messages API tool_result shape. */
export interface AnalystToolResult {
  tool_use_id: string;
  /** Usually a wrapQlooData digest (≤ MODEL_DIGEST_MAX_TOKENS). */
  content: string;
  is_error?: boolean;
}

/** How one tool_use block was answered. */
export interface AnalystToolEnd {
  use: AnalystToolUse;
  turn: AnalystTurn;
  ok: boolean;
  /** Set when the loop answered the call itself with is_error; null for executed calls and accepted submissions. */
  code: AnalystToolErrorCode | null;
  /** The tool_result content (for an accepted report, a short acknowledgement that is never sent). */
  content: string;
  /** True when executeTools ran the call. */
  executed: boolean;
}

/**
 * An ANALYST PIVOT: a turn-2 follow-up driven by a finding (the `pivot` event payload). A planned
 * step run in turn 2 without a trigger is not one.
 */
export interface AnalystPivot {
  toolCallId: string;
  tool: SkillId;
  triggerFindingId: FindingId;
  args: unknown;
}

export interface AnalystRejection {
  toolCallId: string;
  tool: string;
  code: AnalystToolErrorCode;
  turn: AnalystTurn;
}

/** The CHECKER's verdict on a structurally valid draft; a rejection costs the one report repair turn. */
export type ReportReview = { ok: true } | { ok: false; feedback: string };

/** Which submission reviewReport is looking at. */
export interface ReportReviewContext {
  /** 1 for the first submit_report, 2 for the repair turn's (the `report.draft` and `validation` attempt). */
  attempt: 1 | 2;
  /**
   * True when no repair can follow: this is the repair turn's draft, or no model response is left
   * for one. The loop then accepts the draft whatever the verdict, so the CHECKER must downgrade its
   * rejections to warnings (checkReport `attempt: 2`) for them to cost confidence (SPEC §6.2, §6.4).
   */
  final: boolean;
}

export interface AnalystOptions {
  client: AnthropicLike;
  /** live: Sonnet 5.5 with display "updates"; economy: Haiku 5.5 with display "summarized". */
  model: AnalystMode;
  /** The frozen director prompt; sent with cache_control so tools + system cache across runs. */
  systemPrompt: string;
  /** Built by the caller: date, mode, budgets, CLERK JSON, registry, scan list and the wrapped question. */
  firstUserMessage: string;
  limits: RunLimits;
  /** Aborting it stops the run promptly with status "cancelled". */
  signal?: AbortSignal;
  /** Milliseconds; defaults to Date.now. Wall-clock limits count from `startedAt`. */
  now?: () => number;
  /** When the run started, on the `now` clock (default: when runAnalyst is called). */
  startedAt?: number;
  /**
   * Runs the accepted skill calls of one response together (turn 1: wave 1; turn 2: follow-ups and
   * late planned steps, all under the follow-up Qloo sub-cap) and resolves with one result per call.
   * A missing result is answered with TOOL_FAILED; a rejection ends the run as failed ("hook_error").
   * `signal` fires on cancel or the hard wall-clock stop.
   */
  executeTools(calls: AnalystToolCall[], turn: AnalystTurn, signal: AbortSignal): Promise<readonly AnalystToolResult[]>;
  /**
   * Whether a finding id was issued in this run. Asked for every turn-2 call that cites one: a turn-2
   * call must cite an existing finding (a follow-up), unless it has no trigger and its step_id names
   * a plan step that no earlier call has run, with the tool that step names (a planned step whose
   * inputs only existed after wave 1).
   */
  findingExists(id: FindingId): boolean;
  /**
   * Extra text blocks for the message that closes a turn, after its tool results: for turn 1 the
   * opening-scan digests and findings (PLAN §4.1 D), awaited, so the scan can run in parallel with
   * turn 1. Called once per closed turn.
   */
  turnContext?(closedTurn: 1 | 2, signal: AbortSignal): readonly string[] | Promise<readonly string[]>;
  /**
   * Extra text blocks for the same message, placed after turnContext's, written once the loop has
   * decided the next turn: 2 when follow-ups are still allowed, 3 when only submit_report is left (a
   * wrap-up notice went out, or one response remains). Advice that depends on follow-ups, such as
   * the EVIDENCE line, belongs here so it never contradicts the closing TURN guide.
   */
  closingContext?(closedTurn: 1 | 2, nextTurn: AnalystTurn): readonly string[];
  /**
   * The CHECKER (V1–V10) on every structurally valid submit_report, as strict mode guarantees it: id
   * formats (V1) and lengths and counts (V9) are the CHECKER's to judge, so all issues reach the model
   * in one repair message. A rejection that is not `final` sends `feedback` back as an is_error
   * result for the one repair turn; a final draft is accepted whatever the verdict. Without this hook
   * the loop checks the contracts' limits itself (V1 formats, V9) under the same one-repair rule.
   */
  reviewReport?(draft: ReportDraftShape, context: ReportReviewContext, signal: AbortSignal): ReportReview | Promise<ReportReview>;

  // Observers. Fire-and-forget: an exception thrown by one is swallowed so it cannot break the loop.
  /** Thinking updates, coalesced every 300 ms (the `note` event). */
  onThinking?(text: string): void;
  /** Every tool_use block, before validation. */
  onToolStart?(use: AnalystToolUse, turn: AnalystTurn): void;
  onToolEnd?(end: AnalystToolEnd): void;
  /** Per response, after it arrives: its usage and USD on `model`. Outcome totals are the sums. */
  onUsage?(usage: TokenUsage, usd: number, model: LlmModel): void;
  /**
   * The plan the run proceeds with (the `plan` event), once, before wave 1 runs: either within its
   * limits (`issues` empty) or, after its one repair, the last structurally valid plan with the limit
   * issues it still has. The hypotheses the model wrote before any data are never dropped.
   */
  onPlan?(plan: SubmitPlanInputShape, issues: readonly string[]): void;
  /** Every structurally valid submit_report, before the review (the `report.draft` event). */
  onReportDraft?(draft: ReportDraftShape, attempt: 1 | 2): void;
  /** Every accepted finding-triggered turn-2 call, before it runs. */
  onPivot?(pivot: AnalystPivot): void;
}

/**
 * completed: a report was accepted, possibly with CHECKER warnings. incomplete: no accepted report
 * (the caller builds the evidence-digest report marked INCOMPLETE), including a second max_tokens
 * cut with a pending tool_use. refused: the model refused. failed: an API error or a failing hook.
 * cancelled: the caller aborted.
 */
export type AnalystStatus = "completed" | "incomplete" | "refused" | "failed" | "cancelled";

export type AnalystStopCode =
  | "report_accepted"
  | "refused"
  | "response_limit"
  | "no_report_after_nudge"
  | "report_invalid"
  | "wall_clock"
  | "usd_limit"
  | "cancelled"
  | "max_tokens_pending_tool"
  | "api_error"
  | "hook_error";

export interface AnalystOutcome {
  status: AnalystStatus;
  code: AnalystStopCode;
  /** A short human-readable detail; null for a clean completion. */
  reason: string | null;
  /** The plan within its limits (narrow ids), or null when none passed them. */
  plan: SubmitPlanInput | null;
  /**
   * The plan as the model wrote it: the last structurally valid submit_plan, within its limits or
   * not. This is what the CHECKER and the Hypothesis Scorecard judge the verdicts against.
   */
  submittedPlan: SubmitPlanInputShape | null;
  /** The accepted submit_report, as strict mode guarantees it (structure only); set only when status is completed. */
  draft: ReportDraftShape | null;
  /** The last structurally valid submit_report, accepted or not. */
  submittedDraft: ReportDraftShape | null;
  model: LlmModel;
  /** Requests sent, failed ones included. */
  responses: number;
  turn: AnalystTurn;
  usage: TokenUsage;
  /** Measured from usage. */
  usd: number;
  /**
   * Worst-case estimates charged for requests that may have been billed without a usage report:
   * failed requests and streams aborted by a cancel or the hard wall clock. Counts toward the cap
   * and belongs in the daily spend.
   */
  unmeteredUsd: number;
  refusal: LlmRefusal | null;
  error: LlmErrorInfo | null;
  nudges: { plan: boolean; report: boolean; time: boolean; cost: boolean };
  /** plan, report: the one repair turn was used. truncated: a turn cut off by max_tokens was asked again. */
  repairs: { plan: boolean; report: boolean; truncated: boolean };
  /** The accepted finding-triggered turn-2 calls; planned steps run in turn 2 are not pivots. */
  pivots: AnalystPivot[];
  /** Calls the loop answered with is_error itself, e.g. UNTRIGGERED_FOLLOWUP. */
  rejections: AnalystRejection[];
  elapsedMs: number;
}

/** Runs the ANALYST to an outcome. Never throws for API failures, refusals, limits or aborts. */
export function runAnalyst(options: AnalystOptions): Promise<AnalystOutcome> {
  return new AnalystLoop(options).run();
}
