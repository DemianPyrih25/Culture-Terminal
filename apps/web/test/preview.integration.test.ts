// The preview against a real Postgres in a throwaway database: the answer cache, the daily LLM
// accounting, and a preview token carried through POST /api/runs into the run manager and runAgent.
// The fake Anthropic answers CLERK and the Qloo mock transport the gate. Invented entities only.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentRunOptions } from "@ct/agent";
import { normalizeIntent, type Report } from "@ct/contracts";
import { createRun, getRun, type NewRun } from "@ct/db";
import { EventBus } from "../server/event-bus";
import { buildFakeScript } from "../server/fake-script";
import { todayLlmUsd } from "../server/llm-spend";
import { questionHash } from "../server/question-hash";
import { RunManager, type RunAgentFn } from "../server/run-manager";
import { agentDeps, agentResult, runCreated } from "./support/agent";
import { clerkAnswering, clerkReply, fastMockQloo, testIntent } from "./support/preview";
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

  it("records a preview's CLERK spend in today's LLM accounting", async () => {
    const db = t!.db;
    const before = await todayLlmUsd(db);
    await databasePreviewDeps(() => db).recordUsd(0.002);
    expect(await todayLlmUsd(db)).toBeCloseTo(before + 0.002, 6);
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
    g.__ctContainer = { db, bus, runs };
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
