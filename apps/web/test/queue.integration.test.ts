// The global run queue (D24) in the run manager against a real Postgres in a throwaway database, with
// scripted agents: no model and no Qloo call is made. Six runs held at once plus twelve waiting (PLAN
// §14), a full queue refused, a freed slot handed to the first in line, positions told as they change,
// a wait that runs out, a cancel while queued, queued runs counted against the visitor, and shutdown.
// Skips only when no database is reachable. Invented questions and visitor keys only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { queueTimeoutReason, RUN_QUEUE_FULL_MESSAGE, type RunEvent } from "@ct/contracts";
import { getRun, requestCancel } from "@ct/db";
import { EventBus } from "../server/event-bus";
import { agentDeps, waitingAgent } from "./support/agent";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./support/test-db";

vi.mock("server-only", () => ({}));

const available = await databaseAvailable();

const { readAllEvents } = await import("../server/event-store");
const { QUEUE_SHUTDOWN_REASON, RunManager, runManagerErrorCode } = await import("../server/run-manager");
type RunManagerOptions = ConstructorParameters<typeof RunManager>[0];

const QUESTION = "Is the Juniper Cola audience a moat or a niche?";

const refusal = async (start: Promise<unknown>) => {
  try {
    await start;
  } catch (err) {
    return { code: runManagerErrorCode(err), message: err instanceof Error ? err.message : String(err) };
  }
  throw new Error("expected a refusal");
};

const queuedPositions = (events: readonly RunEvent[]) =>
  events.flatMap((e) => (e.type === "run.queued" ? [e.position] : []));

describe.skipIf(!available)("the run queue against Postgres", () => {
  let t: TestDatabase | undefined;
  const managers: InstanceType<typeof RunManager>[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(managers.map((m) => m.drain(0)));
    await t?.dispose();
  }, 60_000);

  function setup(options: Partial<Omit<RunManagerOptions, "db" | "bus">> = {}) {
    const db = t!.db;
    const runs = new RunManager({
      db,
      bus: new EventBus(),
      cancelPollMs: 50,
      agent: agentDeps(),
      runAgent: waitingAgent("incomplete"),
      agentHourlyCap: 10_000,
      judgeHourlyCap: 10_000,
      llmDailyUsdCap: 10_000,
      agentMaxActive: 6,
      judgeMaxActive: 0,
      queueMax: 12,
      queueWaitMs: 60_000,
      ...options,
    });
    managers.push(runs);
    return { db, runs };
  }

  const events = (runId: string) => readAllEvents(t!.db, runId);

  it("holds 6 runs at once plus 12 waiting, refuses the next, and hands a freed slot to the first in line", async () => {
    const { db, runs } = setup();
    const started = [];
    for (let i = 0; i < 18; i++) started.push((await runs.startAgentRun({ question: `${QUESTION} (${i})`, lane: "public" })).runId);
    const [active, queued] = [started.slice(0, 6), started.slice(6)];
    expect(runs.activeCount()).toBe(6);
    expect(runs.queuedCount()).toBe(12);
    expect(await refusal(runs.startAgentRun({ question: QUESTION, lane: "public" }))).toEqual({ code: "busy", message: RUN_QUEUE_FULL_MESSAGE });

    for (const [i, runId] of queued.entries()) {
      expect(runs.isLive(runId)).toBe(true);
      expect((await getRun(db, runId))?.status).toBe("queued");
      await vi.waitFor(async () => expect(queuedPositions(await events(runId))).toEqual([i + 1]));
      const [created, place] = await events(runId);
      expect(created).toMatchObject({ type: "run.created", seq: 1, lane: "public" });
      expect(place).toMatchObject({ type: "run.queued", seq: 2, ahead: i });
      expect((place as Extract<RunEvent, { type: "run.queued" }>).waitSMax).toBeLessThanOrEqual(60);
    }

    // One run ends: the first in line takes its slot, and the rest move up one.
    await requestCancel(db, active[0]!);
    await runs.whenDone(active[0]!);
    const next = queued[0]!;
    await vi.waitFor(async () => expect((await getRun(db, next))?.status).toBe("running"));
    await vi.waitFor(async () => expect((await events(next)).map((e) => e.type)).toEqual(["run.created", "run.queued", "run.created", "note"]));
    expect(runs.activeCount()).toBe(6);
    expect(runs.queuedCount()).toBe(11);
    await vi.waitFor(async () => expect(queuedPositions(await events(queued[1]!))).toEqual([2, 1]));
    await vi.waitFor(async () => expect(queuedPositions(await events(queued[11]!))).toEqual([12, 11]));

    // Shutdown ends the waiting runs at once, unstarted, and stops the rest.
    expect(await runs.drain(0)).toEqual({ finished: 0, stopped: 17 });
    expect(runs.queuedCount()).toBe(0);
    const dropped = await events(queued[5]!);
    expect(dropped.at(-1)).toMatchObject({ type: "run.end", status: "failed", reason: QUEUE_SHUTDOWN_REASON });
    expect(await getRun(db, queued[5]!)).toMatchObject({ status: "failed", llmUsd: 0 });
    expect((await getRun(db, next))?.status).toBe("incomplete");
  }, 60_000);

  it("ends a run whose wait runs out with queue_timeout, and nothing spent", async () => {
    const { db, runs } = setup({ agentMaxActive: 1, queueWaitMs: 400 });
    const first = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    const late = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await runs.whenDone(late.runId);
    const stored = await events(late.runId);
    expect(stored.map((e) => e.type)).toEqual(["run.created", "run.queued", "error", "run.end"]);
    expect(stored[2]).toMatchObject({ code: "queue_timeout", retryable: true });
    expect(stored[3]).toMatchObject({ status: "failed", reason: queueTimeoutReason(0.4) });
    expect(await getRun(db, late.runId)).toMatchObject({ status: "failed", llmUsd: 0 });
    expect(runs.isLive(late.runId)).toBe(false);
    await requestCancel(db, first.runId);
    await runs.whenDone(first.runId);
  }, 30_000);

  it("cancels a queued run without starting it, and moves the runs behind it up", async () => {
    const { db, runs } = setup({ agentMaxActive: 1 });
    const first = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    const a = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    const b = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await requestCancel(db, a.runId);
    await runs.whenDone(a.runId);
    expect((await events(a.runId)).map((e) => e.type)).toEqual(["run.created", "run.queued", "run.end"]);
    expect(await getRun(db, a.runId)).toMatchObject({ status: "cancelled" });
    await vi.waitFor(async () => expect(queuedPositions(await events(b.runId))).toEqual([2, 1]));
    expect(runs.queuedCount()).toBe(1);
    await requestCancel(db, first.runId);
    await runs.whenDone(first.runId);
    await vi.waitFor(async () => expect((await getRun(db, b.runId))?.status).toBe("running"));
    await requestCancel(db, b.runId);
    await runs.whenDone(b.runId);
  }, 30_000);

  it("counts a visitor's queued runs against their limit, and turns the queue off at 0", async () => {
    const { db, runs } = setup({ agentMaxActive: 1, visitorLimits: { maxActive: 2, perHour: 100, perDay: 100 } });
    const client = "invented-visitor-queue";
    const running = await runs.startAgentRun({ question: QUESTION, lane: "public", client });
    const waiting = await runs.startAgentRun({ question: QUESTION, lane: "public", client });
    expect((await getRun(db, waiting.runId))?.status).toBe("queued");
    expect(await refusal(runs.startAgentRun({ question: QUESTION, lane: "public", client }))).toMatchObject({ code: "limited" });
    await requestCancel(db, waiting.runId);
    await requestCancel(db, running.runId);
    await runs.whenDone(waiting.runId);
    await runs.whenDone(running.runId);

    const off = setup({ agentMaxActive: 1, queueMax: 0 });
    const only = await off.runs.startAgentRun({ question: QUESTION, lane: "public" });
    expect(await refusal(off.runs.startAgentRun({ question: QUESTION, lane: "public" }))).toMatchObject({ code: "busy" });
    await requestCancel(db, only.runId);
    await off.runs.whenDone(only.runId);
  }, 30_000);
});
