// The follow-up time budget (D24): Qloo calls past the deadline are refused like a spent budget.
import { DEFAULT_RUN_LIMITS } from "@ct/contracts";
import { BudgetError, type QlooCallRecord } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { createRunBudget } from "../../src/budget";
import { createFollowupDeadline } from "../../src/run/followup";
import { mockQloo } from "./support";

const SEARCH = { query: "Brand Alpha", types: "urn:entity:brand", take: 5 };

function setup(latencyMs: number) {
  const stop = new AbortController();
  const deadline = new AbortController();
  const calls: QlooCallRecord[] = [];
  const tracked: Promise<unknown>[] = [];
  const qloo = mockQloo([], latencyMs)
    .standalone({ onCall: (r) => calls.push(r), signal: stop.signal })
    .forTool(null);
  const followup = createFollowupDeadline({ ms: 40_000, signal: deadline.signal, track: (p) => tracked.push(p) });
  const cleanup = async () => {
    stop.abort();
    await Promise.allSettled(tracked);
  };
  return { qloo: followup.qloo(qloo), followup, deadline, calls, tracked, cleanup };
}

describe("createFollowupDeadline", () => {
  it("passes calls through before the deadline and hands each to track", async () => {
    const s = setup(0);
    const result = await s.qloo.search(SEARCH);
    expect(result.data.results.length).toBeGreaterThan(0);
    expect(s.calls).toHaveLength(1);
    expect(s.tracked).toHaveLength(1);
    await s.cleanup();
  });

  it("rejects a pending call at the deadline, and refuses new calls without reaching Qloo", async () => {
    const s = setup(5_000);
    const pending = s.qloo.search(SEARCH);
    setTimeout(() => s.deadline.abort(), 5);
    const err = await pending.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetError);
    expect(err).toMatchObject({ name: "BudgetError", gate: "followup_cap", message: "follow-ups have used their 40 s" });

    const late = await s.qloo.insights("urn:entity:brand", { "signal.interests.entities": ["synthetic-alpha"] }).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(BudgetError);
    expect(s.tracked).toHaveLength(1);
    await s.cleanup();
  });

  it("makes no network call affordable once the deadline has passed", () => {
    const s = setup(0);
    const budget = s.followup.budget(
      createRunBudget({
        limits: DEFAULT_RUN_LIMITS,
        qlooNetworkUsed: () => 2,
        followupNetworkUsed: () => 1,
        phase: () => "followup",
        llmUsd: () => 0,
        startedAt: 0,
        now: () => 1_000,
      }),
    );
    expect(budget.qlooNetworkRemaining()).toBe(DEFAULT_RUN_LIMITS.followupCalls - 1);
    expect(budget.canAfford(3)).toBe(true);
    s.deadline.abort();
    expect(budget.qlooNetworkRemaining()).toBe(0);
    expect(budget.canAfford(1)).toBe(false);
    expect(budget.canAfford(0)).toBe(true);
    expect(budget.elapsedMs()).toBe(1_000);
  });
});
