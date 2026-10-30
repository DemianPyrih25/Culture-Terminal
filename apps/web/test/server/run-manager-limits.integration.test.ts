// Part 11 run-manager behaviour against a real Postgres in a throwaway database, with scripted agents (no
// model and no Qloo call): started_at stamps (runs that never left the queue count toward no cap), the
// side context calls' spend counted per day for /status, the side settings handed to runAgent, and a
// follow waiting on a run that ends without a note. Skips only when no database is reachable. Invented
// questions, visitors and blocks only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ContextCache } from "@ct/agent";
import { addFollow, getFollow, getQlooUsage, getRun, setPending } from "@ct/db";
import { utcDay } from "@ct/qloo";
import { EventBus } from "../../server/event-bus";
import { agentDeps, agentResult, runCreated, waitingAgent } from "../support/agent";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "../support/test-db";

vi.mock("server-only", () => ({}));

const available = await databaseAvailable();

const { RunManager } = await import("../../server/run-manager");
const { countLaneRunsSince } = await import("../../server/run-counts");
const { visitorWait } = await import("../../server/visitor-limits");
const { CONTEXT_AI_USD_METRIC, CONTEXT_WEB_USD_METRIC, WEB_SEARCHES_METRIC } = await import("../../server/llm-spend");
const { sampleAiContext, sampleWebContext } = await import("../../server/samples/context");
type RunManagerOptions = ConstructorParameters<typeof RunManager>[0];
type AgentFn = NonNullable<RunManagerOptions["runAgent"]>;

const QUESTION = "Is the Juniper Cola audience a moat or a niche?";
const HOUR = 3_600_000;

describe.skipIf(!available)("Part 11 limits and bookkeeping in the run manager", () => {
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
    const runs = new RunManager({
      db: t!.db,
      bus: new EventBus(),
      cancelPollMs: 50,
      agent: agentDeps(),
      agentHourlyCap: 10_000,
      judgeHourlyCap: 10_000,
      llmDailyUsdCap: 10_000,
      judgeMaxActive: 0,
      ...options,
    });
    managers.push(runs);
    return { db: t!.db, runs };
  }

  it("stamps started_at on a run that starts, and leaves it null on one that times out in the queue", async () => {
    const { db, runs } = setup({ agentMaxActive: 1, queueMax: 1, queueWaitMs: 300, runAgent: waitingAgent("incomplete") });
    const visitor = "visitor-started-at";
    const before = await countLaneRunsSince(db, "public", HOUR);
    const first = await runs.startAgentRun({ question: `${QUESTION} (started)`, lane: "public", client: visitor });
    const queued = await runs.startAgentRun({ question: `${QUESTION} (queued)`, lane: "public", client: "visitor-other" });
    await runs.whenDone(queued.runId);
    expect((await getRun(db, first.runId))?.startedAt).toBeInstanceOf(Date);
    const timedOut = await getRun(db, queued.runId);
    expect(timedOut?.status).toBe("failed");
    expect(timedOut?.startedAt).toBeNull();
    // The started run counts toward the hour; the one that never started does not.
    expect(await countLaneRunsSince(db, "public", HOUR)).toBe(before + 1);
    expect(await visitorWait(db, "visitor-other", { maxActive: 1, perHour: 1, perDay: 1 })).toBeNull();
    expect(await visitorWait(db, visitor, { maxActive: 1, perHour: 1, perDay: 1 })).not.toBeNull();
    await runs.drain(0);
  }, 30_000);

  it("stamps a queued run when it leaves the queue", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const agent: AgentFn = async (o) => {
      o.emit(runCreated(o));
      if (o.question.endsWith("(first)")) await gate;
      return agentResult({ status: "completed" });
    };
    const { db, runs } = setup({ agentMaxActive: 1, queueMax: 2, queueWaitMs: 10_000, runAgent: agent });
    const first = await runs.startAgentRun({ question: `${QUESTION} (first)`, lane: "public" });
    const second = await runs.startAgentRun({ question: `${QUESTION} (second)`, lane: "public" });
    expect((await getRun(db, second.runId))?.startedAt).toBeNull();
    release();
    await runs.whenDone(first.runId);
    await runs.whenDone(second.runId);
    expect((await getRun(db, second.runId))?.startedAt).toBeInstanceOf(Date);
  }, 30_000);

  it("hands runAgent the side settings and cache, and counts the side calls' spend and searches per day", async () => {
    const cache: ContextCache = { get: async () => null, put: async () => {} };
    const side = { aiEnabled: true, webEnabled: false, webMaxUses: 2, aiTimeoutMs: 25_000, webTimeoutMs: 45_000 };
    let seen: { sideConfig?: unknown; contextCache?: unknown } = {};
    const at = new Date().toISOString();
    const agent: AgentFn = async (o) => {
      seen = o;
      o.emit(runCreated(o));
      o.emit({ type: "context.ai", block: sampleAiContext(at), usd: 0.012, ms: 5_000 });
      o.emit({ type: "context.web", block: { ...sampleWebContext(at), searches: 3 }, usd: 0.05, ms: 9_000 });
      // A cached web block cost nothing and its searches were billed by the run that made it.
      o.emit({ type: "context.web", block: { ...sampleWebContext(at), searches: 3, cached: true }, usd: 0, ms: 1 });
      return agentResult({ status: "completed" });
    };
    const { db, runs } = setup({ agent: agentDeps({ side, contextCache: () => cache }), runAgent: agent });
    const day = utcDay(Date.now());
    const read = (metric: string) => getQlooUsage(db, { day, lane: "all", metric });
    const [ai0, web0, searches0] = await Promise.all([read(CONTEXT_AI_USD_METRIC), read(CONTEXT_WEB_USD_METRIC), read(WEB_SEARCHES_METRIC)]);
    const { runId } = await runs.startAgentRun({ question: `${QUESTION} (side)`, lane: "public" });
    await runs.whenDone(runId);
    expect(seen.sideConfig).toEqual(side);
    expect(seen.contextCache).toBe(cache);
    expect((await read(CONTEXT_AI_USD_METRIC)) - ai0).toBeCloseTo(0.012);
    expect((await read(CONTEXT_WEB_USD_METRIC)) - web0).toBeCloseTo(0.05);
    expect((await read(WEB_SEARCHES_METRIC)) - searches0).toBe(3);
    expect(await getQlooUsage(db, { day, lane: "public", metric: CONTEXT_AI_USD_METRIC })).toBeGreaterThan(0);
  }, 30_000);

  it("reads the side settings from the environment when the deps give none, and runs uncached when the cache cannot be made", async () => {
    vi.stubEnv("WEB_SEARCH_ENABLED", "0");
    let seen: { sideConfig?: { webEnabled?: boolean }; contextCache?: unknown } = {};
    const agent: AgentFn = async (o) => {
      seen = o as typeof seen;
      o.emit(runCreated(o));
      return agentResult({ status: "completed" });
    };
    const throwing = () => {
      throw new Error("no cache here");
    };
    const { runs } = setup({ agent: agentDeps({ contextCache: throwing }), runAgent: agent });
    const { runId } = await runs.startAgentRun({ question: `${QUESTION} (env)`, lane: "public" });
    await runs.whenDone(runId);
    vi.unstubAllEnvs();
    expect(seen.sideConfig?.webEnabled).toBe(false);
    expect(seen.contextCache).toBeNull();
  }, 30_000);

  it("stops a follow waiting on a run that ends without a note, keeping its last note", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const agent: AgentFn = async (o) => {
      o.emit(runCreated(o));
      await gate;
      return agentResult({ status: "refused", reason: "Declined.", model: null });
    };
    const { db, runs } = setup({ runAgent: agent });
    const added = await addFollow(db, {
      visitorKey: "visitor-follow-refused",
      kind: "question",
      subjectKey: "question:refused",
      label: QUESTION,
      question: QUESTION,
      job: "brand_health",
      metro: null,
      latestRunId: null,
    });
    if (!added.ok) throw new Error("could not add the follow");
    const { runId } = await runs.startAgentRun({ question: `${QUESTION} (refused)`, lane: "public" });
    await setPending(db, added.follow.id, runId);
    release();
    await runs.whenDone(runId);
    expect(await getFollow(db, "visitor-follow-refused", added.follow.id)).toMatchObject({ pendingRunId: null, latestRunId: null });
  }, 30_000);
});
