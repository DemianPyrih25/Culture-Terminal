// Lanes and breakers in the run manager against a real Postgres in a throwaway database, with a
// scripted runAgent: no model and no Qloo call is made. The judge lane's own hourly and daily caps,
// slots and budget; the public lane's per-visitor limits, counted from the runs' visitor hash so a
// restart keeps them, and that hash's retention; the economy reserve; the admin switch's
// stored mode; and the mode machine on the database's real spend, stepping a lane live → economy →
// replay only as runs record what they spent. Skips only when no database is reachable. Invented
// questions and visitor keys only.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Lane } from "@ct/contracts";
import { getRun, requestCancel } from "@ct/db";
import { EventBus } from "../server/event-bus";
import { agentDeps, completedAgent, TOTAL_USD, waitingAgent } from "./support/agent";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./support/test-db";

vi.mock("server-only", () => ({}));

const available = await databaseAvailable();

const { laneBudget, ModeService } = await import("../server/breakers");
const { PRE_RUN_ECONOMY_USD, PRE_RUN_USD, SpendMeter, todayLlmUsd } = await import("../server/llm-spend");
const { LIVE_STORED, readStoredMode, writeMode } = await import("../server/mode");
const { countLaneRunsSince } = await import("../server/run-counts");
const { RunManager, runManagerErrorCode, runManagerRetryAfterS } = await import("../server/run-manager");
type RunManagerOptions = ConstructorParameters<typeof RunManager>[0];

const HOUR = 3_600_000;
const QUESTION = "Is the Juniper Cola audience a moat or a niche?";

const refusal = async (start: Promise<unknown>) => {
  try {
    await start;
  } catch (err) {
    return { code: runManagerErrorCode(err), message: err instanceof Error ? err.message : String(err) };
  }
  throw new Error("expected a refusal");
};

describe.skipIf(!available)("lanes and breakers against Postgres", () => {
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
      runAgent: completedAgent(),
      agentHourlyCap: 10_000,
      judgeHourlyCap: 10_000,
      llmDailyUsdCap: 10_000,
      ...options,
    });
    managers.push(runs);
    return { db, runs };
  }

  async function stop(runs: InstanceType<typeof RunManager>, ...runIds: string[]) {
    for (const runId of runIds) {
      await requestCancel(t!.db, runId);
      await runs.whenDone(runId);
    }
  }

  it("records the lane on the run and counts each lane's runs apart", async () => {
    const { db, runs } = setup();
    const before = { public: await countLaneRunsSince(db, "public", HOUR), judge: await countLaneRunsSince(db, "judge", HOUR) };
    const { runId } = await runs.startAgentRun({ question: QUESTION, lane: "judge" });
    await runs.whenDone(runId);
    expect(await getRun(db, runId)).toMatchObject({ lane: "judge", status: "completed" });
    expect(await countLaneRunsSince(db, "judge", HOUR)).toBe(before.judge + 1);
    expect(await countLaneRunsSince(db, "public", HOUR)).toBe(before.public);
    // Test runs are public-lane rows but never agent runs.
    const fake = await runs.startFakeRun({ seconds: 1 });
    await runs.whenDone(fake.runId);
    expect(await countLaneRunsSince(db, "public", HOUR)).toBe(before.public);
    await expect(countLaneRunsSince(db, "public", 0)).rejects.toThrow(RangeError);
    await expect(countLaneRunsSince(db, "nobody" as Lane, HOUR)).rejects.toThrow();
  }, 30_000);

  it("gives the judge lane its own hourly cap", async () => {
    const db = t!.db;
    const publicRuns = await countLaneRunsSince(db, "public", HOUR);
    const judgeRuns = await countLaneRunsSince(db, "judge", HOUR);
    const { runs } = setup({ agentHourlyCap: publicRuns, judgeHourlyCap: judgeRuns + 1 });
    expect(await refusal(runs.startAgentRun({ question: QUESTION, lane: "public" }))).toMatchObject({ code: "limited" });
    const judged = await runs.startAgentRun({ question: QUESTION, lane: "judge" });
    await runs.whenDone(judged.runId);
    expect(await refusal(runs.startAgentRun({ question: QUESTION, lane: "judge" }))).toMatchObject({ code: "limited" });
  }, 30_000);

  it("keeps a slot for the judge lane inside the global cap, which public runs never take", async () => {
    const { runs } = setup({ agentMaxActive: 3, judgeMaxActive: 1, runAgent: waitingAgent("incomplete") });
    const publicRuns = [
      await runs.startAgentRun({ question: QUESTION, lane: "public" }),
      await runs.startAgentRun({ question: QUESTION, lane: "public" }),
    ];
    expect(await refusal(runs.startAgentRun({ question: QUESTION, lane: "public" }))).toMatchObject({ code: "busy" });
    const judged = await runs.startAgentRun({ question: QUESTION, lane: "judge" });
    expect(await refusal(runs.startAgentRun({ question: QUESTION, lane: "judge" }))).toMatchObject({ code: "busy" });
    // SPEC §10.4: 3 live runs in all, the judge lane's among them.
    expect(runs.activeCount()).toBe(3);
    await stop(runs, ...publicRuns.map((r) => r.runId), judged.runId);
  }, 30_000);

  it("holds no judge slot while the judge lane is closed, and never lets the total pass the cap", async () => {
    const closed = setup({ agentMaxActive: 2, judgeMaxActive: 0, runAgent: waitingAgent("incomplete") });
    const both = [
      await closed.runs.startAgentRun({ question: QUESTION, lane: "public" }),
      await closed.runs.startAgentRun({ question: QUESTION, lane: "public" }),
    ];
    expect(await refusal(closed.runs.startAgentRun({ question: QUESTION, lane: "public" }))).toMatchObject({ code: "busy" });
    await stop(closed.runs, ...both.map((r) => r.runId));
    // One slot in all: a judge run waits for the public run that holds it.
    const one = setup({ agentMaxActive: 1, judgeMaxActive: 1, runAgent: waitingAgent("incomplete") });
    const first = await one.runs.startAgentRun({ question: QUESTION, lane: "public" });
    expect(await refusal(one.runs.startAgentRun({ question: QUESTION, lane: "judge" }))).toMatchObject({ code: "busy" });
    await stop(one.runs, first.runId);
  }, 30_000);

  it("holds a public visitor to one live run at a time and 3 an hour, apart from other visitors and judges", async () => {
    const { runs } = setup({ runAgent: waitingAgent("incomplete") });
    const first = await runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-a" });
    expect(await refusal(runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-a" }))).toEqual({
      code: "limited",
      message: "Your last live question is still running. Ask again once it ends.",
    });
    const other = await runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-b" });
    // The same address on the judge lane is the lane's to limit, not the visitor's.
    const judged = await runs.startAgentRun({ question: QUESTION, lane: "judge", client: "visitor-a" });
    await stop(runs, first.runId, other.runId, judged.runId);
    for (let i = 0; i < 2; i++) {
      const next = await runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-a" });
      await stop(runs, next.runId);
    }
    expect(await refusal(runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-a" }))).toEqual({
      code: "limited",
      message: "You have started 3 live questions in the last hour. Try again in about 1 hour; answers you already have still open.",
    });
    // Trusted callers and unknown addresses have no visitor to count.
    const trusted = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await stop(runs, trusted.runId);
  }, 30_000);

  it("records the visitor's hash on every run it starts, and none for a trusted caller", async () => {
    const { db, runs } = setup();
    const visited = await runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-r" });
    const judged = await runs.startAgentRun({ question: QUESTION, lane: "judge", client: "visitor-r" });
    const fake = await runs.startFakeRun({ seconds: 1, client: "visitor-r" });
    const trusted = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    for (const { runId } of [visited, judged, fake, trusted]) await runs.whenDone(runId);
    expect((await getRun(db, visited.runId))?.ipHash).toBe("visitor-r");
    expect((await getRun(db, judged.runId))?.ipHash).toBe("visitor-r");
    expect((await getRun(db, fake.runId))?.ipHash).toBe("visitor-r");
    expect((await getRun(db, trusted.runId))?.ipHash).toBeNull();
  }, 30_000);

  it("keeps a visitor's hour and day across a restart: a new run manager counts the runs the last one started", async () => {
    const before = setup({ runAgent: completedAgent() });
    for (let i = 0; i < 3; i++) await before.runs.whenDone((await before.runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-s" })).runId);
    await before.runs.drain(0);
    // A new process on the same database: nothing in memory, the runs table remembers.
    const after = setup();
    const refused = await refusal(after.runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-s" }));
    expect(refused).toEqual({
      code: "limited",
      message: "You have started 3 live questions in the last hour. Try again in about 1 hour; answers you already have still open.",
    });
    let retryAfterS: number | null = null;
    try {
      await after.runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-s" });
    } catch (err) {
      retryAfterS = runManagerRetryAfterS(err);
    }
    // The oldest of the three started moments ago: it leaves the hour in just under an hour.
    expect(retryAfterS).toBeGreaterThan(3600 - 60);
    expect(retryAfterS).toBeLessThanOrEqual(3600);
    // Another visitor, and the same visitor's judge runs, are not held back.
    await after.runs.whenDone((await after.runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-t" })).runId);
    await after.runs.whenDone((await after.runs.startAgentRun({ question: QUESTION, lane: "judge", client: "visitor-s" })).runId);
  }, 30_000);

  it("clears the visitor hash of runs past the day, and only theirs", async () => {
    const { db, runs } = setup();
    const old = await runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-u" });
    const recent = await runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-v" });
    for (const { runId } of [old, recent]) await runs.whenDone(runId);
    await db.execute(`update runs set created_at = now() - interval '26 hours' where id = '${old.runId}'`);
    expect(await runs.forgetVisitors()).toBeGreaterThanOrEqual(1);
    expect((await getRun(db, old.runId))?.ipHash).toBeNull();
    expect((await getRun(db, recent.runId))?.ipHash).toBe("visitor-v");
  }, 30_000);

  it("counts a visitor's day, and the judge lane's and the whole day's caps", async () => {
    const db = t!.db;
    const visitor = setup({ visitorLimits: { maxActive: 1, perHour: 10, perDay: 2 } });
    for (let i = 0; i < 2; i++) await visitor.runs.whenDone((await visitor.runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-c" })).runId);
    expect(await refusal(visitor.runs.startAgentRun({ question: QUESTION, lane: "public", client: "visitor-c" }))).toMatchObject({
      code: "limited",
      message: "You have started 2 live questions in the last day. Try again in about 24 hours; answers you already have still open.",
    });

    const judgeDay = await countLaneRunsSince(db, "judge", 24 * HOUR);
    const judges = setup({ judgeDailyCap: judgeDay + 1 });
    await judges.runs.whenDone((await judges.runs.startAgentRun({ question: QUESTION, lane: "judge" })).runId);
    expect(await refusal(judges.runs.startAgentRun({ question: QUESTION, lane: "judge" }))).toEqual({
      code: "limited",
      message: "The judge lane's daily limit for live runs is reached. Answers you already have still open.",
    });

    const day = (await countLaneRunsSince(db, "public", 24 * HOUR)) + (await countLaneRunsSince(db, "judge", 24 * HOUR));
    const all = setup({ agentDailyCap: day + 1 });
    await all.runs.whenDone((await all.runs.startAgentRun({ question: QUESTION, lane: "judge" })).runId);
    expect(await refusal(all.runs.startAgentRun({ question: QUESTION, lane: "public" }))).toEqual({
      code: "limited",
      message: "Today's limit for live runs is reached. Answers you already have still open.",
    });
  }, 30_000);

  it("holds the judge reserve: a public run is refused where a judge run still fits", async () => {
    const spent = await todayLlmUsd(t!.db);
    const { runs } = setup({ llmLaneUsdCap: { public: spent + PRE_RUN_USD - 0.01, judge: spent + PRE_RUN_USD + 0.01 } });
    expect(await refusal(runs.startAgentRun({ question: QUESTION, lane: "public" }))).toMatchObject({ code: "budget" });
    const judged = await runs.startAgentRun({ question: QUESTION, lane: "judge" });
    await runs.whenDone(judged.runId);
  }, 30_000);

  it("holds only the economy reserve for a run on the economy ANALYST", async () => {
    const spent = await todayLlmUsd(t!.db);
    const cap = spent + PRE_RUN_ECONOMY_USD + 0.01;
    const live = setup({ llmDailyUsdCap: cap });
    expect(await refusal(live.runs.startAgentRun({ question: QUESTION, lane: "public" }))).toMatchObject({ code: "budget" });
    const economy = setup({ llmDailyUsdCap: cap, agent: agentDeps({}, "economy"), runAgent: waitingAgent() });
    const first = await economy.runs.startAgentRun({ question: QUESTION, lane: "public" });
    expect(await getRun(t!.db, first.runId)).toMatchObject({ mode: "economy", model: "claude-haiku-5-5" });
    // The first economy run holds its reserve: a second one would pass the cap.
    expect(await refusal(economy.runs.startAgentRun({ question: QUESTION, lane: "public" }))).toMatchObject({ code: "limited" });
    await stop(economy.runs, first.runId);
  }, 30_000);

  it("refuses with the breaker's own message in replay-only mode, picker answers included", async () => {
    const message = "Live analysis is paused: today's budget is used up. It resumes at 00:00 UTC.";
    const { runs } = setup({ agent: agentDeps({ mode: async () => ({ mode: "replay_only", message }) }) });
    expect(await refusal(runs.startAgentRun({ question: QUESTION, lane: "public" }))).toEqual({ code: "unavailable", message });
    expect(await refusal(runs.answerPicker({ runId: "run-needs-0001", key: `pk_${"0a".repeat(8)}`, lane: "public" }))).toEqual({
      code: "unavailable",
      message,
    });
  }, 30_000);

  it("steps a lane down as runs record their spend: live, economy, then replay only", async () => {
    const db = t!.db;
    const spent = await todayLlmUsd(db);
    // Judge share 0, so both lanes share thresholds: economy from spent + 0.20, replay only from spent + 0.55.
    const policy = { dailyCapUsd: spent + 0.6, economyAtUsd: spent + 0.2, judgeShare: 0 };
    const modes = new ModeService(
      { override: () => null, stored: async () => LIVE_STORED, todayUsd: (now) => todayLlmUsd(db, now), qloo: async () => null },
      policy,
    );
    const lanes = ["public", "judge"] as const;
    const { runs } = setup({
      agent: agentDeps({ mode: (lane) => modes.decide(lane) }),
      llmLaneUsdCap: Object.fromEntries(lanes.map((lane) => [lane, laneBudget(lane, policy).cap])),
    });
    const seen: string[] = [];
    for (;;) {
      let runId: string;
      try {
        ({ runId } = await runs.startAgentRun({ question: QUESTION, lane: "public" }));
      } catch (err) {
        expect(runManagerErrorCode(err)).toBe("unavailable");
        expect((err as Error).message).toBe("Live analysis is paused: today's budget is used up. It resumes at 00:00 UTC.");
        break;
      }
      await runs.whenDone(runId);
      seen.push((await getRun(db, runId))?.mode ?? "?");
      if (seen.length > 10) throw new Error("the breaker never tripped");
    }
    // Each run records TOTAL_USD: two live runs reach the economy threshold, two economy runs the replay one.
    expect(TOTAL_USD).toBe(0.15);
    expect(seen).toEqual(["live", "live", "economy", "economy"]);
    expect((await modes.decide("public")).breaker).toBe("llm_spend");
  }, 60_000);

  it("stores the admin switch's mode in the database, so it clears a replay-only the Qloo breaker stored", async () => {
    const db = t!.db;
    vi.stubEnv("ADMIN_TOKEN", "admin-token-for-tests");
    vi.stubEnv("MODE_OVERRIDE", "");
    const container = await import("../server/container");
    const g = globalThis as { __ctContainer?: unknown };
    const modes = new ModeService({ override: () => null, stored: container.getStoredMode, todayUsd: async () => 0, qloo: async () => null });
    g.__ctContainer = { db, modes };
    try {
      await writeMode(db, "replay_only", "qloo");
      const http = await import("../server/http");
      const admin = (init: RequestInit = {}) =>
        new Request("http://test.local/api/admin/mode", {
          ...init,
          headers: { authorization: "Bearer admin-token-for-tests", "content-type": "application/json" },
        });
      expect(await (await http.adminMode(admin())).json()).toMatchObject({
        stored: { mode: "replay_only", reason: "qloo" },
        lanes: { public: { mode: "replay_only", breaker: "stored" }, judge: { mode: "replay_only", breaker: "stored" } },
      });
      const set = await http.adminMode(admin({ method: "POST", body: JSON.stringify({ mode: "live", reason: "key fixed" }) }));
      expect(set.status).toBe(200);
      expect(await set.json()).toMatchObject({
        stored: { mode: "live", reason: "key fixed" },
        lanes: { public: { mode: "live", breaker: null }, judge: { mode: "live", breaker: null } },
      });
      // In the database, where the other processes and a restart read it, not only in this process.
      expect(await readStoredMode(db)).toMatchObject({ mode: "live", reason: "key fixed" });
      expect(await (await http.adminMode(admin())).json()).toMatchObject({ stored: { mode: "live" }, lanes: { public: { mode: "live" } } });
    } finally {
      delete g.__ctContainer;
      vi.unstubAllEnvs();
    }
  }, 30_000);

  it("counts the judge lane's own spend against the day", async () => {
    const db = t!.db;
    const spent = await todayLlmUsd(db);
    const policy = { dailyCapUsd: spent + 0.5, economyAtUsd: spent + 0.1, judgeShare: 0.4 };
    const modes = new ModeService(
      { override: () => null, stored: async () => LIVE_STORED, todayUsd: (now) => todayLlmUsd(db, now), qloo: async () => null },
      policy,
    );
    expect((await modes.decide("judge")).mode).toBe("live");
    await new SpendMeter(db, "judge").upTo(0.2);
    expect((await modes.decide("judge")).mode).toBe("economy");
  }, 30_000);
});
