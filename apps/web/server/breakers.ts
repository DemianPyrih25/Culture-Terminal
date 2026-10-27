import "server-only";
import { DEFAULT_RUN_LIMITS, Lane, type Mode } from "@ct/contracts";
import { getQlooUsage, type Queryable } from "@ct/db";
import { LANE_SHARE, utcDay, type QlooClient } from "@ct/qloo";
import { llmDailyUsdCapFromEnv, llmEconomyUsdFromEnv, llmJudgeShareFromEnv } from "./config";
import { PRE_RUN_ECONOMY_USD, PRE_RUN_USD } from "./llm-spend";
import { log } from "./log";
import type { StoredModeValue } from "./mode";

/**
 * The mode machine (SPEC §4.2, §10.4, PLAN Part 7): which ANALYST a lane's next live run gets, or
 * none. Every breaker can only step a lane down, live → economy → replay_only, and the lowest one
 * wins:
 *
 * - stored: the kv mode, set by the Qloo client (three auth failures in a row, the month floor) or
 *   the admin switch. It stays until someone sets it back.
 * - llm_spend: today's LLM spend (all lanes, UTC day) against the lane's thresholds (laneBudget).
 * - qloo_floor: the monthly Qloo quota below the client's floor.
 * - qloo_daily: today's fresh Qloo calls leave the lane (or the day) no room for a whole run.
 *
 * The daily breakers read today's counters, so they lift by themselves at 00:00 UTC. MODE_OVERRIDE
 * replaces all of them for a demo; the pre-run budget check and the Qloo client's own caps still
 * refuse what they must. The judge lane's thresholds are never lower than the public lane's, so it
 * is never stepped down first by spend or by the stored mode.
 *
 * replay_only means no new live run: showcases, replays and the answer cache still work.
 */

export type Breaker = "override" | "stored" | "llm_spend" | "qloo_floor" | "qloo_daily";

/** A lane's mode and why. */
export interface ModeDecision {
  lane: Lane;
  mode: Mode;
  /** The breaker that set the mode; null while live with nothing tripped. */
  breaker: Breaker | null;
  /** Why, for visitors ("today's budget for live analysis is used up"); null while live. */
  reason: string | null;
  /** The sentence a refusal or notice prints; null while live. */
  message: string | null;
  /** When the step-down lifts by itself (00:00 UTC for a daily breaker), ISO; null when it does not. */
  until: string | null;
}

/** What the run manager and the preview read: a mode, or a decision with its message. */
export type LaneMode = Mode | { mode: Mode; message?: string | null };

export function laneModeOf(value: LaneMode): { mode: Mode; message: string | null } {
  return typeof value === "string" ? { mode: value, message: null } : { mode: value.mode, message: value.message ?? null };
}

/** The daily LLM budget (SPEC §4.2: Sonnet until $1.00, economy until $1.40, 40% held for judges). */
export interface SpendPolicy {
  /** LLM_DAILY_USD_CAP: the most today's spend may reach with a judge run. */
  dailyCapUsd: number;
  /** LLM_ECONOMY_USD: today's spend at which judge runs step down to economy. */
  economyAtUsd: number;
  /** LLM_JUDGE_SHARE: the share of both that public runs may not reach. */
  judgeShare: number;
}

export const DEFAULT_SPEND_POLICY: SpendPolicy = { dailyCapUsd: 1.4, economyAtUsd: 1, judgeShare: 0.4 };

/** The daily LLM budget from LLM_DAILY_USD_CAP, LLM_ECONOMY_USD and LLM_JUDGE_SHARE. */
export function spendPolicyFromEnv(env: NodeJS.ProcessEnv = process.env): SpendPolicy {
  return { dailyCapUsd: llmDailyUsdCapFromEnv(env), economyAtUsd: llmEconomyUsdFromEnv(env), judgeShare: llmJudgeShareFromEnv(env) };
}

/** A lane's thresholds on today's spend across all lanes, in USD. */
export interface LaneBudget {
  /** From here the lane's runs use the economy ANALYST. */
  economyAt: number;
  /** From here the lane is replay only: an economy run's reserve no longer fits under the cap. */
  replayAt: number;
  /** The most today's spend may reach with this lane's runs: the pre-run check's cap. */
  cap: number;
}

const round4 = (usd: number): number => Math.round(usd * 10_000) / 10_000;

/**
 * The public lane gets (1 − judgeShare) of the cap and of the economy threshold, so the rest is held
 * for judges; the judge lane gets all of both. Economy starts no later than where a live run's
 * reserve (PRE_RUN_USD) stops fitting, so a lane is never live yet refused by the pre-run check.
 */
export function laneBudget(lane: Lane, policy: SpendPolicy): LaneBudget {
  const share = lane === "judge" ? 1 : 1 - policy.judgeShare;
  const cap = round4(Math.max(0, policy.dailyCapUsd * share));
  const replayAt = round4(Math.max(0, cap - PRE_RUN_ECONOMY_USD));
  const economyAt = round4(Math.max(0, Math.min(policy.economyAtUsd * share, cap - PRE_RUN_USD, replayAt)));
  return { economyAt, replayAt, cap };
}

/** Today's Qloo counters as the breakers read them. */
export interface QlooUsage {
  /** Whether the daily fresh-call cap applies (prod): the Qloo client enforces it only there. */
  dailyCapEnforced: boolean;
  /** QLOO_DAILY_FRESH_CAP, split between the lanes by LANE_SHARE. */
  dailyCap: number;
  /** Today's (UTC) fresh calls per lane and in all. */
  fresh: Readonly<Record<Lane | "all", number>>;
  /** From the last response's headers; null until one was seen. */
  monthRemaining: number | null;
  monthFloor: number;
}

/** Fresh Qloo calls a lane keeps in hand for a run it starts: the per-run hard cap (SPEC §10.4: 40). */
export const QLOO_RUN_MARGIN = DEFAULT_RUN_LIMITS.qlooCalls;

/** Where the Qloo breakers read from: the process's client and database, and two settings. */
export interface QlooUsageSources {
  /** QLOO_DISABLED: no Qloo call at all, so no Qloo breaker applies. */
  disabled: boolean;
  /** The process-wide client; throws when it cannot be configured. */
  client: () => QlooClient;
  db: () => Queryable;
  /** QLOO_DAILY_FRESH_CAP. */
  dailyCap: number;
}

const QLOO_LANES = ["public", "judge", "all"] as const;

/**
 * Today's Qloo counters for the breakers; null when no Qloo breaker applies (QLOO_DISABLED, or a
 * client that cannot be configured, which refuses live runs anyway). The daily counters are read
 * only where the client enforces the daily cap (prod).
 */
export function qlooUsageReader(sources: QlooUsageSources): (now: number) => Promise<QlooUsage | null> {
  return async (now) => {
    if (sources.disabled) return null;
    let client: QlooClient;
    try {
      client = sources.client();
    } catch {
      return null;
    }
    const quota = client.quota();
    const enforced = client.env === "prod";
    const day = utcDay(now);
    const counts = enforced ? await Promise.all(QLOO_LANES.map((lane) => getQlooUsage(sources.db(), { day, lane }))) : [0, 0, 0];
    const [publicLane = 0, judgeLane = 0, all = 0] = counts;
    return {
      dailyCapEnforced: enforced,
      dailyCap: sources.dailyCap,
      fresh: { public: publicLane, judge: judgeLane, all },
      monthRemaining: quota.monthRemaining,
      monthFloor: client.monthFloor,
    };
  };
}

export interface BreakerInputs {
  /** MODE_OVERRIDE, or null. */
  override: Mode | null;
  stored: StoredModeValue;
  /** Today's (UTC) LLM spend across lanes, in USD. */
  todayUsd: number;
  /** Null when there is no Qloo client (QLOO_DISABLED, or not configured): no Qloo breaker applies. */
  qloo: QlooUsage | null;
}

const RANK: Readonly<Record<Mode, number>> = { live: 2, economy: 1, replay_only: 0 };

/** The next 00:00 UTC after `now`, ISO. */
export function nextUtcMidnight(now: number): string {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return next.toISOString();
}

const STORED_REASON: Readonly<Record<string, string>> = {
  qloo: "the Qloo data connection needs attention",
};

const OVERRIDE_REASON = "the operator switched it for a demo";

/** The sentence a visitor reads for a step-down. */
function messageOf(mode: Mode, reason: string, until: string | null): string {
  const resumes = until !== null ? " It resumes at 00:00 UTC." : "";
  if (mode === "economy") {
    return until !== null
      ? `Live answers run on the economy analyst until 00:00 UTC: ${reason}.`
      : `Live answers run on the economy analyst: ${reason}.`;
  }
  return `Live analysis is paused: ${reason}.${resumes}`;
}

/** The mode of one lane from the breakers' inputs; pure, so every transition is tested directly. */
export function decideMode(lane: Lane, inputs: BreakerInputs, policy: SpendPolicy, now: number): ModeDecision {
  if (inputs.override !== null) {
    const mode = inputs.override;
    if (mode === "live") return { lane, mode, breaker: null, reason: null, message: null, until: null };
    return { lane, mode, breaker: "override", reason: OVERRIDE_REASON, message: messageOf(mode, OVERRIDE_REASON, null), until: null };
  }
  let decision: ModeDecision = { lane, mode: "live", breaker: null, reason: null, message: null, until: null };
  // The first breaker to reach the lowest mode names it.
  const step = (mode: Mode, breaker: Breaker, reason: string, until: string | null) => {
    if (RANK[mode] < RANK[decision.mode]) decision = { lane, mode, breaker, reason, message: messageOf(mode, reason, until), until };
  };

  const { stored, todayUsd, qloo } = inputs;
  if (stored.mode !== "live") {
    const operator = stored.mode === "economy" ? "the operator set it" : "it was paused by the operator";
    step(stored.mode, "stored", STORED_REASON[stored.reason ?? ""] ?? operator, null);
  }
  if (qloo !== null && qloo.monthRemaining !== null && qloo.monthRemaining < qloo.monthFloor) {
    step("replay_only", "qloo_floor", "this month's Qloo quota is at its floor", null);
  }
  const midnight = nextUtcMidnight(now);
  const budget = laneBudget(lane, policy);
  if (todayUsd >= budget.replayAt) step("replay_only", "llm_spend", "today's budget is used up", midnight);
  else if (todayUsd >= budget.economyAt) step("economy", "llm_spend", "today's live budget is nearly used", midnight);
  if (qloo !== null && qloo.dailyCapEnforced) {
    const laneCap = Math.floor(qloo.dailyCap * LANE_SHARE[lane]);
    if (qloo.fresh[lane] + QLOO_RUN_MARGIN > laneCap || qloo.fresh.all + QLOO_RUN_MARGIN > qloo.dailyCap) {
      step("replay_only", "qloo_daily", "today's Qloo requests are used up", midnight);
    }
  }
  return decision;
}

// The service --------------------------------------------------------------------------------------

export interface ModeServiceDeps {
  /** MODE_OVERRIDE as it is now. */
  override: () => Mode | null;
  /** The kv mode; the caller decides what a failed read gives. */
  stored: () => Promise<StoredModeValue>;
  /** Today's LLM spend across lanes; a failed read throws (no run starts on an unknown spend). */
  todayUsd: (now: number) => Promise<number>;
  /** Today's Qloo counters, or null when no Qloo breaker applies; a failed read throws. */
  qloo: (now: number) => Promise<QlooUsage | null>;
  now?: () => number;
}

/** Reads the breakers' inputs and decides each lane's mode. Holds no state: every call reads afresh. */
export class ModeService {
  private readonly deps: ModeServiceDeps;
  private readonly now: () => number;
  private warnedOverride = false;

  constructor(
    deps: ModeServiceDeps,
    readonly policy: SpendPolicy = DEFAULT_SPEND_POLICY,
  ) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  budget(lane: Lane): LaneBudget {
    return laneBudget(lane, this.policy);
  }

  async inputs(now: number = this.now()): Promise<BreakerInputs> {
    const override = this.deps.override();
    if (override !== null && !this.warnedOverride) {
      this.warnedOverride = true;
      log.warn({ mode: override }, "MODE_OVERRIDE is set: the breakers are bypassed");
    }
    const [stored, todayUsd, qloo] = await Promise.all([
      this.deps.stored(),
      this.deps.todayUsd(now),
      this.deps.qloo(now),
    ]);
    return { override, stored, todayUsd, qloo };
  }

  async decide(lane: Lane): Promise<ModeDecision> {
    const now = this.now();
    return decideMode(lane, await this.inputs(now), this.policy, now);
  }

  /** Both lanes from one read of the inputs. */
  async decideAll(): Promise<Record<Lane, ModeDecision>> {
    const now = this.now();
    const inputs = await this.inputs(now);
    return Object.fromEntries(Lane.options.map((lane) => [lane, decideMode(lane, inputs, this.policy, now)])) as Record<
      Lane,
      ModeDecision
    >;
  }
}
