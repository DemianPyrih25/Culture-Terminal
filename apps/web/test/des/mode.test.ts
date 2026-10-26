// The tearsheet's mode on the real mode machine (breakers.ts): every breaker but today's LLM spend steps
// it down, since a tearsheet makes no LLM call.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { desModeFrom } = await import("../../server/des/mode");
const { BREAKER_NOW, qlooUsage, storedMode, testModes } = await import("../support/protection");

const MIDNIGHT = "2026-10-23T00:00:00.000Z";

describe("desModeFrom", () => {
  it("stays live when only today's LLM spend is used up", async () => {
    const modes = testModes({ todayUsd: 5, qloo: qlooUsage() });
    expect(await desModeFrom(modes, "public", BREAKER_NOW)).toEqual({ mode: "live", breaker: null, reason: null, until: null });
    // The briefs of the same lane are paused by it.
    expect((await modes.decide("public")).mode).toBe("replay_only");
  });

  it("pauses when the lane's Qloo calls for today are used up, until 00:00 UTC", async () => {
    const modes = testModes({ qloo: qlooUsage({ fresh: { public: 1_101, judge: 0, all: 1_101 } }) });
    expect(await desModeFrom(modes, "public", BREAKER_NOW)).toEqual({ mode: "replay_only", breaker: "qloo_daily", reason: "today's Qloo requests are used up", until: MIDNIGHT });
    expect((await desModeFrom(modes, "judge", BREAKER_NOW)).mode).toBe("live");
  });

  it("pauses for the stored mode, the month floor and the operator's override", async () => {
    expect(await desModeFrom(testModes({ stored: storedMode("replay_only", "qloo") }), "judge", BREAKER_NOW)).toEqual({
      mode: "replay_only",
      breaker: "stored",
      reason: "the Qloo data connection needs attention",
      until: null,
    });
    const floor = await desModeFrom(testModes({ qloo: qlooUsage({ monthRemaining: 1_500 }) }), "public", BREAKER_NOW);
    expect(floor).toMatchObject({ breaker: "qloo_floor", reason: "this month's Qloo quota is at its floor", until: null });
    expect((await desModeFrom(testModes({ override: "replay_only" }), "public", BREAKER_NOW)).mode).toBe("replay_only");
  });
});
