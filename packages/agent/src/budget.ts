import { RunLimits, type Phase, type RunBudget } from "@ct/contracts";

/**
 * The run's budget view (D24, PLAN §4.2). It only reads counters owned elsewhere: the Qloo client
 * counts and enforces network calls, the pricing module accumulates LLM spend. Skills use it to
 * size their work (estimateCalls vs canAfford) before the client would refuse a call.
 */

export interface RunBudgetOptions {
  limits: RunLimits;
  /** Network calls this run has made so far (cache misses only). */
  qlooNetworkUsed: () => number;
  /** Network calls made during the follow-up phase so far. */
  followupNetworkUsed: () => number;
  phase: () => Phase;
  llmUsd: () => number;
  /** Run start, in epoch ms. */
  startedAt: number;
  now?: () => number;
}

export function createRunBudget(options: RunBudgetOptions): RunBudget {
  const limits = RunLimits.parse(options.limits);
  const { qlooNetworkUsed, followupNetworkUsed, phase, llmUsd, startedAt } = options;
  const now = options.now ?? Date.now;

  const remaining = (): number => {
    const run = Math.max(0, limits.qlooCalls - qlooNetworkUsed());
    if (phase() !== "followup") return run;
    return Math.min(run, Math.max(0, limits.followupCalls - followupNetworkUsed()));
  };

  return {
    limits,
    qlooNetworkUsed,
    qlooNetworkRemaining: remaining,
    canAfford(calls: number): boolean {
      if (!Number.isInteger(calls) || calls < 0) {
        throw new RangeError(`canAfford: calls must be a non-negative integer, got ${calls}`);
      }
      return calls <= remaining();
    },
    elapsedMs: () => Math.max(0, now() - startedAt),
    llmUsd,
  };
}
