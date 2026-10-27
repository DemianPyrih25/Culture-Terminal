// The run manager's agent path against a real Postgres in a throwaway database, with a scripted
// runAgent: no model and no Qloo call is made. Skips only when no database is reachable.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { pickerKey, type AgentRunOptions, type AgentRunResult } from "@ct/agent";
import {
  parseRunEvent,
  reduceRunEvents,
  type EventInput,
  type Intent,
  type PickerCandidate,
  type QlooSearchEntity,
  type RunEvent,
} from "@ct/contracts";
import type { QlooClient } from "@ct/qloo";
import { searchParams } from "@ct/quant";
import {
  countRunsSince,
  deleteKv,
  getQlooUsage,
  getRun,
  incrementQlooUsage,
  listLedgerRows,
  requestCancel,
  setKv,
} from "@ct/db";
import { EventBus } from "../server/event-bus";
import { readAllEvents } from "../server/event-store";
import { LLM_USD_METRIC, PRE_RUN_USD, todayLlmUsd } from "../server/llm-spend";
import { MODE_KV_KEY, readMode, writeMode } from "../server/mode";
import { QUESTION_HASH_PREFIX, questionHash } from "../server/question-hash";
import {
  ORPHAN_REASON,
  RunManager,
  runManagerErrorCode,
  runManagerRetryAfterS,
  type RunAgentFn,
  type RunManagerErrorCode,
  type RunManagerOptions,
} from "../server/run-manager";
import {
  agentDeps,
  agentResult,
  completedAgent,
  deferred,
  mockQlooClient,
  needsInputAgent,
  NO_MODEL_CALLS,
  runCreated,
  SPENT_USD,
  TEST_MODEL,
  TOTAL_USD,
  waitingAgent,
} from "./support/agent";
import { testModes } from "./support/protection";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./support/test-db";

vi.mock("server-only", () => ({}));

const available = await databaseAvailable();

const HOUR = 3_600_000;
const QUESTION = "Is the Juniper Cola audience a moat or a niche?";
const today = () => new Date().toISOString().slice(0, 10);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await sleep(20);
  }
}

function expectGapFree(events: RunEvent[]): void {
  expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
}

function endOf(events: RunEvent[]): Extract<RunEvent, { type: "run.end" }> {
  const last = events.at(-1);
  if (last?.type !== "run.end") throw new Error(`expected run.end last, got ${last?.type}`);
  return last;
}

const refusedWith = (code: RunManagerErrorCode) => (err: unknown) => runManagerErrorCode(err) === code;

const REFUSED_INTENT: Intent = {
  pillar: "audience",
  job: "audience_discovery",
  mentions: [{ text: "Rowan Vale", entity_type: "person", role: "primary", public_figure: false }],
  geo: { metro: null, area: null, unsupported_place: null, market: null },
  constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [] },
  safety: { allowed: false, category: "private_individual", reframe: null },
  assumptions: [],
  mnemonic: "ROWAN VALE <PERSON> AUD",
};

// The mock transport answers a "twin" query with two exact matches: the ambiguous picker.
const TWIN_MENTION = "Twin Cola";
const TWIN_QUESTION = "Is the Twin Cola audience a moat or a niche?";
const TWIN_INTENT: Intent = {
  ...REFUSED_INTENT,
  pillar: "investment",
  job: "brand_health",
  mentions: [{ text: TWIN_MENTION, entity_type: "brand", role: "primary", public_figure: false }],
  safety: { allowed: true, category: null, reframe: null },
  mnemonic: "TWIN COLA <BRAND> HLTH",
};

const candidateOf = (r: QlooSearchEntity): PickerCandidate => ({
  key: pickerKey(r.entity_id),
  name: r.name,
  disambiguation: r.disambiguation ?? null,
  popularity: r.popularity ?? null,
});

/** The mention's /search as the gate runs it, through this client. */
async function twinSearch(qloo: QlooClient): Promise<QlooSearchEntity[]> {
  const params = searchParams({ text: TWIN_MENTION, type: "brand", metro: null });
  if (params === null) throw new Error("no search params for the mention");
  return (await qloo.standalone().forTool(null).search(params)).data.results;
}

/** Emits run.created, then never returns, whatever its signal does. */
function stuckAgent(started: { resolve(): void }, until: Promise<AgentRunResult> = new Promise(() => {})): RunAgentFn {
  return async (o) => {
    o.emit(runCreated(o));
    started.resolve();
    const result = await until;
    o.emit({ type: "note", text: "Back after the run ended." });
    return result;
  };
}

describe.skipIf(!available)("agent runs against Postgres", () => {
  let t: TestDatabase | undefined;
  const managers: RunManager[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(managers.map((m) => m.drain(0)));
    await t?.dispose();
  }, 60_000);

  function setup(options: Partial<Omit<RunManagerOptions, "db" | "bus">> = {}) {
    const db = t!.db;
    const bus = new EventBus();
    const runs = new RunManager({
      db,
      bus,
      cancelPollMs: 50,
      agent: agentDeps(),
      runAgent: completedAgent(),
      agentHourlyCap: 10_000,
      llmDailyUsdCap: 10_000,
      ...options,
    });
    managers.push(runs);
    return { db, bus, runs };
  }

  function record(bus: EventBus, runId: string): RunEvent[] {
    const out: RunEvent[] = [];
    bus.subscribe(runId, { onEvent: (event) => out.push(event) });
    return out;
  }

  /** Starts a run with this agent and waits for its end; returns the stored events and the row. */
  async function runToEnd(runAgent: RunAgentFn, question = QUESTION) {
    const { db, runs } = setup({ runAgent });
    const { runId } = await runs.startAgentRun({ question, lane: "public" });
    await runs.whenDone(runId);
    const events = await readAllEvents(db, runId);
    expectGapFree(events);
    return { runId, events, run: await getRun(db, runId) };
  }

  it("stores and publishes every event in emit order, then fills the runs row, the ledger and the spend", async () => {
    const go = deferred();
    let received: AgentRunOptions | undefined;
    const { db, bus, runs } = setup({ runAgent: completedAgent({ beforeStart: go.promise, onStart: (o) => (received = o) }) });
    const day = today();
    const before = {
      publicLane: await getQlooUsage(db, { day, lane: "public", metric: LLM_USD_METRIC }),
      all: await todayLlmUsd(db),
    };

    const { runId } = await runs.startAgentRun({ question: `  ${QUESTION}\n`, lane: "public" });
    const published = record(bus, runId);
    go.resolve();
    await runs.whenDone(runId);

    const events = await readAllEvents(db, runId);
    expectGapFree(events);
    expect(published).toEqual(events);
    for (const event of events) expect(() => parseRunEvent(event)).not.toThrow();
    expect(events[0]).toMatchObject({ type: "run.created", question: QUESTION, model: TEST_MODEL, parentRunId: null });
    expect(endOf(events)).toMatchObject({ status: "completed", reason: null });
    expect(events.filter((e) => e.type === "run.end")).toHaveLength(1);
    expect(received).toMatchObject({ runId, question: QUESTION, lane: "public", mode: "live", pins: undefined, parent: null });

    const state = reduceRunEvents(runId, events);
    const run = await getRun(db, runId);
    expect(run).toMatchObject({
      status: "completed",
      question: QUESTION,
      mode: "live",
      lane: "public",
      model: TEST_MODEL,
      effort: "medium",
      pillar: "investment",
      job: "brand_health",
      llmUsd: TOTAL_USD,
      tokens: 2100,
      qlooNetwork: 5,
      qlooCached: 4,
      error: null,
    });
    expect(run?.questionHash).toBe(questionHash(QUESTION, undefined, "live"));
    expect(run?.questionHash.startsWith(QUESTION_HASH_PREFIX)).toBe(true);
    expect(run?.report).toEqual(state.report);
    expect(run?.validation).toEqual({ issues: [], numbersTraced: state.report?.receipt.numbersTraced });
    expect(run?.intent).toEqual(state.intent);
    expect(run?.wallMs).toBeGreaterThanOrEqual(0);

    // The repo returns each table in id order; the trace may emit ids out of order.
    const inIdOrder = (ids: string[]) => [...ids].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
    const ledger = await listLedgerRows(db, runId);
    expect(ledger.evidence.map((e) => e.id)).toEqual(inIdOrder(Object.keys(state.evidence)));
    expect(ledger.metrics.map((m) => m.id)).toEqual(inIdOrder(Object.keys(state.metrics)));
    expect(ledger.datasets.map((d) => d.id)).toEqual(
      inIdOrder(Object.values(state.datasets).flatMap((d) => (d.data ? [d.id] : []))),
    );
    expect(ledger.datasets.every((d) => d.bytes > 0)).toBe(true);
    expect(ledger.findings.map((f) => f.id)).toEqual(inIdOrder(state.findings.map((f) => f.id)));

    // The usage event recorded 0.12 as it arrived; the result topped it up to 0.15.
    expect(await getQlooUsage(db, { day, lane: "public", metric: LLM_USD_METRIC })).toBeCloseTo(before.publicLane + TOTAL_USD, 9);
    expect(await todayLlmUsd(db)).toBeCloseTo(before.all + TOTAL_USD, 9);
  }, 30_000);

  it("records pillar and job once CLERK has read the question, while the run goes on", async () => {
    const afterClerk = deferred();
    const { db, runs } = setup({ runAgent: completedAgent({ afterClerk: afterClerk.promise }) });
    const { runId } = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await until(async () => (await getRun(db, runId))?.pillar === "investment");
    expect(await getRun(db, runId)).toMatchObject({ status: "running", job: "brand_health" });
    expect(runs.isLive(runId)).toBe(true);
    afterClerk.resolve();
    await runs.whenDone(runId);
    expect((await getRun(db, runId))?.status).toBe("completed");
  }, 30_000);

  it("records spend as usage events arrive, so a run that dies keeps its cost", async () => {
    const { run, events } = await runToEnd(async (o) => {
      o.emit(runCreated(o));
      o.emit({
        type: "usage",
        llmUsd: SPENT_USD,
        tokens: { input: 10, output: 1, cacheRead: 0, cacheCreation: 0 },
        qloo: { network: 0, cached: 0, reused: 0 },
        elapsedMs: 10,
      });
      throw new Error("the agent fell over after spending");
    });
    expect(endOf(events)).toMatchObject({ status: "failed", reason: "The analysis hit an internal error." });
    expect(run).toMatchObject({ status: "failed", llmUsd: SPENT_USD, error: { reason: "The analysis hit an internal error." } });
  }, 30_000);

  it("ends needs_input with the picker on the stream and no report", async () => {
    const { run, events } = await runToEnd(async (o) => {
      o.emit(runCreated(o));
      o.emit({
        type: "needs_input",
        mention: "Juniper",
        entityType: "brand",
        reason: "ambiguous",
        candidates: [
          { key: "pick-a", name: "Juniper Cola", disambiguation: "soft drink", popularity: 0.6 },
          { key: "pick-b", name: "Juniper Tonic", disambiguation: null, popularity: 0.3 },
        ],
      });
      return agentResult({ status: "needs_input", reason: "Pick the brand you meant.", model: null });
    });
    expect(events.map((e) => e.type)).toEqual(["run.created", "needs_input", "run.end"]);
    expect(endOf(events)).toMatchObject({ status: "needs_input", reason: "Pick the brand you meant." });
    expect(run).toMatchObject({ status: "needs_input", report: null, error: null, model: TEST_MODEL });
  }, 30_000);

  it("ends refused with CLERK's intent and no Qloo calls", async () => {
    const { run, events } = await runToEnd(async (o) => {
      o.emit(runCreated(o));
      o.emit({ type: "clerk", intent: REFUSED_INTENT, ms: 640 });
      return agentResult({ status: "refused", intent: REFUSED_INTENT, model: null, reason: "Questions about private individuals are out of scope." });
    });
    expect(endOf(events)).toMatchObject({ status: "refused", reason: "Questions about private individuals are out of scope." });
    expect(run).toMatchObject({ status: "refused", pillar: "audience", job: "audience_discovery", report: null, error: null });
  }, 30_000);

  it("stops at the database cancel flag and ends cancelled, whatever status the agent returns", async () => {
    const started = deferred();
    const { db, runs } = setup({ runAgent: waitingAgent("incomplete", started) });
    const { runId } = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await started.promise;
    expect(await requestCancel(db, runId)).toBe(true);
    await runs.whenDone(runId);
    const events = await readAllEvents(db, runId);
    expectGapFree(events);
    expect(endOf(events)).toMatchObject({ status: "cancelled", reason: "Cancelled by the viewer." });
    expect(await getRun(db, runId)).toMatchObject({ status: "cancelled", error: null });
  }, 30_000);

  it("keeps a completed note when the cancel arrives as it finishes", async () => {
    const started = deferred();
    const { db, runs } = setup({
      runAgent: async (o) => {
        o.emit(runCreated(o));
        started.resolve();
        await new Promise<void>((resolve) => o.signal.addEventListener("abort", () => resolve(), { once: true }));
        return agentResult({ status: "completed" });
      },
    });
    const { runId } = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await started.promise;
    await requestCancel(db, runId);
    await runs.whenDone(runId);
    expect(endOf(await readAllEvents(db, runId)).status).toBe("completed");
  }, 30_000);

  it("on shutdown marks a running agent run incomplete, as for fake runs", async () => {
    const started = deferred();
    const { db, runs } = setup({ runAgent: waitingAgent("cancelled", started) });
    const { runId } = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await started.promise;
    const drained = runs.drain(0);
    await expect(runs.startAgentRun({ question: QUESTION, lane: "public" })).rejects.toSatisfy(refusedWith("not_accepting"));
    expect(await drained).toEqual({ finished: 0, stopped: 1 });
    const events = await readAllEvents(db, runId);
    expectGapFree(events);
    const reason = "The server shut down before this run finished.";
    expect(endOf(events)).toMatchObject({ status: "incomplete", reason });
    expect(await getRun(db, runId)).toMatchObject({ status: "incomplete", error: { reason } });
  }, 30_000);

  it("ends failed with an opening run.created when the agent throws before its first event", async () => {
    const { run, events } = await runToEnd(() => {
      throw new Error("runAgent: not implemented yet");
    });
    expect(events.map((e) => e.type)).toEqual(["run.created", "run.end"]);
    expect(events[0]).toMatchObject({ question: QUESTION, mode: "live", lane: "public", model: TEST_MODEL });
    expect(endOf(events)).toMatchObject({ status: "failed", reason: "The analysis hit an internal error." });
    expect(run).toMatchObject({ status: "failed", error: { reason: "The analysis hit an internal error." } });
    expect(await listLedgerRows(t!.db, events[0]!.runId)).toEqual({ evidence: [], metrics: [], datasets: [], findings: [] });
  }, 30_000);

  it("drops events that break the contracts and any run.end from the agent", async () => {
    const { events } = await runToEnd(async (o) => {
      o.emit(runCreated(o));
      o.emit({ type: "note", text: 42 } as unknown as EventInput);
      o.emit({ type: "run.end", status: "completed", elapsedMs: 1, reason: null });
      o.emit({ type: "note", text: "Still going." });
      return agentResult({ status: "completed" });
    });
    expect(events.map((e) => e.type)).toEqual(["run.created", "note", "run.end"]);
    expect(events[1]).toMatchObject({ text: "Still going." });
  }, 30_000);

  it("runs in economy mode with the economy model, and refuses live runs in replay-only mode", async () => {
    let received: AgentRunOptions | undefined;
    const economy = setup({ agent: agentDeps({}, "economy"), runAgent: completedAgent({ onStart: (o) => (received = o) }) });
    const { runId } = await economy.runs.startAgentRun({ question: QUESTION, lane: "public" });
    await economy.runs.whenDone(runId);
    expect(received?.mode).toBe("economy");
    expect(await getRun(economy.db, runId)).toMatchObject({ mode: "economy", effort: "medium" });
    expect((await getRun(economy.db, runId))?.questionHash).toBe(questionHash(QUESTION, undefined, "economy"));

    const paused = setup({ agent: agentDeps({}, "replay_only") });
    await expect(paused.runs.startAgentRun({ question: QUESTION, lane: "public" })).rejects.toSatisfy(refusedWith("unavailable"));
    expect(paused.runs.activeCount()).toBe(0);
  }, 30_000);

  it("refuses live runs without an Anthropic key, a Qloo client or agent deps, and still runs test runs", async () => {
    const noKey = setup({ agent: agentDeps({ anthropic: () => null }), fakeRunSeconds: 1 });
    await expect(noKey.runs.startAgentRun({ question: QUESTION, lane: "public" })).rejects.toSatisfy(
      (err) => refusedWith("unavailable")(err) && String((err as Error).message).includes("Anthropic API key"),
    );
    const fake = await noKey.runs.startFakeRun();
    await noKey.runs.whenDone(fake.runId);
    expect((await getRun(noKey.db, fake.runId))?.status).toBe("completed");

    const noQloo = setup({
      agent: agentDeps({
        qloo: () => {
          throw new Error("QLOO_API_KEY is not set.");
        },
      }),
    });
    await expect(noQloo.runs.startAgentRun({ question: QUESTION, lane: "public" })).rejects.toSatisfy(refusedWith("unavailable"));
    const noDeps = setup({ agent: undefined });
    await expect(noDeps.runs.startAgentRun({ question: QUESTION, lane: "public" })).rejects.toSatisfy(refusedWith("unavailable"));
    await expect(noDeps.runs.startAgentRun({ question: " \u200B\n", lane: "public" })).rejects.toSatisfy(refusedWith("invalid"));
  }, 30_000);

  it("refuses agent runs beyond the rolling hourly cap, counted apart from fake runs", async () => {
    const existing = await countRunsSince(t!.db, { hashPrefix: QUESTION_HASH_PREFIX, sinceMs: HOUR });
    const { runs } = setup({ agentHourlyCap: existing + 1, fakeRunSeconds: 1 });
    const first = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await runs.whenDone(first.runId);
    // "limited", not "busy": the browser must not retry a cap that clears within the hour.
    await expect(runs.startAgentRun({ question: QUESTION, lane: "public" })).rejects.toSatisfy(
      (err) => refusedWith("limited")(err) && runManagerRetryAfterS(err) === 3600,
    );
    expect(runs.activeCount()).toBe(0);
    const fake = await runs.startFakeRun();
    await runs.whenDone(fake.runId);
  }, 30_000);

  it("holds PRE_RUN_USD of today's budget for each run in flight, so concurrent starts cannot pass the cap together", async () => {
    const spent = await todayLlmUsd(t!.db);
    const { db, runs } = setup({ llmDailyUsdCap: spent + 3 * PRE_RUN_USD - 0.01, agentMaxActive: 10, runAgent: waitingAgent() });
    const starts = await Promise.allSettled(Array.from({ length: 6 }, () => runs.startAgentRun({ question: QUESTION, lane: "public" })));
    const admitted = starts.flatMap((s) => (s.status === "fulfilled" ? [s.value.runId] : []));
    expect(admitted).toHaveLength(2);
    for (const s of starts) if (s.status === "rejected") expect(runManagerErrorCode(s.reason)).toBe("limited");
    expect(runs.activeCount()).toBe(2);

    // The hold leaves with the run.
    await requestCancel(db, admitted[0]!);
    await runs.whenDone(admitted[0]!);
    const third = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    for (const runId of [admitted[1]!, third.runId]) {
      await requestCancel(db, runId);
      await runs.whenDone(runId);
    }
  }, 30_000);

  it("counts what a run in flight has recorded against its hold", async () => {
    const spent = await todayLlmUsd(t!.db);
    const recorded = 0.3;
    const { db, runs } = setup({
      // Room for today's spend plus the 0.05 the first run still holds plus one more run.
      llmDailyUsdCap: spent + recorded + (PRE_RUN_USD - recorded) + PRE_RUN_USD + 0.005,
      runAgent: async (o) => {
        o.emit(runCreated(o));
        o.emit({
          type: "usage",
          llmUsd: recorded,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 },
          qloo: { network: 0, cached: 0, reused: 0 },
          elapsedMs: 5,
        });
        await new Promise<void>((resolve) => o.signal.addEventListener("abort", () => resolve(), { once: true }));
        return agentResult({ status: "cancelled", model: null });
      },
    });
    const first = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await until(async () => (await todayLlmUsd(db)) >= spent + recorded - 1e-9);
    const second = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    for (const { runId } of [first, second]) {
      await requestCancel(db, runId);
      await runs.whenDone(runId);
    }
  }, 30_000);

  it("holds at most agentMaxActive agent runs, apart from test runs", async () => {
    const started = deferred();
    const { db, runs } = setup({ agentMaxActive: 1, fakeRunSeconds: 1, runAgent: waitingAgent("incomplete", started) });
    const first = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await started.promise;
    await expect(runs.startAgentRun({ question: QUESTION, lane: "public" })).rejects.toSatisfy(refusedWith("busy"));
    const fake = await runs.startFakeRun();
    await runs.whenDone(fake.runId);
    await requestCancel(db, first.runId);
    await runs.whenDone(first.runId);
  }, 30_000);

  it("keeps the agent slots apart from test runs: test runs that fill their own cap never refuse a live run", async () => {
    const started = deferred();
    const { db, runs } = setup({ fakeMaxActive: 2, agentMaxActive: 1, fakeRunSeconds: 60, runAgent: waitingAgent("incomplete", started) });
    const fakes = [await runs.startFakeRun(), await runs.startFakeRun()];
    await expect(runs.startFakeRun()).rejects.toSatisfy(refusedWith("busy"));
    const live = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await started.promise;
    expect(runs.activeCount()).toBe(3);
    await expect(runs.startAgentRun({ question: QUESTION, lane: "public" })).rejects.toSatisfy(refusedWith("busy"));
    for (const { runId } of [...fakes, live]) {
      await requestCancel(db, runId);
      await runs.whenDone(runId);
    }
  }, 30_000);

  it("drains a run whose agent ignores its signal: after the grace it ends incomplete without it", async () => {
    const started = deferred();
    const { db, runs } = setup({ agentStopGraceMs: 50, runAgent: stuckAgent(started) });
    const { runId } = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await started.promise;
    expect(await runs.drain(0)).toEqual({ finished: 0, stopped: 1 });
    expect(runs.activeCount()).toBe(0);
    const events = await readAllEvents(db, runId);
    expectGapFree(events);
    const reason = "The server shut down before this run finished.";
    expect(endOf(events)).toMatchObject({ status: "incomplete", reason });
    expect(await getRun(db, runId)).toMatchObject({ status: "incomplete", error: { reason } });
  }, 30_000);

  it("stops a run at the watchdog, frees its slot, ignores the late result and still records its spend", async () => {
    const started = deferred();
    let finishLate: (result: AgentRunResult) => void = () => {};
    const late = new Promise<AgentRunResult>((resolve) => (finishLate = resolve));
    const { db, runs } = setup({ agentWatchdogMs: 100, agentStopGraceMs: 50, runAgent: stuckAgent(started, late) });
    const before = await todayLlmUsd(db);
    const { runId } = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await started.promise;
    await runs.whenDone(runId);
    expect(runs.activeCount()).toBe(0);
    const reason = "The run went past its time limit and was stopped.";
    expect(await getRun(db, runId)).toMatchObject({ status: "incomplete", error: { reason } });

    finishLate(agentResult({ status: "completed", usd: 0.05 }));
    await until(async () => (await todayLlmUsd(db)) >= before + 0.05 - 1e-9);
    const events = await readAllEvents(db, runId);
    expect(events.map((e) => e.type)).toEqual(["run.created", "run.end"]);
    expect(endOf(events)).toMatchObject({ status: "incomplete", reason });
    expect((await getRun(db, runId))?.status).toBe("incomplete");
  }, 30_000);

  it("refuses to start when today's LLM spend plus the pre-run reserve would pass the daily cap", async () => {
    const spent = await todayLlmUsd(t!.db);
    const tight = setup({ llmDailyUsdCap: spent + PRE_RUN_USD - 0.01 });
    await expect(tight.runs.startAgentRun({ question: QUESTION, lane: "public" })).rejects.toSatisfy(refusedWith("budget"));
    expect(tight.runs.activeCount()).toBe(0);

    const roomy = setup({ llmDailyUsdCap: spent + PRE_RUN_USD + 0.01 });
    const { runId } = await roomy.runs.startAgentRun({ question: QUESTION, lane: "public" });
    await roomy.runs.whenDone(runId);
    expect((await getRun(t!.db, runId))?.status).toBe("completed");
  }, 30_000);

  it("normalises pins, passes them to the agent and keys the question hash on them", async () => {
    let received: AgentRunOptions | undefined;
    const { db, runs } = setup({ runAgent: completedAgent({ onStart: (o) => (received = o) }) });
    const { runId } = await runs.startAgentRun({
      question: QUESTION,
      lane: "public",
      pins: { "The Juniper Cola Co.": " entity-alpha ", "   ": "entity-beta" },
    });
    await runs.whenDone(runId);
    const pins = { "juniper cola": "entity-alpha" };
    expect(received?.pins).toEqual(pins);
    const run = await getRun(db, runId);
    expect(run?.pins).toEqual(pins);
    expect(run?.questionHash).toBe(questionHash(QUESTION, pins, "live"));
    expect(run?.questionHash).not.toBe(questionHash(QUESTION, undefined, "live"));
  }, 30_000);

  it("starts a child run from a finished note with its case summary, and refuses a parent without one", async () => {
    const parent = await runToEnd(completedAgent());
    let received: AgentRunOptions | undefined;
    const { db, runs } = setup({ runAgent: completedAgent({ onStart: (o) => (received = o) }) });
    const { runId } = await runs.startAgentRun({ question: "Where does that audience travel?", lane: "public", parentRunId: parent.runId });
    await runs.whenDone(runId);
    expect(received?.parent?.runId).toBe(parent.runId);
    expect(received?.parent?.caseSummary).toContain(`CASE SUMMARY from run ${parent.runId}`);
    const child = await getRun(db, runId);
    expect(child?.parentRunId).toBe(parent.runId);
    // Keyed on its parent: the follow-up never answers the same words asked on their own.
    expect(child?.questionHash).toBe(questionHash("Where does that audience travel?", undefined, "live", parent.runId));
    expect(child?.questionHash).not.toBe(questionHash("Where does that audience travel?", undefined, "live"));
    expect((await readAllEvents(db, runId))[0]).toMatchObject({ type: "run.created", parentRunId: parent.runId });

    await expect(runs.startAgentRun({ question: QUESTION, lane: "public", parentRunId: "no-such-run-0000" })).rejects.toSatisfy(
      refusedWith("invalid"),
    );
    const unfinished = await runToEnd(async (o) => {
      o.emit(runCreated(o));
      return agentResult({ status: "needs_input", reason: "Pick one.", model: null });
    });
    await expect(runs.startAgentRun({ question: QUESTION, lane: "public", parentRunId: unfinished.runId })).rejects.toSatisfy(
      refusedWith("invalid"),
    );
    // A completed test run stores a contract-valid note of invented numbers: never a parent.
    const testRuns = setup({ fakeRunSeconds: 1 });
    const fake = await testRuns.runs.startFakeRun();
    await testRuns.runs.whenDone(fake.runId);
    expect(await getRun(db, fake.runId)).toMatchObject({ status: "completed", report: expect.anything() });
    await expect(runs.startAgentRun({ question: QUESTION, lane: "public", parentRunId: fake.runId })).rejects.toSatisfy(
      refusedWith("invalid"),
    );
  }, 30_000);

  describe("picker answers", () => {
    /** A needs_input run on TWIN_INTENT offering these candidates, started with these trusted pins and parent. */
    async function waitingRun(qloo: QlooClient, candidates: PickerCandidate[], start: { pins?: Record<string, string>; parentRunId?: string } = {}) {
      const { db, runs } = setup({
        agent: agentDeps({ qloo: () => qloo }),
        runAgent: needsInputAgent(TWIN_INTENT, { mention: TWIN_MENTION, entityType: "brand", reason: "ambiguous", candidates }),
      });
      const { runId } = await runs.startAgentRun({ question: TWIN_QUESTION, lane: "public", ...start });
      await runs.whenDone(runId);
      expect((await getRun(db, runId))?.status).toBe("needs_input");
      return runId;
    }

    it("re-asks the question with the chosen entity pinned, mapped from the opaque key on the server", async () => {
      const qloo = mockQlooClient();
      const results = await twinSearch(qloo);
      expect(results.length).toBeGreaterThanOrEqual(2);
      const parent = await runToEnd(completedAgent());
      const waitingId = await waitingRun(qloo, results.slice(0, 2).map(candidateOf), {
        pins: { "Other Brand": "entity-other" },
        parentRunId: parent.runId,
      });

      let received: AgentRunOptions | undefined;
      const { db, runs } = setup({ agent: agentDeps({ qloo: () => qloo }), runAgent: completedAgent({ onStart: (o) => (received = o) }) });
      const { runId } = await runs.answerPicker({ runId: waitingId, key: pickerKey(results[1]!.entity_id), lane: "public" });
      await runs.whenDone(runId);

      // The waiting run's pins and parent carry over; the choice is keyed by the normalised mention.
      const pins = { "other brand": "entity-other", "twin cola": results[1]!.entity_id };
      expect(received).toMatchObject({ question: TWIN_QUESTION, pins, parent: { runId: parent.runId } });
      const run = await getRun(db, runId);
      expect(run).toMatchObject({ status: "completed", question: TWIN_QUESTION, pins, parentRunId: parent.runId });
      expect(run?.questionHash).toBe(questionHash(TWIN_QUESTION, pins, "live", parent.runId));
    }, 30_000);

    it("refuses a key the run did not offer, a key no longer in the search, a run not waiting, and a Qloo failure", async () => {
      const qloo = mockQlooClient();
      const results = await twinSearch(qloo);
      const gone: PickerCandidate = { key: pickerKey("entity-gone"), name: "Twin Cola Gone", disambiguation: null, popularity: null };
      const waitingId = await waitingRun(qloo, [candidateOf(results[0]!), gone]);
      const { runs } = setup({ agent: agentDeps({ qloo: () => qloo }) });
      const answer = (runId: string, key: string) => runs.answerPicker({ runId, key, lane: "public" });

      await expect(answer(waitingId, pickerKey(results[1]!.entity_id))).rejects.toSatisfy(refusedWith("invalid"));
      await expect(answer(waitingId, gone.key)).rejects.toSatisfy(refusedWith("invalid"));
      await expect(answer("no-such-run-0000", gone.key)).rejects.toSatisfy(refusedWith("invalid"));
      const finished = await runToEnd(completedAgent());
      await expect(answer(finished.runId, gone.key)).rejects.toSatisfy(refusedWith("invalid"));

      const down = {
        ...qloo,
        standalone: () => ({
          forTool: () => ({
            search: () => Promise.reject(new Error("Qloo is down")),
          }),
        }),
      } as unknown as QlooClient;
      const offline = setup({ agent: agentDeps({ qloo: () => down }) });
      await expect(offline.runs.answerPicker({ runId: waitingId, key: candidateOf(results[0]!).key, lane: "public" })).rejects.toSatisfy(
        refusedWith("unavailable"),
      );
      const paused = setup({ agent: agentDeps({ qloo: () => qloo }, "replay_only") });
      await expect(paused.runs.answerPicker({ runId: waitingId, key: candidateOf(results[0]!).key, lane: "public" })).rejects.toSatisfy(
        refusedWith("unavailable"),
      );
      expect(runs.activeCount() + offline.runs.activeCount() + paused.runs.activeCount()).toBe(0);
    }, 30_000);
  });

  it("stops a stalled agent run that lost its next seq to an orphan finalizer, without publishing past it", async () => {
    const go = deferred();
    const proceed = deferred();
    const { db, bus, runs: driver } = setup({
      runAgent: async (o) => {
        await go.promise;
        o.emit(runCreated(o));
        o.emit({ type: "note", text: "Before the stall." });
        await proceed.promise;
        o.emit({ type: "note", text: "After the stall." });
        o.emit({ type: "note", text: "Never stored." });
        return agentResult({ status: "completed", usd: 0.07 });
      },
    });
    const { runs: elsewhere } = setup();
    const spentBefore = await todayLlmUsd(db);
    const { runId } = await driver.startAgentRun({ question: QUESTION, lane: "public" });
    const published = record(bus, runId);
    go.resolve();
    await until(() => published.length === 2);

    expect(await elsewhere.finalizeOrphan(runId)).toBe(true);
    proceed.resolve();
    await driver.whenDone(runId);

    const events = await readAllEvents(db, runId);
    expectGapFree(events);
    expect(events.filter((e) => e.type === "run.end")).toHaveLength(1);
    expect(endOf(events)).toMatchObject({ seq: 3, status: "incomplete", reason: ORPHAN_REASON });
    expect(published).toEqual(events.slice(0, 2));
    expect((await getRun(db, runId))?.status).toBe("incomplete");
    // The spend is real whoever wrote run.end.
    expect(await todayLlmUsd(db)).toBeCloseTo(spentBefore + 0.07, 9);
  }, 30_000);

  describe("mode in kv", () => {
    it("reads what writeMode stores, a bare mode string, and treats anything else as live", async () => {
      const db = t!.db;
      expect(await readMode(db)).toBe("live");
      await writeMode(db, "replay_only", "qloo");
      expect(await readMode(db)).toBe("replay_only");
      await setKv(db, MODE_KV_KEY, "economy");
      expect(await readMode(db)).toBe("economy");
      await setKv(db, MODE_KV_KEY, { mode: "turbo" });
      expect(await readMode(db)).toBe("live");
      await deleteKv(db, MODE_KV_KEY);
    });

    it("lets the Qloo client's replay-only request reach kv through the container", async () => {
      const db = t!.db;
      const g = globalThis as { __ctContainer?: unknown };
      g.__ctContainer = { db };
      try {
        const container = await import("../server/container");
        expect(await container.getMode()).toBe("live");
        await container.setMode("replay_only", "qloo");
        expect(container.lastKnownMode()).toBe("replay_only");
        expect(await readMode(db)).toBe("replay_only");
        expect(await container.getMode()).toBe("replay_only");
      } finally {
        delete g.__ctContainer;
        await deleteKv(db, MODE_KV_KEY);
      }
    });
  });

  describe("route handlers", () => {
    async function withContainer<T>(container: object, fn: () => Promise<T>): Promise<T> {
      const g = globalThis as { __ctContainer?: unknown; __ctMigrationsApplied?: boolean };
      g.__ctContainer = container;
      g.__ctMigrationsApplied = true;
      try {
        return await fn();
      } finally {
        delete g.__ctContainer;
        delete g.__ctMigrationsApplied;
      }
    }

    const post = (body: unknown) =>
      new Request("http://test.local/api/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    it("POST {question} starts an agent run that streams to its end; an empty body still starts a test run", async () => {
      const { db, bus, runs } = setup({ fakeRunSeconds: 1 });
      const http = await import("../server/http");
      // Live whatever this file has spent today; the answer cache is this database's.
      await withContainer({ db, bus, runs, modes: testModes() }, async () => {
        const res = await http.startRun(post({ question: QUESTION, fresh: true }));
        expect(res.status).toBe(201);
        const { runId } = (await res.json()) as { runId: string };
        await runs.whenDone(runId);
        expect(await getRun(db, runId)).toMatchObject({ status: "completed", lane: "public", question: QUESTION });

        // The same question again: the completed brief answers it from the answer cache (D26), at once.
        const again = await http.startRun(post({ question: `  ${QUESTION.toUpperCase()} ` }));
        expect(again.status).toBe(200);
        expect(await again.json()).toEqual({ runId, cached: true });

        const fake = await http.startRun(new Request("http://test.local/api/runs", { method: "POST" }));
        expect(fake.status).toBe(201);
        const fakeId = ((await fake.json()) as { runId: string }).runId;
        await runs.whenDone(fakeId);
        expect((await getRun(db, fakeId))?.questionHash).toBe(`fake:${fakeId}`);
      });
    }, 30_000);

    it("answers 503 without retry when today's budget is spent, with Retry-After until midnight UTC", async () => {
      const { db, bus, runs } = setup({ llmDailyUsdCap: 0 });
      const http = await import("../server/http");
      // The breakers say live; the run manager's own pre-run check refuses.
      await withContainer({ db, bus, runs, modes: testModes() }, async () => {
        const res = await http.startRun(post({ question: QUESTION, fresh: true }));
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({ retry: false });
        const retryAfter = Number(res.headers.get("retry-after"));
        expect(retryAfter).toBeGreaterThan(0);
        expect(retryAfter).toBeLessThanOrEqual(86_400);
      });
    }, 30_000);

    it("reports mode, the Qloo quota and today's LLM spend on /api/health", async () => {
      const { db, bus, runs } = setup();
      await writeMode(db, "economy", "test");
      await incrementQlooUsage(db, { day: today(), lanes: ["public", "all"], by: 0.01, metric: LLM_USD_METRIC });
      // Thresholds far above what this file spends, so the stored mode is the one that shows.
      vi.stubEnv("LLM_DAILY_USD_CAP", "900");
      vi.stubEnv("LLM_ECONOMY_USD", "900");
      const http = await import("../server/http");
      try {
        await withContainer({ db, bus, runs, qloo: mockQlooClient(), anthropic: NO_MODEL_CALLS }, async () => {
          const res = await http.health();
          expect(res.status).toBe(200);
          const body = (await res.json()) as Record<string, unknown>;
          expect(body).toMatchObject({
            ok: true,
            mode: "economy",
            db: { ok: true },
            qloo: { env: "mock", today_network: 0, floor: 38_000, last_success: null, auth_errors: 0 },
            llm: { cap: 900, configured: true },
            lanes: { public: { mode: "economy", breaker: "stored" }, judge: { mode: "economy", breaker: "stored" } },
          });
          expect(body.qloo).toHaveProperty("month_remaining");
          const spent = await todayLlmUsd(db);
          expect((body.llm as { today_usd: number }).today_usd).toBeCloseTo(spent, 4);
          expect(spent).toBeGreaterThan(0);
        });
        await withContainer({ db, bus, runs, anthropic: null }, async () => {
          vi.stubEnv("QLOO_MOCK", "0");
          vi.stubEnv("QLOO_API_KEY", "");
          const body = (await (await http.health()).json()) as Record<string, unknown>;
          expect(body).toMatchObject({ ok: true, qloo: null, llm: { configured: false } });
        });
      } finally {
        vi.unstubAllEnvs();
        await deleteKv(db, MODE_KV_KEY);
      }
    }, 30_000);
  });
});
