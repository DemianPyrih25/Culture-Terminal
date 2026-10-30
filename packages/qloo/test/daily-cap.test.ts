import { describe, expect, it } from "vitest";
import { dailyFreshCapFor, judgingDaysLeft, PROD_MONTH_FLOOR } from "../src/budget";
import { parseJudgingEndDate } from "../src/env";
import { BudgetError } from "../src/errors";
import { utcDay } from "../src/quota";
import { fakeTransport, harness, runScope, START } from "./support/fakes";

const base = { staticCap: 1_900, day: "2026-11-02", judgingEndDate: "2026-11-16", floor: PROD_MONTH_FLOOR };

describe("dailyFreshCapFor (D24)", () => {
  it("counts judging days inclusively and stops after the last one", () => {
    expect(judgingDaysLeft("2026-11-02", "2026-11-16")).toBe(15);
    expect(judgingDaysLeft("2026-11-16", "2026-11-16")).toBe(1);
    expect(judgingDaysLeft("2026-11-17", "2026-11-16")).toBe(0);
  });

  it("spreads the calls above the floor over the days left, at least 2,000", () => {
    // (62,000 - 2,000) / 15 = 4,000 a day.
    expect(dailyFreshCapFor({ ...base, monthRemaining: 62_000 })).toBe(4_000);
    // (17,000 - 2,000) / 15 = 1,000, raised to the 2,000 minimum.
    expect(dailyFreshCapFor({ ...base, monthRemaining: 17_000 })).toBe(2_000);
  });

  it("never allows more than the calls above the floor", () => {
    expect(dailyFreshCapFor({ ...base, monthRemaining: 3_500 })).toBe(1_500);
    expect(dailyFreshCapFor({ ...base, monthRemaining: 1_000 })).toBe(0);
  });

  it("uses the static cap outside the window or before a remaining figure exists", () => {
    expect(dailyFreshCapFor({ ...base, day: "2026-11-17", monthRemaining: 62_000 })).toBe(1_900);
    expect(dailyFreshCapFor({ ...base, monthRemaining: null })).toBe(1_900);
    expect(dailyFreshCapFor({ ...base, judgingEndDate: null, monthRemaining: 62_000 })).toBe(1_900);
  });
});

describe("JUDGING_END_DATE", () => {
  it("defaults, turns off, and refuses a malformed day", () => {
    expect(parseJudgingEndDate(undefined)).toBe("2026-11-16");
    expect(parseJudgingEndDate(" 2026-12-01 ")).toBe("2026-12-01");
    expect(parseJudgingEndDate("off")).toBeNull();
    expect(() => parseJudgingEndDate("2026-02-30")).toThrow(/JUDGING_END_DATE/);
    expect(() => parseJudgingEndDate("next week")).toThrow(/JUDGING_END_DATE/);
  });
});

describe("the prod client applies the dynamic cap", () => {
  it("computes the cap from the day's first remaining figure and holds it for the UTC day", async () => {
    // START is 2026-10-22: 26 judging days to 2026-11-16. (54,000 - 2,000) / 26 = 2,000.
    const h = harness({
      env: "prod",
      dailyFreshCap: 5,
      judgingEndDate: "2026-11-16",
      transport: fakeTransport(() => ({ headers: { monthRemaining: 54_000 } })),
    });
    expect(h.client.dailyFreshCap?.()).toBe(5);
    await h.client.standalone().forTool(null).search({ query: "Brand Fixture A" });
    expect(utcDay(START)).toBe("2026-10-22");
    expect(h.client.dailyFreshCap?.()).toBe(2_000);
    // More calls the same day do not move it.
    await h.client.standalone().forTool(null).search({ query: "Brand Fixture B" });
    expect(h.client.dailyFreshCap?.()).toBe(2_000);
  });

  it("refuses at the computed cap, not the static one", async () => {
    const h = harness({
      env: "prod",
      dailyFreshCap: 1_000_000,
      judgingEndDate: "2026-10-22",
      transport: fakeTransport(() => ({ headers: { monthRemaining: 2_003 } })),
    });
    const qloo = h.client.forRun(runScope()).forTool(null);
    // The first call runs under the static cap; its response leaves 3 calls above the floor, so today's
    // cap is 3 and the public lane's share of it 1, which that call already used.
    await qloo.search({ query: "Brand Fixture A" });
    expect(h.client.dailyFreshCap?.()).toBe(3);
    let gate: string | null = null;
    try {
      await qloo.search({ query: "Brand Fixture B" });
    } catch (err) {
      if (err instanceof BudgetError) gate = err.gate;
      else throw err;
    }
    expect(gate).toBe("daily_lane_cap");
    expect(h.transport.requests).toHaveLength(1);
  });
});
