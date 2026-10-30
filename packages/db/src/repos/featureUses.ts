import { gte, sql, type AnyColumn } from "drizzle-orm";
import type { Queryable } from "../client";
import { featureUses } from "../schema";

/**
 * Measured costs of the code-only features (screener, brand profile): one row per use, so /method shows
 * medians beside the plan figures (Part 10 open issue). Rows hold counts and costs only, never Qloo data.
 */

export interface FeatureUseInput {
  /** The feature id, e.g. "screener" or "des_profile" (@ct/contracts Feature). */
  feature: string;
  qlooNetwork: number;
  qlooCached: number;
  publicCalls?: number;
  llmUsd?: number;
  ms: number;
  /** When it happened; defaults to the database time of the insert. */
  ts?: Date;
}

/** The medians of one feature's uses within a window. */
export interface FeatureUseMedian {
  feature: string;
  /** Uses inside the window. */
  n: number;
  qlooNetworkMedian: number;
  qlooCachedMedian: number;
  llmUsdMedian: number;
  msMedian: number;
}

function nonNegative(what: string, v: number, integer: boolean): void {
  if (!Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) {
    throw new RangeError(`recordFeatureUse: ${what} must be a non-negative ${integer ? "integer" : "number"}, got ${v}`);
  }
}

/** Records one use of a feature. */
export async function recordFeatureUse(db: Queryable, input: FeatureUseInput): Promise<void> {
  if (input.feature.trim() === "") throw new RangeError("recordFeatureUse: feature must not be empty");
  nonNegative("qlooNetwork", input.qlooNetwork, true);
  nonNegative("qlooCached", input.qlooCached, true);
  nonNegative("publicCalls", input.publicCalls ?? 0, true);
  nonNegative("llmUsd", input.llmUsd ?? 0, false);
  nonNegative("ms", input.ms, false);
  await db.insert(featureUses).values({
    feature: input.feature,
    qlooNetwork: input.qlooNetwork,
    qlooCached: input.qlooCached,
    publicCalls: input.publicCalls ?? 0,
    llmUsd: input.llmUsd ?? 0,
    ms: Math.round(input.ms),
    ...(input.ts === undefined ? {} : { ts: input.ts }),
  });
}

const median = (col: AnyColumn) => sql<number>`(percentile_cont(0.5) within group (order by ${col}))::float8`.mapWith(Number);

/**
 * Per feature, the number of uses and the medians of what they spent within the window (measured back from
 * the database clock), in feature order. A feature with no use in the window is absent.
 */
export async function featureUseMedians(db: Queryable, options: { sinceMs: number }): Promise<FeatureUseMedian[]> {
  const { sinceMs } = options;
  if (!Number.isFinite(sinceMs) || sinceMs <= 0) throw new RangeError(`featureUseMedians: sinceMs must be positive, got ${sinceMs}`);
  return db
    .select({
      feature: featureUses.feature,
      n: sql<number>`count(*)::int`.mapWith(Number),
      qlooNetworkMedian: median(featureUses.qlooNetwork),
      qlooCachedMedian: median(featureUses.qlooCached),
      llmUsdMedian: median(featureUses.llmUsd),
      msMedian: median(featureUses.ms),
    })
    .from(featureUses)
    .where(gte(featureUses.ts, sql`now() - make_interval(secs => ${sinceMs / 1000})`))
    .groupBy(featureUses.feature)
    .orderBy(featureUses.feature);
}
