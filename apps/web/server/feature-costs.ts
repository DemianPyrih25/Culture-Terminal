import "server-only";
import { Feature } from "@ct/contracts";
import { featureUseMedians, type FeatureUseMedian, type Queryable } from "@ct/db";

/**
 * Measured costs of the code-only features (Part 10 open issue): the screener and the brand profile record
 * one feature_uses row per use (counts and costs only, never Qloo data), and /method shows the medians of
 * the last 30 days beside each plan figure, with how many uses they rest on. A feature with no use in the
 * window keeps its plan figure, labelled as a plan.
 */

/** The window /method's measured feature costs cover, in days. */
export const FEATURE_MEASURE_WINDOW_DAYS = 30;

/** One feature's medians as /method prints them. */
export interface FeatureMeasurement {
  feature: Feature;
  /** Uses in the window; the medians rest on these. */
  n: number;
  qlooNetwork: number;
  qlooCached: number;
  llmUsd: number;
  ms: number;
}

export interface FeatureCostMeasurements {
  windowDays: number;
  /** Measured features only; a feature absent here has no use in the window (show its plan). */
  features: Partial<Record<Feature, FeatureMeasurement>>;
}

const FEATURES: ReadonlySet<string> = new Set(Feature);
const isFeature = (id: string): id is Feature => FEATURES.has(id);

/** Repo rows as measurements: known features with at least one use, rounded as /method prints them. */
export function measurementsFromRows(rows: readonly FeatureUseMedian[], windowDays: number = FEATURE_MEASURE_WINDOW_DAYS): FeatureCostMeasurements {
  const features: Partial<Record<Feature, FeatureMeasurement>> = {};
  for (const row of rows) {
    if (!isFeature(row.feature) || !(row.n > 0)) continue;
    features[row.feature] = {
      feature: row.feature,
      n: row.n,
      qlooNetwork: Math.round(row.qlooNetworkMedian * 10) / 10,
      qlooCached: Math.round(row.qlooCachedMedian * 10) / 10,
      llmUsd: Math.round(row.llmUsdMedian * 10_000) / 10_000,
      ms: Math.round(row.msMedian),
    };
  }
  return { windowDays, features };
}

/** The measured medians of every code-only feature over the last FEATURE_MEASURE_WINDOW_DAYS. Rejects when the read fails. */
export async function featureCostMeasurements(db: Queryable, windowDays: number = FEATURE_MEASURE_WINDOW_DAYS): Promise<FeatureCostMeasurements> {
  const rows = await featureUseMedians(db, { sinceMs: windowDays * 86_400_000 });
  return measurementsFromRows(rows, windowDays);
}
