// The protection layer at the routes, without a database: the answer cache on POST /api/runs, the
// human check on runs, picks and previews, the judge lane, GET /api/access, the judge link, the
// admin mode switch and the lanes in /api/health. A stub run manager, a mode service on injected
// inputs, an answer cache from a map and a fake Turnstile verifier stand in. Invented entities only.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RunManagerError } from "../server/run-manager";
import { mockQlooClient } from "./support/agent";
import { clerkAnswering, clerkReply, previewDeps, testIntent } from "./support/preview";
import {
  BREAKER_NOW,
  cachedBrief,
  cookiePair,
  fakeVerifier,
  GOOD_TOKEN,
  qlooUsage,
  storedMode,
  TEST_JUDGE_TOKEN,
  TEST_SITE_KEY,
  testAccess,
  testAnswers,
  testModes,
  type ModeInputs,
} from "./support/protection";

vi.mock("server-only", () => ({}));

const http = await import("../server/http");
const { PreviewService } = await import("../server/preview");
const { JUDGE_MISSES_PER_MINUTE } = await import("../server/access");
const { ModeService } = await import("../server/breakers");
const { log } = await import("../server/log");

const QUESTION = "Who really competes with Juniper Cola?";
const KEY = `pk_${"0a".repeat(8)}`;

const runs = {
  startFakeRun: vi.fn(async () => ({ runId: "run-fake-0001" })),
  startAgentRun: vi.fn<(request: unknown) => Promise<{ runId: string }>>(async () => ({ runId: "run-agent-0001" })),
  answerPicker: vi.fn<(answer: unknown) => Promise<{ runId: string }>>(async () => ({ runId: "run-picked-0001" })),
  activeCount: () => 0,
  isAccepting: () => true,
};

const g = globalThis as {
  __ctContainer?: unknown;
  __ctAccess?: unknown;
  __ctPreview?: unknown;
  __ctMigrationsApplied?: boolean;
  __ctAccessModes?: unknown;
};
let modeInputs: ModeInputs;
let answers: ReturnType<typeof testAnswers>;

beforeEach(() => {
  for (const fn of [runs.startFakeRun, runs.startAgentRun, runs.answerPicker]) fn.mockClear();
  modeInputs = {};
  answers = testAnswers({ [QUESTION]: cachedBrief(QUESTION) });
  g.__ctContainer = { runs, modes: testModes(modeInputs), answers, stored: storedMode("live", null) };
  // Turnstile on, with a fake verifier; the judge lane open.
  g.__ctAccess = testAccess();
});

afterEach(() => {
  delete g.__ctContainer;
  delete g.__ctAccess;
  delete g.__ctPreview;
  delete g.__ctMigrationsApplied;
  delete g.__ctAccessModes;
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function postJson(path: string, value: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://test.local${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(value),
  });
}

async function answer(res: Response): Promise<{ status: number; body: Record<string, unknown> }> {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** A browser that passed the check: its ct_human cookie. */
async function humanCookie(): Promise<string> {
  const res = await http.startRun(postJson("/api/runs", { question: "A question nobody asked before", turnstileToken: GOOD_TOKEN }));
  expect(res.status).toBe(201);
  runs.startAgentRun.mockClear();
  return cookiePair(res.headers.get("set-cookie"));
}

describe("POST /api/runs: the answer cache (D26)", () => {
  it("answers a question it already has at once, with no human check and no run", async () => {
    const res = await answer(await http.startRun(postJson("/api/runs", { question: QUESTION })));
    expect(res).toEqual({ status: 200, body: { runId: "run-cached-0001", cached: true } });
    expect(answers.find).toHaveBeenCalledWith(QUESTION);
    expect(runs.startAgentRun).not.toHaveBeenCalled();
  });

  it("runs it live on {fresh: true}, and always for a follow-up, which never reads the cache", async () => {
    const fresh = await http.startRun(postJson("/api/runs", { question: QUESTION, fresh: true, turnstileToken: GOOD_TOKEN }));
    expect(fresh.status).toBe(201);
    const child = await http.startRun(
      postJson("/api/runs", { question: QUESTION, parentRunId: "run-parent-0001", turnstileToken: GOOD_TOKEN }),
    );
    expect(child.status).toBe(201);
    expect(runs.startAgentRun).toHaveBeenCalledTimes(2);
    expect(answers.find).not.toHaveBeenCalled();
  });

  it("answers from the cache in replay-only mode, fresh or not, and refuses politely when it has nothing", async () => {
    modeInputs.todayUsd = 5;
    expect(await answer(await http.startRun(postJson("/api/runs", { question: QUESTION, fresh: true })))).toEqual({
      status: 200,
      body: { runId: "run-cached-0001", cached: true },
    });
    const none = await http.startRun(postJson("/api/runs", { question: "Something new", turnstileToken: GOOD_TOKEN }));
    expect(await answer(none)).toEqual({
      status: 503,
      body: { error: "Live analysis is paused: today's budget is used up. It resumes at 00:00 UTC.", retry: false },
    });
    expect(runs.startAgentRun).not.toHaveBeenCalled();
  });

  it("never answers a follow-up from the cache in replay-only mode: it is refused, not handed another brief", async () => {
    modeInputs.todayUsd = 5;
    const child = await http.startRun(postJson("/api/runs", { question: QUESTION, parentRunId: "run-parent-0001" }));
    expect(await answer(child)).toEqual({
      status: 503,
      body: { error: "Live analysis is paused: today's budget is used up. It resumes at 00:00 UTC.", retry: false },
    });
    expect(answers.find).not.toHaveBeenCalled();
    expect(runs.startAgentRun).not.toHaveBeenCalled();
  });

  it("says nothing about the human check on a cached answer, which comes before it", async () => {
    const res = await http.startRun(postJson("/api/runs", { question: QUESTION, turnstileToken: GOOD_TOKEN }));
    expect(res.status).toBe(200);
    expect(res.headers.get("x-human-check")).toBeNull();
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers 503 when the cache cannot be read", async () => {
    answers.find.mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
    expect((await http.startRun(postJson("/api/runs", { question: QUESTION }))).status).toBe(503);
  });

  it("rejects a fresh flag that is not a boolean", async () => {
    expect((await http.startRun(postJson("/api/runs", { question: QUESTION, fresh: "yes" }))).status).toBe(400);
  });
});

describe("POST /api/runs: the human check", () => {
  it("refuses a live run without a token or with a bad one, asking the browser for a check", async () => {
    for (const body of [{ question: "Something new" }, { question: "Something new", turnstileToken: "bad" }]) {
      const { status, body: reply } = await answer(await http.startRun(postJson("/api/runs", body)));
      expect(status).toBe(403);
      expect(reply).toMatchObject({ turnstile: true, retry: false });
    }
    expect(runs.startAgentRun).not.toHaveBeenCalled();
  });

  it("starts the run on a good token, sets the two-hour cookie, and takes the cookie next time", async () => {
    const res = await http.startRun(postJson("/api/runs", { question: "Something new", turnstileToken: GOOD_TOKEN }));
    expect(res.status).toBe(201);
    expect(res.headers.get("x-human-check")).toBe("passed");
    const cookie = cookiePair(res.headers.get("set-cookie"));
    expect(cookie).toMatch(/^ct_human=/);
    const again = await http.startRun(postJson("/api/runs", { question: "Something else" }, { cookie }));
    expect(again.status).toBe(201);
    expect(again.headers.get("set-cookie")).toBeNull();
    expect(again.headers.get("x-human-check")).toBe("passed");
    expect(runs.startAgentRun).toHaveBeenCalledTimes(2);
  });

  it("keeps the cookie it minted on a run the manager then refuses", async () => {
    runs.startAgentRun.mockRejectedValueOnce(new RunManagerError("busy", "Too many runs are active. Try again shortly."));
    const res = await http.startRun(postJson("/api/runs", { question: "Something new", turnstileToken: GOOD_TOKEN }));
    expect(res.status).toBe(429);
    expect(res.headers.get("set-cookie")).toMatch(/^ct_human=/);
    expect(res.headers.get("x-human-check")).toBe("passed");
  });

  it("answers 503 to retry shortly when Cloudflare cannot be asked, with no word that the check passed", async () => {
    g.__ctAccess = testAccess({ verify: fakeVerifier(() => ({ ok: false, kind: "unavailable", error: "timeout" })) });
    const res = await http.startRun(postJson("/api/runs", { question: "Something new", turnstileToken: "t" }));
    expect(res.headers.get("retry-after")).toBe("5");
    expect(res.headers.get("x-human-check")).toBeNull();
    const { status, body } = await answer(res);
    expect(status).toBe(503);
    expect(body).toMatchObject({ retry: true });
    expect(body).not.toHaveProperty("turnstile");
  });

  it("refuses live runs, picks and previews when the check is required but has no keys (production)", async () => {
    g.__ctAccess = testAccess({ turnstile: null, required: true });
    const refused = { error: "Live analysis is unavailable: the human check is not configured.", retry: false };
    expect(await answer(await http.startRun(postJson("/api/runs", { question: "Something new" })))).toEqual({ status: 503, body: refused });
    expect(await answer(await http.startRun(postJson("/api/runs", { pick: { runId: "run-needs-0001", key: KEY } })))).toEqual({
      status: 503,
      body: refused,
    });
    expect(await answer(await http.previewQuestion(postJson("/api/preview", { question: QUESTION })))).toEqual({ status: 503, body: refused });
    expect(runs.startAgentRun).not.toHaveBeenCalled();
    expect(runs.answerPicker).not.toHaveBeenCalled();
    // The answer cache and test runs still work.
    expect((await http.startRun(postJson("/api/runs", { question: QUESTION }))).status).toBe(200);
    expect((await http.startRun(postJson("/api/runs", { fake: true }))).status).toBe(201);
  });

  it("guards picker answers too, and never test runs", async () => {
    expect((await http.startRun(postJson("/api/runs", { pick: { runId: "run-needs-0001", key: KEY } }))).status).toBe(403);
    const picked = await http.startRun(postJson("/api/runs", { pick: { runId: "run-needs-0001", key: KEY }, turnstileToken: GOOD_TOKEN }));
    expect(picked.status).toBe(201);
    expect(runs.answerPicker).toHaveBeenCalledWith({ runId: "run-needs-0001", key: KEY, lane: "public", client: null });
    expect((await http.startRun(postJson("/api/runs", { fake: true }))).status).toBe(201);
    expect(runs.startFakeRun).toHaveBeenCalledTimes(1);
  });
});

describe("POST /api/runs: the visitor", () => {
  it("passes the visitor's key, a hash of the right-most forwarded address, and never the address", async () => {
    const human = await humanCookie();
    const from = (forwarded: string) => ({ cookie: human, "x-forwarded-for": forwarded });
    await http.startRun(postJson("/api/runs", { question: "Something new" }, from("198.51.100.7, 203.0.113.9")));
    const first = (runs.startAgentRun.mock.lastCall?.[0] as { client: string | null }).client;
    expect(first).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(first).not.toContain("203.0.113.9");
    // The left entries are the visitor's own to write: only the edge's last one counts.
    await http.startRun(postJson("/api/runs", { question: "Something new" }, from("192.0.2.1, 203.0.113.9")));
    expect(runs.startAgentRun.mock.lastCall?.[0]).toMatchObject({ client: first });
    await http.startRun(postJson("/api/runs", { question: "Something new" }, from("203.0.113.10")));
    expect(runs.startAgentRun.mock.lastCall?.[0]).not.toMatchObject({ client: first });
    await http.startRun(postJson("/api/runs", { pick: { runId: "run-needs-0001", key: KEY } }, from("203.0.113.9")));
    expect(runs.answerPicker).toHaveBeenLastCalledWith(expect.objectContaining({ client: first }));
  });

  it("passes the per-visitor refusal on as 429, not to be retried by itself", async () => {
    runs.startAgentRun.mockRejectedValueOnce(
      new RunManagerError("limited", "You have started 3 live briefs in the last hour. Try again in 20 minutes; showcases and replays still work.", 1200),
    );
    const res = await http.startRun(postJson("/api/runs", { question: "Something new", turnstileToken: GOOD_TOKEN }));
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("1200");
    expect(await res.json()).toMatchObject({ retry: false });
  });
});

describe("the judge lane", () => {
  async function judgeCookie(): Promise<string> {
    const res = http.judgeLink(new Request(`http://test.local/api/judge?token=${TEST_JUDGE_TOKEN}`));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    return cookiePair(res.headers.get("set-cookie"));
  }

  it("opens with the judge link and records the lane on every run started from it", async () => {
    const human = await humanCookie();
    const cookie = `${await judgeCookie()}; ${human}`;
    await http.startRun(postJson("/api/runs", { question: "Something new" }, { cookie }));
    expect(runs.startAgentRun).toHaveBeenLastCalledWith({ question: "Something new", lane: "judge", parentRunId: null, client: null });
    await http.startRun(postJson("/api/runs", { pick: { runId: "run-needs-0001", key: KEY } }, { cookie }));
    expect(runs.answerPicker).toHaveBeenLastCalledWith({ runId: "run-needs-0001", key: KEY, lane: "judge", client: null });
  });

  it("keeps running live for judges while the public lane is paused", async () => {
    modeInputs.todayUsd = 0.9;
    const human = await (async () => {
      // The public lane is replay only now, so a judge's browser passes the check on its own run.
      const cookie = await judgeCookie();
      const res = await http.startRun(postJson("/api/runs", { question: "First judge question", turnstileToken: GOOD_TOKEN }, { cookie }));
      expect(res.status).toBe(201);
      return `${cookie}; ${cookiePair(res.headers.get("set-cookie"))}`;
    })();
    expect((await http.startRun(postJson("/api/runs", { question: "Something new", turnstileToken: GOOD_TOKEN }))).status).toBe(503);
    expect((await http.startRun(postJson("/api/runs", { question: "Something new" }, { cookie: human }))).status).toBe(201);
    expect(runs.startAgentRun).toHaveBeenLastCalledWith(expect.objectContaining({ lane: "judge" }));
  });

  it("answers 404 to a wrong token, and while the judge lane is closed", async () => {
    for (const url of ["http://test.local/api/judge?token=wrong", "http://test.local/api/judge"]) {
      const res = http.judgeLink(new Request(url));
      expect(res.status).toBe(404);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    g.__ctAccess = testAccess({ judgeToken: null });
    expect(http.judgeLink(new Request(`http://test.local/api/judge?token=${TEST_JUDGE_TOKEN}`)).status).toBe(404);
  });

  it("refuses every judge link for the rest of the minute after 20 wrong ones, the right one too", async () => {
    const clock = { ms: Date.parse("2026-10-22T18:00:00.000Z") };
    g.__ctAccess = testAccess({ clock });
    for (let i = 0; i < JUDGE_MISSES_PER_MINUTE; i++) {
      expect(http.judgeLink(new Request(`http://test.local/api/judge?token=guess-${i}`)).status).toBe(404);
      clock.ms += 1_000;
    }
    const locked = http.judgeLink(new Request(`http://test.local/api/judge?token=${TEST_JUDGE_TOKEN}`));
    expect(locked.status).toBe(429);
    expect(locked.headers.get("retry-after")).toBe("40");
    expect(locked.headers.get("set-cookie")).toBeNull();
    // Once the first guess leaves the minute, the right token opens the lane again.
    clock.ms += 40_000;
    expect(http.judgeLink(new Request(`http://test.local/api/judge?token=${TEST_JUDGE_TOKEN}`)).status).toBe(303);
  });
});

describe("POST /api/preview: the human check", () => {
  it("needs the check while live, and passes the lane's mode to the service", async () => {
    g.__ctPreview = new PreviewService(previewDeps(clerkAnswering(clerkReply(testIntent()), clerkReply(testIntent()))));
    expect((await http.previewQuestion(postJson("/api/preview", { question: QUESTION }))).status).toBe(403);
    const ok = await http.previewQuestion(postJson("/api/preview", { question: QUESTION, turnstileToken: GOOD_TOKEN }));
    expect(ok.status).toBe(200);
    expect(ok.headers.get("set-cookie")).toMatch(/^ct_human=/);
    expect(await ok.json()).toMatchObject({ mode: "live", modeNote: null });
  });

  it("tells the browser a brief would run on the economy analyst", async () => {
    modeInputs.todayUsd = 0.6;
    g.__ctPreview = new PreviewService(previewDeps(clerkAnswering(clerkReply(testIntent()))));
    const res = await http.previewQuestion(postJson("/api/preview", { question: QUESTION, turnstileToken: GOOD_TOKEN }));
    expect(await res.json()).toMatchObject({
      mode: "economy",
      modeNote: "Live briefs run on the economy analyst until 00:00 UTC: today's live budget is nearly used.",
    });
  });

  it("asks for no check in replay-only mode, where it only offers the brief in hand", async () => {
    modeInputs.stored = storedMode("replay_only", "qloo");
    const findAnswer = vi.fn(async () => cachedBrief(QUESTION));
    g.__ctPreview = new PreviewService(previewDeps(clerkAnswering(), { findAnswer }));
    const { status, body } = await answer(await http.previewQuestion(postJson("/api/preview", { question: QUESTION })));
    expect(status).toBe(503);
    expect(body).toMatchObject({
      error: "Live analysis is paused: the Qloo data connection needs attention.",
      alreadyHave: { runId: "run-cached-0001" },
    });
  });
});

describe("GET /api/access", () => {
  it("tells the browser its lane, its mode, the site key and whether it already passed", async () => {
    const res = await http.accessStatus(new Request("http://test.local/api/access"));
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      lane: "public",
      mode: "live",
      message: null,
      until: null,
      turnstile: { siteKey: TEST_SITE_KEY },
      verified: false,
    });
    const cookie = await humanCookie();
    expect(await (await http.accessStatus(new Request("http://test.local/api/access", { headers: { cookie } }))).json()).toMatchObject({
      verified: true,
    });
  });

  it("says when the lane is paused, and reports no site key while the check is off", async () => {
    modeInputs.override = "replay_only";
    g.__ctAccess = testAccess({ turnstile: null });
    expect(await (await http.accessStatus(new Request("http://test.local/api/access"))).json()).toMatchObject({
      mode: "replay_only",
      message: "Live analysis is paused: the operator switched it for a demo.",
      turnstile: null,
      verified: true,
    });
  });

  it("reports a null mode when the breakers cannot be read", async () => {
    g.__ctContainer = {
      runs,
      answers,
      modes: { decideAll: async () => Promise.reject(new Error("connect ECONNREFUSED")) },
    };
    expect(await (await http.accessStatus(new Request("http://test.local/api/access"))).json()).toMatchObject({ mode: null, message: null });
  });

  it("reuses one reading of the breakers for 5 s across page loads and lanes, keeps no failed one, and drops it on a mode switch", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(BREAKER_NOW);
    expect(http.ACCESS_REUSE_MS).toBe(5_000);
    const stored = vi.fn(async () => storedMode("economy"));
    g.__ctContainer = {
      runs,
      answers,
      stored: storedMode("live", null),
      modes: new ModeService({ override: () => null, stored, todayUsd: async () => 0, qloo: async () => null, now: () => BREAKER_NOW }),
      // Takes the admin switch's kv write; the stored mode is read from `stored` above.
      db: { insert: () => ({ values: () => ({ onConflictDoUpdate: async () => undefined }) }) },
    };
    const judge = cookiePair(http.judgeLink(new Request(`http://test.local/api/judge?token=${TEST_JUDGE_TOKEN}`)).headers.get("set-cookie"));
    const access = async (cookie?: string) =>
      (await (await http.accessStatus(new Request("http://test.local/api/access", cookie ? { headers: { cookie } } : {}))).json()) as Record<
        string,
        unknown
      >;
    expect(await access()).toMatchObject({ lane: "public", mode: "economy" });
    expect(await access(judge)).toMatchObject({ lane: "judge", mode: "economy" });
    vi.setSystemTime(BREAKER_NOW + 4_999);
    expect(await access()).toMatchObject({ mode: "economy" });
    expect(stored).toHaveBeenCalledTimes(1);
    // Past the window: read again. A failed read answers null and is not reused.
    vi.setSystemTime(BREAKER_NOW + 5_000);
    stored.mockRejectedValueOnce(new Error("connect ECONNREFUSED"));
    expect(await access()).toMatchObject({ mode: null });
    expect(await access()).toMatchObject({ mode: "economy" });
    expect(stored).toHaveBeenCalledTimes(3);
    // An operator's switch through this process is seen at once.
    const admin = new Request("http://test.local/api/admin/mode", {
      method: "POST",
      headers: { authorization: "Bearer admin-token-for-tests", "content-type": "application/json" },
      body: JSON.stringify({ mode: "live" }),
    });
    vi.stubEnv("ADMIN_TOKEN", "admin-token-for-tests");
    vi.spyOn(log, "warn").mockImplementation(() => undefined);
    stored.mockResolvedValue(storedMode("live", null));
    expect((await http.adminMode(admin)).status).toBe(200);
    const reads = stored.mock.calls.length;
    expect(await access()).toMatchObject({ mode: "live" });
    expect(stored).toHaveBeenCalledTimes(reads + 1);
  });
});

describe("/api/admin/mode", () => {
  const admin = (init: RequestInit = {}) =>
    new Request("http://test.local/api/admin/mode", {
      ...init,
      headers: { authorization: "Bearer admin-token-for-tests", "content-type": "application/json", ...(init.headers ?? {}) },
    });

  it("answers 404 without the admin token, and while ADMIN_TOKEN is unset", async () => {
    vi.stubEnv("ADMIN_TOKEN", "");
    expect((await http.adminMode(admin())).status).toBe(404);
    vi.stubEnv("ADMIN_TOKEN", "admin-token-for-tests");
    expect((await http.adminMode(new Request("http://test.local/api/admin/mode"))).status).toBe(404);
  });

  it("shows the stored mode, the override and each lane's decision", async () => {
    vi.stubEnv("ADMIN_TOKEN", "admin-token-for-tests");
    vi.stubEnv("MODE_OVERRIDE", "");
    modeInputs.todayUsd = 0.6;
    const { status, body } = await answer(await http.adminMode(admin()));
    expect(status).toBe(200);
    expect(body).toMatchObject({
      override: null,
      lanes: { public: { mode: "economy", breaker: "llm_spend" }, judge: { mode: "live", breaker: null } },
    });
  });

  it("rejects a bad mode request", async () => {
    vi.stubEnv("ADMIN_TOKEN", "admin-token-for-tests");
    const bad = await http.adminMode(admin({ method: "POST", body: JSON.stringify({ mode: "turbo" }) }));
    expect(bad.status).toBe(400);
  });

  it("answers 503 when the mode it was told cannot be stored, rather than report a mode only this process holds", async () => {
    vi.stubEnv("ADMIN_TOKEN", "admin-token-for-tests");
    const refused = () => {
      throw Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
    };
    // A database that refuses every statement: the kv write fails.
    g.__ctContainer = { runs, modes: testModes(modeInputs), answers, db: { insert: refused, select: refused, execute: refused } };
    const res = await http.adminMode(admin({ method: "POST", body: JSON.stringify({ mode: "live" }) }));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "The mode could not be stored. Try again shortly.", retry: true });
  });
});

describe("GET /api/health: lanes and protection", () => {
  it("reports each lane's mode and breaker, the thresholds and the protection switches", async () => {
    g.__ctMigrationsApplied = true;
    modeInputs.todayUsd = 0.5;
    modeInputs.qloo = qlooUsage();
    // A database whose ping and reads answer: just enough for health.
    const db = { execute: async () => [{ "?column?": 1 }] };
    g.__ctContainer = { db, runs, modes: testModes(modeInputs), answers, qloo: mockQlooClient(), anthropic: null, stored: storedMode("live", null) };
    const { body } = await answer(await http.health());
    expect(body).toMatchObject({
      mode: "economy",
      lanes: {
        public: { mode: "economy", breaker: "llm_spend", until: "2026-10-23T00:00:00.000Z" },
        judge: { mode: "live", breaker: null },
      },
      llm: { thresholds: { public: { economy_at: 0.49, replay_at: 0.79 }, judge: { economy_at: 1, replay_at: 1.35 } } },
      protection: { turnstile: true, human_check: "on", judge_lane: true },
    });
  });
});
