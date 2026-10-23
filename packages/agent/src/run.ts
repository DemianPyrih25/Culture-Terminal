import type {
  Emit,
  Intent,
  Lane,
  NumbersTraced,
  Report,
  RunLimits,
  TerminalRunStatus,
  TokenUsage,
  ValidationIssue,
} from "@ct/contracts";
import type { QlooClient } from "@ct/qloo";
import type { AnalystMode, AnthropicLike } from "./anthropic";
import type { LedgerSnapshot } from "./ledger";
import { executeRun } from "./run/agentRun";

/**
 * One agent run end to end (PLAN §4.1 A–H): CLERK → resolution gate → opening scan in parallel with
 * ANALYST turn 1 → follow-ups → submit_report → CHECKER (≤1 repair) → ASSEMBLE.
 *
 * Seam file: these types are fixed for the parallel Wave B build (the web run manager and the dev
 * CLIs code against them); the agent-run workstream implements runAgent.
 */

export interface AgentRunOptions {
  runId: string;
  /** The raw question; runAgent caps it at QUESTION_MAX_CHARS and strips control characters. */
  question: string;
  lane: Lane;
  /** live: Sonnet 5.5; economy: Haiku 5.5 (labelled in the receipt). */
  mode: AnalystMode;
  /**
   * Receives every event of the run from run.created up to, but not including, run.end: the caller
   * (the run manager) stamps seq/ts/runId, persists and publishes, and writes run.end itself from the
   * returned status (or from a cancel/abort it saw).
   */
  emit: Emit;
  qloo: QlooClient;
  anthropic: AnthropicLike;
  /** Defaults to DEFAULT_RUN_LIMITS. */
  limits?: RunLimits;
  /** Cancel or shutdown: runAgent stops promptly and returns status "cancelled" or "incomplete". */
  signal: AbortSignal;
  /** Milliseconds clock; defaults to Date.now. */
  now?: () => number;
  /**
   * Entities chosen in advance, keyed by the normalised mention text (normaliseName): a needs_input
   * picker answer or a showcase pin. A pinned mention skips matching and uses this Qloo entity id.
   */
  pins?: Readonly<Record<string, string>>;
  /** A child run launched from next_moves (§7.3): the parent and its case summary. */
  parent?: { runId: string; caseSummary: string } | null;
  /** False forces the fail-closed path (V7: insufficient_evidence). Defaults to true. */
  qlooEnabled?: boolean;
  /**
   * CLERK's reading of this same question, made earlier for a preview (POST /api/preview). The run
   * skips CLERK and uses it, still emitting the `clerk` event (ms 0) and still applying the safety
   * checks. Only a trusted server-side caller passes it; it never comes from the browser.
   */
  intent?: Intent;
}

export interface AgentRunResult {
  /** needs_input ends the run with a picker; refused ends it with a refusal card. */
  status: TerminalRunStatus;
  /** Null for needs_input, refused, cancelled and failed-before-ANALYST runs. */
  report: Report | null;
  /** The ledger at the end of the run, for the evidence/metrics/datasets/findings tables. */
  ledger: LedgerSnapshot;
  /** CLERK's intent, or null when CLERK failed or refused. */
  intent: Intent | null;
  /** The ANALYST model id that ran, or null when the run ended before the ANALYST. */
  model: string | null;
  usage: TokenUsage;
  /** Measured plus unmetered (worst-case for aborted or failed requests) LLM spend in USD. */
  usd: number;
  qloo: { network: number; cached: number; reused: number };
  validation: { issues: ValidationIssue[]; numbersTraced: NumbersTraced } | null;
  /** Human-readable reason for any status other than completed; null otherwise. */
  reason: string | null;
  elapsedMs: number;
}

/**
 * Runs one question end to end. Never throws for model, Qloo or limit failures: every path ends in an
 * AgentRunResult whose status the caller writes as run.end. Invalid `limits` throw (a caller bug).
 */
export function runAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  return executeRun(options);
}

/**
 * The steps of a run that a preview repeats before the run (POST /api/preview): the safety checks on
 * CLERK's intent and the resolution gate's matching, exactly as runAgent applies them, so an intent
 * a preview hands back as `AgentRunOptions.intent` was read and checked the same way.
 */
export { refusalOf } from "./run/agentRun";
export { privatePersonRefusal, runResolutionGate, type GateOutcome, type GateResolved } from "./run/gate";
