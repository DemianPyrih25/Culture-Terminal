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
  FollowupLead,
  ReportReview,
  ReportReviewContext,
} from "../analyst";
import { ANALYST_CONFIGS, ANALYST_MAX_TOKENS, type AnalystModelConfig, type AnalystRequest, type AnalystStream } from "../anthropic";
import {
  addTokenUsage,
  affordableMaxTokens,
  emptyTokenUsage,
  estimateRequestUsd,
  tokenUsageOf,
  unreportedOutputTokens,
  unreportedOutputUsd,
  usdFor,
  type StreamedSoFar,
} from "../pricing";
import { Answers } from "./answers";
import { describeLlmError, type LlmErrorInfo } from "./errors";
import { decodeInputEscapes } from "./escapes";
import { History } from "./history";
import { NoteCoalescer } from "./notes";
import { readSkillInput } from "./inputs";
import {
  citableLine,
  FOLLOWUP_NUDGE,
  FOLLOWUP_NUDGE_ASK,
  FOLLOWUP_NUDGE_COMPANION,
  followupsLine,
  issueLines,
  NOTICE_COST,
  NOTICE_FOLLOWUP_OPEN,
  NOTICE_INVALID_JSON,
  NOTICE_TIME,
  NOTICE_TRUNCATED,
  NOTICE_TURN2_OPEN,
  NUDGE_PLAN,
  NUDGE_REPORT,
  planAck,
  TURN3_NOTICE,
  turn2Guide,
} from "./notices";
import { analystPrefix, buildAnalystRequest, promptChars, type AnalystPrefix } from "./request";
import { RunControl, RunStopped, type StopCause } from "./run-control";
import { classifyStop, toolUses, type LlmRefusal } from "./stop";
import { receivedLine, responseUpTo, StreamTap, unparsedToolUse } from "./unparsed";

type BetaMessage = Anthropic.Beta.BetaMessage;
type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type ToolResultBlock = Anthropic.Beta.BetaToolResultBlockParam;
type RawEvent = Anthropic.Beta.BetaRawMessageStreamEvent;

/**
 * The smallest max_tokens the cost guard will send. Below it a medium-effort turn risks max_tokens
 * with a pending tool_use, so the run stops at the cap instead (tools/llm-bench smoke settings).
 */
export const ANALYST_MIN_MAX_TOKENS = 8000;

/** At most this many follow-ups are listed when turn 1 closes (FOLLOW-UPS WORTH RUNNING). */
export const FOLLOWUP_LEADS_MAX = 3;

/**
 * Responses that must be left for the follow-up nudge (on a turn-2 report or after turn-2 planned
 * steps) or a turn 2 kept open after refused input or a call that was not valid JSON: the follow-up,
 * the report and the CHECKER repair, so a second chance at a pivot never costs the repair.
 */
export const SECOND_CHANCE_RESPONSES = 3;

/** A request that ended without its final message: the error, the message streamed until then, how long it ran and what it showed. */
interface Failed {
  ok: false;
  error: unknown;
  partial: BetaMessage | null;
  ms: number;
  tap: StreamTap;
}

/** How one request ended: its final message, or how it failed. */
type Sent = { ok: true; message: BetaMessage } | Failed;

/** A tool_use whose input the SDK could not parse, with the issue line that shows the model what it sent. */
interface Unparsed {
  use: ToolUseBlock;
  issues: readonly string[];
}

/** Where a failed request leaves the run: ended, the same request again, or a response rebuilt around an unparsed call. */
type AfterFailure =
  | { kind: "end"; outcome: AnalystOutcome }
  | { kind: "retry" }
  | { kind: "rebuilt"; message: BetaMessage; unparsed: Unparsed };

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
/** A finding id as prose writes it ("F2"), for the decline an open question writes. */
const FINDING_ID_RE = /\bF[1-9]\d*\b/g;

const INVALID_JSON_RESEND = "the tool input was not valid JSON; send the call again.";
const INVALID_JSON_CLOSED = "the tool input was not valid JSON, so it did not run; only submit_report is left.";

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
  readonly #nudges = { plan: false, report: false, time: false, cost: false, followup: false };
  readonly #repairs = { plan: false, report: false, truncated: false, invalidJson: false, input: false };
  /**
   * The leads FOLLOW-UPS WORTH RUNNING listed when turn 1 closed, none when it did not go out: a turn-2
   * report without a follow-up gets the nudge, unless it already declines them in writing.
   */
  #listedLeads: readonly FollowupLead[] = [];
  /** The tool of every opening-scan call, read when turn 1 closes (AnalystOptions.scanTools). */
  #scanTools: readonly SkillId[] = [];
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

      const sent = await this.#send(request);
      let message: BetaMessage;
      let unparsed: Unparsed | null = null;
      if (sent.ok) {
        message = sent.message;
        this.#charge(message.usage);
      } else {
        const next = this.#afterFailure(sent, request.max_tokens);
        if (next.kind === "end") return next.outcome;
        if (next.kind === "retry") continue;
        ({ message, unparsed } = next);
      }

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
        const outcome = await this.#handle(toolUses(message), unparsed);
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

  /**
   * One streamed request. Never rejects: a failure comes back with the message the stream held by
   * then, how long it ran and what its raw events showed.
   */
  async #send(request: AnalystRequest): Promise<Sent> {
    this.#responses++;
    const sentAt = this.#now();
    // Besides the run's stop, a request of its own: the SDK keeps reading a stream it has given up
    // on, so a failed one is aborted and its generation stops instead of running on, billed and unread.
    const own = new AbortController();
    const tap = new StreamTap();
    let stream: AnalystStream | undefined;
    try {
      stream = this.#o.client.beta.messages.stream(request, { signal: AbortSignal.any([this.#control.signal, own.signal]) });
      stream.on("thinking", (delta, snapshot) => this.#notes.push(delta, snapshot));
      stream.on("streamEvent", (event: RawEvent) => tap.add(event));
      return { ok: true, message: await this.#control.race(stream.finalMessage()) };
    } catch (error) {
      own.abort();
      const held = stream?.currentMessage;
      const partial = held === undefined ? null : { ...held, content: [...held.content], usage: { ...held.usage } };
      return { ok: false, error, partial, ms: this.#now() - sentAt, tap };
    } finally {
      this.#notes.flush();
    }
  }

  /**
   * A request that ended without a final message. A stop ends the run. The SDK's error for a tool
   * input it could not parse (llm/unparsed.ts) gets one repair, like a max_tokens cut: the response
   * streamed up to that call goes back with the call answered INVALID_JSON and the turn goes on, or,
   * when that response cannot be sent back, the request is issued again; a second such error ends
   * the run incomplete. Any other client-side SDK error, such as a dropped stream, leaves no
   * tool_use to answer and is re-issued once. Every typed API error fails the run.
   */
  #afterFailure(failed: Failed, maxTokens: number): AfterFailure {
    const { error, partial } = failed;
    const info = describeLlmError(error);
    const stopped = this.#control.cause;
    this.#chargeFailed(partial, maxTokens, { ms: failed.ms, chars: failed.tap.chars }, stopped !== null || info.maybeBilled);
    if (stopped !== null) return { kind: "end", outcome: this.#stopped(stopped) };

    const use = partial === null ? null : unparsedToolUse(error, partial);
    if (partial !== null && use !== null) {
      if (this.#repairs.invalidJson) {
        const reason = `a second tool input that was not valid JSON (${use.name}); that response was not run`;
        return { kind: "end", outcome: this.#end("incomplete", "invalid_tool_json", reason) };
      }
      this.#repairs.invalidJson = true;
      const message = responseUpTo(partial);
      if (message === null) return { kind: "retry" };
      this.#notices.push(NOTICE_INVALID_JSON);
      // The unparsed call is the snapshot's last block, so its index is the last one.
      const received = receivedLine(failed.tap.inputText(partial.content.length - 1));
      return { kind: "rebuilt", message, unparsed: { use, issues: received === null ? [] : [received] } };
    }
    if (info.retryTurn && !this.#retriedAfterSdkError) {
      this.#retriedAfterSdkError = true;
      return { kind: "retry" };
    }
    this.#error = info;
    return { kind: "end", outcome: this.#end("failed", "api_error", `${info.kind}${info.status === null ? "" : ` (${info.status})`}: ${info.message}`) };
  }

  /**
   * Charges a request that ended without a final message. Once the stream reported usage (it comes
   * with message_start, so the prompt side is exact), that usage is metered, and only the output no
   * report showed is estimated (unreportedOutputTokens: what the stream could generate in the time it
   * ran, within the rest of max_tokens), since a failed stream rarely delivers message_delta's final
   * count. A request that reported none is charged its worst case when it may have been billed at all.
   */
  #chargeFailed(partial: BetaMessage | null, maxTokens: number, streamed: StreamedSoFar, maybeBilled: boolean): void {
    if (partial !== null) {
      // message_delta sets the stop reason and the final usage; once it arrived, nothing is unreported.
      const unreported = partial.stop_reason === null ? unreportedOutputTokens(partial.usage, maxTokens, streamed) : 0;
      this.#unmeteredUsd += unreportedOutputUsd(this.#config.model, partial.usage, unreported);
      this.#charge(partial.usage);
    } else if (maybeBilled) {
      this.#unmeteredUsd += this.#pendingEstimate;
    }
  }

  #charge(reported: Anthropic.Beta.BetaUsage): void {
    const model = this.#config.model;
    const usd = usdFor(model, reported);
    const usage = tokenUsageOf(reported);
    this.#usd += usd;
    this.#usage = addTokenUsage(this.#usage, usage);
    this.#notify(() => this.#o.onUsage?.(usage, usd, model));
    if (!this.#nudges.cost && this.#spent() >= this.#o.limits.usdNudge) {
      this.#nudges.cost = true;
      this.#wrapUp = true;
      this.#notices.push(NOTICE_COST);
    }
  }

  /**
   * Answers every tool_use of a response. An `unparsed` call (its input was not valid JSON) is
   * answered INVALID_JSON with the text it sent, and the rest are handled as the turn's rules say.
   * Turn 1 with nothing else in the response is asked again, since no plan was accepted yet. A
   * turn-2 submit_report may get the follow-up nudge before any review.
   */
  async #handle(uses: ToolUseBlock[], unparsed: Unparsed | null): Promise<AnalystOutcome | null> {
    const turn = this.#turn;
    for (const use of uses) this.#notify(() => this.#o.onToolStart?.(useOf(use), turn));
    const answers = new Answers(uses);
    if (unparsed) this.#answerUnparsed(answers, unparsed, true);
    const readable = unparsed === null ? uses : uses.filter((u) => u !== unparsed.use);
    if (unparsed && readable.length === 0 && turn === 1) {
      this.#pushUser(this.#finish(answers, turn), [], []);
      return null;
    }
    const report = turn === 1 ? undefined : readable.find((u) => u.name === "submit_report");
    if (report) {
      if (turn === 2 && unparsed === null && (await this.#nudgeFollowup(readable, report, answers))) return null;
      if (unparsed) this.#answerUnparsed(answers, unparsed, false);
      return this.#report(readable, report, answers);
    }
    if (turn === 1) return this.#turnOne(readable, answers, unparsed?.use.name === "submit_plan");
    if (turn === 2) return this.#turnTwo(readable, answers, unparsed);
    return this.#turnThree(readable, answers, unparsed);
  }

  /** INVALID_JSON for an unparsed call: send it again (`resend`), or only submit_report is left. */
  #answerUnparsed(answers: Answers, unparsed: Unparsed, resend: boolean): void {
    answers.reject(unparsed.use, "INVALID_JSON", resend ? INVALID_JSON_RESEND : INVALID_JSON_CLOSED, unparsed.issues);
  }

  /**
   * Turn 1: submit_plan plus wave-1 tools. Without a valid plan, data is held back for one nudge or
   * repair; a submit_plan that was not valid JSON holds it back under its INVALID_JSON repair.
   */
  async #turnOne(uses: ToolUseBlock[], answers: Answers, planUnparsed: boolean): Promise<AnalystOutcome | null> {
    const planUse = uses.find((u) => u.name === "submit_plan");
    const planIssues = planUse ? this.#takePlan(planUse, answers) : null;
    const resend = planUse === undefined && planUnparsed;
    const missing = planUse === undefined && !planUnparsed;
    const holdBack = resend || (missing ? !this.#nudges.plan : planIssues !== null && !this.#repairs.plan);
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
      else if (!resend) this.#repairs.plan = true;
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
    const input = decodeInputEscapes(use.input);
    const shape = SubmitPlanInputShape.safeParse(input);
    const parsed = parseToolInput("submit_plan", input);
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
   * report nudge. After a call that was not valid JSON (`unparsed`), turn 2 stays open for it while
   * follow-ups are still allowed (no wrap-up notice) and SECOND_CHANCE_RESPONSES are left, so sending
   * it again never costs the CHECKER repair; otherwise it closes, and the call's answer says that only
   * submit_report is left. A response
   * whose calls were all refused for their input keeps turn 2 open once, with NOTICE_TURN2_OPEN,
   * while no wrap-up notice went out and SECOND_CHANCE_RESPONSES are left. A response that ran
   * planned steps but no follow-up may keep it open for the follow-up nudge (#nudgeAfterSteps).
   */
  async #turnTwo(uses: ToolUseBlock[], answers: Answers, unparsed: Unparsed | null): Promise<AnalystOutcome | null> {
    if (uses.length === 0 && unparsed === null) return this.#nudgeReport(answers);
    const calls: AnalystToolCall[] = [];
    let citable: string | undefined;
    const cite = (): string => (citable ??= this.#citable());
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
        else answers.reject(use, "UNTRIGGERED_FOLLOWUP", `${refusal}${cite()}`);
      } else if (!this.#findingExists(trigger)) {
        answers.reject(use, "UNTRIGGERED_FOLLOWUP", `${trigger} is not a finding of this run.${cite()}`);
      } else {
        const pivot: AnalystPivot = {
          toolCallId: call.id,
          tool: call.name,
          triggerFindingId: trigger,
          args: call.input,
          afterNudge: this.#nudges.followup,
        };
        this.#pivots.push(pivot);
        this.#notify(() => this.#o.onPivot?.(pivot));
        calls.push(call);
      }
    }
    await this.#execute(calls, 2, answers);
    this.#checkClock();
    const left = this.#o.limits.modelResponses - this.#responses;
    const open = unparsed !== null && !this.#wrapUp && left >= SECOND_CHANCE_RESPONSES;
    // Every call that did not run was refused for its input (UNKNOWN_TOOL, INVALID_INPUT or
    // UNTRIGGERED_FOLLOWUP); a lone submit_plan is no follow-up to correct.
    const refused = calls.length === 0 && uses.some((u) => u.name !== "submit_plan");
    const reopen = !open && refused && !this.#repairs.input && !this.#wrapUp && left >= SECOND_CHANCE_RESPONSES;
    if (unparsed && !open) this.#answerUnparsed(answers, unparsed, false);
    const results = this.#finish(answers, 2);
    if (open || reopen) {
      if (reopen) this.#repairs.input = true;
      this.#pushUser(results, [], reopen ? [NOTICE_TURN2_OPEN] : []);
      return null;
    }
    // Calls ran and none was a pivot (#nudgeLeads checks), so they were planned steps.
    if (unparsed === null && calls.length > 0 && (await this.#nudgeAfterSteps(results))) return null;
    await this.#closeTurn(results, 2);
    return null;
  }

  /** The findings a refused follow-up could cite (AnalystOptions.findings); nothing without the hook. */
  #citable(): string {
    const { findings } = this.#o;
    if (!findings) return "";
    try {
      return citableLine(findings());
    } catch (err) {
      throw new HookFailed("findings", err);
    }
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
    const planned = this.#planSteps().find((s) => s.id === step);
    if (planned === undefined) return `${step} is not a step of the plan; a follow-up ${CITE_FINDING}.`;
    if (this.#stepsRun.has(step) || pending.some((c) => stepOf(c.input) === step)) {
      return `${step} has already run; running it again is a follow-up that ${CITE_FINDING}.`;
    }
    if (planned.tool !== call.name) return `${step} plans ${planned.tool}, not ${call.name}; a follow-up ${CITE_FINDING}.`;
    return null;
  }

  /** The steps of the plan the run proceeds with: the checked plan, else the last well-formed one. */
  #planSteps(): readonly { id: string; tool: SkillId }[] {
    return (this.#plan ?? this.#submittedPlan)?.steps ?? [];
  }

  /**
   * Turn 3: submit_report is the only call; anything else is refused and costs the report nudge,
   * unless the response also held a call that was not valid JSON (`unparsed`): that response was
   * cut short, so turn 3 is asked again under its INVALID_JSON repair instead, and only an unparsed
   * submit_report is asked for again.
   */
  #turnThree(uses: ToolUseBlock[], answers: Answers, unparsed: Unparsed | null): AnalystOutcome | null {
    for (const use of uses) answers.reject(use, "INVESTIGATION_BUDGET_EXHAUSTED", "turn 3 allows only submit_report.");
    if (unparsed === null) return this.#nudgeReport(answers);
    if (unparsed.use.name !== "submit_report") this.#answerUnparsed(answers, unparsed, false);
    this.#pushUser(this.#finish(answers, 3), [], []);
    return null;
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
   * The leads the follow-up nudge restates, asked as things now stand, or none when the nudge cannot
   * be sent: it went out already, a follow-up ran (an ANALYST PIVOT), a wrap-up notice went out,
   * fewer than SECOND_CHANCE_RESPONSES are left, or the run's time or cost cannot carry them
   * (#secondChanceFits).
   */
  async #nudgeLeads(): Promise<FollowupLead[]> {
    this.#checkClock();
    if (this.#nudges.followup || this.#pivots.length > 0 || this.#wrapUp) return [];
    if (this.#o.limits.modelResponses - this.#responses < SECOND_CHANCE_RESPONSES || !this.#secondChanceFits()) return [];
    return this.#followupLeads();
  }

  /**
   * Whether the follow-up, the report and its repair still fit once the nudge goes out: the follow-up's
   * Qloo time (followupMs) inside the soft window, and the repair's request, at its worst case on the
   * floor of max_tokens, within usdHard after the two responses before it cost what this run's
   * responses have cost on average. A nudge without that room could turn a complete report into an
   * INCOMPLETE digest at the wall clock or the cost cap. Three worst cases are not asked for: at a live
   * prompt's size they pass the cap, so the nudge could never go out.
   */
  #secondChanceFits(): boolean {
    const { limits } = this.#o;
    if (this.#elapsed() > limits.softMs - limits.followupMs) return false;
    const chars = promptChars(buildAnalystRequest(this.#config, this.#prefix, this.#history.snapshot()));
    const average = this.#spent() / Math.max(1, this.#responses);
    const repair = estimateRequestUsd(this.#config.model, chars, ANALYST_MIN_MAX_TOKENS);
    return limits.usdHard - this.#spent() - (SECOND_CHANCE_RESPONSES - 1) * average >= repair;
  }

  /**
   * Whether a turn-2 submit_report already declines the listed follow-ups in writing, as the TURN 2
   * guide allows: one of its open questions names a listed lead's finding (F#). That decline is the
   * model's call, so the nudge does not override it.
   */
  #declinesLeads(reportUse: ToolUseBlock): boolean {
    const draft = ReportDraftShape.safeParse(reportUse.input);
    if (!draft.success) return false;
    const listed = new Set<string>(this.#listedLeads.map((lead) => lead.findingId));
    return draft.data.open_questions.some((q) => (q.match(FINDING_ID_RE) ?? []).some((id) => listed.has(id)));
  }

  /**
   * The follow-up nudge, once per run: a turn-2 submit_report sent while FOLLOW-UPS WORTH RUNNING
   * were listed and no follow-up has run is answered FOLLOWUP_EXPECTED with the leads as they now
   * stand, and the model picks one, or says why none could and submits again. The calls made with it
   * do not run, and turn 2 stays open. Sent only when a lead is left (#nudgeLeads) and the report does
   * not already decline the listed leads in writing (#declinesLeads). Returns whether it was sent.
   */
  async #nudgeFollowup(uses: readonly ToolUseBlock[], reportUse: ToolUseBlock, answers: Answers): Promise<boolean> {
    if (this.#listedLeads.length === 0 || this.#declinesLeads(reportUse)) return false;
    const leads = await this.#nudgeLeads();
    if (leads.length === 0) return false;
    this.#nudges.followup = true;
    for (const use of uses) {
      if (use === reportUse) continue;
      if (use.name === "submit_report") answers.reject(use, "DUPLICATE_SUBMISSION", "submit_report was already called in this response.");
      else answers.reject(use, "REPORT_SUBMITTED", FOLLOWUP_NUDGE_COMPANION);
    }
    const line = followupsLine(leads, this.#plan ?? this.#submittedPlan, this.#openSteps());
    answers.reject(reportUse, "FOLLOWUP_EXPECTED", FOLLOWUP_NUDGE, [line, FOLLOWUP_NUDGE_ASK]);
    this.#pushUser(this.#finish(answers, 2), [], []);
    return true;
  }

  /**
   * The same follow-up nudge for a turn-2 response that ran planned steps but no follow-up: instead of
   * closing turn 2, its results go back with the leads as they now stand (those turn 1 listed and any
   * the steps just raised, within the follow-up calls left) and NOTICE_FOLLOWUP_OPEN, and turn 2 stays
   * open for one response. The model runs the follow-up it judges worth it or submits, saying why none
   * could. A planned step spends the turn's one response, so without this a lead it leaves standing,
   * or one it raises, could never be followed. Returns whether it was sent.
   */
  async #nudgeAfterSteps(results: ToolResultBlock[]): Promise<boolean> {
    const leads = await this.#nudgeLeads();
    if (leads.length === 0) return false;
    this.#nudges.followup = true;
    const line = followupsLine(leads, this.#plan ?? this.#submittedPlan, this.#openSteps());
    this.#pushUser(results, [line], [NOTICE_FOLLOWUP_OPEN]);
    return true;
  }

  /**
   * submit_report: the structure strict mode guarantees, then the CHECKER review (V1–V10, limits
   * included). One repair turn; after it, or when no response is left for one, the draft is accepted
   * with warnings (SPEC §6.2).
   */
  async #report(uses: ToolUseBlock[], reportUse: ToolUseBlock, answers: Answers): Promise<AnalystOutcome | null> {
    const turn = this.#turn;
    for (const use of uses) {
      if (use === reportUse) continue;
      if (use.name === "submit_report") answers.reject(use, "DUPLICATE_SUBMISSION", "submit_report was already called in this response.");
      else if (turn === 3) answers.reject(use, "INVESTIGATION_BUDGET_EXHAUSTED", "turn 3 allows only submit_report; this call was not run.");
      else answers.reject(use, "REPORT_SUBMITTED", "calls made together with submit_report are not run.");
    }
    const attempt: 1 | 2 = this.#repairs.report ? 2 : 1;
    const final = this.#repairs.report || this.#responses >= this.#o.limits.modelResponses;

    const input = decodeInputEscapes(reportUse.input);
    const shape = ReportDraftShape.safeParse(input);
    if (!shape.success) {
      // Strict mode should never send this; without the structure there is nothing to assemble.
      const parsed = parseToolInput("submit_report", input);
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

  /**
   * A known skill with valid input, or null after answering the call with is_error. INVALID_INPUT
   * names each field, what it takes and what was sent (llm/inputs.ts, which also unwraps an id sent
   * inside an extra pair of quotes), for the schema and then for the run's own checks (checkInput).
   */
  #parseSkill(use: ToolUseBlock, answers: Answers): AnalystToolCall | null {
    const skill = SkillId.safeParse(use.name);
    if (!skill.success) {
      answers.reject(use, "UNKNOWN_TOOL", `${use.name} is not an available tool.`);
      return null;
    }
    const read = readSkillInput(skill.data, use.input);
    if (!read.ok) {
      answers.reject(use, "INVALID_INPUT", "the arguments do not match the tool schema; fix them and call again.", read.issues);
      return null;
    }
    const issues = this.#checkInput(skill.data, read.input);
    if (issues.length > 0) {
      answers.reject(use, "INVALID_INPUT", "the arguments name ids this run does not have; fix them and call again.", issues);
      return null;
    }
    return { id: use.id, name: skill.data, input: read.input };
  }

  /** The caller's run-level input checks (AnalystOptions.checkInput); none without the hook. */
  #checkInput(tool: SkillId, input: unknown): readonly string[] {
    const { checkInput } = this.#o;
    if (!checkInput) return [];
    try {
      return checkInput(tool, input);
    } catch (err) {
      throw new HookFailed("checkInput", err);
    }
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
   * decided next turn, the follow-ups worth running when turn 2 is next, notices, then the next
   * turn's guide, which says when a plan step still to run shares the follow-up calls.
   */
  async #closeTurn(results: ToolResultBlock[], closed: 1 | 2): Promise<void> {
    const { turnContext, closingContext, scanTools } = this.#o;
    const context = turnContext ? await this.#hook("turnContext", () => turnContext(closed, this.#control.signal)) : [];
    if (closed === 1 && scanTools) this.#scanTools = await this.#hook("scanTools", () => scanTools());
    this.#checkClock();
    // With one response left, or after a wrap-up notice, there is room only for the report.
    const next: AnalystTurn = closed === 2 || this.#wrapUp || this.#o.limits.modelResponses - this.#responses <= 1 ? 3 : 2;
    const closing = closingContext ? await this.#hook("closingContext", () => closingContext(closed, next)) : [];
    const leads = next === 2 ? await this.#followupLeads() : [];
    this.#listedLeads = leads;
    const open = this.#openSteps();
    const followups = leads.length === 0 ? [] : [followupsLine(leads, this.#plan ?? this.#submittedPlan, open)];
    const guide = next === 2 ? turn2Guide(this.#o.limits, { followups: leads.length > 0, stepsPending: open.length > 0 }) : TURN3_NOTICE;
    this.#pushUser(results, [...context, ...closing, ...followups], [guide]);
    this.#turn = next;
  }

  /**
   * The caller's follow-up leads, those whose tool tests a hypothesis first, otherwise in the
   * caller's order, at most FOLLOWUP_LEADS_MAX. A lead whose tool a plan step still to run plans is
   * kept (followupsLine names the step, so the finding-driven call replaces it), unless it names no
   * subjects: then it cannot be told apart from the step, which runs in turn 2 anyway.
   */
  async #followupLeads(): Promise<FollowupLead[]> {
    const { followupLeads } = this.#o;
    if (!followupLeads) return [];
    const leads = await this.#hook("followupLeads", () => followupLeads());
    const open = this.#openSteps();
    const tests = new Set<string>(((this.#plan ?? this.#submittedPlan)?.hypotheses ?? []).map((h) => h.test_tool));
    const rank = (lead: FollowupLead): number => (tests.has(lead.tool) ? 0 : 1);
    return leads
      .filter((lead) => lead.subjects.length > 0 || !open.some((s) => s.tool === lead.tool))
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, FOLLOWUP_LEADS_MAX);
  }

  /** The plan steps no call has carried out yet: the planned-step rule reads these. */
  #pendingSteps(): readonly { id: string; tool: SkillId }[] {
    const ran: ReadonlySet<string> = this.#stepsRun;
    return this.#planSteps().filter((s) => !ran.has(s.id));
  }

  /**
   * The pending steps less those the opening scan carried out, for what the loop tells the model:
   * each scan call covers the first pending step that plans its tool, since a plan often names scan
   * calls as steps. A covered step can still run once under its step_id (#notPlannedStep).
   */
  #openSteps(): readonly { id: string; tool: SkillId }[] {
    const scanned = [...this.#scanTools];
    return this.#pendingSteps().filter((step) => {
      const i = scanned.indexOf(step.tool);
      if (i >= 0) scanned.splice(i, 1);
      return i < 0;
    });
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
