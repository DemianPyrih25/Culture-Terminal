import "server-only";
import type { Lane } from "@ct/contracts";
import { getQlooUsage, incrementQlooUsage, type Queryable } from "@ct/db";
import { utcDay } from "@ct/qloo";

/** usage_daily metric for LLM spend in USD, per lane and under lane "all" (SPEC §4.2 Pricing). */
export const LLM_USD_METRIC = "llm_usd";

/** Pre-run check (PLAN §4.2): a live run starts only while today's spend plus this stays within the cap. */
export const PRE_RUN_USD = 0.35;

/** Today's (UTC) LLM spend across lanes. */
export function todayLlmUsd(db: Queryable, now: number = Date.now()): Promise<number> {
  return getQlooUsage(db, { day: utcDay(now), lane: "all", metric: LLM_USD_METRIC });
}

/**
 * Adds one run's LLM spend to usage_daily as it grows. The run reports running totals; each call
 * records only the increase since the last recorded total, so the daily counter is right even when
 * the run dies before it ends. A failed write records nothing and the next call catches up.
 */
export class SpendMeter {
  private recordedUsd = 0;

  constructor(
    private readonly db: Queryable,
    private readonly lane: Lane,
  ) {}

  /** The run's spend recorded so far. */
  get recorded(): number {
    return this.recordedUsd;
  }

  async upTo(totalUsd: number, now: number = Date.now()): Promise<void> {
    const delta = totalUsd - this.recordedUsd;
    if (!(delta > 0)) return;
    await incrementQlooUsage(this.db, { day: utcDay(now), lanes: [this.lane, "all"], by: delta, metric: LLM_USD_METRIC });
    this.recordedUsd = totalUsd;
  }
}
