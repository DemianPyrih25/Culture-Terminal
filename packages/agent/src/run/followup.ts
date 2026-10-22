import type { InsightsFilterType, QlooApi, QlooParams, RunBudget } from "@ct/contracts";
import { BudgetError } from "@ct/qloo";

/**
 * The follow-up time budget (D24, PLAN §4.1 E: follow-ups take ≤8 Qloo calls and ≤40 s). The Qloo
 * client enforces the call cap; this enforces the clock, which starts with the first turn-2 tool
 * call. Past the deadline every follow-up Qloo call, pending or new, is refused like a spent budget,
 * so a skill marks those calls BUDGET_TRUNCATED and returns what it already has instead of holding
 * the turn until the hard stop. A refused call still in flight is handed to `track`: the run stops
 * it with its other work.
 */

export interface FollowupDeadline {
  /** Fires when the follow-up time is spent. */
  readonly signal: AbortSignal;
  /** A skill's Qloo surface under the deadline. */
  qloo(api: QlooApi): QlooApi;
  /** The budget view under the deadline: no network call is affordable once it has passed. */
  budget(budget: RunBudget): RunBudget;
}

export interface FollowupDeadlineOptions {
  ms: number;
  /** Fires at the deadline: AbortSignal.timeout(ms) in a run. */
  signal: AbortSignal;
  /** Receives every Qloo call made under the deadline, so the run can stop and await it. */
  track: (call: Promise<unknown>) => void;
}

const duration = (ms: number): string => (ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);

export function createFollowupDeadline(options: FollowupDeadlineOptions): FollowupDeadline {
  const { signal, track } = options;
  // The Qloo client's own refusal type: skills already read it as BUDGET_TRUNCATED.
  const refusal = () => new BudgetError("followup_cap", `follow-ups have used their ${duration(options.ms)}`);

  const guard = <R>(call: () => Promise<R>): Promise<R> => {
    if (signal.aborted) return Promise.reject(refusal());
    const pending = Promise.resolve().then(call);
    track(pending);
    return new Promise<R>((resolve, reject) => {
      const onDeadline = (): void => reject(refusal());
      signal.addEventListener("abort", onDeadline, { once: true });
      pending.then(
        (value) => {
          signal.removeEventListener("abort", onDeadline);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onDeadline);
          reject(err as Error);
        },
      );
    });
  };

  return {
    signal,
    qloo: (api) => ({
      search: (params) => guard(() => api.search(params)),
      entities: (entityIds) => guard(() => api.entities(entityIds)),
      tags: (params) => guard(() => api.tags(params)),
      audiences: (params) => guard(() => api.audiences(params)),
      insights: <F extends InsightsFilterType>(filterType: F, params: QlooParams) => guard(() => api.insights(filterType, params)),
      trending: (params) => guard(() => api.trending(params)),
    }),
    budget: (budget) => ({
      limits: budget.limits,
      qlooNetworkUsed: () => budget.qlooNetworkUsed(),
      qlooNetworkRemaining: () => (signal.aborted ? 0 : budget.qlooNetworkRemaining()),
      canAfford: (calls) => budget.canAfford(calls) && (calls === 0 || !signal.aborted),
      elapsedMs: () => budget.elapsedMs(),
      llmUsd: () => budget.llmUsd(),
    }),
  };
}
