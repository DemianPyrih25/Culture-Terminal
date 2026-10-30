// POST /api/runs request handling and /api/health without a database: a stub run manager stands in,
// so these run anywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { QUESTION_MAX_CHARS } from "@ct/contracts";
import { RunManagerError, type RunManagerErrorCode } from "../server/run-manager";
import { mockQlooClient } from "./support/agent";
import { testAnswers, testModes } from "./support/protection";

vi.mock("server-only", () => ({}));

const { startRun, health } = await import("../server/http");

const stub = {
  startFakeRun: vi.fn(async () => ({ runId: "run-fake-0001" })),
  startAgentRun: vi.fn<(request: unknown) => Promise<{ runId: string }>>(async () => ({ runId: "run-agent-0001" })),
  answerPicker: vi.fn<(answer: unknown) => Promise<{ runId: string }>>(async () => ({ runId: "run-picked-0001" })),
  activeCount: () => 0,
  isAccepting: () => true,
};

const g = globalThis as { __ctContainer?: unknown; __ctMigrationsApplied?: boolean };

beforeEach(() => {
  stub.startFakeRun.mockClear();
  stub.startAgentRun.mockClear();
  stub.answerPicker.mockClear();
  // Live, nothing in the answer cache; the human check is off (no Turnstile keys in tests).
  g.__ctContainer = { runs: stub, modes: testModes(), answers: testAnswers() };
});

afterEach(() => {
  delete g.__ctContainer;
  delete g.__ctMigrationsApplied;
  vi.unstubAllEnvs();
});

function post(body?: BodyInit, headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/api/runs", { method: "POST", headers, body });
}

const postJson = (value: unknown) => post(JSON.stringify(value), { "Content-Type": "application/json" });

async function answer(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// Built at runtime: a literal key-shaped string trips the gitleaks generic-api-key rule.
const KEY = `pk_${"0a".repeat(8)}`;

describe("POST /api/runs", () => {
  it("starts a test run without a request, with an empty body or with {fake: true}", async () => {
    for (const request of [undefined, post(), post("   \n"), postJson({ fake: true })]) {
      expect(await answer(await startRun(request))).toEqual({ status: 201, body: { runId: "run-fake-0001" } });
    }
    expect(stub.startFakeRun).toHaveBeenCalledTimes(4);
    expect(stub.startAgentRun).not.toHaveBeenCalled();
  });

  it("starts an agent run on the public lane from {question, parentRunId}", async () => {
    const res = await startRun(postJson({ question: "  Is Brand Alpha a moat?  ", parentRunId: "run-parent-0001" }));
    expect(await answer(res)).toEqual({ status: 201, body: { runId: "run-agent-0001" } });
    expect(stub.startAgentRun).toHaveBeenCalledWith({
      question: "Is Brand Alpha a moat?",
      lane: "public",
      parentRunId: "run-parent-0001",
      client: null,
    });
    await startRun(postJson({ question: "Is Brand Alpha a moat?", parentRunId: null }));
    expect(stub.startAgentRun).toHaveBeenLastCalledWith({ question: "Is Brand Alpha a moat?", lane: "public", parentRunId: null, client: null });
    expect(stub.startFakeRun).not.toHaveBeenCalled();
    expect(stub.answerPicker).not.toHaveBeenCalled();
  });

  it("answers a picker from {pick: {runId, key}} with the opaque key alone", async () => {
    const res = await startRun(postJson({ pick: { runId: "run-needs-0001", key: KEY } }));
    expect(await answer(res)).toEqual({ status: 201, body: { runId: "run-picked-0001" } });
    expect(stub.answerPicker).toHaveBeenCalledWith({ runId: "run-needs-0001", key: KEY, lane: "public", client: null });
    expect(stub.startAgentRun).not.toHaveBeenCalled();
  });

  it.each([
    ["no question", {}],
    ["an empty question", { question: "" }],
    ["a blank question", { question: "   " }],
    ["a question that is not text", { question: 42 }],
    ["a question over the limit", { question: "x".repeat(QUESTION_MAX_CHARS + 1) }],
    ["an unknown field", { question: "Is Brand Alpha a moat?", lane: "judge" }],
    // Entity ids never come from the browser (D20): a picker answer is an opaque key.
    ["raw entity-id pins", { question: "Is Brand Alpha a moat?", pins: { "Brand Alpha": "entity-alpha" } }],
    ["a parentRunId that is not a run id", { question: "Is Brand Alpha a moat?", parentRunId: "../etc" }],
    ["a pick whose key is an entity id", { pick: { runId: "run-needs-0001", key: "entity-alpha" } }],
    ["a pick whose key is not lowercase hex", { pick: { runId: "run-needs-0001", key: KEY.toUpperCase() } }],
    ["a pick without a key", { pick: { runId: "run-needs-0001" } }],
    ["a pick with a bad run id", { pick: { runId: "../etc", key: KEY } }],
    ["a pick with a question", { pick: { runId: "run-needs-0001", key: KEY }, question: "Is Brand Alpha a moat?" }],
    ["a test run flag that is not true", { fake: false }],
    ["a test run with extra fields", { fake: true, question: "Is Brand Alpha a moat?" }],
    ["an array", [1, 2]],
    ["a bare string", "Is Brand Alpha a moat?"],
  ])("answers 400 to %s", async (_label, value) => {
    const { status, body } = await answer(await startRun(postJson(value)));
    expect(status).toBe(400);
    expect(typeof body.error).toBe("string");
    expect(stub.startAgentRun).not.toHaveBeenCalled();
    expect(stub.answerPicker).not.toHaveBeenCalled();
    expect(stub.startFakeRun).not.toHaveBeenCalled();
  });

  it("lists the failing fields of a bad body", async () => {
    const { body } = await answer(await startRun(postJson({ question: "" })));
    expect(body.issues).toEqual([expect.objectContaining({ path: "question" })]);
  });

  it("answers 400 to a body that is not JSON and 413 to one that is too large", async () => {
    expect((await startRun(post("{question:", { "Content-Type": "application/json" }))).status).toBe(400);
    expect((await startRun(post("x".repeat(20_000)))).status).toBe(413);
    expect((await startRun(post("{}", { "Content-Length": "999999" }))).status).toBe(413);
    expect(stub.startAgentRun).not.toHaveBeenCalled();
  });

  it("stops reading a streamed body with no Content-Length once it passes the limit", async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode("x".repeat(4096));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    // Node needs duplex for a stream body; the DOM RequestInit type does not list it.
    const request = new Request("http://test.local/api/runs", { method: "POST", body: endless, duplex: "half" } as RequestInit);
    expect(request.headers.get("content-length")).toBeNull();
    expect((await startRun(request)).status).toBe(413);
    expect(pulled).toBeLessThan(10);
  });

  it("answers 415 to a body not sent as JSON, which another site could post without a preflight", async () => {
    const question = JSON.stringify({ question: "Is Brand Alpha a moat?" });
    for (const type of ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data; boundary=x"]) {
      expect((await startRun(post(question, { "Content-Type": type }))).status).toBe(415);
    }
    expect(stub.startAgentRun).not.toHaveBeenCalled();
    expect((await startRun(post(question, { "Content-Type": "application/json; charset=utf-8" }))).status).toBe(201);
    expect(stub.startAgentRun).toHaveBeenCalledTimes(1);
  });

  it("answers 403 to a start sent from another site's page", async () => {
    const question = JSON.stringify({ question: "Is Brand Alpha a moat?" });
    expect((await startRun(post(undefined, { "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
    expect((await startRun(post(question, { "Content-Type": "application/json", "Sec-Fetch-Site": "cross-site" }))).status).toBe(403);
    expect(stub.startFakeRun).not.toHaveBeenCalled();
    expect(stub.startAgentRun).not.toHaveBeenCalled();
    expect((await startRun(post(undefined, { "Sec-Fetch-Site": "same-origin" }))).status).toBe(201);
    expect(stub.startFakeRun).toHaveBeenCalledTimes(1);
  });

  it.each<[RunManagerErrorCode, number, boolean | undefined]>([
    ["not_accepting", 503, true],
    ["busy", 429, true],
    ["limited", 429, false],
    ["budget", 503, false],
    ["unavailable", 503, false],
    ["invalid", 400, undefined],
  ])("maps a %s refusal to %i", async (code, status, retry) => {
    stub.startAgentRun.mockRejectedValueOnce(new RunManagerError(code, `refused: ${code}`));
    const res = await startRun(postJson({ question: "Is Brand Alpha a moat?" }));
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(status);
    expect(body.error).toBe(`refused: ${code}`);
    expect(body.retry).toBe(retry);
    if (code === "budget") {
      const seconds = Number(res.headers.get("retry-after"));
      expect(seconds).toBeGreaterThan(0);
      expect(seconds).toBeLessThanOrEqual(86_400);
    }
  });

  it("sends a limit's own Retry-After, and a minute when it has none", async () => {
    stub.answerPicker.mockRejectedValueOnce(new RunManagerError("limited", "The hourly limit is reached.", 3600));
    const hourly = await startRun(postJson({ pick: { runId: "run-needs-0001", key: KEY } }));
    expect(hourly.status).toBe(429);
    expect(hourly.headers.get("retry-after")).toBe("3600");
    stub.startAgentRun.mockRejectedValueOnce(new RunManagerError("limited", "Held by runs in progress."));
    expect((await startRun(postJson({ question: "Is Brand Alpha a moat?" }))).headers.get("retry-after")).toBe("60");
  });

  it("answers 503 when the database is unreachable and 500 on anything else", async () => {
    stub.startAgentRun.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    const down = await startRun(postJson({ question: "Is Brand Alpha a moat?" }));
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ retry: true });
    stub.startAgentRun.mockRejectedValueOnce(new Error("boom"));
    expect((await startRun(postJson({ question: "Is Brand Alpha a moat?" }))).status).toBe(500);
  });
});

describe("GET /api/health without a database", () => {
  it("answers 503 but still reports the mode, the Qloo quota and the LLM cap", async () => {
    vi.stubEnv("LLM_DAILY_USD_CAP", "");
    // A database handle whose every query fails.
    g.__ctContainer = { db: {}, runs: stub, qloo: mockQlooClient(), anthropic: null, modes: testModes() };
    g.__ctMigrationsApplied = true;
    const { status, body } = await answer(await health());
    expect(status).toBe(503);
    expect(body).toMatchObject({
      ok: false,
      mode: "live",
      db: { ok: false, latency_ms: null },
      qloo: { env: "mock", month_remaining: null, today_network: 0, floor: 32_000, last_success: null, auth_errors: 0 },
      llm: { today_usd: null, cap: 8, configured: false },
    });
  });
});
