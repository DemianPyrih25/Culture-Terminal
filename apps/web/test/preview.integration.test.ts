// The preview against a real Postgres in a throwaway database: the answer cache (which follow-ups
// never answer), the daily LLM accounting, and a preview token carried through POST /api/runs into
// the run manager and runAgent.
// The fake Anthropic answers CLERK and the Qloo mock transport the gate. Invented entities only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions } from "@ct/agent";
import { normalizeIntent, type Report } from "@ct/contracts";
import { createRun, getQlooUsage, getRun, type NewRun } from "@ct/db";
import { utcDay } from "@ct/qloo";
import { EventBus } from "../server/event-bus";
import { buildFakeScript } from "../server/fake-script";
import { LLM_USD_METRIC, todayLlmUsd } from "../server/llm-spend";
import { questionHash } from "../server/question-hash";
import { RunManager, type RunAgentFn } from "../server/run-manager";
import { agentDeps, agentResult, completedAgent, runCreated } from "./support/agent";
import { clerkAnswering, clerkReply, fastMockQloo, testIntent } from "./support/preview";
import { testModes } from "./support/protection";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./support/test-db";

vi.mock("server-only", () => ({}));

const available = await databaseAvailable();
const { databasePreviewDeps, findAlreadyHave, PreviewService } = await import("../server/preview");

const g = globalThis as { __ctContainer?: unknown; __ctPreview?: unknown };
const QUESTION = "Who really competes with Juniper Cola?";

describe.skipIf(!available)("previews against Postgres", () => {
  let t: TestDatabase | undefined;
  let report: Report;
  const managers: RunManager[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
    report = buildFakeScript({ runId: "seed", startedAt: Date.now(), durationMs: 1000 }).report;
  }, 60_000);

  afterEach(() => {
    delete g.__ctContainer;
    delete g.__ctPreview;
  });

  afterAll(async () => {
    await Promise.all(managers.map((m) => m.drain(0)));
    await t?.dispose();
  }, 60_000);

  async function seed(question: string, hoursAgo: number, over: Partial<NewRun> & { mode?: "live" | "economy" } = {}) {
    const db = t!.db;
    const run = await createRun(db, {
      question,
      questionHash: questionHash(question, undefined, over.mode ?? "live"),
      status: "completed",
      report,
      ...over,
    });
    await db.$client`update runs set created_at = now() - make_interval(secs => ${hoursAgo * 3600}) where id = ${run.id}`;
    return run.id;
  }

  it("finds the newest completed brief for the question under either mode, within 72 hours", async () => {
    const db = t!.db;
    const q = "Is the Brand Beta audience a moat?";
    await seed(q, 5);
    const economy = await seed(q.toUpperCase(), 2, { mode: "economy" });
    await seed(q, 1, { status: "incomplete" });
    await seed(q, 0.5, { questionHash: `fake:${q}` });
    expect(await findAlreadyHave(db, `  ${q.toLowerCase()} `)).toEqual({
      runId: economy,
      question: q.toUpperCase(),
      createdAt: expect.any(String),
      signal: report.verdict.signal,
      confidence: { score: report.verdict.confidence.score, band: report.verdict.confidence.band },
    });

    const old = "Is the Brand Gamma audience a moat?";
    await seed(old, 80);
    expect(await findAlreadyHave(db, old)).toBeNull();
    const odd = "Is the Brand Delta audience a moat?";
    const oddId = await seed(odd, 1, { report: { verdict: { signal: "buy" } } });
    expect(await findAlreadyHave(db, odd)).toMatchObject({ runId: oddId, signal: null, confidence: null });
  });

  it("never answers a question with a follow-up's brief: not from the cache, the preview or POST /api/runs", async () => {
    const db = t!.db;
    const bus = new EventBus();
    const runs = new RunManager({ db, bus, agent: agentDeps(), runAgent: completedAgent(), agentHourlyCap: 10_000, llmDailyUsdCap: 10_000 });
    managers.push(runs);
    const asked = "Is the Brand Epsilon audience a moat?";
    const followUp = "What about the youngest of them?";
    const parent = await runs.startAgentRun({ question: asked, lane: "public" });
    await runs.whenDone(parent.runId);
    const child = await runs.startAgentRun({ question: followUp, lane: "public", parentRunId: parent.runId });
    await runs.whenDone(child.runId);
    expect(await getRun(db, child.runId)).toMatchObject({ status: "completed", parentRunId: parent.runId });
    expect(await findAlreadyHave(db, followUp)).toBeNull();
    // A follow-up stored under a top-level key (before keys carried the parent) is no hit either.
    await seed(followUp, 1, { parentRunId: parent.runId });
    expect(await findAlreadyHave(db, followUp)).toBeNull();
    // The parent's own question, asked on its own, still answers from the cache.
    expect(await findAlreadyHave(db, asked)).toMatchObject({ runId: parent.runId });

    const anthropic = clerkAnswering(clerkReply(testIntent()));
    const qloo = fastMockQloo();
    g.__ctPreview = new PreviewService({ qloo: () => qloo, anthropic: () => anthropic, mode: async () => "live", ...databasePreviewDeps(() => db) });
    g.__ctContainer = { db, bus, runs, modes: testModes() };
    const http = await import("../server/http");
    const post = (path: string, body: unknown) =>
      new Request(`http://test.local${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const preview = await http.previewQuestion(post("/api/preview", { question: followUp }));
    expect(((await preview.json()) as { alreadyHave: unknown }).alreadyHave).toBeNull();
    const started = await http.startRun(post("/api/runs", { question: followUp }));
    expect(started.status).toBe(201);
    const { runId, cached } = (await started.json()) as { runId: string; cached?: boolean };
    expect(cached).toBeUndefined();
    expect(runId).not.toBe(child.runId);
    await runs.whenDone(runId);
    expect(await getRun(db, runId)).toMatchObject({ parentRunId: null, questionHash: questionHash(followUp, undefined, "live") });
  }, 30_000);

  it("records a preview's CLERK spend in today's LLM accounting", async () => {
    const db = t!.db;
    const before = await todayLlmUsd(db);
    const judgeBefore = await getQlooUsage(db, { day: utcDay(Date.now()), lane: "judge", metric: LLM_USD_METRIC });
    await databasePreviewDeps(() => db).recordUsd(0.002, "judge");
    expect(await todayLlmUsd(db)).toBeCloseTo(before + 0.002, 6);
    // Under the previewing lane too, as a run's spend is.
    expect(await getQlooUsage(db, { day: utcDay(Date.now()), lane: "judge", metric: LLM_USD_METRIC })).toBeCloseTo(judgeBefore + 0.002, 6);
  });

  it("carries a preview's reading through POST /api/runs into the run, which skips CLERK", async () => {
    const db = t!.db;
    const bus = new EventBus();
    const seen: AgentRunOptions[] = [];
    // Emits CLERK's event the way runAgent does with a preset intent.
    const runAgent: RunAgentFn = async (o) => {
      seen.push(o);
      o.emit(runCreated(o));
      if (o.intent) o.emit({ type: "clerk", intent: o.intent, ms: 0 });
      return agentResult({ status: "needs_input", intent: o.intent ?? null, model: null });
    };
    const runs = new RunManager({ db, bus, agent: agentDeps(), runAgent, agentHourlyCap: 10_000, llmDailyUsdCap: 10_000, qlooEnabled: false });
    managers.push(runs);
    const anthropic = clerkAnswering(clerkReply(testIntent()));
    const qloo = fastMockQloo();
    g.__ctPreview = new PreviewService({ qloo: () => qloo, anthropic: () => anthropic, mode: async () => "live", ...databasePreviewDeps(() => db) });
    // Live whatever this database has spent; the answer cache is this database's.
    g.__ctContainer = { db, bus, runs, modes: testModes() };
    const http = await import("../server/http");
    const post = (path: string, body: unknown) =>
      new Request(`http://test.local${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

    const spentBefore = await todayLlmUsd(db);
    const preview = await http.previewQuestion(post("/api/preview", { question: QUESTION }));
    expect(preview.status).toBe(200);
    const { token, alreadyHave } = (await preview.json()) as { token: string; alreadyHave: unknown };
    expect(alreadyHave).toBeNull();
    expect(await todayLlmUsd(db)).toBeGreaterThan(spentBefore);

    const started = await http.startRun(post("/api/runs", { question: QUESTION, previewToken: token }));
    expect(started.status).toBe(201);
    const { runId } = (await started.json()) as { runId: string };
    await runs.whenDone(runId);
    expect(anthropic.createRequests).toHaveLength(1);
    expect(seen[0]?.intent).toEqual(normalizeIntent(testIntent()));
    expect(seen[0]?.qlooEnabled).toBe(false);
    expect(await getRun(db, runId)).toMatchObject({ status: "needs_input", pillar: "investment", job: "brand_health", question: QUESTION });

    // Without a token the run reads the question itself.
    const plain = await http.startRun(post("/api/runs", { question: QUESTION }));
    await runs.whenDone(((await plain.json()) as { runId: string }).runId);
    expect(seen[1]).not.toHaveProperty("intent");
  }, 30_000);
});
