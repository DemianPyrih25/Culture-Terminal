import type Anthropic from "@anthropic-ai/sdk";
import {
  parseToolInput,
  ReportDraftShape,
  SkillId,
  SubmitPlanInputShape,
  type FindingId,
  type StepId,
  type SubmitPlanInput,
  type TokenUsage,
} from "@ct/contracts";
import type {
  AnalystOptions,
  AnalystOutcome,
  AnalystPivot,
  AnalystRejection,
  AnalystStatus,
  AnalystStopCode,
  AnalystToolCall,
  AnalystToolUse,
  AnalystTurn,
  ReportReview,
  ReportReviewContext,
} from "../analyst";
import { ANALYST_CONFIGS, ANALYST_MAX_TOKENS, type AnalystModelConfig, type AnalystRequest } from "../anthropic";
import { addTokenUsage, affordableMaxTokens, emptyTokenUsage, estimateRequestUsd, tokenUsageOf, usdFor } from "../pricing";
import { Answers } from "./answers";
import { describeLlmError, type LlmErrorInfo } from "./errors";
import { History } from "./history";
import { NoteCoalescer } from "./notes";
import {
  issueLines,
  NOTICE_COST,
  NOTICE_TIME,
  NOTICE_TRUNCATED,
  NUDGE_PLAN,
  NUDGE_REPORT,
  planAck,
  TURN3_NOTICE,
  turn2Guide,
} from "./notices";
import { analystPrefix, buildAnalystRequest, promptChars, type AnalystPrefix } from "./request";
import { RunControl, RunStopped, type StopCause } from "./run-control";
import { classifyStop, toolUses, type LlmRefusal } from "./stop";

type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;

/**
 * The smallest max_tokens the cost guard will send. Below it a medium-effort turn risks max_tokens
 * with a pending tool_use, so the run stops at the cap instead (tools/llm-bench smoke settings).
 */
export const ANALYST_MIN_MAX_TOKENS = 8000;

/** A caller-supplied hook threw: the run ends as failed with code "hook_error". */
class HookFailed extends Error {
  constructor(hook: string, cause: unknown) {
    super(`${hook} failed: ${cause instanceof Error ? cause.message : String(cause)}`.slice(0, 500));
    this.name = "HookFailed";
  }
}

const useOf = (use: ToolUseBlock): AnalystToolUse => ({ id: use.id, name: use.name, input: use.input });

/** Every skill input carries trigger_finding_id and step_id (contracts callMeta), so a parsed input has both. */
const triggerOf = (input: unknown): FindingId | null => (input as { trigger_finding_id: FindingId | null }).trigger_finding_id;
const stepOf = (input: unknown): StepId | null => (input as { step_id: StepId | null }).step_id;

const CITE_FINDING = "cites the finding (F#) that motivates it as trigger_finding_id";

/** One ANALYST run. Single use: construct, then await run(). */
export class AnalystLoop {
  readonly #o: AnalystOptions;
  readonly #config: AnalystModelConfig;
  readonly #prefix: AnalystPrefix;
  readonly #history = new History();
  readonly #now: () => number;
  readonly #startedAt: number;
  readonly #control: RunControl;
  readonly #notes: NoteCoalescer;

  #turn: AnalystTurn = 1;
  #responses = 0;
  #usage: TokenUsage = emptyTokenUsage();
  #usd = 0;
  #unmeteredUsd = 0;
  #pendingEstimate = 0;
  #retriedAfterSdkError = false;
  /** A wrap-up notice went out (time or cost): every later request is held to turn-3 rules. */
  #wrapUp = false;
  #notices: string[] = [];
  #plan: SubmitPlanInput | null = null;
  #submittedPlan: SubmitPlanInputShape | null = null;
  /** The limit issues of #submittedPlan; empty when it is within its limits. */
  #planIssues: string[] = [];
  /** onPlan has fired; it fires once, for the plan the run proceeds with. */
  #planSettled = false;
  #draft: ReportDraftShape | null = null;
  #submittedDraft: ReportDraftShape | null = null;
  #refusal: LlmRefusal | null = null;
  #error: LlmErrorInfo | null = null;
  readonly #nudges = { plan: false, report: false, time: false, cost: false };
  readonly #repairs = { plan: false, report: false, truncated: false };
  readonly #pivots: AnalystPivot[] = [];
  readonly #rejections: AnalystRejection[] = [];
  /** Step ids of every call handed to executeTools, so a planned step runs untriggered at most once. */
  readonly #stepsRun = new Set<StepId>();

  constructor(options: AnalystOptions) {
    this.#o = options;
    this.#config = ANALYST_CONFIGS[options.model];
    this.#prefix = analystPrefix(options.systemPrompt);
    this.#now = options.now ?? (() => Date.now());
    this.#startedAt = options.startedAt ?? this.#now();
    this.#control = new RunControl(options.signal, options.limits.hardMs - this.#elapsed());
    this.#notes = new NoteCoalescer((text) => this.#notify(() => options.onThinking?.(text)));
  }

  async run(): Promise<AnalystOutcome> {
    try {
      this.#history.push({ role: "user", content: this.#o.firstUserMessage });
      return await this.#loop();
    } finally {
      this.#control.dispose();
      this.#notes.flush();
    }
  }

  async #loop(): Promise<AnalystOutcome> {
    const { limits } = this.#o;
    for (;;) {
      if (this.#control.cause === null && this.#elapsed() >= limits.hardMs) this.#control.stop("wall_clock");
      if (this.#control.cause !== null) return this.#stopped(this.#control.cause);
      if (this.#responses >= limits.modelResponses) {
        return this.#end("incomplete", "response_limit", `reached the limit of ${limits.modelResponses} model responses without an accepted submit_report`);
      }
      const request = this.#nextRequest();
      if (request === null) {
        return this.#end("incomplete", "usd_limit", `the next response could pass the per-run cost cap of $${limits.usdHard}`);
      }

      let message: Anthropic.Beta.BetaMessage;
      try {
        message = await this.#send(request);
      } catch (err) {
        if (this.#control.cause !== null) {
          // The aborted stream may already have generated billed tokens that no usage report will show.
          this.#unmeteredUsd += this.#pendingEstimate;
          return this.#stopped(this.#control.cause);
        }
        const info = describeLlmError(err);
        if (info.maybeBilled) this.#unmeteredUsd += this.#pendingEstimate;
        // Unparseable eager tool JSON or a dropped stream leaves no tool_use to answer: re-issue once.
        if (info.retryTurn && !this.#retriedAfterSdkError) {
          this.#retriedAfterSdkError = true;
          continue;
        }
        this.#error = info;
        return this.#end("failed", "api_error", `${info.kind}${info.status === null ? "" : ` (${info.status})`}: ${info.message}`);
      }
      this.#charge(message);

      // stop_reason first, before any content is read.
      const stop = classifyStop(message);
      if (stop.kind === "refusal") {
        this.#refusal = stop.refusal;
        return this.#end("refused", "refused", `refusal (${stop.refusal.category ?? "no category"})`);
      }
      if (stop.kind === "max_tokens_pending_tool") {
        const outcome = this.#truncated(message, stop.pendingTools);
        if (outcome !== null) return outcome;
        continue;
      }
      this.#history.pushAssistant(message);
      if (stop.kind === "pause_turn") continue;

      try {
        const outcome = await this.#handle(toolUses(message));
        if (outcome !== null) return outcome;
      } catch (err) {
        if (err instanceof RunStopped) return this.#stopped(err.stopCause);
        if (err instanceof HookFailed) return this.#end("failed", "hook_error", err.message);
        throw err;
      }
    }
  }

  /** The next request, with max_tokens lowered if the full worst case would pass usdHard; null when nothing useful fits. */
  #nextRequest(): AnalystRequest | null {
    const request = buildAnalystRequest(this.#config, this.#prefix, this.#history.snapshot());
    const chars = promptChars(request);
    const maxTokens = affordableMaxTokens(this.#config.model, chars, this.#o.limits.usdHard - this.#spent(), ANALYST_MAX_TOKENS);
    if (maxTokens < ANALYST_MIN_MAX_TOKENS) return null;
    this.#pendingEstimate = estimateRequestUsd(this.#config.model, chars, maxTokens);
    return maxTokens === request.max_tokens ? request : { ...request, max_tokens: maxTokens };
  }

  async #send(request: AnalystRequest): Promise<Anthropic.Beta.BetaMessage> {
    this.#responses++;
    try {
      const stream = this.#o.client.beta.messages.stream(request, { signal: this.#control.signal });
      stream.on("thinking", (delta, snapshot) => this.#notes.push(delta, snapshot));
      return await this.#control.race(stream.finalMessage());
    } finally {
      this.#notes.flush();
    }
  }

  #charge(message: Anthropic.Beta.BetaMessage): void {
    const model = this.#config.model;
    const usd = usdFor(model, message.usage);
    const usage = tokenUsageOf(message.usage);
    this.#usd += usd;
    this.#usage = addTokenUsage(this.#usage, usage);
    this.#notify(() => this.#o.onUsage?.(usage, usd, model));
    if (!this.#nudges.cost && this.#spent() >= this.#o.limits.usdNudge) {
      this.#nudges.cost = true;
      this.#wrapUp = true;
      this.#notices.push(NOTICE_COST);
    }
  }

  async #handle(uses: ToolUseBlock[]): Promise<AnalystOutcome | null> {
    const turn = this.#turn;
    for (const use of uses) this.#notify(() => this.#o.onToolStart?.(useOf(use), turn));
    const report = turn === 1 ? undefined : uses.find((u) => u.name === "submit_report");
    if (report) return this.#report(uses, report);
    if (turn === 1) return this.#turnOne(uses);
    if (turn === 2) return this.#turnTwo(uses);
    return this.#turnThree(uses);
  }

  /** Turn 1: submit_plan plus wave-1 tools. Without a valid plan, data is held back for one nudge or repair. */
  async #turnOne(uses: ToolUseBlock[]): Promise<AnalystOutcome | null> {
    const answers = new Answers(uses);
    const planUse = uses.find((u) => u.name === "submit_plan");
    const planIssues = planUse ? this.#takePlan(planUse, answers) : null;
    const missing = planUse === undefined;
    const holdBack = missing ? !this.#nudges.plan : planIssues !== null && !this.#repairs.plan;
    if (planUse && planIssues) {
      const message = holdBack
        ? "fix these issues and call submit_plan again; wave-1 tools run together with it."
        : this.#submittedPlan
          ? "no repair is left, so the last well-formed plan is kept as written; the run continues."
          : "no repair is left and no well-formed plan was submitted; the run continues without one.";
      answers.reject(planUse, "INVALID_PLAN", message, planIssues);
    }

    const calls: AnalystToolCall[] = [];
    for (const use of uses) {
      if (use === planUse) continue;
      if (use.name === "submit_plan") answers.reject(use, "DUPLICATE_SUBMISSION", "submit_plan was already called in this response.");
      else if (use.name === "submit_report") answers.reject(use, "WRONG_TURN", "submit_report comes after the data, in turn 2 or 3.");
      else if (holdBack && SkillId.safeParse(use.name).success) {
        answers.reject(use, "PLAN_REQUIRED", "call submit_plan first; wave-1 tools run together with it.");
      } else {
        const call = this.#parseSkill(use, answers);
        if (call) calls.push(call);
      }
    }
    if (!holdBack) this.#settlePlan();
    await this.#execute(calls, 1, answers);
    const results = this.#finish(answers, 1);
    if (holdBack) {
      if (missing) this.#nudges.plan = true;
      else this.#repairs.plan = true;
      this.#pushUser(results, [], missing ? [NUDGE_PLAN] : []);
      return null;
    }
    await this.#closeTurn(results, 1);
    return null;
  }

  /**
   * Records a submit_plan: the narrow plan when it is within its limits, and in any case the last
   * structurally valid one with its issues. Returns the issues, or null when the plan was accepted.
   */
  #takePlan(use: ToolUseBlock, answers: Answers): string[] | null {
    const shape = SubmitPlanInputShape.safeParse(use.input);
    const parsed = parseToolInput("submit_plan", use.input);
    const issues = parsed.ok ? [] : issueLines(parsed.error);
    if (shape.success) {
      this.#submittedPlan = shape.data;
      this.#planIssues = issues;
    }
    if (!parsed.ok) return issues;
    this.#plan = parsed.input;
    answers.accept(use, planAck(parsed.input));
    return null;
  }

  /** Fires onPlan once, before wave 1 runs, with the plan the run proceeds with (the `plan` event). */
  #settlePlan(): void {
    const plan = this.#submittedPlan;
    if (this.#planSettled || plan === null) return;
    this.#planSettled = true;
    const issues = [...this.#planIssues];
    this.#notify(() => this.#o.onPlan?.(plan, issues));
  }

  /**
   * Turn 2: follow-ups, each citing a finding this run issued (an ANALYST PIVOT), and planned steps
   * whose inputs only existed after wave 1, run untriggered under their step_id. Both share the
   * follow-up Qloo sub-cap, since executeTools runs them as turn 2. An ended turn gets the one
   * report nudge.
   */
  async #turnTwo(uses: ToolUseBlock[]): Promise<AnalystOutcome | null> {
    const answers = new Answers(uses);
    if (uses.length === 0) return this.#nudgeReport(answers);
    const calls: AnalystToolCall[] = [];
    for (const use of uses) {
      if (use.name === "submit_plan") {
        answers.reject(use, "WRONG_TURN", "the plan was fixed in turn 1.");
        continue;
      }
      const call = this.#parseSkill(use, answers);
      if (!call) continue;
      const trigger = triggerOf(call.input);
      if (trigger === null) {
        const refusal = this.#notPlannedStep(call, calls);
        if (refusal === null) calls.push(call);
        else answers.reject(use, "UNTRIGGERED_FOLLOWUP", refusal);
      } else if (!this.#findingExists(trigger)) {
        answers.reject(use, "UNTRIGGERED_FOLLOWUP", `${trigger} is not a finding of this run.`);
      } else {
        const pivot: AnalystPivot = { toolCallId: call.id, tool: call.name, triggerFindingId: trigger, args: call.input };
        this.#pivots.push(pivot);
        this.#notify(() => this.#o.onPivot?.(pivot));
        calls.push(call);
      }
    }
    await this.#execute(calls, 2, answers);
    await this.#closeTurn(this.#finish(answers, 2), 2);
    return null;
  }

  /**
   * Why an untriggered turn-2 call is refused, or null when it is a planned step: its step_id names
   * a step of the plan the run proceeds with (the checked plan, else the last well-formed one) that
   * no call has carried out yet, in an earlier turn or earlier in this response (`pending`), and it
   * calls the tool that step names, so a spare step id cannot carry an unplanned call.
   */
  #notPlannedStep(call: AnalystToolCall, pending: readonly AnalystToolCall[]): string | null {
    const step = stepOf(call.input);
    if (step === null) {
      return `every turn-2 call ${CITE_FINDING}, except a plan step that has not run yet, named by its step_id.`;
    }
    const steps: readonly { id: string; tool: SkillId }[] = (this.#plan ?? this.#submittedPlan)?.steps ?? [];
    const planned = steps.find((s) => s.id === step);
    if (planned === undefined) return `${step} is not a step of the plan; a follow-up ${CITE_FINDING}.`;
    if (this.#stepsRun.has(step) || pending.some((c) => stepOf(c.input) === step)) {
      return `${step} has already run; running it again is a follow-up that ${CITE_FINDING}.`;
    }
    if (planned.tool !== call.name) return `${step} plans ${planned.tool}, not ${call.name}; a follow-up ${CITE_FINDING}.`;
    return null;
  }

  /** Turn 3: submit_report is the only call; anything else is refused and costs the report nudge. */
  #turnThree(uses: ToolUseBlock[]): AnalystOutcome | null {
    const answers = new Answers(uses);
    for (const use of uses) answers.reject(use, "INVESTIGATION_BUDGET_EXHAUSTED", "turn 3 allows only submit_report.");
    return this.#nudgeReport(answers);
  }

  #nudgeReport(answers: Answers): AnalystOutcome | null {
    const results = this.#finish(answers, this.#turn);
    if (this.#nudges.report) return this.#end("incomplete", "no_report_after_nudge", "no submit_report after the nudge");
    this.#nudges.report = true;
    this.#pushUser(results, [], [NUDGE_REPORT]);
    this.#turn = 3;
    return null;
  }

  /**
   * submit_report: the structure strict mode guarantees, then the CHECKER review (V1–V10, limits
   * included). One repair turn; after it, or when no response is left for one, the draft is accepted
   * with warnings (SPEC §6.2).
   */
  async #report(uses: ToolUseBlock[], reportUse: ToolUseBlock): Promise<AnalystOutcome | null> {
    const turn = this.#turn;
    const answers = new Answers(uses);
    for (const use of uses) {
      if (use === reportUse) continue;
      if (use.name === "submit_report") answers.reject(use, "DUPLICATE_SUBMISSION", "submit_report was already called in this response.");
      else if (turn === 3) answers.reject(use, "INVESTIGATION_BUDGET_EXHAUSTED", "turn 3 allows only submit_report; this call was not run.");
      else answers.reject(use, "REPORT_SUBMITTED", "calls made together with submit_report are not run.");
    }
    const attempt: 1 | 2 = this.#repairs.report ? 2 : 1;
    const final = this.#repairs.report || this.#responses >= this.#o.limits.modelResponses;

    const shape = ReportDraftShape.safeParse(reportUse.input);
    if (!shape.success) {
      // Strict mode should never send this; without the structure there is nothing to assemble.
      const parsed = parseToolInput("submit_report", reportUse.input);
      const issues = parsed.ok ? [] : issueLines(parsed.error);
      if (!final) {
        answers.reject(reportUse, "INVALID_REPORT", "fix these issues and call submit_report again.", issues);
        return this.#repairReport(answers, turn);
      }
      answers.reject(reportUse, "INVALID_REPORT", "the report does not match the tool schema.", issues);
      this.#finish(answers, turn);
      return this.#end("incomplete", "report_invalid", `submit_report failed validation: ${issues.join("; ")}`);
    }

    const draft = shape.data;
    this.#submittedDraft = draft;
    this.#notify(() => this.#o.onReportDraft?.(draft, attempt));
    const review = await this.#review(draft, { attempt, final });
    if (review.ok || final) {
      this.#draft = draft;
      answers.accept(reportUse, "REPORT_ACCEPTED");
      this.#finish(answers, turn);
      const when = this.#repairs.report ? "after the repair turn" : "with no response left for a repair turn";
      const reason = review.ok ? null : `accepted with warnings ${when}: ${review.feedback}`.slice(0, 500);
      return this.#end("completed", "report_accepted", reason);
    }
    const message = "fix the issues below and call submit_report once more with the complete report; this is the only repair turn.";
    answers.reject(reportUse, "REPORT_REJECTED", message, review.feedback.split("\n"));
    return this.#repairReport(answers, turn);
  }

  /** Sends the rejection back for the one report repair; the repair is held to turn-3 rules. */
  #repairReport(answers: Answers, turn: AnalystTurn): null {
    this.#repairs.report = true;
    this.#pushUser(this.#finish(answers, turn), [], []);
    this.#turn = 3;
    return null;
  }

  /**
   * max_tokens cut a tool call short (SPEC §4.2): that turn fails and none of its calls run. The
   * turn is asked once more while a response is left; otherwise the run ends incomplete, so the
   * caller still builds the evidence-digest report.
   */
  #truncated(message: Anthropic.Beta.BetaMessage, pendingTools: readonly string[]): AnalystOutcome | null {
    if (this.#repairs.truncated || this.#responses >= this.#o.limits.modelResponses) {
      const detail = `max_tokens with a pending tool_use (${pendingTools.join(", ")}); its tools were not run`;
      return this.#end("incomplete", "max_tokens_pending_tool", detail);
    }
    this.#repairs.truncated = true;
    const turn = this.#turn;
    const uses = toolUses(message);
    // The cut-off response stays in the history: its thinking is bound to it and every tool_use needs a result.
    this.#history.pushAssistant(message);
    for (const use of uses) this.#notify(() => this.#o.onToolStart?.(useOf(use), turn));
    const answers = new Answers(uses);
    for (const use of uses) {
      answers.reject(use, "TOOL_INPUT_TRUNCATED", "the response hit max_tokens before this call was complete; it was not run.");
    }
    this.#pushUser(this.#finish(answers, turn), [], [NOTICE_TRUNCATED]);
    return null;
  }

  /** A known skill with valid input, or null after answering the call with is_error. */
  #parseSkill(use: ToolUseBlock, answers: Answers): AnalystToolCall | null {
    const skill = SkillId.safeParse(use.name);
    if (!skill.success) {
      answers.reject(use, "UNKNOWN_TOOL", `${use.name} is not an available tool.`);
      return null;
    }
    const parsed = parseToolInput(skill.data, use.input);
    if (!parsed.ok) {
      answers.reject(use, "INVALID_INPUT", "the arguments do not match the tool schema; fix them and call again.", issueLines(parsed.error));
      return null;
    }
    return { id: use.id, name: skill.data, input: parsed.input };
  }

  async #execute(calls: AnalystToolCall[], turn: AnalystTurn, answers: Answers): Promise<void> {
    if (calls.length === 0) return;
    for (const call of calls) {
      const step = stepOf(call.input);
      if (step !== null) this.#stepsRun.add(step);
    }
    const results = await this.#hook("executeTools", () => this.#o.executeTools(calls, turn, this.#control.signal));
    const byId = new Map(results.map((r) => [r.tool_use_id, r]));
    for (const call of calls) answers.executed(call.id, byId.get(call.id));
  }

  #findingExists(id: FindingId): boolean {
    try {
      return this.#o.findingExists(id);
    } catch (err) {
      throw new HookFailed("findingExists", err);
    }
  }

  /** The caller's CHECKER, or without one the contracts' limits (V1 formats, V9) under the same rule. */
  async #review(draft: ReportDraftShape, context: ReportReviewContext): Promise<ReportReview> {
    const review = this.#o.reviewReport;
    if (review) return this.#hook("reviewReport", () => review(draft, context, this.#control.signal));
    const parsed = parseToolInput("submit_report", draft);
    return parsed.ok ? { ok: true } : { ok: false, feedback: issueLines(parsed.error).join("\n") };
  }

  /**
   * The message that closes turn 1 or 2: results, the turn's context, the context written for the
   * decided next turn, notices, then the next turn's guide.
   */
  async #closeTurn(results: ToolResultBlock[], closed: 1 | 2): Promise<void> {
    const { turnContext, closingContext } = this.#o;
    const context = turnContext ? await this.#hook("turnContext", () => turnContext(closed, this.#control.signal)) : [];
    this.#checkClock();
    // With one response left, or after a wrap-up notice, there is room only for the report.
    const next: AnalystTurn = closed === 2 || this.#wrapUp || this.#o.limits.modelResponses - this.#responses <= 1 ? 3 : 2;
    const closing = closingContext ? await this.#hook("closingContext", () => closingContext(closed, next)) : [];
    this.#pushUser(results, [...context, ...closing], [next === 2 ? turn2Guide(this.#o.limits) : TURN3_NOTICE]);
    this.#turn = next;
  }

  /** tool_result blocks first (an API rule), then text: context, pending notices, closing guidance. */
  #pushUser(results: ToolResultBlock[], context: readonly string[], closing: readonly string[]): void {
    this.#checkClock();
    const texts = [...context, ...this.#notices.splice(0), ...closing].filter((t) => t.trim() !== "");
    this.#history.push({ role: "user", content: [...results, ...texts.map((text) => ({ type: "text" as const, text }))] });
  }

  /** The soft wall-clock nudge: once, on the next message after softMs. */
  #checkClock(): void {
    if (this.#nudges.time || this.#elapsed() < this.#o.limits.softMs) return;
    this.#nudges.time = true;
    this.#wrapUp = true;
    this.#notices.push(NOTICE_TIME);
  }

  /** Fires onToolEnd for every call of the response and returns their tool_result blocks in call order. */
  #finish(answers: Answers, turn: AnalystTurn): ToolResultBlock[] {
    return answers.uses.map((use) => {
      const a = answers.get(use);
      if (a.code !== null) this.#rejections.push({ toolCallId: use.id, tool: use.name, code: a.code, turn });
      this.#notify(() =>
        this.#o.onToolEnd?.({ use: useOf(use), turn, ok: !a.isError, code: a.code, content: a.content, executed: a.executed }),
      );
      return { type: "tool_result", tool_use_id: use.id, content: a.content, ...(a.isError ? { is_error: true } : {}) };
    });
  }

  /** Awaits a caller hook while watching the run's stop signal; sync throws become rejections. */
  async #hook<T>(name: string, fn: () => T | PromiseLike<T>): Promise<T> {
    try {
      return await this.#control.race(Promise.resolve().then(fn));
    } catch (err) {
      if (err instanceof RunStopped) throw err;
      if (this.#control.cause !== null) throw new RunStopped(this.#control.cause);
      throw new HookFailed(name, err);
    }
  }

  #notify(fn: () => void): void {
    try {
      fn();
    } catch {
      // Observers are fire-and-forget: a UI or persistence bug must not break the model loop.
    }
  }

  #elapsed(): number {
    return this.#now() - this.#startedAt;
  }

  #spent(): number {
    return this.#usd + this.#unmeteredUsd;
  }

  #stopped(cause: StopCause): AnalystOutcome {
    return cause === "cancelled"
      ? this.#end("cancelled", "cancelled", "the run was cancelled")
      : this.#end("incomplete", "wall_clock", `stopped at the hard wall-clock limit of ${Math.round(this.#o.limits.hardMs / 1000)} s`);
  }

  #end(status: AnalystStatus, code: AnalystStopCode, reason: string | null): AnalystOutcome {
    return {
      status,
      code,
      reason,
      plan: this.#plan,
      submittedPlan: this.#submittedPlan,
      draft: this.#draft,
      submittedDraft: this.#submittedDraft,
      model: this.#config.model,
      responses: this.#responses,
      turn: this.#turn,
      usage: this.#usage,
      usd: this.#usd,
      unmeteredUsd: this.#unmeteredUsd,
      refusal: this.#refusal,
      error: this.#error,
      nudges: { ...this.#nudges },
      repairs: { ...this.#repairs },
      pivots: [...this.#pivots],
      rejections: [...this.#rejections],
      elapsedMs: this.#elapsed(),
    };
  }
}
