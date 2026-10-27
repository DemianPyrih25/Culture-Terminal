import { ANALYST_CONFIGS, CLERK_MODEL, MIN_OK_EVIDENCE, SCAN_TABLE } from "@ct/agent";
import { DEFAULT_RUN_LIMITS, Job, Lane, type Pillar, type SkillId } from "@ct/contracts";
import { ALLOW, AUDIENCE_ALLOWLIST, LANE_SHARE, PROBE_FACTS, type QlooPath } from "@ct/qloo";
import type { MethodFacts } from "../../content/method";
import type { DailyBudgetView } from "../../content/trust";
import { endpointLabel, modelLabel, windowEndMonth } from "../../components/method/facts";
import type { RulesFacts } from "../../components/method/rules-sections";
import { formatTrendWindow } from "../../lib/brief/format";
import { laneBudget, type SpendPolicy } from "../../server/breakers";
import { llmDailyUsdCapFromEnv, llmEconomyUsdFromEnv, llmJudgeShareFromEnv, qlooDailyFreshCapFromEnv } from "../../server/config";
import { PRE_RUN_ECONOMY_USD, PRE_RUN_USD } from "../../server/llm-spend";

// The code facts /method quotes, read on the server from the packages that run every answer (the agent
// and the Qloo client are server-only, so the page passes plain data down), and the server's own
// configuration for the daily caps.

export function methodFacts(): MethodFacts {
  return {
    clerkModel: modelLabel(CLERK_MODEL),
    analystModel: modelLabel(ANALYST_CONFIGS.live.model),
    limits: DEFAULT_RUN_LIMITS,
    minOkEvidence: MIN_OK_EVIDENCE,
    windowEnd: windowEndMonth(PROBE_FACTS.trendingWindow.end),
  };
}

/** The skills each job's opening scan runs (SCAN_TABLE). */
export function openingScan(): Record<Job, SkillId[]> {
  return Object.fromEntries(Job.options.map((job) => [job, SCAN_TABLE[job].map((entry) => entry.tool)])) as Record<Job, SkillId[]>;
}

/** The Qloo endpoints the client's allowlist admits, as words: "Search · Entities · Insights …". */
export function qlooEndpoints(): string[] {
  return (Object.keys(ALLOW) as QlooPath[]).map(endpointLabel);
}

/** The probe-verified trending window, e.g. "Apr–Sep 2025". */
export function trendWindowText(): string {
  return formatTrendWindow(PROBE_FACTS.trendingWindow);
}

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

/** The rules facts /method absorbed from /trust: the audience allowlist, the models, the limits and the daily budgets. */
export function rulesFacts(env: NodeJS.ProcessEnv = process.env): RulesFacts {
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
