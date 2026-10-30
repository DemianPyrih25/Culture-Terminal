// POST /api/preview and POST /api/runs with a preview token, without a database: a preview service
// on fake deps and a stub run manager stand in. Invented entities only (D29).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeIntent, QUESTION_MAX_CHARS } from "@ct/contracts";
import type { PreviewDeps, PreviewServiceOptions } from "../server/preview";
import { alreadyHave, clerkAnswering, clerkReply, previewDeps, testIntent } from "./support/preview";
import { storedMode, testAnswers, testModes } from "./support/protection";

vi.mock("server-only", () => ({}));

const { previewQuestion, startRun } = await import("../server/http");
const { PreviewService } = await import("../server/preview");

const QUESTION = "Who really competes with Juniper Cola?";

const stub = {
  startAgentRun: vi.fn<(request: unknown) => Promise<{ runId: string }>>(async () => ({ runId: "run-agent-0001" })),
};

const g = globalThis as { __ctContainer?: unknown; __ctPreview?: unknown };

function useService(deps: PreviewDeps, options: PreviewServiceOptions = {}) {
  const service = new PreviewService(deps, options);
  g.__ctPreview = service;
  return service;
}

beforeEach(() => {
  stub.startAgentRun.mockClear();
  // Live, nothing in the answer cache; the human check is off (no Turnstile keys in tests).
  g.__ctContainer = { runs: stub, modes: testModes(), answers: testAnswers() };
});

afterEach(() => {
  delete g.__ctContainer;
  delete g.__ctPreview;
});

function post(path: string, body?: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request(`http://test.local${path}`, { method: "POST", headers, body });
}

const postJson = (path: string, value: unknown, headers: Record<string, string> = {}) =>
  post(path, JSON.stringify(value), { "Content-Type": "application/json", ...headers });

async function answer(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("POST /api/preview", () => {
  it("answers 200 with the reading, a token and the estimate", async () => {
    useService(previewDeps(clerkAnswering(clerkReply(testIntent()))));
    const { status, body } = await answer(await previewQuestion(postJson("/api/preview", { question: QUESTION })));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      token: expect.stringMatching(/^pv_[0-9a-f]{32}$/),
      understood: { job: "brand_health", jobLabel: "Real competitors", mnemonic: "JUNIPER COLA <BRAND> HLTH" },
      alreadyHave: null,
      estimate: { networkCalls: expect.any(Number), cachedCalls: expect.any(Number), seconds: expect.any(Number) },
    });
  });

  it.each([
    ["no body", undefined],
    ["no question", {}],
    ["a blank question", { question: "   " }],
    ["a question over the limit", { question: "x".repeat(QUESTION_MAX_CHARS + 1) }],
    ["a question that is not text", { question: 7 }],
    ["an unknown field", { question: QUESTION, previewToken: "pv_0" }],
    ["an array", [QUESTION]],
  ])("answers 400 to %s, without reading it", async (_label, value) => {
    const anthropic = clerkAnswering();
    useService(previewDeps(anthropic));
    const request = value === undefined ? post("/api/preview") : postJson("/api/preview", value);
    const { status, body } = await answer(await previewQuestion(request));
    expect(status).toBe(400);
    expect(typeof body.error).toBe("string");
    expect(anthropic.createRequests).toHaveLength(0);
  });

  it("is guarded like POST /api/runs: 403 from another site, 415 when not JSON, 413 when too large", async () => {
    const anthropic = clerkAnswering();
    useService(previewDeps(anthropic));
    const body = JSON.stringify({ question: QUESTION });
    expect((await previewQuestion(postJson("/api/preview", { question: QUESTION }, { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
    expect((await previewQuestion(post("/api/preview", body, { "Content-Type": "text/plain" }))).status).toBe(415);
    expect((await previewQuestion(post("/api/preview", "{question:", { "Content-Type": "application/json" }))).status).toBe(400);
    expect((await previewQuestion(post("/api/preview", "x".repeat(20_000), { "Content-Type": "application/json" }))).status).toBe(413);
    expect(anthropic.createRequests).toHaveLength(0);
  });

  it("answers 429 with Retry-After past the hourly cap, with the brief already in hand", async () => {
    const hit = alreadyHave();
    useService(previewDeps(clerkAnswering(clerkReply(testIntent())), { findAnswer: async () => hit }), { hourlyCap: 1 });
    expect((await previewQuestion(postJson("/api/preview", { question: QUESTION }))).status).toBe(200);
    const res = await previewQuestion(postJson("/api/preview", { question: "Is Juniper Cola a taste island?" }));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(3500);
    expect(await res.json()).toMatchObject({ retry: false, alreadyHave: hit });
  });

  it("answers 503 when paused or out of budget, and 502 when CLERK fails", async () => {
    // The route decides the lane's mode and hands it to the service.
    g.__ctContainer = { runs: stub, modes: testModes({ stored: storedMode("replay_only") }), answers: testAnswers() };
    useService(previewDeps(clerkAnswering()));
    const paused = await answer(await previewQuestion(postJson("/api/preview", { question: QUESTION })));
    expect(paused).toMatchObject({ status: 503, body: { retry: false, alreadyHave: null } });
    expect(paused.body.error).toBe("Live analysis is paused: it was paused by the operator.");
    g.__ctContainer = { runs: stub, modes: testModes(), answers: testAnswers() };

    useService(previewDeps(clerkAnswering(), { todayUsd: async () => 9 }));
    const spent = await previewQuestion(postJson("/api/preview", { question: QUESTION }));
    expect(spent.status).toBe(503);
    expect(Number(spent.headers.get("retry-after"))).toBeGreaterThan(0);

    useService(previewDeps(clerkAnswering({ error: new Error("synthetic outage") })));
    const failed = await answer(await previewQuestion(postJson("/api/preview", { question: QUESTION })));
    expect(failed.status).toBe(502);
    expect(typeof failed.body.retry).toBe("boolean");
  });

  it("answers 503 with retry when the database is unreachable", async () => {
    const down = Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    useService(previewDeps(clerkAnswering(), { findAnswer: async () => Promise.reject(down) }));
    const res = await answer(await previewQuestion(postJson("/api/preview", { question: QUESTION })));
    expect(res).toMatchObject({ status: 503, body: { retry: true } });
  });
});

describe("POST /api/runs with a preview token", () => {
  async function previewToken(question = QUESTION): Promise<string> {
    const res = await previewQuestion(postJson("/api/preview", { question }));
    const { token } = (await res.json()) as { token: string };
    return token;
  }

  it("hands the preview's intent to the run for the same question", async () => {
    useService(previewDeps(clerkAnswering(clerkReply(testIntent()))));
    const token = await previewToken();
    const res = await startRun(postJson("/api/runs", { question: `${QUESTION.toLowerCase()}  `, previewToken: token }));
    expect(res.status).toBe(201);
    expect(stub.startAgentRun).toHaveBeenCalledWith({
      question: QUESTION.toLowerCase(),
      lane: "public",
      parentRunId: null,
      client: null,
      intent: normalizeIntent(testIntent()),
    });
  });

  it("runs as before, with CLERK, when the token is for another question, unknown or expired", async () => {
    const c = { ms: Date.parse("2026-10-22T09:00:00.000Z") };
    useService(previewDeps(clerkAnswering(clerkReply(testIntent()))), { now: () => c.ms });
    const token = await previewToken();
    const plain = { question: "Who really competes with Brand Beta?", lane: "public", parentRunId: null, client: null };

    await startRun(postJson("/api/runs", { question: plain.question, previewToken: token }));
    expect(stub.startAgentRun).toHaveBeenLastCalledWith(plain);
    await startRun(postJson("/api/runs", { question: QUESTION, previewToken: `pv_${"ab".repeat(16)}` }));
    expect(stub.startAgentRun).toHaveBeenLastCalledWith({ ...plain, question: QUESTION });
    c.ms += 10 * 60_000;
    await startRun(postJson("/api/runs", { question: QUESTION, previewToken: token, parentRunId: null }));
    expect(stub.startAgentRun).toHaveBeenLastCalledWith({ ...plain, question: QUESTION });
    expect(stub.startAgentRun).toHaveBeenCalledTimes(3);
    for (const [request] of stub.startAgentRun.mock.calls) expect(request).not.toHaveProperty("intent");
  });

  it.each([
    ["a token of the wrong shape", "pv_short"],
    ["a token with upper-case hex", `pv_${"AB".repeat(16)}`],
    ["a token that is not text", 42],
  ])("answers 400 to %s", async (_label, previewToken) => {
    useService(previewDeps(clerkAnswering()));
    const { status, body } = await answer(await startRun(postJson("/api/runs", { question: QUESTION, previewToken })));
    expect(status).toBe(400);
    expect(body.issues).toEqual([expect.objectContaining({ path: "previewToken" })]);
    expect(stub.startAgentRun).not.toHaveBeenCalled();
  });

  it("accepts a null token as no token", async () => {
    useService(previewDeps(clerkAnswering()));
    expect((await startRun(postJson("/api/runs", { question: QUESTION, previewToken: null }))).status).toBe(201);
    expect(stub.startAgentRun).toHaveBeenCalledWith({ question: QUESTION, lane: "public", parentRunId: null, client: null });
  });
});
