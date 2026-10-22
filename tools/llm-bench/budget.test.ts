import { describe, expect, it } from "vitest";
import { analystPrefix, runAnalyst } from "./analyst-run";
import { BudgetGuard, BudgetStop, readUsdCap } from "./budget";
import { promptChars } from "./client";
import { ANALYST_MAX_TOKENS, BENCH_CONFIGS } from "./config";
import { fakeClock, scriptedStreamer } from "./fakes";
import { estimateRequestUsd } from "./pricing";
import { buildScenario } from "./scenario";
import { peerCall, planCall, reportCall, respond } from "./test-utils";

const sonnetMedium = BENCH_CONFIGS[0]!;

describe("BudgetGuard", () => {
  it("allows a request only while spent + estimate stays within the cap", () => {
    const guard = new BudgetGuard(1);
    expect(guard.allows(1)).toBe(true);
    guard.charge(0.6);
    expect(guard.allows(0.4)).toBe(true);
    expect(guard.allows(0.41)).toBe(false);
    expect(() => guard.reserve(0.41)).toThrow(BudgetStop);
    expect(() => guard.reserve(0.4)).not.toThrow();
    expect(guard.spentUsd).toBe(0.6);
  });

  it("rejects nonsense caps and charges", () => {
    expect(() => new BudgetGuard(0)).toThrow(RangeError);
    expect(() => new BudgetGuard(Number.NaN)).toThrow(RangeError);
    expect(() => new BudgetGuard(1).charge(-1)).toThrow(RangeError);
  });

  it("explains the stop", () => {
    expect(new BudgetStop(1.2, 0.4, 1.5).message).toBe(
      "budget guard: $1.20 spent + up to $0.4000 for the next request would exceed the cap of $1.50",
    );
  });
});

describe("readUsdCap", () => {
  it("falls back when unset or blank and parses a positive number", () => {
    expect(readUsdCap({}, "LLM_BENCH_USD_CAP", 1.5)).toBe(1.5);
    expect(readUsdCap({ LLM_BENCH_USD_CAP: "  " }, "LLM_BENCH_USD_CAP", 1.5)).toBe(1.5);
    expect(readUsdCap({ LLM_BENCH_USD_CAP: "0.75" }, "LLM_BENCH_USD_CAP", 1.5)).toBe(0.75);
  });

  it("rejects invalid values instead of running uncapped", () => {
    expect(() => readUsdCap({ LLM_BENCH_USD_CAP: "abc" }, "LLM_BENCH_USD_CAP", 1.5)).toThrow(/positive number/);
    expect(() => readUsdCap({ LLM_BENCH_USD_CAP: "-1" }, "LLM_BENCH_USD_CAP", 1.5)).toThrow(/positive number/);
  });
});

describe("the bench loop under the budget guard", () => {
  const firstEstimate = (): number => {
    const prefix = analystPrefix();
    const messages = [{ role: "user", content: buildScenario().runContext }];
    return estimateRequestUsd(sonnetMedium.model, promptChars({ system: prefix.system, tools: prefix.tools, messages }), ANALYST_MAX_TOKENS);
  };

  it("sends nothing when even the first request could pass the cap", async () => {
    const scripted = scriptedStreamer([respond([planCall(), peerCall()])]);
    const guard = new BudgetGuard(0.01);
    const rec = await runAnalyst(sonnetMedium, 1, { streamer: scripted.streamer, guard, now: fakeClock(1) });
    expect(rec.outcome).toBe("budget_stopped");
    expect(rec.reason).toMatch(/would exceed the cap/);
    expect(scripted.requests).toHaveLength(0);
    expect(guard.spentUsd).toBe(0);
  });

  it("stops mid-run before the request that could push the total over the cap", async () => {
    const cap = firstEstimate() + 0.001;
    const scripted = scriptedStreamer([
      respond([planCall(), peerCall()], "tool_use", { input_tokens: 2000, output_tokens: 3000 }),
      respond([reportCall()]),
    ]);
    const guard = new BudgetGuard(cap);
    const rec = await runAnalyst(sonnetMedium, 1, { streamer: scripted.streamer, guard, now: fakeClock(1) });
    expect(scripted.requests).toHaveLength(1);
    expect(rec.outcome).toBe("budget_stopped");
    expect(rec.responses).toBe(1);
    expect(guard.spentUsd).toBeLessThanOrEqual(cap);
    expect(rec.usd).toBeCloseTo(guard.spentUsd, 12);
  });

  it("never lets total spend pass the cap across runs that share one guard", async () => {
    const cap = 1.5;
    const guard = new BudgetGuard(cap);
    for (let run = 1; run <= 10; run++) {
      const scripted = scriptedStreamer([
        respond([planCall(), peerCall()], "tool_use", { output_tokens: 32_000 }),
        respond([reportCall()], "tool_use", { output_tokens: 32_000 }),
      ]);
      await runAnalyst(sonnetMedium, run, { streamer: scripted.streamer, guard, now: fakeClock(1) });
      expect(guard.spentUsd).toBeLessThanOrEqual(cap);
    }
    // With every response maxed out, the guard must have stopped somewhere well short of ten runs.
    expect(guard.spentUsd).toBeGreaterThan(cap / 2);
  });
});
