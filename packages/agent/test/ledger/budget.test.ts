import { DEFAULT_RUN_LIMITS, type Phase } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { createRunBudget } from "../../src/budget";

function harness(start: { used?: number; followup?: number; phase?: Phase; usd?: number } = {}) {
  const state = { used: 0, followup: 0, phase: "wave1" as Phase, usd: 0, now: 1_000, ...start };
  const budget = createRunBudget({
    limits: DEFAULT_RUN_LIMITS,
    qlooNetworkUsed: () => state.used,
    followupNetworkUsed: () => state.followup,
    phase: () => state.phase,
    llmUsd: () => state.usd,
    startedAt: 1_000,
    now: () => state.now,
  });
  return { state, budget };
}

describe("createRunBudget", () => {
  it("counts down from the run cap and never goes negative", () => {
    const { state, budget } = harness();
    expect(budget.qlooNetworkRemaining()).toBe(DEFAULT_RUN_LIMITS.qlooCalls);
    state.used = 35;
    expect(budget.qlooNetworkUsed()).toBe(35);
    expect(budget.qlooNetworkRemaining()).toBe(5);
    state.used = 45;
    expect(budget.qlooNetworkRemaining()).toBe(0);
  });

  it("also applies the follow-up cap in the follow-up phase", () => {
    const { state, budget } = harness({ used: 20, phase: "followup", followup: 3 });
    expect(budget.qlooNetworkRemaining()).toBe(DEFAULT_RUN_LIMITS.followupCalls - 3);
    state.used = 38;
    expect(budget.qlooNetworkRemaining()).toBe(2);
    state.phase = "scan";
    state.used = 20;
    expect(budget.qlooNetworkRemaining()).toBe(20);
  });

  it("answers canAfford against what remains now", () => {
    const { state, budget } = harness({ used: 38 });
    expect(budget.canAfford(0)).toBe(true);
    expect(budget.canAfford(2)).toBe(true);
    expect(budget.canAfford(3)).toBe(false);
    state.used = 40;
    expect(budget.canAfford(1)).toBe(false);
    expect(() => budget.canAfford(-1)).toThrow(RangeError);
    expect(() => budget.canAfford(1.5)).toThrow(RangeError);
  });

  it("reports elapsed time and LLM spend from the injected clocks", () => {
    const { state, budget } = harness({ usd: 0.12 });
    state.now = 4_500;
    expect(budget.elapsedMs()).toBe(3_500);
    expect(budget.llmUsd()).toBe(0.12);
    state.now = 0;
    expect(budget.elapsedMs()).toBe(0);
    expect(budget.limits).toEqual(DEFAULT_RUN_LIMITS);
  });

  it("refuses invalid limits", () => {
    expect(() =>
      createRunBudget({
        limits: { ...DEFAULT_RUN_LIMITS, qlooCalls: 0 },
        qlooNetworkUsed: () => 0,
        followupNetworkUsed: () => 0,
        phase: () => "scan",
        llmUsd: () => 0,
        startedAt: 0,
      }),
    ).toThrow();
  });
});
