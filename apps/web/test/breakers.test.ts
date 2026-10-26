// The mode machine (breakers.ts): every breaker forced through every transition, on injected spend,
// Qloo counters, stored mode and clock, and the reader of those counters on a stub client and
// database. No database.
import { describe, expect, it, vi } from "vitest";
import type { Lane } from "@ct/contracts";
import type { Queryable } from "@ct/db";
import type { QlooClient } from "@ct/qloo";

vi.mock("server-only", () => ({}));

const { DEFAULT_SPEND_POLICY, decideMode, laneBudget, laneModeOf, nextUtcMidnight, QLOO_RUN_MARGIN, qlooUsageReader } = await import(
  "../server/breakers"
);
const { PRE_RUN_ECONOMY_USD, PRE_RUN_USD } = await import("../server/llm-spend");
const { LIVE_STORED } = await import("../server/mode");
const { BREAKER_NOW, qlooUsage, storedMode, testModes } = await import("./support/protection");

type Inputs = Parameters<typeof decideMode>[1];
const LANES: readonly Lane[] = ["public", "judge"];
const MIDNIGHT = "2026-10-23T00:00:00.000Z";

const inputs = (partial: Partial<Inputs> = {}): Inputs => ({ override: null, stored: LIVE_STORED, todayUsd: 0, qloo: null, ...partial });
const decide = (lane: Lane, partial: Partial<Inputs> = {}, policy = DEFAULT_SPEND_POLICY) =>
  decideMode(lane, inputs(partial), policy, BREAKER_NOW);

describe("laneBudget", () => {
  it("gives the judge lane the whole budget and the public lane what the judge reserve leaves", () => {
    expect(laneBudget("judge", DEFAULT_SPEND_POLICY)).toEqual({ economyAt: 1, replayAt: 1.35, cap: 1.4 });
    // 60% of $1.40 is $0.84; economy starts where a live run's $0.35 reserve stops fitting.
    expect(laneBudget("public", DEFAULT_SPEND_POLICY)).toEqual({ economyAt: 0.49, replayAt: 0.79, cap: 0.84 });
  });

  it("never lets a live run's reserve or an economy run's reserve overrun the lane's cap", () => {
    for (const dailyCapUsd of [0, 0.2, 0.5, 1, 1.4, 3, 10]) {
      for (const economyAtUsd of [0, 0.5, 1, 5]) {
        for (const judgeShare of [0, 0.4, 0.9]) {
          for (const lane of LANES) {
            const b = laneBudget(lane, { dailyCapUsd, economyAtUsd, judgeShare });
            expect(b.economyAt).toBeLessThanOrEqual(b.replayAt);
            expect(b.replayAt).toBeLessThanOrEqual(b.cap);
            if (b.economyAt > 0) expect(b.economyAt + PRE_RUN_USD).toBeLessThanOrEqual(b.cap + 1e-9);
            if (b.replayAt > 0) expect(b.replayAt + PRE_RUN_ECONOMY_USD).toBeLessThanOrEqual(b.cap + 1e-9);
          }
        }
      }
    }
  });
});

describe("decideMode: the LLM spend breaker", () => {
  it("steps the public lane live → economy → replay only as today's spend crosses its thresholds", () => {
    expect(decide("public", { todayUsd: 0.48 })).toMatchObject({ mode: "live", breaker: null, message: null, until: null });
    expect(decide("public", { todayUsd: 0.49 })).toEqual({
      lane: "public",
      mode: "economy",
      breaker: "llm_spend",
      reason: "today's live budget is nearly used",
      message: "Live briefs run on the economy analyst until 00:00 UTC: today's live budget is nearly used.",
      until: MIDNIGHT,
    });
    expect(decide("public", { todayUsd: 0.79 })).toEqual({
      lane: "public",
      mode: "replay_only",
      breaker: "llm_spend",
      reason: "today's budget is used up",
      message: "Live analysis is paused: today's budget is used up. It resumes at 00:00 UTC.",
      until: MIDNIGHT,
    });
  });

  it("steps the judge lane at $1.00 and $1.35, while the public lane is already paused", () => {
    expect(decide("judge", { todayUsd: 0.99 }).mode).toBe("live");
    expect(decide("judge", { todayUsd: 1 }).mode).toBe("economy");
    expect(decide("judge", { todayUsd: 1.34 }).mode).toBe("economy");
    expect(decide("judge", { todayUsd: 1.35 }).mode).toBe("replay_only");
    expect(decide("public", { todayUsd: 1 }).mode).toBe("replay_only");
  });

  it("never steps the judge lane down before the public lane, at any spend", () => {
    const rank = { live: 2, economy: 1, replay_only: 0 } as const;
    for (let cents = 0; cents <= 200; cents++) {
      const todayUsd = cents / 100;
      expect(rank[decide("judge", { todayUsd }).mode]).toBeGreaterThanOrEqual(rank[decide("public", { todayUsd }).mode]);
    }
  });

  it("follows the policy, so each step can be forced from the environment", () => {
    // LLM_ECONOMY_USD=0: economy at once; LLM_DAILY_USD_CAP=0: replay only at once.
    expect(decide("judge", {}, { ...DEFAULT_SPEND_POLICY, economyAtUsd: 0 }).mode).toBe("economy");
    expect(decide("judge", {}, { ...DEFAULT_SPEND_POLICY, dailyCapUsd: 0 }).mode).toBe("replay_only");
    // LLM_JUDGE_SHARE=0: the lanes share every threshold.
    const even = { ...DEFAULT_SPEND_POLICY, judgeShare: 0 };
    expect(laneBudget("public", even)).toEqual(laneBudget("judge", even));
  });
});

describe("decideMode: the Qloo breakers", () => {
  it("pauses both lanes below the monthly floor, with no time it lifts by itself", () => {
    for (const lane of LANES) {
      expect(decide(lane, { qloo: qlooUsage({ monthRemaining: 1_999 }) })).toMatchObject({
        mode: "replay_only",
        breaker: "qloo_floor",
        message: "Live analysis is paused: this month's Qloo quota is at its floor.",
        until: null,
      });
      expect(decide(lane, { qloo: qlooUsage({ monthRemaining: 2_000 }) }).mode).toBe("live");
      expect(decide(lane, { qloo: qlooUsage({ monthRemaining: null }) }).mode).toBe("live");
    }
  });

  it("pauses a lane once its share of today's fresh calls has no room for a whole run", () => {
    // Public share: 60% of 1,900 = 1,140 calls; the judge's 760.
    const publicEdge = 1_140 - QLOO_RUN_MARGIN;
    expect(decide("public", { qloo: qlooUsage({ fresh: { public: publicEdge, judge: 0, all: publicEdge } }) }).mode).toBe("live");
    const full = qlooUsage({ fresh: { public: publicEdge + 1, judge: 0, all: publicEdge + 1 } });
    expect(decide("public", { qloo: full })).toMatchObject({
      mode: "replay_only",
      breaker: "qloo_daily",
      message: "Live analysis is paused: today's Qloo requests are used up. It resumes at 00:00 UTC.",
      until: MIDNIGHT,
    });
    // The judge lane's own share is untouched.
    expect(decide("judge", { qloo: full }).mode).toBe("live");
    // The day's total binds every lane.
    const total = qlooUsage({ fresh: { public: 0, judge: 0, all: 1_900 - QLOO_RUN_MARGIN + 1 } });
    for (const lane of LANES) expect(decide(lane, { qloo: total }).breaker).toBe("qloo_daily");
  });

  it("leaves the daily cap to prod, where the Qloo client enforces it", () => {
    const counted = qlooUsage({ dailyCapEnforced: false, fresh: { public: 5_000, judge: 5_000, all: 10_000 } });
    expect(decide("public", { qloo: counted }).mode).toBe("live");
  });
});

describe("decideMode: the stored mode and the override", () => {
  it("keeps a stored replay-only (the Qloo client's breaker) until someone sets it back", () => {
    expect(decide("judge", { stored: storedMode("replay_only", "qloo") })).toEqual({
      lane: "judge",
      mode: "replay_only",
      breaker: "stored",
      reason: "the Qloo data connection needs attention",
      message: "Live analysis is paused: the Qloo data connection needs attention.",
      until: null,
    });
    expect(decide("public", { stored: storedMode("economy") }).message).toBe("Live briefs run on the economy analyst: the operator set it.");
    expect(decide("public", { stored: storedMode("live") }).mode).toBe("live");
  });

  it("names the first breaker to reach the lowest mode", () => {
    const both = { stored: storedMode("replay_only", "qloo"), todayUsd: 2 };
    expect(decide("public", both).breaker).toBe("stored");
    // A lower mode wins over an earlier, milder one.
    expect(decide("public", { stored: storedMode("economy"), todayUsd: 2 }).breaker).toBe("llm_spend");
  });

  it("forces the given mode on every lane with MODE_OVERRIDE, whatever the breakers say", () => {
    const tripped = { stored: storedMode("replay_only", "qloo"), todayUsd: 5, qloo: qlooUsage({ monthRemaining: 0 }) };
    for (const lane of LANES) {
      expect(decide(lane, { ...tripped, override: "live" })).toMatchObject({ mode: "live", breaker: null, message: null });
      expect(decide(lane, { override: "economy" })).toMatchObject({ mode: "economy", breaker: "override", until: null });
      expect(decide(lane, { override: "replay_only" })).toMatchObject({
        mode: "replay_only",
        breaker: "override",
        message: "Live analysis is paused: the operator switched it for a demo.",
      });
    }
  });
});

describe("ModeService", () => {
  it("decides from fresh inputs on every call, so a breaker trips and lifts as its counter moves", async () => {
    const state = { todayUsd: 0, now: BREAKER_NOW };
    const modes = testModes(state);
    expect((await modes.decide("public")).mode).toBe("live");
    state.todayUsd = 0.6;
    expect((await modes.decide("public")).mode).toBe("economy");
    state.todayUsd = 0.9;
    const paused = await modes.decideAll();
    expect(paused.public.mode).toBe("replay_only");
    expect(paused.judge.mode).toBe("live");
    // 00:00 UTC: a new day's counter starts at zero.
    state.now = Date.parse(MIDNIGHT);
    state.todayUsd = 0;
    expect((await modes.decide("public")).mode).toBe("live");
  });

  it("reads the inputs once for both lanes and passes its clock to the counters", async () => {
    const todayUsd = vi.fn(async () => 0);
    const qloo = vi.fn(async () => null);
    const { ModeService } = await import("../server/breakers");
    const modes = new ModeService({ override: () => null, stored: async () => LIVE_STORED, todayUsd, qloo, now: () => BREAKER_NOW });
    await modes.decideAll();
    expect(todayUsd).toHaveBeenCalledTimes(1);
    expect(todayUsd).toHaveBeenCalledWith(BREAKER_NOW);
    expect(qloo).toHaveBeenCalledWith(BREAKER_NOW);
  });

  it("fails when the spend cannot be read: no run starts on an unknown spend", async () => {
    const { ModeService } = await import("../server/breakers");
    const modes = new ModeService({
      override: () => null,
      stored: async () => LIVE_STORED,
      todayUsd: async () => Promise.reject(new Error("connect ECONNREFUSED")),
      qloo: async () => null,
    });
    await expect(modes.decide("public")).rejects.toThrow("ECONNREFUSED");
  });
});

describe("the policy from the environment", () => {
  it("reads LLM_DAILY_USD_CAP, LLM_ECONOMY_USD and LLM_JUDGE_SHARE, so each step can be forced", async () => {
    const { spendPolicyFromEnv } = await import("../server/breakers");
    const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });
    expect(spendPolicyFromEnv(env())).toEqual(DEFAULT_SPEND_POLICY);
    const forced = spendPolicyFromEnv(env({ LLM_DAILY_USD_CAP: "0", LLM_ECONOMY_USD: "0", LLM_JUDGE_SHARE: "0.5" }));
    expect(forced).toEqual({ dailyCapUsd: 0, economyAtUsd: 0, judgeShare: 0.5 });
    expect(decide("judge", {}, forced).mode).toBe("replay_only");
    expect(decide("judge", {}, spendPolicyFromEnv(env({ LLM_ECONOMY_USD: "0" }))).mode).toBe("economy");
    // The container hands out the same function.
    expect((await import("../server/container")).spendPolicyFromEnv).toBe(spendPolicyFromEnv);
  });
});

describe("the Qloo counters the breakers read", () => {
  const client = (env: "prod" | "dev", monthRemaining: number | null = 30_000) =>
    ({ env, monthFloor: 2_000, quota: () => ({ monthRemaining }) }) as unknown as QlooClient;
  /** A database whose usage reads answer `values` in turn (public, judge, all). */
  const usageDb = (...values: number[]) => {
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => [{ value: values.shift() ?? 0 }] }) }) }));
    return { db: { select } as unknown as Queryable, select };
  };

  it("applies no Qloo breaker with Qloo off or a client that cannot be configured", async () => {
    const { db, select } = usageDb();
    expect(await qlooUsageReader({ disabled: true, client: () => client("prod"), db: () => db, dailyCap: 1_900 })(BREAKER_NOW)).toBeNull();
    const unconfigured = () => {
      throw new Error("QLOO_API_KEY is not set");
    };
    expect(await qlooUsageReader({ disabled: false, client: unconfigured, db: () => db, dailyCap: 1_900 })(BREAKER_NOW)).toBeNull();
    expect(select).not.toHaveBeenCalled();
  });

  it("reads today's fresh calls per lane in prod, where the daily cap applies, and none elsewhere", async () => {
    const prod = usageDb(11, 7, 18);
    expect(await qlooUsageReader({ disabled: false, client: () => client("prod"), db: () => prod.db, dailyCap: 1_900 })(BREAKER_NOW)).toEqual({
      dailyCapEnforced: true,
      dailyCap: 1_900,
      fresh: { public: 11, judge: 7, all: 18 },
      monthRemaining: 30_000,
      monthFloor: 2_000,
    });
    const dev = usageDb(11, 7, 18);
    expect(await qlooUsageReader({ disabled: false, client: () => client("dev", null), db: () => dev.db, dailyCap: 1_900 })(BREAKER_NOW)).toMatchObject({
      dailyCapEnforced: false,
      fresh: { public: 0, judge: 0, all: 0 },
      monthRemaining: null,
    });
    expect(dev.select).not.toHaveBeenCalled();
  });
});

describe("helpers", () => {
  it("finds the next 00:00 UTC", () => {
    expect(nextUtcMidnight(BREAKER_NOW)).toBe(MIDNIGHT);
    expect(nextUtcMidnight(Date.parse(MIDNIGHT))).toBe("2026-10-24T00:00:00.000Z");
  });

  it("reads a bare mode or a decision", () => {
    expect(laneModeOf("economy")).toEqual({ mode: "economy", message: null });
    expect(laneModeOf({ mode: "replay_only", message: "Paused." })).toEqual({ mode: "replay_only", message: "Paused." });
  });
});
