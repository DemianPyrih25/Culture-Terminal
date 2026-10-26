import { ANALYST_CONFIGS, CLERK_MODEL } from "@ct/agent";
import { DEFAULT_RUN_LIMITS, Lane, type Pillar } from "@ct/contracts";
import { AUDIENCE_ALLOWLIST, LANE_SHARE } from "@ct/qloo";
import { modelLabel } from "../../components/method/facts";
import type { TrustViewProps } from "../../components/trust/trust-view";
import type { DailyBudgetView } from "../../content/trust";
import { laneBudget, type SpendPolicy } from "../../server/breakers";
import { llmDailyUsdCapFromEnv, llmEconomyUsdFromEnv, llmJudgeShareFromEnv, qlooDailyFreshCapFromEnv } from "../../server/config";
import { PRE_RUN_ECONOMY_USD, PRE_RUN_USD } from "../../server/llm-spend";

// What /trust shows from the code and the server's configuration, read on the server: the Qloo
// client's audience allowlist, the models, the per-brief limits and the daily budgets.

/** The spend policy the server's breakers run on (container spendPolicyFromEnv reads the same three settings). */
export function spendPolicy(env: NodeJS.ProcessEnv = process.env): SpendPolicy {
  return { dailyCapUsd: llmDailyUsdCapFromEnv(env), economyAtUsd: llmEconomyUsdFromEnv(env), judgeShare: llmJudgeShareFromEnv(env) };
}

/** Each lane's thresholds as the breakers compute them, and the Qloo client's daily cap split as it splits it. */
export function dailyBudget(env: NodeJS.ProcessEnv = process.env): DailyBudgetView {
  const policy = spendPolicy(env);
  const fresh = qlooDailyFreshCapFromEnv(env);
  const perLane = <T>(of: (lane: Lane) => T) => Object.fromEntries(Lane.options.map((lane) => [lane, of(lane)])) as Record<Lane, T>;
  return {
    dailyCapUsd: policy.dailyCapUsd,
    judgeShare: policy.judgeShare,
    lanes: perLane((lane) => laneBudget(lane, policy)),
    preRunUsd: { live: PRE_RUN_USD, economy: PRE_RUN_ECONOMY_USD },
    qloo: { dailyFresh: fresh, lanes: perLane((lane) => Math.floor(fresh * LANE_SHARE[lane])) },
  };
}

export function trustFacts(env: NodeJS.ProcessEnv = process.env): TrustViewProps {
  return {
    allowlist: {
      desks: AUDIENCE_ALLOWLIST.desks as Readonly<Record<Pillar, readonly string[]>>,
      denied: { families: AUDIENCE_ALLOWLIST.denied.families, audiences: AUDIENCE_ALLOWLIST.denied.audiences },
    },
    models: {
      clerk: modelLabel(CLERK_MODEL),
      analyst: modelLabel(ANALYST_CONFIGS.live.model),
      economy: modelLabel(ANALYST_CONFIGS.economy.model),
    },
    limits: DEFAULT_RUN_LIMITS,
    daily: dailyBudget(env),
  };
}
