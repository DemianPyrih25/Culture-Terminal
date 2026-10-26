// server/status.ts with fake sources: what one reading composes, how each breaker is measured, what
// stops a live question, and that a read which fails or hangs costs only its own part of the page.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BUDGETS,
  CANARY_ENTITY,
  CANARY_QUESTION,
  CANARY_REQUEST_ID,
  decision,
  fakeSources,
  LIMITS,
  NOW,
  qlooView,
  statusReport,
  TODAY,
} from "./fixtures";

vi.mock("server-only", () => ({}));

const { breakersOf, currentStatus, liveOf, readQlooView, readStatus, shareLevel, STATUS_REUSE_MS } = await import("../../server/status");

const level = (report: Awaited<ReturnType<typeof readStatus>>, key: string) => report.breakers.find((b) => b.key === key)?.level;

afterEach(() => {
  vi.useRealTimers();
  delete (globalThis as { __ctStatusReading?: unknown }).__ctStatusReading;
});

describe("readStatus", () => {
  it("composes a healthy prod server's reading", async () => {
    const report = await readStatus(fakeSources());
    expect(report.readAt).toBe(new Date(NOW + 5).toISOString());
    expect(report.version).toBe("0.0.0-test");
    expect(report.db).toEqual({ ok: true, latencyMs: 5 });
    expect(report.migrations).toEqual({ state: "applied", journal: { count: 2, latest: "0001_invented_step" } });
    expect(report.mode).toEqual({
      stored: { mode: "live", reason: null, since: null },
      override: null,
      lanes: { public: expect.objectContaining({ mode: "live" }), judge: expect.objectContaining({ mode: "live" }) },
    });
    expect(report.live).toEqual({ state: "live", blocks: [], message: null });
    expect(report.llm).toMatchObject({ configured: true, todayUsd: 0.12, laneUsd: { public: 0.1, judge: 0.02 }, capUsd: 1.4 });
    expect(report.llm.budgets.public.economyAt).toBe(0.49);
    expect(report.runs).toMatchObject({
      accepting: true,
      activeHere: 1,
      slots: { public: 3, judge: 1 },
      recentLimit: 20,
      lanes: { public: { lastHour: 4, hourlyCap: 20 }, judge: { lastHour: 1, hourlyCap: 20 } },
      test: { lastHour: 6, hourlyCap: 60 },
    });
    expect(report.runs.recent.live).toEqual(["completed", "completed", "failed", "incomplete", "completed"]);
    expect(report.qloo).toMatchObject({
      configured: true,
      env: "prod",
      today: { network: 120, cap: 1900, enforced: true, lanes: { public: { used: 100, cap: 1140 }, judge: { used: 20, cap: 760 } } },
      month: { remaining: 41_000, limit: 50_000, floor: 2000 },
      cache: { total: 400, served: 300, sampled: false },
      authErrors: 0,
      authErrorsTrip: 3,
    });
    expect(report.breakers.map((b) => b.key)).toEqual([
      "stored",
      "override",
      "llm_spend",
      "qloo_floor",
      "qloo_daily",
      "qloo_auth",
      "live_hourly",
      "qloo_switch",
      "draining",
    ]);
    expect(report.breakers.every((b) => b.level === "clear")).toBe(true);
  });

  it("reads today's UTC counters and the runs by hash prefix", async () => {
    const llmUsd = vi.fn(async () => 0);
    const recentStatuses = vi.fn(async () => []);
    const runsSince = vi.fn(async () => 0);
    const qlooCache = vi.fn(async () => ({ total: 0, served: 0, sampled: false }));
    await readStatus(fakeSources({ llmUsd, recentStatuses, runsSince, qlooCache }));
    expect(llmUsd.mock.calls.map((c) => c as unknown[])).toEqual([
      [TODAY, "all"],
      [TODAY, "public"],
      [TODAY, "judge"],
    ]);
    expect(recentStatuses.mock.calls).toEqual([
      ["q1:", 20],
      ["fake:", 20],
    ]);
    expect(runsSince).toHaveBeenCalledWith("fake:", 3_600_000);
    expect(qlooCache).toHaveBeenCalledWith("prod", new Date(`${TODAY}T00:00:00.000Z`));
  });

  it("passes on only the fields it names: a question, entity or request id in a source stays out", async () => {
    // Canaries in fields no type declares, as a source that grew a column would carry them.
    const extra = { question: CANARY_QUESTION, entity: CANARY_ENTITY, requestId: CANARY_REQUEST_ID };
    const with_ = <T extends object>(value: T): T => ({ ...value, ...extra });
    const report = await readStatus(
      fakeSources({
        storedMode: async () => with_({ mode: "economy" as const, reason: "admin", since: null }),
        decide: async () => ({ public: with_(decision("public")), judge: with_(decision("judge")) }),
        budget: (lane) => with_(BUDGETS[lane]),
        runManager: () => with_({ activeCount: () => 1, isAccepting: () => true }),
        migrations: () => with_({ applied: true, skipped: false, journal: with_({ count: 2, latest: "0001_invented_step" }) }),
        limits: () => with_({ ...LIMITS, slots: with_(LIMITS.slots) }),
        qlooCache: async () => with_({ total: 4, served: 3, sampled: false }),
        qloo: async () => {
          const view = qlooView();
          return with_({ ...view, quota: with_(view.quota) });
        },
      }),
    );
    const text = JSON.stringify(report);
    for (const canary of [CANARY_QUESTION, CANARY_ENTITY, CANARY_REQUEST_ID]) expect(text).not.toContain(canary);
    expect(report.mode.stored).toEqual({ mode: "economy", reason: "admin", since: null });
  });

  it("times the database from the ping alone", async () => {
    let clock = NOW;
    // Making the run manager takes 40 ms here; the ping, one tick.
    const report = await readStatus(
      fakeSources({
        now: () => (clock += 1),
        runManager: () => {
          clock += 40;
          return { activeCount: () => 0, isAccepting: () => true };
        },
      }),
    );
    expect(report.db.latencyMs).toBe(1);
    expect(report.readMs).toBeGreaterThan(40);
  });

  it("lets the Qloo read use the stored snapshot only once the database answered", async () => {
    const up = vi.fn(async () => qlooView());
    await readStatus(fakeSources({ qloo: up }));
    expect(up).toHaveBeenCalledWith(true);
    const down = vi.fn(async () => qlooView());
    await readStatus(fakeSources({ qloo: down, pingDb: async () => false }));
    expect(down).toHaveBeenCalledWith(false);
  });

  it("skips every database read while the database is down and says so first", async () => {
    const sources = fakeSources({ pingDb: async () => false, lastKnownMode: () => "economy" });
    const report = await readStatus(sources);
    expect(sources.reads).toEqual(["qloo"]);
    expect(report.db).toEqual({ ok: false, latencyMs: null });
    expect(report.mode.stored).toEqual({ mode: "economy", reason: null, since: null });
    expect(report.mode.lanes).toBeNull();
    expect(report.llm.todayUsd).toBeNull();
    expect(report.runs.recent).toEqual({ live: null, test: null });
    expect(report.live.blocks[0]).toBe("no_database");
    expect(report.live.state).toBe("unavailable");
    expect(level(report, "llm_spend")).toBe("unknown");
  });

  it("says whether kv pins every market a run needs, by market id and count only", async () => {
    expect((await readStatus(fakeSources())).localities).toEqual({ state: "complete", required: ["nashville", "austin"], missing: [], pinned: 2 });
    const partial = { state: "partial" as const, required: ["nashville", "austin"], missing: ["austin"], pinned: 1 };
    // Named fields only: anything else a source adds (here a planted locality id) never reaches the reading.
    const planted = { ...partial, entityId: CANARY_REQUEST_ID };
    const report = await readStatus(fakeSources({ localities: async () => planted }));
    expect(report.localities).toEqual(partial);
    expect(JSON.stringify(report)).not.toContain(CANARY_REQUEST_ID);
    const failed = await readStatus(
      fakeSources({
        localities: async () => {
          throw new Error("kv is unreadable");
        },
      }),
    );
    expect(failed.localities).toBeNull();
    expect(failed.db.ok).toBe(true);
    expect((await readStatus(fakeSources({ pingDb: async () => false }))).localities).toBeNull();
  });

  it("loses only the part whose read fails", async () => {
    const report = await readStatus(
      fakeSources({
        llmUsd: async () => {
          throw new Error("usage_daily is unreadable");
        },
        recentStatuses: async (prefix) => {
          if (prefix === "q1:") throw new Error("runs is unreadable");
          return ["completed"];
        },
      }),
    );
    expect(report.llm.todayUsd).toBeNull();
    expect(report.llm.laneUsd).toEqual({ public: null, judge: null });
    expect(report.runs.recent).toEqual({ live: null, test: ["completed"] });
    expect(report.runs.lanes.public.lastHour).toBe(4);
    expect(level(report, "llm_spend")).toBe("unknown");
  });

  it("gives up on a read that hangs after its timeout", async () => {
    vi.useFakeTimers();
    const pending = readStatus(fakeSources({ decide: () => new Promise(() => {}) }));
    await vi.advanceTimersByTimeAsync(3_000);
    const report = await pending;
    expect(report.mode.lanes).toBeNull();
    // Undecided, the public lane falls back to the stored mode.
    expect(report.live.state).toBe("live");
  });

  it("keeps the process counters unknown when the run manager cannot be made", async () => {
    const report = await readStatus(
      fakeSources({
        runManager: () => {
          throw new Error("DATABASE_URL is not set");
        },
      }),
    );
    expect(report.runs.activeHere).toBeNull();
    expect(report.runs.accepting).toBeNull();
    expect(level(report, "draining")).toBe("unknown");
  });

  it("counts only this server's mock calls, from today's snapshot only", async () => {
    const qlooFresh = vi.fn(async () => 999);
    const report = await readStatus(
      fakeSources({ qlooFresh, qloo: async () => qlooView({ env: "mock", monthFloor: 38_000 }, { todayNetwork: 12 }) }),
    );
    expect(qlooFresh).not.toHaveBeenCalled();
    expect(report.qloo).toMatchObject({ env: "mock", today: { network: 12, enforced: false, lanes: { public: { used: null } } } });
    expect(level(report, "qloo_daily")).toBe("off");

    const yesterday = await readStatus(
      fakeSources({ qlooFresh, qloo: async () => qlooView({ env: "mock" }, { day: "2026-10-22", todayNetwork: 12 }) }),
    );
    expect(yesterday.qloo.configured && yesterday.qloo.today.network).toBe(0);
  });

  it("takes the higher of the stored counter and this server's own count", async () => {
    const report = await readStatus(fakeSources({ qloo: async () => qlooView({}, { todayNetwork: 150 }) }));
    expect(report.qloo.configured && report.qloo.today.network).toBe(150);
  });

  it("reports Qloo as not configured, and live analysis as unavailable, without a client", async () => {
    const report = await readStatus(fakeSources({ qloo: async () => null }));
    expect(report.qloo).toEqual({ configured: false, disabled: false });
    expect(report.live).toEqual({ state: "unavailable", blocks: ["no_qloo"], message: null });
    expect(level(report, "qloo_floor")).toBe("unknown");
    expect(level(report, "qloo_switch")).toBe("clear");
  });

  it("holds live runs back, and leaves the Qloo breakers unenforced, while QLOO_DISABLED", async () => {
    // A configured client whose numbers would trip the floor and warn on the key: none of it applies.
    const report = await readStatus(
      fakeSources({
        limits: () => ({ ...LIMITS, qlooDisabled: true }),
        qloo: async () => qlooView({}, { monthRemaining: 100, consecutiveAuthErrors: 1 }),
      }),
    );
    expect(report.qloo).toMatchObject({ configured: true, disabled: true });
    expect(report.live).toEqual({ state: "limited", blocks: ["qloo_disabled"], message: null });
    expect(level(report, "qloo_floor")).toBe("off");
    expect(level(report, "qloo_daily")).toBe("off");
    expect(level(report, "qloo_auth")).toBe("off");
    expect(level(report, "qloo_switch")).toBe("tripped");

    // Without a client too, the run manager refuses first; QLOO_DISABLED still holds.
    const bare = await readStatus(fakeSources({ qloo: async () => null, limits: () => ({ ...LIMITS, qlooDisabled: true }) }));
    expect(bare.live.blocks).toEqual(["no_qloo", "qloo_disabled"]);
    expect(level(bare, "qloo_floor")).toBe("off");
  });

  it("passes the public lane's decision and message through when it steps down", async () => {
    const message = "Live briefs run on the economy analyst until 00:00 UTC: today's live budget is nearly used.";
    const report = await readStatus(
      fakeSources({
        llmUsd: async (_day, lane) => (lane === "all" ? 0.6 : 0.3),
        decide: async () => ({
          public: decision("public", "economy", { breaker: "llm_spend", message, until: "2026-10-24T00:00:00.000Z" }),
          judge: decision("judge"),
        }),
      }),
    );
    expect(report.live).toEqual({ state: "economy", blocks: [], message });
    expect(report.mode.lanes?.public).toMatchObject({ mode: "economy", breaker: "llm_spend" });
    expect(level(report, "llm_spend")).toBe("stepped");
  });
});

describe("breakersOf", () => {
  const base = statusReport();
  const of = (over: Partial<ReturnType<typeof statusReport>>, qlooDisabled = false) => {
    const r = { ...base, ...over };
    return Object.fromEntries(breakersOf({ mode: r.mode, llm: r.llm, runs: r.runs, qloo: r.qloo, qlooDisabled }).map((b) => [b.key, b.level]));
  };

  it("measures LLM spend on the public lane: past half of the cap, economy, then tripped", () => {
    const at = (todayUsd: number) => of({ llm: { ...base.llm, todayUsd } }).llm_spend;
    expect(at(0.2)).toBe("clear");
    expect(at(0.49)).toBe("stepped");
    expect(at(0.79)).toBe("tripped");
    // With a public economy step above half the cap, half shows first.
    expect(of({ llm: { ...base.llm, todayUsd: 0.75, budgets: { ...base.llm.budgets, public: { economyAt: 1, replayAt: 1.3, cap: 1.4 } } } }).llm_spend).toBe("half");
  });

  it("reads the stored mode and the override", () => {
    expect(of({ mode: { ...base.mode, stored: { mode: "replay_only", reason: "qloo", since: null } } }).stored).toBe("tripped");
    expect(of({ mode: { ...base.mode, stored: { mode: "economy", reason: "admin", since: null } } }).stored).toBe("stepped");
    expect(of({ mode: { ...base.mode, override: "live" } }).override).toBe("bypassed");
    expect(of({ mode: { ...base.mode, override: "replay_only" } }).override).toBe("tripped");
  });

  it("trips the month floor below it and measures the calls usable above it", () => {
    const month = (remaining: number | null, limit: number | null = 50_000) =>
      of({ qloo: { ...(base.qloo as Extract<typeof base.qloo, { configured: true }>), month: { remaining, limit, floor: 2000, resetsAt: null, capturedAt: null } } })
        .qloo_floor;
    expect(month(1_999)).toBe("tripped");
    expect(month(10_000)).toBe("high");
    expect(month(25_000)).toBe("half");
    expect(month(45_000)).toBe("clear");
    expect(month(null)).toBe("unknown");
    expect(month(1_000, null)).toBe("tripped");
  });

  it("trips the daily cap once a whole run no longer fits, in prod only", () => {
    const q = base.qloo as Extract<typeof base.qloo, { configured: true }>;
    const today = (network: number, publicUsed: number, enforced = true) =>
      of({ qloo: { ...q, today: { ...q.today, network, enforced, lanes: { ...q.today.lanes, public: { used: publicUsed, cap: 1140 } } } } }).qloo_daily;
    expect(today(1000, 1101)).toBe("tripped");
    expect(today(1861, 900)).toBe("tripped");
    expect(today(1000, 900)).toBe("half");
    expect(today(1861, 1101, false)).toBe("off");
  });

  it("reads the key streak, the hourly cap, the switch and the drain", () => {
    const q = base.qloo as Extract<typeof base.qloo, { configured: true }>;
    expect(of({ qloo: { ...q, authErrors: 3 } }).qloo_auth).toBe("tripped");
    // A streak is a count: begun, it warns; it is never a share like "past 80%".
    expect(of({ qloo: { ...q, authErrors: 1 } }).qloo_auth).toBe("warn");
    expect(of({ qloo: { ...q, authErrors: 2 } }).qloo_auth).toBe("warn");
    expect(of({ runs: { ...base.runs, lanes: { ...base.runs.lanes, public: { lastHour: 20, hourlyCap: 20 } } } }).live_hourly).toBe("tripped");
    expect(of({ runs: { ...base.runs, lanes: { ...base.runs.lanes, public: { lastHour: 16, hourlyCap: 20 } } } }).live_hourly).toBe("high");
    expect(of({}, true).qloo_switch).toBe("tripped");
    expect(of({ runs: { ...base.runs, accepting: false } }).draining).toBe("tripped");
  });

  it("leaves the Qloo breakers unenforced while QLOO_DISABLED, as the mode machine does", () => {
    const q = base.qloo as Extract<typeof base.qloo, { configured: true }>;
    const off = of({ qloo: { ...q, authErrors: 3, month: { ...q.month, remaining: 10 } } }, true);
    expect([off.qloo_floor, off.qloo_daily, off.qloo_auth, off.qloo_switch]).toEqual(["off", "off", "off", "tripped"]);
  });
});

describe("liveOf", () => {
  const ok = {
    dbOk: true,
    accepting: true,
    anthropic: true,
    qlooConfigured: true,
    qlooDisabled: false,
    mode: "live" as const,
    message: null,
    hourlyFull: false,
  };

  it("lists what stops a live question, most fundamental first", () => {
    expect(liveOf({ ...ok, dbOk: false, anthropic: false, mode: "replay_only" }).blocks).toEqual(["no_database", "no_anthropic", "replay_only"]);
    expect(liveOf({ ...ok, accepting: false }).state).toBe("unavailable");
    expect(liveOf({ ...ok, mode: "replay_only", message: "Live analysis is paused." })).toEqual({
      state: "paused",
      blocks: ["replay_only"],
      message: "Live analysis is paused.",
    });
    expect(liveOf({ ...ok, hourlyFull: true }).state).toBe("limited");
    expect(liveOf({ ...ok, mode: "economy" }).state).toBe("economy");
    expect(liveOf({ ...ok, message: "ignored while live" })).toEqual({ state: "live", blocks: [], message: null });
  });

  it("holds runs back while QLOO_DISABLED, behind a pause and a full hour", () => {
    expect(liveOf({ ...ok, qlooDisabled: true })).toEqual({ state: "limited", blocks: ["qloo_disabled"], message: null });
    expect(liveOf({ ...ok, qlooDisabled: true, mode: "economy" }).state).toBe("limited");
    expect(liveOf({ ...ok, qlooDisabled: true, mode: "replay_only" }).blocks).toEqual(["replay_only", "qloo_disabled"]);
    expect(liveOf({ ...ok, qlooDisabled: true, hourlyFull: true }).blocks).toEqual(["live_hourly", "qloo_disabled"]);
    expect(liveOf({ ...ok, qlooDisabled: true, qlooConfigured: false }).state).toBe("unavailable");
  });
});

describe("readQlooView", () => {
  const loaded = qlooView().quota;
  const untouched = { ...loaded, monthLimit: null, monthRemaining: null, monthReset: null, capturedAt: null, lastSuccessAt: null, todayNetwork: 0 };
  /** A prod client whose snapshot is `quota`, over a kv that holds `stored`. */
  const deps = (quota: typeof loaded, stored: unknown) => ({
    client: () => ({ env: "prod" as const, monthFloor: 2000, quota: () => quota }),
    readStored: vi.fn<(env: string) => Promise<unknown>>(async () => stored),
  });

  it("uses the client's own snapshot once it holds anything", async () => {
    const d = deps({ ...untouched, consecutiveAuthErrors: 1 }, loaded);
    expect(await readQlooView(true, d)).toMatchObject({ env: "prod", monthFloor: 2000, quota: { consecutiveAuthErrors: 1, monthRemaining: null } });
    expect(d.readStored).not.toHaveBeenCalled();
  });

  it("reads the stored snapshot while the client's is untouched (still loading)", async () => {
    const d = deps(untouched, loaded);
    expect(await readQlooView(true, d)).toEqual({ env: "prod", monthFloor: 2000, quota: loaded });
    expect(d.readStored).toHaveBeenCalledWith("prod");
  });

  it("keeps the client's defaults when the stored snapshot is missing, malformed or not readable", async () => {
    expect((await readQlooView(true, deps(untouched, undefined)))?.quota).toEqual(untouched);
    expect((await readQlooView(true, deps(untouched, { monthLimit: "many" })))?.quota).toEqual(untouched);
    const failing = { ...deps(untouched, loaded), readStored: async () => Promise.reject(new Error("kv is unreadable")) };
    expect((await readQlooView(true, failing))?.quota).toEqual(untouched);
    const throwing = {
      ...deps(untouched, loaded),
      readStored: (): Promise<unknown> => {
        throw new Error("DATABASE_URL is not set");
      },
    };
    expect((await readQlooView(true, throwing))?.quota).toEqual(untouched);
    const down = deps(untouched, loaded);
    expect((await readQlooView(false, down))?.quota).toEqual(untouched);
    expect(down.readStored).not.toHaveBeenCalled();
  });

  it("gives up on a stored read that hangs, and has no view without a client", async () => {
    vi.useFakeTimers();
    const pending = readQlooView(true, { ...deps(untouched, loaded), readStored: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(1_500);
    expect((await pending)?.quota).toEqual(untouched);
    const none = await readQlooView(true, {
      client: () => {
        throw new Error("QLOO_API_KEY is not set");
      },
      readStored: async () => loaded,
    });
    expect(none).toBeNull();
  });
});

describe("shareLevel", () => {
  it("is clear below 50%, then past 50% and past 80%", () => {
    expect(shareLevel(49, 100, false)).toBe("clear");
    expect(shareLevel(50, 100, false)).toBe("half");
    expect(shareLevel(80, 100, false)).toBe("high");
    expect(shareLevel(10, 100, true)).toBe("tripped");
    expect(shareLevel(null, 100, true)).toBe("unknown");
    expect(shareLevel(1, 0, false)).toBe("unknown");
  });
});

describe("currentStatus", () => {
  it("reuses a reading for STATUS_REUSE_MS, then takes a new one", async () => {
    const read = vi.fn(async () => statusReport());
    const first = currentStatus(NOW, read);
    expect(currentStatus(NOW + STATUS_REUSE_MS - 1, read)).toBe(first);
    expect(read).toHaveBeenCalledTimes(1);
    currentStatus(NOW + STATUS_REUSE_MS, read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("drops a reading that failed, so the next request tries again", async () => {
    const read = vi.fn(async () => {
      throw new Error("unexpected");
    });
    await expect(currentStatus(NOW, read)).rejects.toThrow("unexpected");
    await expect(currentStatus(NOW + 1, read)).rejects.toThrow("unexpected");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
