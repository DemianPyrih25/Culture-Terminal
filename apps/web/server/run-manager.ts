import "server-only";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_RUN_LIMITS,
  placeSearchMarket,
  queueTimeoutReason,
  reduceRunEvents,
  Report,
  RUN_QUEUE_DEFAULTS,
  RUN_QUEUE_FULL_MESSAGE,
  RunEvent,
  stampEvent,
  type ErrorCode,
  type EventInput,
  type Intent,
  type Lane,
  type QlooSearchEntity,
  type RunState,
  type TerminalRunStatus,
  type TokenUsage,
} from "@ct/contracts";
import {
  ANALYST_CONFIGS,
  buildCaseSummary,
  findPickerChoice,
  runAgent,
  sanitizeQuestion,
  type AgentRunOptions,
  type AgentRunResult,
  type AnalystMode,
  type AnthropicLike,
  type ContextCache,
  type SideConfig,
} from "@ct/agent";
import {
  clearIpHashes,
  countRunsSince,
  createRun,
  getRun,
  incrementQlooUsage,
  insertLedgerSnapshot,
  isCancelRequested,
  lockRun,
  markStarted,
  purgeRuns,
  setFollowLatestRun,
  setPending,
  setStatus,
  updateRun,
  type LedgerSnapshotInput,
  type Queryable,
  type RunPatch,
  type RunStatus,
} from "@ct/db";
import type { PublicDataClient } from "@ct/publicdata";
import type { QlooClient } from "@ct/qloo";
import { normaliseName, searchParams } from "@ct/quant";
import { utcDay } from "@ct/qloo";
import { z } from "zod";
import { laneModeOf, type LaneMode } from "./breakers";
import { sideConfigFromEnv, visitorLimitsFromEnv } from "./config";
import type { EventBus } from "./event-bus";
import { appendRunEvent, readAllEvents, readEventAt, readLastEvent, sameEvent } from "./event-store";
import { buildFakeScript, FAKE_MODEL, FAKE_QUESTION } from "./fake-script";
import { CONTEXT_AI_USD_METRIC, CONTEXT_WEB_USD_METRIC, preRunUsd, SpendMeter, todayLlmUsd, WEB_SEARCHES_METRIC } from "./llm-spend";
import { kvLocalities } from "./localities";
import { log } from "./log";
import { RunQueue, type TakenRun } from "./queue";
import { QUESTION_HASH_PREFIX, questionHash } from "./question-hash";
import { countLaneRunsSince } from "./run-counts";
import { VISITOR_HASH_RETENTION_MS, visitorWait, visitorWaitMessage, type VisitorLimits } from "./visitor-limits";

/**
 * not_accepting: draining for a restart (503, retry). busy: no free slot and no room in the queue (429,
 * retry soon). limited:
 * an hourly cap, or the rest of today's budget is held by runs in progress (429, not soon; see
 * retryAfterS). budget: today's LLM budget is spent (503, not before 00:00 UTC). unavailable: live
 * runs are switched off or not configured (503). invalid: the request itself is wrong (400).
 */
export type RunManagerErrorCode = "not_accepting" | "busy" | "limited" | "budget" | "unavailable" | "invalid";
const ERROR_CODES: ReadonlySet<string> = new Set<RunManagerErrorCode>([
  "not_accepting",
  "busy",
  "limited",
  "budget",
  "unavailable",
  "invalid",
]);

export class RunManagerError extends Error {
  readonly code: RunManagerErrorCode;
  /** Seconds before a retry can succeed, when the refusal knows. */
  readonly retryAfterS: number | null;
  constructor(code: RunManagerErrorCode, message: string, retryAfterS: number | null = null) {
    super(message);
    this.name = "RunManagerError";
    this.code = code;
    this.retryAfterS = retryAfterS;
  }
}

function isRunManagerError(err: unknown): err is { code?: unknown; retryAfterS?: unknown } {
  return typeof err === "object" && err !== null && (err as { name?: unknown }).name === "RunManagerError";
}

/**
 * Reads the code by name rather than `instanceof`: Next.js may bundle this module once per route,
 * so the class that threw is not always the class the caller imported.
 */
export function runManagerErrorCode(err: unknown): RunManagerErrorCode | null {
  if (!isRunManagerError(err)) return null;
  const code = err.code;
  return typeof code === "string" && ERROR_CODES.has(code) ? (code as RunManagerErrorCode) : null;
}

/** A RunManagerError's retryAfterS, read by name like its code. */
export function runManagerRetryAfterS(err: unknown): number | null {
  if (!isRunManagerError(err)) return null;
  const s = err.retryAfterS;
  return typeof s === "number" && Number.isFinite(s) && s > 0 ? Math.ceil(s) : null;
}

export const ACTIVE_STATUSES = ["queued", "running"] as const satisfies readonly RunStatus[];

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** Every fake run's question_hash starts with this, so they can be counted and purged together. */
export const FAKE_HASH_PREFIX = "fake:";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
// startFakeRun purges old fake runs, and a visitor's live run clears old visitor hashes, at most this often.
const PURGE_EVERY_MS = 10 * 60_000;

/** Another writer stored a different event at the seq a run loop was about to write. */
class SeqTakenError extends Error {
  constructor(readonly runId: string, readonly seq: number) {
    super(`seq ${seq} of run ${runId} is already taken by another writer`);
    this.name = "SeqTakenError";
  }
}

export const ORPHAN_REASON = "The server stopped before this run finished.";
const STOPS = {
  cancelled: { status: "cancelled", reason: "Cancelled by the viewer." },
  aborted: { status: "incomplete", reason: "The server shut down before this run finished." },
  overran: { status: "incomplete", reason: "The run went past its time limit and was stopped." },
} as const satisfies Record<string, { status: TerminalRunStatus; reason: string }>;
type Stop = keyof typeof STOPS;
type RunEnd = Extract<RunEvent, { type: "run.end" }>;

const AGENT_FAILED_REASON = "The analysis hit an internal error.";
const UNSAVED_REASON = "The run could not be saved.";
/** A minute past the agent's own hard stop (limits.hardMs), the run manager stops it: a stuck run must not hold a slot. */
const AGENT_WATCHDOG_MS = DEFAULT_RUN_LIMITS.hardMs + 60_000;
/**
 * After a stop, runAgent gets this long to return before the run ends without it. Short enough that
 * SIGTERM's drain (SHUTDOWN_GRACE_MS, 180 s) plus this stays inside Render's 200 s shutdown delay.
 */
const AGENT_STOP_GRACE_MS = 10_000;
/** The picker's /search lookup gives up after this; the gate's own call cached the answer. */
const PICK_LOOKUP_MS = 10_000;
/** Ancestors listed in a child run's case summary (§7.3). */
const CHAIN_MAX = 5;
/** Parents a child run may follow up on: runs that stored a note. */
const PARENT_STATUSES: ReadonlySet<string> = new Set<RunStatus>(["completed", "incomplete"]);
const STORED_PINS = z.record(z.string(), z.string()).nullable();
const BUSY_REASON = "Too many runs are active. Try again shortly.";
const NOT_ACCEPTING_REASON = "The server is restarting. Try again in a moment.";
const PAUSED_REASON = "Live analysis is paused. Answers you already have still open.";
const VISITOR_ACTIVE_REASON = "Your last live question is still running. Ask again once it ends.";
const DAILY_REASON = "Today's limit for live runs is reached. Answers you already have still open.";
const JUDGE_DAILY_REASON = "The judge lane's daily limit for live runs is reached. Answers you already have still open.";
const BUDGET_REASON = "Today's budget for live analysis is used up. Live runs resume at 00:00 UTC.";
/** run.end reason of a queued run the server dropped as it drained for a restart. */
export const QUEUE_SHUTDOWN_REASON = "The server restarted before this question could start. Nothing was spent; ask it again in a moment.";

/**
 * Agent-run slots per lane in one process (SPEC §10.4: 3 in all, the judge lane's 1 among them):
 * `total` in all, of which `judge` are held for the judge lane, never every one. Pass 0 for `judge`
 * while the judge lane is closed, so no slot waits for it. A judge run also needs the total to have room.
 */
export function laneSlots(total: number, judge: number): Record<Lane, number> {
  const held = Math.max(0, Math.min(judge, total - 1));
  return { public: total - held, judge: Math.max(0, Math.min(judge, total)) };
}

/** What agent runs take from the process. Getters, so a missing key refuses live runs and nothing else. */
export interface AgentDeps {
  /** The process-wide Qloo client; throws when it cannot be configured (no key outside mock mode). */
  qloo: () => QlooClient;
  /** Null when ANTHROPIC_API_KEY is unset. */
  anthropic: () => AnthropicLike | null;
  /**
   * The process-wide SEC EDGAR and US Census client (Part 9). Absent, or throwing when it cannot be
   * configured, leaves public data off: runs still go, and the company_financials and area_economics
   * tools say plainly that the data is unavailable.
   */
  publicdata?: () => PublicDataClient;
  /**
   * The lane's mode as the breakers decide it (breakers.ts), or a bare mode. replay_only refuses
   * the run with the decision's message.
   */
  mode: (lane: Lane) => Promise<LaneMode>;
  /**
   * The side context calls' settings (R4, R5, D45): "What AI knows" and "From the web". Absent: read from
   * the environment (config.ts sideConfigFromEnv). The run's mode turns web search off in economy.
   */
  side?: SideConfig;
  /**
   * The side blocks' shared cache (context_cache; AI 7 days, web 24 hours). Absent or null: the side
   * calls run uncached. A getter that throws is treated as no cache.
   */
  contextCache?: () => ContextCache | null;
}

/**
 * What the run manager adds to runAgent's options for the side context calls (R4, R5). Kept apart from
 * AgentRunOptions so this file compiles whatever the agent names them; the agent reads `sideConfig` and
 * `contextCache` (Part 11 contract note in the ops handoff).
 */
export interface SideRunOptions {
  sideConfig: SideConfig;
  contextCache: ContextCache | null;
}

export type RunAgentFn = (options: AgentRunOptions & Partial<SideRunOptions>) => Promise<AgentRunResult>;

export interface AgentRunRequest {
  /** The question as the user typed it; it is sanitized (and capped) before anything else sees it. */
  question: string;
  lane: Lane;
  /**
   * Mention → Qloo entity id, for trusted callers only (showcase pins, dev tools); mentions are
   * normalised here. A browser's picker answer goes through answerPicker, which never takes an id.
   */
  pins?: Readonly<Record<string, string>>;
  /** Starts a child run from a finished run's note (next_moves, §7.3). */
  parentRunId?: string | null;
  /**
   * CLERK's reading of this same question from a preview (POST /api/preview): the run skips CLERK.
   * The caller vouches that it belongs to this question; it never comes from the browser.
   */
  intent?: Intent;
  /**
   * The visitor (client-ip.ts clientKey: a salted hash, never the address), recorded on the run as
   * ip_hash and counted by the public lane's per-visitor limits; null or absent for a trusted caller
   * (showcases, dev tools) and when the address is unknown.
   */
  client?: string | null;
}

/** A needs_input picker answer (D20): the waiting run and the opaque key of the chosen candidate. */
export interface PickerAnswer {
  runId: string;
  key: string;
  lane: Lane;
  /** As AgentRunRequest.client. */
  client?: string | null;
}

export interface RunManagerOptions {
  db: Queryable;
  bus: EventBus;
  /** Default length of a fake run. */
  fakeRunSeconds?: number;
  /** Concurrent fake runs this process will hold. Agent runs have their own agentMaxActive slots. */
  fakeMaxActive?: number;
  /** Fake runs any process may start per rolling hour, counted in the database. */
  hourlyCap?: number;
  /** Finished fake runs older than this are purged. */
  retentionMs?: number;
  /** How often a run polls the database cancel flag. */
  cancelPollMs?: number;
  /** Without these, agent runs are refused as unavailable. */
  agent?: AgentDeps;
  /** The agent entry point (default: runAgent from @ct/agent); tests inject a scripted one. */
  runAgent?: RunAgentFn;
  /** Public-lane agent runs any process may start per rolling hour, counted in the database (default 120, D24). */
  agentHourlyCap?: number;
  /** Judge-lane agent runs any process may start per rolling hour, counted apart (default 30, D24). */
  judgeHourlyCap?: number;
  /** Agent runs of both lanes any process may start per rolling 24 hours (default 500, D24 overall). */
  agentDailyCap?: number;
  /** Judge-lane agent runs any process may start per rolling 24 hours (default 120, D24). */
  judgeDailyCap?: number;
  /**
   * Agent runs of both lanes this process holds at once (default 6, D24 global concurrency),
   * judgeMaxActive of them held for the judge lane (laneSlots). They never share fakeMaxActive: anyone
   * may start a test run, and test runs must not be able to take a live run's slot.
   */
  agentMaxActive?: number;
  /** Of agentMaxActive, the slots held for judge-lane runs (default 2, D24); 0 while the judge lane is closed. */
  judgeMaxActive?: number;
  /**
   * Agent runs that may wait for a slot when every one of their lane is busy (D24: 12, RUN_QUEUE_MAX).
   * Default 0: no queue, a run that finds no slot is refused as busy at once.
   */
  queueMax?: number;
  /** How long a queued run waits for a slot before it ends unstarted (D24: 120 s, RUN_QUEUE_WAIT_S). */
  queueWaitMs?: number;
  /** The public lane's per-visitor limits (default from VISITOR_*: 2 at once, 10 an hour, 30 a day, D24). */
  visitorLimits?: VisitorLimits;
  /**
   * The daily LLM breaker in USD. A run starts only while today's spend, plus its pre-run reserve
   * (PRE_RUN_USD, or PRE_RUN_ECONOMY_USD on the economy ANALYST) and that of each run in flight here
   * (less what each has recorded), stays within its lane's cap: llmLaneUsdCap's, else this.
   */
  llmDailyUsdCap?: number;
  /** Per-lane caps (breakers.ts laneBudget): the public lane's leaves the judge lane its reserve. */
  llmLaneUsdCap?: Partial<Record<Lane, number>>;
  /** How long an agent run may go before the manager stops it (default: its hard stop plus a minute). */
  agentWatchdogMs?: number;
  /** After a stop, how long runAgent gets to return before the run ends without it. */
  agentStopGraceMs?: number;
  /** False (QLOO_DISABLED=1) runs every agent run on the fail-closed path with no Qloo call (V7). Default true. */
  qlooEnabled?: boolean;
}

export interface DrainResult {
  /** Runs that ended on their own within the grace period. */
  finished: number;
  /** Runs stopped at the deadline and marked incomplete, and queued runs ended before they started. */
  stopped: number;
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
  kind: "fake" | "agent";
  /** An agent run's lane; null for a test run. */
  lane: Lane | null;
  /** The visitor a public run counts against while it runs (visitor-limits.ts); null when none does. */
  visitor: string | null;
  /** An agent run's spend meter, set once admission passes: from then on its reserve counts. */
  spend: SpendMeter | null;
  /** What the run holds of today's budget until it records its own spend (preRunUsd of its ANALYST). */
  reserveUsd: number;
}

/**
 * An agent run waiting in the queue (D24), from its reserved place to its start or its end. `run` is
 * null until its admission has created the row.
 */
interface QueuedRun {
  runId: string;
  lane: Lane;
  visitor: string | null;
  deps: AgentDeps;
  controller: AbortController;
  done: Promise<void>;
  release: () => void;
  run: AgentRunContext | null;
}

/** How a run that never started ends: cancelled, timed out, refused at its start, or dropped at shutdown. */
interface QueueEnd {
  status: TerminalRunStatus;
  reason: string;
  /** An error event before run.end, for a failure the viewer can retry. */
  code?: ErrorCode;
}

type Settled<T> = { kind: "result"; value: T } | { kind: "threw"; error: unknown } | { kind: "abandoned" };

/**
 * Waits for `promise`. Once `signal` aborts, waits at most `graceMs` more and then gives up on it,
 * so a callee that ignores its signal cannot hold the caller.
 */
function settleWithin<T>(promise: Promise<T>, signal: AbortSignal, graceMs: number): Promise<Settled<T>> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      timer = setTimeout(() => finish({ kind: "abandoned" }), graceMs);
    };
    const finish = (outcome: Settled<T>) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", arm);
      resolve(outcome);
    };
    promise.then(
      (value) => finish({ kind: "result", value }),
      (error: unknown) => finish({ kind: "threw", error }),
    );
    if (signal.aborted) arm();
    else signal.addEventListener("abort", arm, { once: true });
  });
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Attempts per database write that is safe to repeat: an event, the end-of-run row, the ledger. */
const WRITE_ATTEMPTS = 3;

/**
 * Runs a database write that is safe to repeat, and retries a failure 250 ms and then 500 ms later,
 * unless `final` says that error will not change.
 */
async function withRetries<T>(
  what: string,
  context: Record<string, unknown>,
  write: () => Promise<T>,
  final: (err: unknown) => boolean = () => false,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (err) {
      if (final(err) || attempt >= WRITE_ATTEMPTS) throw err;
      log.warn({ err, ...context, attempt }, `${what} failed; retrying`);
      await sleep(250 * 2 ** (attempt - 1));
    }
  }
}

interface EventWriterHooks {
  /** Stores the event; throws SeqTakenError when another writer owns its seq. */
  store(event: RunEvent): Promise<void>;
  publish(event: RunEvent): void;
  /** Bookkeeping after an emitted event is published. */
  afterPublish(event: RunEvent): Promise<void>;
  /** The first failed store; nothing emitted after it is stored. */
  onFailure(err: unknown): void;
}

/**
 * Turns a synchronous emit (runAgent's) into ordered writes. Each event gets the next seq and is
 * validated at once, then stored and published one at a time in emit order. Nothing is stored after
 * a failed write, so the stored events never have a gap, and append() goes on from the last stored seq.
 */
class EventWriter {
  private assigned = 0;
  private storedSeq = 0;
  private tail: Promise<void> = Promise.resolve();
  private closed = false;
  private warnedLate = false;
  private failed: unknown = null;
  private first: string | null = null;

  constructor(
    private readonly runId: string,
    private readonly hooks: EventWriterHooks,
  ) {}

  /** Seq of the last stored event; 0 before the first. */
  get stored(): number {
    return this.storedSeq;
  }

  /** The error of the first failed write, or null. */
  get failure(): unknown {
    return this.failed;
  }

  /** The timestamp of the first event accepted, or null before it. */
  get firstTs(): string | null {
    return this.first;
  }

  readonly emit = (input: EventInput): void => {
    if (this.failed !== null) return;
    if (this.closed) {
      // Once: an agent abandoned after a stop may go on emitting for a while.
      if (!this.warnedLate) log.warn({ runId: this.runId, type: input.type }, "agent events after the run ended; dropped");
      this.warnedLate = true;
      return;
    }
    // run.end belongs to the run manager, which writes it from the returned status.
    if (input.type === "run.end") {
      log.warn({ runId: this.runId }, "the agent emitted run.end; dropped");
      return;
    }
    const parsed = RunEvent.safeParse(
      stampEvent(input, { seq: this.assigned + 1, ts: new Date().toISOString(), runId: this.runId }),
    );
    if (!parsed.success) {
      // Dropped rather than thrown: emit runs inside the agent's callbacks, where a throw could escape.
      log.error({ runId: this.runId, type: input.type, issues: parsed.error.issues.slice(0, 5) }, "agent event breaks the contracts; dropped");
      return;
    }
    const event = parsed.data;
    this.assigned = event.seq;
    this.first ??= event.ts;
    this.tail = this.tail.then(() => this.write(event));
  };

  private async write(event: RunEvent): Promise<void> {
    if (this.failed !== null) return;
    try {
      await this.hooks.store(event);
    } catch (err) {
      this.failed = err;
      this.hooks.onFailure(err);
      return;
    }
    this.storedSeq = event.seq;
    try {
      this.hooks.publish(event);
      await this.hooks.afterPublish(event);
    } catch (err) {
      log.warn({ err, runId: this.runId, seq: event.seq }, "after-store step failed; continuing");
    }
  }

  /** Stops taking emitted events and waits until every accepted one is written. */
  async close(): Promise<void> {
    this.closed = true;
    await this.tail;
  }

  /** After close(): stores and publishes one more event at the next seq. Throws when the write fails. */
  async append(input: EventInput): Promise<void> {
    const event = RunEvent.parse(
      stampEvent(input, { seq: this.storedSeq + 1, ts: new Date().toISOString(), runId: this.runId }),
    );
    await this.hooks.store(event);
    this.storedSeq = event.seq;
    this.hooks.publish(event);
  }
}

interface AgentRunContext {
  runId: string;
  question: string;
  lane: Lane;
  mode: AnalystMode;
  pins: Record<string, string> | undefined;
  parent: { runId: string; caseSummary: string } | null;
  intent: Intent | undefined;
  qloo: QlooClient;
  /** Null when public data is not set up: the public tools then come back unavailable. */
  publicdata: PublicDataClient | null;
  anthropic: AnthropicLike;
  /** The side context calls' settings and cache (R4, R5). */
  side: SideRunOptions;
  /** When the agent started; reset when a queued run leaves the queue, so run time never counts the wait. */
  startedAt: number;
  spend: SpendMeter;
  /** Writes the run's events in order, from run.created (and its queue events) to run.end. */
  writer: EventWriter;
  /** Stops runAgent: cancel, shutdown, the watchdog, or a failed event write. */
  abort: AbortController;
}

/**
 * What launchAgent starts: a sanitized question, pins keyed by normaliseName, the parent's summary
 * and, from a preview, CLERK's reading of the question.
 */
interface AgentLaunch {
  question: string;
  lane: Lane;
  pins: Record<string, string> | undefined;
  parent: { runId: string; caseSummary: string } | null;
  intent?: Intent;
  client: string | null;
}

interface AgentClients {
  deps: AgentDeps;
  qloo: QlooClient;
  publicdata: PublicDataClient | null;
  anthropic: AnthropicLike;
  side: SideRunOptions;
}

/** Pins keyed the way runAgent looks them up (normaliseName); undefined when none are left. */
function normalisePins(pins: Readonly<Record<string, string>> | undefined): Record<string, string> | undefined {
  const entries = Object.entries(pins ?? {}).flatMap(([mention, entityId]) => {
    const key = normaliseName(mention);
    const id = entityId.trim();
    return key !== "" && id !== "" ? [[key, id] as const] : [];
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * run.end's status and reason. A stop (cancel, shutdown, overrun) decides any outcome but a
 * completed note, which stands even when the stop arrived as it finished; that includes an agent
 * that threw after the stop or never returned from it.
 */
function agentOutcome(
  result: AgentRunResult | null,
  stop: Stop | null,
  unsaved: boolean,
): { status: TerminalRunStatus; reason: string | null } {
  if (unsaved) return { status: "failed", reason: UNSAVED_REASON };
  if (result?.status === "completed") return { status: "completed", reason: null };
  if (stop) return STOPS[stop];
  if (!result) return { status: "failed", reason: AGENT_FAILED_REASON };
  return { status: result.status, reason: result.reason };
}

const totalTokens = (u: TokenUsage) => u.input + u.output + u.cacheRead + u.cacheCreation;

/** The runs row at the end of an agent run: what the result says, else what the stream recorded. */
function agentRunPatch(
  result: AgentRunResult | null,
  outcome: { status: TerminalRunStatus; reason: string | null },
  elapsedMs: number,
  recordedUsd: number,
): RunPatch {
  const patch: RunPatch = {
    wallMs: Math.round(elapsedMs),
    llmUsd: result?.usd ?? recordedUsd,
    error: outcome.status === "failed" || outcome.status === "incomplete" ? { reason: outcome.reason } : null,
  };
  if (!result) return patch;
  return {
    ...patch,
    report: result.report,
    validation: result.validation,
    tokens: totalTokens(result.usage),
    qlooNetwork: result.qloo.network,
    // qloo_cached counts every call served without the network, reuses included.
    qlooCached: result.qloo.cached + result.qloo.reused,
    ...(result.model ? { model: result.model } : {}),
    ...(result.intent ? { intent: result.intent, pillar: result.intent.pillar, job: result.intent.job } : {}),
  };
}

/**
 * The runs row its driver writes at run.end, rebuilt from the stored events of a run whose driver
 * stored run.end but not the row. An agent run's spend, tokens and Qloo counts come from its last
 * usage event (runAgent emits its totals as it ends). A test run's usage is invented, so its row
 * gets only what runFake writes.
 */
function patchFromEvents(state: RunState, end: RunEnd, agentRun: boolean): RunPatch {
  const patch: RunPatch = {
    wallMs: Math.round(end.elapsedMs),
    error: end.status === "failed" || end.status === "incomplete" ? { reason: end.reason } : null,
  };
  if (!agentRun) return { ...patch, report: end.status === "completed" ? state.report : null };
  const { usage, validation, intent } = state;
  return {
    ...patch,
    report: state.report,
    validation: validation && { issues: validation.issues, numbersTraced: validation.numbersTraced },
    ...(usage
      ? {
          llmUsd: usage.llmUsd,
          tokens: totalTokens(usage.tokens),
          qlooNetwork: usage.qloo.network,
          qlooCached: usage.qloo.cached + usage.qloo.reused,
        }
      : {}),
    ...(intent ? { intent, pillar: intent.pillar, job: intent.job } : {}),
  };
}

/**
 * An agent run's ledger as its stored events add up to it. Datasets that did not stream inline are
 * missing: only the driver's own snapshot held them.
 */
function ledgerFromEvents(state: RunState): LedgerSnapshotInput {
  return {
    evidence: Object.values(state.evidence),
    metrics: Object.values(state.metrics),
    datasets: Object.values(state.datasets).flatMap((d) => (d.data ? [d.data] : [])),
    findings: state.findings,
  };
}

/**
 * A run's status, taken from its stored run.end while the row still says queued or running: a
 * run.end is final, and its driver may have stored it without managing to write the row. Null for a
 * run that has not ended.
 */
function endedStatus(rowStatus: RunStatus, state: RunState): RunStatus | null {
  if (!isActiveStatus(rowStatus)) return rowStatus;
  return state.ended?.status ?? null;
}

/** run.created as the run manager writes it: a queued run's first event, or a run whose agent failed before its own. */
function runCreatedInput(run: AgentRunContext): EventInput {
  return {
    type: "run.created",
    question: run.question,
    mode: run.mode,
    lane: run.lane,
    limits: DEFAULT_RUN_LIMITS,
    parentRunId: run.parent?.runId ?? null,
    model: ANALYST_CONFIGS[run.mode].model,
  };
}

/**
 * Owns the runs this process is executing. Each event is validated against the contracts, given the
 * next seq, appended to run_events and only then published on the bus, so the database is always at
 * least as far along as any live subscriber.
 */
export class RunManager {
  private readonly db: Queryable;
  private readonly bus: EventBus;
  private readonly fakeRunSeconds: number;
  private readonly fakeMaxActive: number;
  private readonly hourlyCap: number;
  private readonly retentionMs: number;
  private readonly cancelPollMs: number;
  private readonly agent: AgentDeps | undefined;
  private readonly runAgentFn: RunAgentFn;
  private readonly agentHourlyCap: number;
  private readonly judgeHourlyCap: number;
  private readonly agentDailyCap: number;
  private readonly judgeDailyCap: number;
  private readonly agentMaxActive: number;
  private readonly slots: Record<Lane, number>;
  private readonly visitorLimits: VisitorLimits;
  private readonly llmDailyUsdCap: number;
  private readonly llmLaneUsdCap: Partial<Record<Lane, number>>;
  private readonly agentWatchdogMs: number;
  private readonly agentStopGraceMs: number;
  private readonly qlooEnabled: boolean;
  private readonly queueMax: number;
  private readonly queueWaitMs: number;
  private readonly active = new Map<string, ActiveRun>();
  /** Agent runs that wait for a slot (D24), in order; queuedRuns holds each from its reserved place to its start or end. */
  private readonly queue: RunQueue<QueuedRun>;
  private readonly queuedRuns = new Map<string, QueuedRun>();
  /** The pending check of the queued runs' cancel flags, while any run waits. */
  private queueCancelTimer: ReturnType<typeof setTimeout> | null = null;
  /** Orphan finalizations in flight, so viewers of one run in this process share one attempt. */
  private readonly finalizing = new Map<string, Promise<boolean>>();
  /** Tail of the admission queue: the hourly count and the insert run one start at a time. */
  private admission: Promise<unknown> = Promise.resolve();
  private lastPurgeAt = 0;
  private lastForgetAt = 0;
  private accepting = true;

  constructor(options: RunManagerOptions) {
    this.db = options.db;
    this.bus = options.bus;
    this.fakeRunSeconds = options.fakeRunSeconds ?? 200;
    this.fakeMaxActive = options.fakeMaxActive ?? 20;
    this.hourlyCap = options.hourlyCap ?? 60;
    this.retentionMs = options.retentionMs ?? 6 * HOUR_MS;
    this.cancelPollMs = options.cancelPollMs ?? 1000;
    this.agent = options.agent;
    this.runAgentFn = options.runAgent ?? runAgent;
    this.agentHourlyCap = options.agentHourlyCap ?? 120;
    this.judgeHourlyCap = options.judgeHourlyCap ?? 30;
    this.agentDailyCap = options.agentDailyCap ?? 500;
    this.judgeDailyCap = options.judgeDailyCap ?? 120;
    this.agentMaxActive = options.agentMaxActive ?? RUN_QUEUE_DEFAULTS.maxActive;
    this.slots = laneSlots(this.agentMaxActive, options.judgeMaxActive ?? 2);
    this.visitorLimits = options.visitorLimits ?? visitorLimitsFromEnv();
    this.llmDailyUsdCap = options.llmDailyUsdCap ?? 8;
    this.llmLaneUsdCap = options.llmLaneUsdCap ?? {};
    this.agentWatchdogMs = options.agentWatchdogMs ?? AGENT_WATCHDOG_MS;
    this.agentStopGraceMs = options.agentStopGraceMs ?? AGENT_STOP_GRACE_MS;
    this.qlooEnabled = options.qlooEnabled ?? true;
    this.queueMax = Math.max(0, options.queueMax ?? 0);
    this.queueWaitMs = options.queueWaitMs ?? RUN_QUEUE_DEFAULTS.waitS * 1000;
    this.queue = new RunQueue<QueuedRun>({
      max: this.queueMax,
      waitMs: this.queueWaitMs,
      onPlace: (_id, place, queued) => queued.run?.writer.emit({ type: "run.queued", ...place }),
      onTimeout: (_id, queued) => {
        const waitS = Math.round(this.queueWaitMs / 1000);
        log.info({ runId: queued.runId, waitS }, "queued run timed out");
        void this.endQueued(queued, { status: "failed", reason: queueTimeoutReason(waitS), code: "queue_timeout" });
      },
    });
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  /** The run is driven here: running, or waiting in the queue. */
  isLive(runId: string): boolean {
    return this.active.has(runId) || this.queuedRuns.has(runId);
  }

  activeCount(): number {
    return this.active.size;
  }

  /** Agent runs waiting for a slot here (D24), those still being admitted to the queue included. */
  queuedCount(): number {
    return this.queue.size;
  }

  /** Resolves once the run's loop has written run.end (or immediately when it is not live here). */
  async whenDone(runId: string): Promise<void> {
    await (this.active.get(runId) ?? this.queuedRuns.get(runId))?.done;
  }

  /** A test run; `client` (as AgentRunRequest.client) is recorded on its row and limits nothing. */
  async startFakeRun(options: { seconds?: number; client?: string | null } = {}): Promise<{ runId: string }> {
    if (!this.accepting) throw new RunManagerError("not_accepting", NOT_ACCEPTING_REASON);
    if (this.activeCountOf("fake") >= this.fakeMaxActive) {
      throw new RunManagerError("busy", "Too many test runs are active. Try again shortly.");
    }
    const seconds = options.seconds ?? this.fakeRunSeconds;
    const runId = randomUUID();
    const controller = new AbortController();
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => (release = resolve));
    // Reserve the slot before the first await so concurrent starts respect fakeMaxActive and drain sees it.
    this.active.set(runId, { controller, done, kind: "fake", lane: null, visitor: null, spend: null, reserveUsd: 0 });
    try {
      await this.admit(async () => {
        // Counted in the database, so started-then-cancelled runs count too: every run leaves rows.
        const lastHour = await countRunsSince(this.db, { hashPrefix: FAKE_HASH_PREFIX, sinceMs: HOUR_MS });
        if (lastHour >= this.hourlyCap) {
          throw new RunManagerError("limited", "The hourly limit for test runs is reached. Try again later.", HOUR_MS / 1000);
        }
        await createRun(this.db, {
          id: runId,
          question: FAKE_QUESTION,
          // Namespaced so a fake run can never answer a real question from the answer cache (D26).
          questionHash: `${FAKE_HASH_PREFIX}${runId}`,
          status: "running",
          pillar: "investment",
          job: "brand_health",
          mode: "live",
          lane: "public",
          model: FAKE_MODEL,
          ipHash: options.client ?? null,
        });
      });
    } catch (err) {
      this.active.delete(runId);
      release();
      throw err;
    }
    this.purgeSoon();
    void this.runFake(runId, seconds * 1000, controller.signal).finally(() => {
      this.active.delete(runId);
      this.bus.close(runId);
      release();
    });
    log.info({ runId, seconds }, "fake run started");
    return { runId };
  }

  /**
   * Starts an agent run (PLAN §4.1) on the agent slots, which fake runs never take. Admission checks
   * the mode, the visitor's, hourly and daily limits and today's LLM budget, then creates the runs
   * row; runAgent goes on in the background. A preview's intent skips CLERK; everything else runs as
   * without it.
   */
  async startAgentRun(request: AgentRunRequest): Promise<{ runId: string }> {
    if (!this.accepting) throw new RunManagerError("not_accepting", NOT_ACCEPTING_REASON);
    const question = sanitizeQuestion(request.question);
    if (question === "") throw new RunManagerError("invalid", "The question is empty.");
    const clients = this.agentClients();
    const parent = request.parentRunId ? await this.parentContext(request.parentRunId) : null;
    const launch: AgentLaunch = { question, lane: request.lane, pins: normalisePins(request.pins), parent, client: request.client ?? null };
    return this.launchAgent(request.intent ? { ...launch, intent: request.intent } : launch, clients);
  }

  /**
   * Answers a needs_input picker (D20, SPEC §4.1 "picker → new run with pins"): re-asks the waiting
   * run's question with the chosen entity pinned to its mention, keeping that run's pins and parent.
   * The browser only ever holds the opaque key; the entity id is found here, from the mention's own
   * /search (cached by the gate, so no Qloo call), and never comes from the request.
   */
  async answerPicker(answer: PickerAnswer): Promise<{ runId: string }> {
    if (!this.accepting) throw new RunManagerError("not_accepting", NOT_ACCEPTING_REASON);
    const clients = this.agentClients();
    // Checked again at admission; checked here too so a paused service makes no Qloo call.
    const paused = laneModeOf(await clients.deps.mode(answer.lane));
    if (paused.mode === "replay_only") throw new RunManagerError("unavailable", paused.message ?? PAUSED_REASON);
    const picked = await this.resolvePick(answer, clients.qloo);
    const parent = picked.parentRunId ? await this.parentContext(picked.parentRunId) : null;
    const started = await this.launchAgent(
      { question: picked.question, lane: answer.lane, pins: picked.pins, parent, client: answer.client ?? null },
      clients,
    );
    // A follow whose re-run waited on this pick now waits on the run the pick started.
    await this.movePendingFollows(answer.runId, started.runId);
    return started;
  }

  /**
   * Admits an agent run and starts it on a free slot of its lane, or queues it (D24) when every slot of
   * its lane is busy or runs of its lane already wait: the run is created as queued, emits run.queued
   * with its place and starts on its own when a slot frees (pump). The per-visitor, hourly and daily
   * limits and the spent budget are checked as it joins; the mode and the budget's reserve again as it starts.
   */
  private async launchAgent(launch: AgentLaunch, clients: AgentClients): Promise<{ runId: string }> {
    const { question, lane, pins, parent, intent } = launch;
    if (!this.accepting) throw new RunManagerError("not_accepting", NOT_ACCEPTING_REASON);
    // Each lane has slots of its own inside the total: public runs can never take the judge lane's.
    // A free slot goes to the runs already waiting on its lane first.
    const queued = !this.hasSlot(lane) || this.queue.waiting(lane) > 0;
    if (queued && this.queue.size >= this.queueMax) {
      throw new RunManagerError("busy", this.queueMax > 0 ? RUN_QUEUE_FULL_MESSAGE : BUSY_REASON);
    }
    // The public lane's per-visitor limits (SPEC §10.4); the judge lane's are the lane's own. Queued runs count.
    const visitor = lane === "public" ? launch.client : null;
    if (visitor !== null && this.activeVisitorRuns(visitor) >= this.visitorLimits.maxActive) {
      throw new RunManagerError("limited", VISITOR_ACTIVE_REASON, Math.ceil(DEFAULT_RUN_LIMITS.hardMs / 1000));
    }
    const runId = randomUUID();
    const controller = new AbortController();
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => (release = resolve));
    // Checked and reserved with no await in between, so concurrent starts respect the slots and the
    // queue's size, and drain sees the run.
    const slot: ActiveRun = { controller, done, kind: "agent", lane, visitor, spend: null, reserveUsd: 0 };
    const waiting: QueuedRun = { runId, lane, visitor, deps: clients.deps, controller, done, release, run: null };
    if (!queued) this.active.set(runId, slot);
    else if (this.queue.reserve(runId, lane, waiting)) this.queuedRuns.set(runId, waiting);
    else throw new RunManagerError("busy", RUN_QUEUE_FULL_MESSAGE);
    const spend = new SpendMeter(this.db, lane);
    let mode: AnalystMode;
    try {
      mode = await this.admit(async () => {
        const { mode: current, message } = laneModeOf(await clients.deps.mode(lane));
        if (current === "replay_only") throw new RunManagerError("unavailable", message ?? PAUSED_REASON);
        if (visitor !== null) {
          // Counted in the database from the runs' ip_hash, so a restart forgets no start.
          const wait = await visitorWait(this.db, visitor, this.visitorLimits);
          if (wait) throw new RunManagerError("limited", visitorWaitMessage(wait, this.visitorLimits), wait.retryAfterS);
        }
        // Counted in the database per lane, whatever the status: every started run may have spent.
        const lastHour = await countLaneRunsSince(this.db, lane, HOUR_MS);
        if (lastHour >= (lane === "judge" ? this.judgeHourlyCap : this.agentHourlyCap)) {
          throw new RunManagerError("limited", "The hourly limit for live runs is reached. Try again later.", HOUR_MS / 1000);
        }
        if (lane === "judge" && (await countLaneRunsSince(this.db, "judge", DAY_MS)) >= this.judgeDailyCap) {
          throw new RunManagerError("limited", JUDGE_DAILY_REASON, HOUR_MS / 1000);
        }
        if ((await countRunsSince(this.db, { hashPrefix: QUESTION_HASH_PREFIX, sinceMs: DAY_MS })) >= this.agentDailyCap) {
          throw new RunManagerError("limited", DAILY_REASON, HOUR_MS / 1000);
        }
        const cap = this.llmLaneUsdCap[lane] ?? this.llmDailyUsdCap;
        const reserve = preRunUsd(current);
        const today = await todayLlmUsd(this.db);
        if (today + reserve > cap) throw new RunManagerError("budget", BUDGET_REASON);
        // Runs in flight have spent little of what they will: each holds its reserve until it records more.
        // A queued run takes its reserve as it starts (admitQueued), when the runs ahead may have ended.
        if (!queued && today + this.reservedUsd() + reserve > cap) {
          throw new RunManagerError(
            "limited",
            "Live runs in progress hold the rest of today's budget. Try again in a few minutes.",
            DEFAULT_RUN_LIMITS.hardMs / 1000,
          );
        }
        if (!queued) {
          // Admissions run one at a time, so the next one already counts this run's reserve.
          slot.reserveUsd = reserve;
          slot.spend = spend;
        }
        await createRun(this.db, {
          id: runId,
          question,
          // A follow-up's key carries its parent, so it never answers (or is answered by) the bare question.
          questionHash: questionHash(question, pins, current, parent?.runId ?? null),
          status: queued ? "queued" : "running",
          mode: current,
          lane,
          model: ANALYST_CONFIGS[current].model,
          effort: ANALYST_CONFIGS[current].effort,
          pins: pins ?? null,
          parentRunId: parent?.runId ?? null,
          // Every run keeps its visitor, judge runs too; only public runs count against it.
          ipHash: launch.client,
          // A queued run is stamped when it leaves the queue (admitQueued); one that never does counts toward no cap.
          ...(queued ? {} : { startedAt: new Date() }),
        });
        return current;
      });
    } catch (err) {
      if (queued) {
        this.queue.leave(runId);
        this.queuedRuns.delete(runId);
      } else {
        this.active.delete(runId);
      }
      release();
      throw err;
    }
    if (launch.client !== null) this.forgetSoon();
    const { qloo, publicdata, anthropic, side } = clients;
    const abort = new AbortController();
    const run: AgentRunContext = {
      runId,
      question,
      lane,
      mode,
      pins,
      parent,
      intent,
      qloo,
      publicdata,
      anthropic,
      side,
      startedAt: Date.now(),
      spend,
      writer: this.agentWriter(runId, lane, spend, abort),
      abort,
    };
    const logged = { runId, mode, lane, child: parent !== null, pinned: pins !== undefined, previewed: intent !== undefined };
    if (!queued) {
      this.drive(run, controller.signal, release);
      log.info(logged, "agent run started");
      return { runId };
    }
    waiting.run = run;
    run.writer.emit(runCreatedInput(run));
    // A shutdown cleared the queue while this run was admitted: it ends before it ever waits.
    if (!this.accepting || this.queue.enter(runId) === null) {
      this.queue.leave(runId);
      await this.endQueued(waiting, { status: "failed", reason: QUEUE_SHUTDOWN_REASON });
      throw new RunManagerError("not_accepting", NOT_ACCEPTING_REASON);
    }
    this.watchQueuedCancels();
    log.info({ ...logged, place: this.queue.place(runId) }, "agent run queued");
    // A slot may have freed while this run was admitted.
    this.pump();
    return { runId };
  }

  /** A free agent slot for this lane: its own slots and the total both have room. */
  private hasSlot(lane: Lane): boolean {
    return this.activeAgentRuns(lane) < this.slots[lane] && this.activeCountOf("agent") < this.agentMaxActive;
  }

  /** Drives an admitted agent run to its end, then frees its slot for the queue. */
  private drive(run: AgentRunContext, shutdown: AbortSignal, release: () => void): void {
    void this.driveAgent(run, shutdown).finally(() => {
      this.active.delete(run.runId);
      this.bus.close(run.runId);
      release();
      this.pump();
    });
  }

  /** Starts queued runs, first in first out per lane, while their lanes have free slots. */
  private pump(): void {
    if (!this.accepting) return;
    const canStart = (lane: Lane) => this.hasSlot(lane);
    for (let next = this.queue.take(canStart); next; next = this.queue.take(canStart)) this.startQueued(next);
  }

  /** Moves a run taken from the queue onto the slot it was taken for, before any await. */
  private startQueued(taken: TakenRun<QueuedRun>): void {
    const queued = taken.value;
    this.active.set(queued.runId, {
      controller: queued.controller,
      done: queued.done,
      kind: "agent",
      lane: queued.lane,
      visitor: queued.visitor,
      spend: null,
      reserveUsd: 0,
    });
    this.queuedRuns.delete(queued.runId);
    void this.admitQueued(taken);
  }

  /**
   * A queued run's start: the lane's mode and today's budget are checked again, now that it is about to
   * spend. A paused lane or a spent budget ends it unstarted; a budget held by the runs in flight puts
   * it back at its place until one of them ends (and pumps the queue again).
   */
  private async admitQueued(taken: TakenRun<QueuedRun>): Promise<void> {
    const queued = taken.value;
    const run = queued.run!;
    const slot = this.active.get(queued.runId)!;
    type Start = "start" | "wait" | "gone" | QueueEnd;
    let start: Start;
    try {
      start = await this.admit(async (): Promise<Start> => {
        if (!this.accepting) return { status: "failed", reason: QUEUE_SHUTDOWN_REASON };
        if (run.writer.failure !== null) return { status: "failed", reason: UNSAVED_REASON };
        const { mode: current, message } = laneModeOf(await queued.deps.mode(run.lane));
        if (current === "replay_only") return { status: "failed", reason: message ?? PAUSED_REASON };
        // The run keeps the ANALYST it was admitted with: its row and run.created already name it.
        const cap = this.llmLaneUsdCap[run.lane] ?? this.llmDailyUsdCap;
        const reserve = preRunUsd(run.mode);
        const today = await todayLlmUsd(this.db);
        if (today + reserve > cap) return { status: "failed", reason: BUDGET_REASON };
        if (today + this.reservedUsd() + reserve > cap) return "wait";
        slot.reserveUsd = reserve;
        slot.spend = run.spend;
        // False when the row is no longer queued: another writer ended it.
        if (!(await setStatus(this.db, run.runId, "running", { from: ["queued"] }))) return "gone";
        // From here the run counts toward the visitor and global caps (started_at set).
        await markStarted(this.db, run.runId);
        return "start";
      });
    } catch (err) {
      log.error({ err, runId: run.runId }, "a queued run could not be started");
      start = { status: "failed", reason: AGENT_FAILED_REASON };
    }
    if (start === "start") {
      run.startedAt = Date.now();
      this.drive(run, queued.controller.signal, queued.release);
      const joined = Date.parse(run.writer.firstTs ?? "");
      log.info({ runId: run.runId, lane: run.lane, waitedMs: Number.isFinite(joined) ? run.startedAt - joined : null }, "queued run started");
    } else if (start === "wait") {
      this.active.delete(run.runId);
      this.queuedRuns.set(run.runId, queued);
      this.queue.restore(taken);
      this.watchQueuedCancels();
    } else if (start === "gone") {
      log.warn({ runId: run.runId }, "queued run was ended by another writer; not starting it");
      this.active.delete(run.runId);
      this.bus.close(run.runId);
      queued.release();
      this.pump();
    } else {
      await this.endQueued(queued, start);
    }
  }

  /**
   * Ends a run that never started: its error event (if any) and run.end after its queue events, then
   * the row. Nothing was spent. Frees whatever it held, a place or a slot, and starts the next run.
   */
  private async endQueued(queued: QueuedRun, end: QueueEnd): Promise<void> {
    const run = queued.run;
    try {
      if (run) {
        await run.writer.close();
        const joined = Date.parse(run.writer.firstTs ?? "");
        const elapsedMs = Math.max(0, Date.now() - (Number.isFinite(joined) ? joined : run.startedAt));
        if (end.code) await run.writer.append({ type: "error", code: end.code, message: end.reason, retryable: true });
        await run.writer.append({ type: "run.end", status: end.status, elapsedMs, reason: end.reason });
        const patch: RunPatch = {
          wallMs: Math.round(elapsedMs),
          llmUsd: 0,
          error: end.status === "failed" || end.status === "incomplete" ? { reason: end.reason } : null,
        };
        await withRetries("end-of-run status write", { runId: run.runId }, () =>
          setStatus(this.db, run.runId, end.status, { from: ACTIVE_STATUSES, patch }),
        );
        log.info({ runId: run.runId, status: end.status, elapsedMs }, "queued run ended before it started");
        await this.settlePendingFollows(run.runId, end.status);
      }
    } catch (err) {
      if (err instanceof SeqTakenError) log.warn({ runId: queued.runId, seq: err.seq }, "queued run was ended by another writer");
      // As for any run: finalizeOrphan rebuilds the row from a stored run.end or ends the run incomplete.
      else log.error({ err, runId: queued.runId }, "could not record the end of a queued run");
    } finally {
      this.queuedRuns.delete(queued.runId);
      this.active.delete(queued.runId);
      this.bus.close(queued.runId);
      queued.release();
      this.pump();
    }
  }

  /** Polls the cancel flags of the waiting runs while any wait; a raised flag ends that run as cancelled. */
  private watchQueuedCancels(): void {
    if (this.queueCancelTimer !== null || this.queue.size === 0) return;
    this.queueCancelTimer = setTimeout(() => void this.checkQueuedCancels(), this.cancelPollMs);
  }

  private async checkQueuedCancels(): Promise<void> {
    try {
      for (const queued of this.queue.values()) {
        if (!queued.run) continue;
        let asked = false;
        try {
          asked = await isCancelRequested(this.db, queued.runId);
        } catch (err) {
          log.warn({ err, runId: queued.runId }, "cancel flag check failed; continuing");
        }
        // Null when it started or ended while the flag was read.
        if (asked && this.queue.leave(queued.runId) !== null) void this.endQueued(queued, STOPS.cancelled);
      }
    } finally {
      this.queueCancelTimer = null;
      this.watchQueuedCancels();
    }
  }

  /** The event writer of an agent run: stores, publishes and books each event; a failed store stops the run. */
  private agentWriter(runId: string, lane: Lane, spend: SpendMeter, abort: AbortController): EventWriter {
    return new EventWriter(runId, {
      store: (event) => this.persist(event),
      publish: (event) => this.bus.publish(event),
      afterPublish: (event) => this.afterAgentEvent(runId, lane, event, spend),
      onFailure: (err) => {
        // A run whose events cannot be stored is not worth finishing.
        if (!(err instanceof SeqTakenError)) log.error({ err, runId }, "agent run events could not be stored; stopping");
        abort.abort();
      },
    });
  }

  private activeCountOf(kind: ActiveRun["kind"]): number {
    let n = 0;
    for (const run of this.active.values()) if (run.kind === kind) n += 1;
    return n;
  }

  /** Agent runs in flight here on this lane. */
  private activeAgentRuns(lane: Lane): number {
    let n = 0;
    for (const run of this.active.values()) if (run.kind === "agent" && run.lane === lane) n += 1;
    return n;
  }

  /** Public runs in flight or waiting in the queue here for this visitor. */
  private activeVisitorRuns(visitor: string): number {
    let n = 0;
    for (const run of this.active.values()) if (run.visitor === visitor) n += 1;
    for (const run of this.queuedRuns.values()) if (run.visitor === visitor) n += 1;
    return n;
  }

  /** USD the admitted agent runs in flight here still hold: each one's reserve, less what it has recorded. */
  private reservedUsd(): number {
    let usd = 0;
    for (const run of this.active.values()) if (run.spend) usd += Math.max(run.reserveUsd - run.spend.recorded, 0);
    return usd;
  }

  /** The clients a live run needs, or an "unavailable" refusal that says what is missing. */
  private agentClients(): AgentClients {
    const deps = this.agent;
    if (!deps) throw new RunManagerError("unavailable", "Live analysis is not set up on this server.");
    const anthropic = deps.anthropic();
    if (!anthropic) {
      throw new RunManagerError(
        "unavailable",
        "Live analysis is unavailable: this server has no Anthropic API key. Test runs still work.",
      );
    }
    let qloo: QlooClient;
    try {
      qloo = deps.qloo();
    } catch (err) {
      log.error({ err }, "the Qloo client could not be created; refusing live runs");
      throw new RunManagerError("unavailable", "Live analysis is unavailable: the Qloo client is not configured.");
    }
    return { deps, qloo, publicdata: this.publicDataClient(deps), anthropic, side: this.sideOptions(deps) };
  }

  /** The side context calls' settings and cache for a run; a cache that cannot be made leaves them uncached. */
  private sideOptions(deps: AgentDeps): SideRunOptions {
    let contextCache: ContextCache | null = null;
    try {
      contextCache = deps.contextCache?.() ?? null;
    } catch (err) {
      log.warn({ err }, "the context cache could not be made; side context calls run uncached");
    }
    return { sideConfig: deps.side ?? sideConfigFromEnv(), contextCache };
  }

  /**
   * The SEC EDGAR and US Census client, or null when it cannot be made (a malformed SEC_USER_AGENT): a run
   * goes on without public data and its public tools say the data is unavailable. Logged once per failure.
   */
  private publicDataClient(deps: AgentDeps): PublicDataClient | null {
    if (!deps.publicdata) return null;
    try {
      return deps.publicdata();
    } catch (err) {
      log.error({ err }, "the public-data client could not be created; runs go on without SEC and Census data");
      return null;
    }
  }

  /**
   * A child run's parent and its case summary (§7.3), rebuilt from the parent's stored events. Only
   * an agent run that stored a note qualifies: a test run's note is invented and must never seed one.
   * A parent whose row lags behind its stored run.end (see endedStatus) gives its report.final.
   */
  private async parentContext(parentRunId: string): Promise<{ runId: string; caseSummary: string }> {
    const parent = await getRun(this.db, parentRunId);
    if (!parent) throw new RunManagerError("invalid", "parentRunId does not name a run.");
    const noNote = () => new RunManagerError("invalid", "The parent run has no finished note to follow up on.");
    const lagging = isActiveStatus(parent.status);
    if (!parent.questionHash.startsWith(QUESTION_HASH_PREFIX) || !(lagging || PARENT_STATUSES.has(parent.status))) throw noNote();
    const state = reduceRunEvents(parentRunId, await readAllEvents(this.db, parentRunId));
    const status = endedStatus(parent.status, state);
    const report = Report.safeParse(lagging ? state.report : parent.report);
    if (status === null || !PARENT_STATUSES.has(status) || !report.success) throw noNote();
    const priorRunIds: string[] = [];
    let ancestor = parent.parentRunId;
    while (ancestor && priorRunIds.length < CHAIN_MAX) {
      priorRunIds.unshift(ancestor);
      ancestor = (await getRun(this.db, ancestor))?.parentRunId ?? null;
    }
    // The summary writes out metric values; it never reads datasets, which may not have streamed inline.
    const ledger = {
      evidence: Object.values(state.evidence),
      metrics: Object.values(state.metrics),
      datasets: [],
      findings: state.findings,
    };
    return { runId: parentRunId, caseSummary: buildCaseSummary(report.data, { ledger, priorRunIds }) };
  }

  /**
   * A picker answer as the new run's inputs: the waiting run's question and parent, and its pins plus
   * the chosen entity keyed by the mention. The key must be one the run offered and must still name
   * a result of the mention's /search, rebuilt exactly as the gate built it.
   */
  private async resolvePick(
    answer: PickerAnswer,
    qloo: QlooClient,
  ): Promise<{ question: string; pins: Record<string, string>; parentRunId: string | null }> {
    const notWaiting = () => new RunManagerError("invalid", "This run is not waiting for a choice.");
    const run = await getRun(this.db, answer.runId);
    // Events are read only for a run that waits, or whose row may lag behind its stored run.end.
    if (!run || !run.questionHash.startsWith(QUESTION_HASH_PREFIX) || !(run.status === "needs_input" || isActiveStatus(run.status))) {
      throw notWaiting();
    }
    const state = reduceRunEvents(answer.runId, await readAllEvents(this.db, answer.runId));
    if (endedStatus(run.status, state) !== "needs_input") throw notWaiting();
    const picker = state.needsInput;
    if (!picker?.candidates.some((c) => c.key === answer.key)) {
      throw new RunManagerError("invalid", "That choice is not one this run offered.");
    }
    // The gate's own search: a place around its map city or market (D44).
    const metro = picker.entityType === "place" && state.intent ? placeSearchMarket(state.intent.geo) : null;
    const params = searchParams({ text: picker.mention, type: picker.entityType, metro });
    if (params === null) throw new RunManagerError("invalid", "That choice is not one this run offered.");
    let results: readonly QlooSearchEntity[];
    try {
      const reply = await qloo.standalone({ signal: AbortSignal.timeout(PICK_LOOKUP_MS) }).forTool(null).search(params);
      results = reply.data.results;
    } catch (err) {
      log.warn({ err, runId: answer.runId }, "the picker lookup failed");
      throw new RunManagerError("unavailable", "The choice could not be checked with Qloo right now. Try again shortly.");
    }
    const choice = findPickerChoice(results, answer.key);
    if (!choice) throw new RunManagerError("invalid", "That choice is no longer offered. Ask the question again.");
    const stored = STORED_PINS.safeParse(run.pins);
    const pins = { ...(stored.success ? stored.data : null), [normaliseName(picker.mention)]: choice.entity_id };
    return { question: run.question, pins, parentRunId: run.parentRunId };
  }

  /** Deletes finished fake runs older than the retention, with their events. Returns how many. */
  async purgeFakeRuns(): Promise<number> {
    this.lastPurgeAt = Date.now();
    const purged = await purgeRuns(this.db, {
      hashPrefix: FAKE_HASH_PREFIX,
      olderThanMs: this.retentionMs,
      keepStatuses: ACTIVE_STATUSES,
    });
    if (purged > 0) log.info({ purged }, "old fake runs purged");
    return purged;
  }

  private purgeSoon(): void {
    if (Date.now() - this.lastPurgeAt < PURGE_EVERY_MS) return;
    this.lastPurgeAt = Date.now();
    void this.purgeFakeRuns().catch((err: unknown) => log.warn({ err }, "fake run purge failed"));
  }

  /**
   * Clears the visitor hash of runs past every per-visitor window (VISITOR_HASH_RETENTION_MS): it
   * counts toward nothing any more, so it is not kept. Returns how many runs were cleared.
   */
  async forgetVisitors(): Promise<number> {
    this.lastForgetAt = Date.now();
    const cleared = await clearIpHashes(this.db, { olderThanMs: VISITOR_HASH_RETENTION_MS });
    if (cleared > 0) log.info({ cleared }, "visitor hashes of old runs cleared");
    return cleared;
  }

  private forgetSoon(): void {
    if (Date.now() - this.lastForgetAt < PURGE_EVERY_MS) return;
    this.lastForgetAt = Date.now();
    void this.forgetVisitors().catch((err: unknown) => log.warn({ err }, "clearing old visitor hashes failed"));
  }

  // One admission at a time in this process, so concurrent starts cannot all pass the same count.
  private admit<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.admission.then(fn, fn);
    this.admission = next.catch(() => undefined);
    return next;
  }

  /** SIGTERM step one: refuse new runs; queued runs no longer start. */
  beginShutdown(): void {
    this.accepting = false;
  }

  /**
   * Ends the queued runs at once (they would start into a restart), then waits up to `graceMs` for
   * active runs to end and stops the rest, which end as incomplete; an agent that ignores the stop is
   * left behind after agentStopGraceMs. There is no event buffer to flush: every event is stored before
   * it is published.
   */
  async drain(graceMs: number): Promise<DrainResult> {
    this.beginShutdown();
    // A run still being admitted to the queue ends itself once its admission returns (launchAgent).
    const unstarted = this.queue.clear().flatMap(({ value }) => (value.run ? [value] : []));
    await Promise.all(unstarted.map((queued) => this.endQueued(queued, { status: "failed", reason: QUEUE_SHUTDOWN_REASON })));
    const pending = [...this.active.values()];
    if (pending.length === 0) return { finished: 0, stopped: unstarted.length };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), graceMs);
    });
    const all = Promise.all(pending.map((r) => r.done)).then(() => "done" as const);
    const outcome = await Promise.race([all, deadline]);
    clearTimeout(timer);
    let stopped = 0;
    if (outcome === "deadline") {
      const left = [...this.active.values()];
      stopped = left.length;
      for (const run of left) run.controller.abort();
      await Promise.all(left.map((r) => r.done));
    }
    return { finished: pending.length - stopped, stopped: stopped + unstarted.length };
  }

  /**
   * Ends a run that no process is driving any more (its server crashed or was killed) with an
   * incomplete run.end. When run.end is already stored (the driver wrote it but not the row), it
   * rebuilds the row from the stored events instead, and an agent run's ledger with it. Safe to race:
   * it holds the run's row lock throughout, so a run gets at most one run.end. True when this call
   * changed the run.
   */
  async finalizeOrphan(runId: string, reason: string = ORPHAN_REASON): Promise<boolean> {
    if (this.isLive(runId)) return false;
    const pending = this.finalizing.get(runId);
    if (pending) return pending;
    const attempt = this.finalizeLocked(runId, reason).finally(() => this.finalizing.delete(runId));
    this.finalizing.set(runId, attempt);
    return attempt;
  }

  private async finalizeLocked(runId: string, reason: string): Promise<boolean> {
    const outcome = await this.db.transaction(async (tx) => {
      const run = await lockRun(tx, runId);
      if (!run || !isActiveStatus(run.status)) return null;
      const last = await readLastEvent(tx, runId);
      if (last?.type === "run.end") {
        const state = reduceRunEvents(runId, await readAllEvents(tx, runId));
        const agentRun = run.questionHash.startsWith(QUESTION_HASH_PREFIX);
        // Records the driver did store are skipped.
        if (agentRun) await insertLedgerSnapshot(tx, runId, ledgerFromEvents(state));
        await setStatus(tx, runId, last.status, { from: ACTIVE_STATUSES, patch: patchFromEvents(state, last, agentRun) });
        return { seq: last.seq, repaired: true };
      }
      const seq = (last?.seq ?? 0) + 1;
      const elapsedMs = Math.max(0, Date.now() - run.createdAt.getTime());
      const event = RunEvent.parse(
        stampEvent({ type: "run.end", status: "incomplete", elapsedMs, reason }, { seq, ts: new Date().toISOString(), runId }),
      );
      // A driver in another process wrote this seq after our read: the run is not orphaned.
      if (!(await appendRunEvent(tx, event))) return null;
      await setStatus(tx, runId, "incomplete", {
        from: ACTIVE_STATUSES,
        patch: { wallMs: elapsedMs, error: { reason } },
      });
      return { seq, repaired: false };
    });
    if (!outcome) return false;
    if (outcome.repaired) log.warn({ runId, seq: outcome.seq }, "run row repaired from its stored run.end");
    else log.warn({ runId, seq: outcome.seq }, "orphaned run marked incomplete");
    return true;
  }

  private async runFake(runId: string, durationMs: number, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const script = buildFakeScript({ runId, startedAt, durationMs });
    let seq = 0;

    const emit = async (input: EventInput): Promise<void> => {
      const event = RunEvent.parse(stampEvent(input, { seq: seq + 1, ts: new Date().toISOString(), runId }));
      await this.persist(event);
      // Only advance after the write: a failed write must not leave a hole in the sequence.
      seq = event.seq;
      this.bus.publish(event);
    };

    let lastCancelCheck = 0;
    const waitUntil = async (due: number): Promise<keyof typeof STOPS | null> => {
      for (;;) {
        if (signal.aborted) return "aborted";
        if (Date.now() - lastCancelCheck >= this.cancelPollMs) {
          lastCancelCheck = Date.now();
          try {
            if (await isCancelRequested(this.db, runId)) return "cancelled";
          } catch (err) {
            log.warn({ err, runId }, "cancel flag check failed; continuing");
          }
        }
        const remaining = due - Date.now();
        if (remaining <= 0) return null;
        await sleep(Math.min(remaining, this.cancelPollMs), signal);
      }
    };

    let status: TerminalRunStatus = "completed";
    let reason: string | null = null;
    try {
      for (const step of script.steps) {
        const stop = await waitUntil(startedAt + step.at * durationMs);
        if (stop) {
          ({ status, reason } = STOPS[stop]);
          break;
        }
        await emit(step.input);
      }
      if (status === "completed") {
        const stop = await waitUntil(startedAt + durationMs);
        if (stop) ({ status, reason } = STOPS[stop]);
      }
    } catch (err) {
      if (err instanceof SeqTakenError) {
        // An orphan finalizer ended this run while it was stalled. The stored run.end stands.
        log.warn({ runId, seq: err.seq }, "fake run was ended by another writer; stopping");
        return;
      }
      status = "failed";
      reason = "The test run hit an internal error.";
      log.error({ err, runId, seq }, "fake run failed");
    }

    const elapsedMs = Date.now() - startedAt;
    try {
      await emit({ type: "run.end", status, elapsedMs, reason });
      const patch: RunPatch = {
        wallMs: elapsedMs,
        report: status === "completed" ? script.report : null,
        error: status === "failed" ? { reason } : null,
      };
      await withRetries("end-of-run status write", { runId }, () =>
        setStatus(this.db, runId, status, { from: ACTIVE_STATUSES, patch }),
      );
      log.info({ runId, status, events: seq, elapsedMs }, "fake run ended");
    } catch (err) {
      // The run stays active in the database until finalizeOrphan repairs it from a stored run.end
      // or ends it incomplete: a viewer's stream calls it after delivering an old run.end, or while
      // tailing past the last stored event.
      log.error({ err, runId, seq }, "could not record the end of a fake run");
    }
  }

  /**
   * Drives one agent run to its run.end. Cancel (the database flag), shutdown (`shutdown` aborts)
   * and the watchdog abort runAgent; the stop then decides run.end as for fake runs. An agent that
   * ignores its signal gets agentStopGraceMs and is then left behind, so it cannot hold a slot or
   * the drain. The spend and the ledger are stored before run.end, so a viewer that sees the end can
   * read everything.
   */
  private async driveAgent(run: AgentRunContext, shutdown: AbortSignal): Promise<void> {
    const { runId, lane, spend, writer, abort } = run;
    let stop: Stop | null = null;
    const stopWith = (why: Stop) => {
      stop ??= why;
      abort.abort();
    };
    const onShutdown = () => stopWith("aborted");
    shutdown.addEventListener("abort", onShutdown, { once: true });
    if (shutdown.aborted) onShutdown();
    const watchdog = setTimeout(() => stopWith("overran"), this.agentWatchdogMs);
    const polling = new AbortController();
    const poller = this.pollCancel(runId, polling.signal, () => stopWith("cancelled"));

    // Async, so a runAgent that throws at once rejects like one that throws later.
    const agent = (async () =>
      this.runAgentFn({
        runId,
        question: run.question,
        lane,
        mode: run.mode,
        emit: writer.emit,
        qloo: run.qloo,
        // SEC EDGAR and US Census (Part 9); without it the public tools come back unavailable.
        publicdata: run.publicdata,
        anthropic: run.anthropic,
        signal: abort.signal,
        pins: run.pins,
        parent: run.parent,
        // A missing or partial metro_localities is logged with the run id on the first lookup.
        localities: kvLocalities(this.db, { runId }),
        ...(run.intent ? { intent: run.intent } : {}),
        ...(this.qlooEnabled ? {} : { qlooEnabled: false }),
        // The side context calls (R4, R5): settings from the environment, the shared context_cache.
        sideConfig: run.side.sideConfig,
        contextCache: run.side.contextCache,
      }))();
    const settled = await settleWithin(agent, abort.signal, this.agentStopGraceMs);
    clearTimeout(watchdog);
    shutdown.removeEventListener("abort", onShutdown);
    polling.abort();
    await poller;
    await writer.close();

    let result: AgentRunResult | null = null;
    if (settled.kind === "result") {
      result = settled.value;
    } else if (settled.kind === "threw") {
      log.error({ err: settled.error, runId }, "agent run threw");
    } else {
      log.error({ runId, stop, graceMs: this.agentStopGraceMs }, "the agent did not return after its stop; ending the run without it");
      // Whatever it spends from here on is still today's spend.
      void agent.then(
        (late) => this.recordSpend(spend, runId, late.usd),
        () => undefined,
      );
    }
    // The spend is real whoever writes run.end, so it is recorded before anything can return.
    if (result) await this.recordSpend(spend, runId, result.usd);
    if (writer.failure instanceof SeqTakenError) {
      // An orphan finalizer ended this run while it was stalled. The stored run.end stands.
      log.warn({ runId, seq: writer.failure.seq }, "agent run was ended by another writer; stopping");
      return;
    }

    const outcome = agentOutcome(result, stop, writer.failure !== null);
    if (result) {
      const { ledger } = result;
      try {
        // Repeating it is safe: records already stored for the run are skipped.
        await withRetries("ledger write", { runId }, () => insertLedgerSnapshot(this.db, runId, ledger));
      } catch (err) {
        log.error({ err, runId }, "could not store the ledger of an agent run");
      }
    }
    const elapsedMs = Date.now() - run.startedAt;
    try {
      // runAgent failed before its first event: the stream still opens with run.created.
      if (writer.stored === 0) await writer.append(runCreatedInput(run));
      await writer.append({ type: "run.end", status: outcome.status, elapsedMs, reason: outcome.reason });
      const patch = agentRunPatch(result, outcome, elapsedMs, spend.recorded);
      // A repeat after a lost reply finds the status already set and changes nothing.
      await withRetries("end-of-run status write", { runId }, () =>
        setStatus(this.db, runId, outcome.status, { from: ACTIVE_STATUSES, patch }),
      );
      log.info({ runId, status: outcome.status, events: writer.stored, elapsedMs, usd: spend.recorded }, "agent run ended");
      await this.settlePendingFollows(runId, outcome.status);
    } catch (err) {
      if (err instanceof SeqTakenError) {
        log.warn({ runId, seq: err.seq }, "agent run was ended by another writer; stopping");
        return;
      }
      // As for fake runs: finalizeOrphan rebuilds the row from a stored run.end or ends the run incomplete.
      log.error({ err, runId, seq: writer.stored }, "could not record the end of an agent run");
    }
  }

  /** Raises the run's recorded LLM spend to `usd`; a failed write is logged, and the next call catches up. */
  private async recordSpend(spend: SpendMeter, runId: string, usd: number): Promise<void> {
    try {
      await spend.upTo(usd);
    } catch (err) {
      log.error({ err, runId, usd }, "could not record the LLM spend of an agent run");
    }
  }

  /** Polls the database cancel flag until `signal` aborts; calls `onCancel` once when it is raised. */
  private async pollCancel(runId: string, signal: AbortSignal, onCancel: () => void): Promise<void> {
    while (!signal.aborted) {
      await sleep(this.cancelPollMs, signal);
      if (signal.aborted) return;
      try {
        if (await isCancelRequested(this.db, runId)) {
          onCancel();
          return;
        }
      } catch (err) {
        log.warn({ err, runId }, "cancel flag check failed; continuing");
      }
    }
  }

  /**
   * Bookkeeping once an agent event is stored: pillar and job after CLERK, LLM spend as it grows, and the
   * side context calls' share of it per UTC day (usage_daily, for /status): their spend is already in the
   * run's LLM total, so these counters are a breakdown, never added to the daily breaker twice.
   */
  private async afterAgentEvent(runId: string, lane: Lane, event: RunEvent, spend: SpendMeter): Promise<void> {
    try {
      if (event.type === "clerk") {
        await updateRun(this.db, runId, { pillar: event.intent.pillar, job: event.intent.job, intent: event.intent });
      } else if (event.type === "usage") {
        await spend.upTo(event.llmUsd);
      } else if (event.type === "context.ai" || event.type === "context.web") {
        const day = utcDay(Date.now());
        const lanes = [lane, "all"];
        const metric = event.type === "context.ai" ? CONTEXT_AI_USD_METRIC : CONTEXT_WEB_USD_METRIC;
        if (event.usd > 0) await incrementQlooUsage(this.db, { day, lanes, by: event.usd, metric });
        if (event.type === "context.web" && !event.block.cached && event.block.searches > 0) {
          await incrementQlooUsage(this.db, { day, lanes, by: event.block.searches, metric: WEB_SEARCHES_METRIC });
        }
      }
    } catch (err) {
      log.warn({ err, runId, type: event.type }, "run bookkeeping failed; continuing");
    }
  }

  /**
   * Follows whose re-run waits on `runId` (follows.pending_run_id). Server-side only: keyed by run, read
   * without a visitor key, and written back through the visitor-scoped repos.
   */
  private async pendingFollows(runId: string): Promise<{ id: string; visitorKey: string }[]> {
    return this.db.query.follows.findMany({
      columns: { id: true, visitorKey: true },
      where: (follow, { eq }) => eq(follow.pendingRunId, runId),
    });
  }

  /** A picker answer started `next` for the run a follow waited on: the follow now waits on `next`. */
  private async movePendingFollows(waiting: string, next: string): Promise<void> {
    try {
      for (const follow of await this.pendingFollows(waiting)) await setPending(this.db, follow.id, next);
    } catch (err) {
      log.warn({ err, runId: waiting, next }, "could not move a follow's pending re-run to the picked run");
    }
  }

  /**
   * A run a follow waited on has ended: with a note, the follow points at it and stops waiting; still at
   * a picker, it keeps waiting (the next pick moves it on); otherwise it stops waiting and keeps its last note.
   */
  private async settlePendingFollows(runId: string, status: RunStatus): Promise<void> {
    if (status === "needs_input") return;
    try {
      for (const follow of await this.pendingFollows(runId)) {
        if (status === "completed" || status === "incomplete") await setFollowLatestRun(this.db, follow.visitorKey, follow.id, runId);
        await setPending(this.db, follow.id, null);
      }
    } catch (err) {
      log.warn({ err, runId, status }, "could not settle the follows waiting on a run");
    }
  }

  private async persist(event: RunEvent): Promise<void> {
    await withRetries(
      "event write",
      { runId: event.runId, seq: event.seq },
      async () => {
        if (await appendRunEvent(this.db, event)) return;
        // The seq is taken: by our own earlier attempt whose reply was lost (fine), or by another
        // writer, in which case this event must not be published.
        const stored = await readEventAt(this.db, event.runId, event.seq);
        if (stored && sameEvent(stored, event)) return;
        throw new SeqTakenError(event.runId, event.seq);
      },
      (err) => err instanceof SeqTakenError,
    );
  }
}
