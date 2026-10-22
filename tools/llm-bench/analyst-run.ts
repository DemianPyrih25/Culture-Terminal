import { BudgetStop, type BudgetGuard } from "./budget";
import { callModel, CallFailed, type AnalystStreamer, type CallOutcome, type ErrorInfo } from "./client";
import { buildAnalystRequest, cachedSystem, type AnalystPrefix, type BenchConfig, type BenchConfigId } from "./config";
import { DEFAULT_RUN_LIMITS, toAnthropicTools, type Anthropic } from "./deps";
import { History, textBlock } from "./history";
import { ANALYST_SYSTEM_PROMPT } from "./prompts";
import {
  answerSkillCall,
  buildScenario,
  NUDGE_PLAN,
  NUDGE_REPORT,
  planAck,
  TURN2_GUIDE,
  TURN3_NOTICE,
  type Scenario,
} from "./scenario";
import { classifyStop, thinkingSummary, toolUses, type RefusalResult } from "./stop";
import { checkPlan, checkReport, reportQuality, type ReportQuality } from "./validate";

/** At most five model responses per run, nudges and continuations included (D4). */
export const MAX_RESPONSES = DEFAULT_RUN_LIMITS.modelResponses;

export type RequestKind = "turn" | "nudge_retry" | "pause_continue" | "retry_after_error";

export interface TurnRecord {
  response: number;
  /** The logical turn the request served: plan (1), follow-ups (2) or report (3). */
  turn: 1 | 2 | 3;
  kind: RequestKind;
  /** For retry_after_error: the error that made the turn re-issue (its kind and message). */
  retryCause: string | null;
  latencyMs: number;
  firstDeltaMs: number | null;
  usage: { input: number; output: number; cacheCreation: number; cacheRead: number };
  usd: number;
  estimateUsd: number;
  estimateShortfallTokens: number;
  stopReason: string | null;
  thinking: { blocks: number; nonEmpty: number; deltaChars: number; texts: string[] };
  text: string[];
  /** ok: the call was answered with data (or a valid submission); false: it got is_error; null: never answered. */
  tools: Array<{ id: string; name: string; ok: boolean | null; input: unknown }>;
}

export interface SubmissionRecord {
  submitted: boolean;
  /** Matches the schema the API saw (what strict mode guarantees). */
  structural: boolean | null;
  /** Also within the id formats, counts and lengths enforced server-side (CHECKER V1 and V9). */
  limits: boolean | null;
  issues: string[];
  input: unknown;
}

export type RunOutcome = "completed" | "incomplete" | "refused" | "failed" | "budget_stopped";

export interface RunRecord {
  config: BenchConfigId;
  model: string;
  effort: string;
  thinkingDisplay: string;
  run: number;
  outcome: RunOutcome;
  reason: string | null;
  error: ErrorInfo | null;
  refusal: RefusalResult | null;
  wallMs: number;
  /** Measured cost: the sum of the responses' usage. */
  usd: number;
  /**
   * Worst-case estimates charged to the guard for failed requests that may have been billed. Kept
   * apart from usd so one dropped stream cannot inflate the cost the decision rule reads.
   */
  estimatedChargesUsd: number;
  usage: { input: number; output: number; cacheCreation: number; cacheRead: number };
  responses: number;
  turnReached: 1 | 2 | 3;
  nudges: { plan: boolean; report: boolean };
  plan: SubmissionRecord;
  report: SubmissionRecord;
  quality: ReportQuality | null;
  /** cache_read_input_tokens of the run's first request: > 0 on a second identical-prefix run. */
  firstRequestCacheRead: number | null;
  thinkingNonEmpty: boolean;
  turns: TurnRecord[];
}

export interface RunDeps {
  streamer: AnalystStreamer;
  guard: BudgetGuard;
  now: () => number;
}

export function analystPrefix(): AnalystPrefix {
  return { system: cachedSystem(ANALYST_SYSTEM_PROMPT), tools: toAnthropicTools() };
}

const notSubmitted = (): SubmissionRecord => ({ submitted: false, structural: null, limits: null, issues: [], input: null });

function turnRecord(call: CallOutcome, response: number, turn: 1 | 2 | 3, kind: RequestKind, retryCause: string | null): TurnRecord {
  const u = call.message.usage;
  const thinking = thinkingSummary(call.message);
  return {
    response,
    turn,
    kind,
    retryCause,
    latencyMs: call.latencyMs,
    firstDeltaMs: call.firstDeltaMs,
    usage: {
      input: u.input_tokens,
      output: u.output_tokens,
      cacheCreation: u.cache_creation_input_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
    },
    usd: call.usd,
    estimateUsd: call.estimateUsd,
    estimateShortfallTokens: call.estimateShortfallTokens,
    stopReason: call.message.stop_reason,
    thinking: { ...thinking, deltaChars: call.thinkingDeltaChars },
    text: call.message.content.flatMap((b) => (b.type === "text" && b.text.trim() ? [b.text] : [])),
    tools: toolUses(call.message).map((u) => ({ id: u.id, name: u.name, ok: null, input: u.input })),
  };
}

function errorResult(use: Anthropic.Beta.BetaToolUseBlock, content: string): Anthropic.Beta.BetaToolResultBlockParam {
  return { type: "tool_result", tool_use_id: use.id, is_error: true, content };
}

/**
 * One synthetic three-turn ANALYST run (PLAN §4.1 D–F) with the §4.2 guards: stop_reason before
 * content, one plan nudge, one report nudge, pause_turn continues, max_tokens with a pending
 * tool_use fails the turn, and the history is append-only. Never throws for API failures: the
 * record carries the outcome and the error's scope.
 */
export async function runAnalyst(config: BenchConfig, run: number, deps: RunDeps, scenario: Scenario = buildScenario()): Promise<RunRecord> {
  const prefix = analystPrefix();
  const history = new History();
  history.push({ role: "user", content: scenario.runContext });

  const rec: RunRecord = {
    config: config.id,
    model: config.model,
    effort: config.effort,
    thinkingDisplay: config.thinkingDisplay,
    run,
    outcome: "incomplete",
    reason: null,
    error: null,
    refusal: null,
    wallMs: 0,
    usd: 0,
    estimatedChargesUsd: 0,
    usage: { input: 0, output: 0, cacheCreation: 0, cacheRead: 0 },
    responses: 0,
    turnReached: 1,
    nudges: { plan: false, report: false },
    plan: notSubmitted(),
    report: notSubmitted(),
    quality: null,
    firstRequestCacheRead: null,
    thinkingNonEmpty: false,
    turns: [],
  };
  const end = (outcome: RunOutcome, reason: string | null): void => {
    rec.outcome = outcome;
    rec.reason = reason;
  };

  const started = deps.now();
  let turn: 1 | 2 | 3 = 1;
  let kind: RequestKind = "turn";
  let retryCause: string | null = null;
  let turnRetries = 0;
  let planned: string[] = [];

  for (;;) {
    rec.turnReached = turn;
    if (rec.responses >= MAX_RESPONSES) {
      end("incomplete", `reached the limit of ${MAX_RESPONSES} model responses without submit_report`);
      break;
    }

    let call: CallOutcome;
    try {
      call = await callModel(deps.streamer, buildAnalystRequest(config, prefix, history.messages), deps.guard, deps.now);
    } catch (err) {
      if (err instanceof BudgetStop) {
        end("budget_stopped", err.message);
        break;
      }
      if (err instanceof CallFailed) {
        rec.responses++;
        rec.estimatedChargesUsd += err.chargedUsd;
        // Unparseable tool JSON or a dropped stream left no tool_use block to answer, so the turn is re-issued once.
        if (err.info.retryTurn && turnRetries < 1) {
          turnRetries++;
          kind = "retry_after_error";
          retryCause = err.message.slice(0, 200);
          continue;
        }
        rec.error = err.info;
        end("failed", err.message);
        break;
      }
      throw err;
    }

    rec.responses++;
    const record = turnRecord(call, rec.responses, turn, kind, kind === "retry_after_error" ? retryCause : null);
    rec.turns.push(record);

    // stop_reason first, before any content is read.
    const stop = classifyStop(call.message);
    if (stop.kind === "refusal") {
      rec.refusal = stop.refusal;
      end("refused", `refusal (${stop.refusal.category ?? "no category"})`);
      break;
    }
    if (stop.kind === "max_tokens_pending_tool") {
      end("failed", `max_tokens with a pending tool_use (${stop.pendingTools.join(", ")}); its tools were not run`);
      break;
    }

    history.pushAssistant(call.message);
    if (stop.kind === "pause_turn") {
      kind = "pause_continue";
      continue;
    }

    const uses = toolUses(call.message);
    const mark = (use: Anthropic.Beta.BetaToolUseBlock, ok: boolean): void => {
      const entry = record.tools.find((t) => t.id === use.id);
      if (entry) entry.ok = ok;
    };

    const reportUse = uses.find((u) => u.name === "submit_report");
    if (reportUse) {
      const c = checkReport(reportUse.input);
      rec.report = { submitted: true, structural: c.structural, limits: c.limits, issues: c.issues, input: reportUse.input };
      rec.quality = c.report ? reportQuality(c.report, scenario.ledger, planned) : null;
      mark(reportUse, c.structural);
      end("completed", null);
      break;
    }

    if (turn === 1) {
      const planUse = uses.find((u) => u.name === "submit_plan");
      const gate = !planUse && !rec.nudges.plan;
      const results: Anthropic.Beta.BetaContentBlockParam[] = [];
      if (planUse) {
        const c = checkPlan(planUse.input);
        rec.plan = { submitted: true, structural: c.structural, limits: c.limits, issues: c.issues, input: planUse.input };
        planned = c.plan?.hypotheses.map((h) => h.id) ?? [];
        mark(planUse, c.structural);
        results.push(
          c.plan
            ? { type: "tool_result", tool_use_id: planUse.id, content: planAck(c.plan) + (c.limits ? "" : ` Limit issues: ${c.issues.join("; ")}`) }
            : errorResult(planUse, "INVALID_PLAN: the plan does not match the submit_plan schema."),
        );
      }
      for (const use of uses) {
        if (use === planUse) continue;
        if (gate) {
          results.push(errorResult(use, "PLAN_REQUIRED: call submit_plan first; wave-1 tools run together with it."));
          mark(use, false);
          continue;
        }
        const answer = answerSkillCall(use, "wave1", scenario);
        results.push(answer.result);
        mark(use, answer.ok);
      }
      if (gate) {
        rec.nudges.plan = true;
        history.push({ role: "user", content: [...results, textBlock(NUDGE_PLAN)] });
        kind = "nudge_retry";
        continue;
      }
      history.push({
        role: "user",
        content: [
          ...results,
          textBlock(`OPENING SCAN (run by code for brand_health; cite it like any other evidence):\n${scenario.scan.join("\n")}`),
          textBlock(TURN2_GUIDE),
        ],
      });
      turn = 2;
      kind = "turn";
      continue;
    }

    if (turn === 2) {
      if (uses.length === 0) {
        if (rec.nudges.report) {
          end("incomplete", "the turn ended without submit_report after the nudge");
          break;
        }
        rec.nudges.report = true;
        history.push({ role: "user", content: NUDGE_REPORT });
        turn = 3;
        kind = "nudge_retry";
        continue;
      }
      const results = uses.map((use) => {
        const answer = answerSkillCall(use, "followup", scenario);
        mark(use, answer.ok);
        return answer.result;
      });
      history.push({ role: "user", content: [...results, textBlock(TURN3_NOTICE)] });
      turn = 3;
      kind = "turn";
      continue;
    }

    // Turn 3: submit_report is the only allowed call.
    if (rec.nudges.report) {
      end("incomplete", "no submit_report after the nudge");
      break;
    }
    rec.nudges.report = true;
    const results = uses.map((use) => {
      const answer = answerSkillCall(use, "final", scenario);
      mark(use, answer.ok);
      return answer.result;
    });
    history.push({ role: "user", content: results.length > 0 ? [...results, textBlock(NUDGE_REPORT)] : NUDGE_REPORT });
    kind = "nudge_retry";
  }

  rec.wallMs = deps.now() - started;
  for (const t of rec.turns) {
    rec.usd += t.usd;
    rec.usage.input += t.usage.input;
    rec.usage.output += t.usage.output;
    rec.usage.cacheCreation += t.usage.cacheCreation;
    rec.usage.cacheRead += t.usage.cacheRead;
  }
  rec.firstRequestCacheRead = rec.turns[0]?.usage.cacheRead ?? null;
  rec.thinkingNonEmpty = rec.turns.some((t) => t.thinking.nonEmpty > 0 || t.thinking.deltaChars > 0);
  return rec;
}
