import "server-only";
import {
  type CostRange,
  DEFAULT_RUN_LIMITS,
  Feature,
  FEATURE_COSTS,
  Job,
  JOB_QLOO_PLAN,
  NOTE_LLM_USD,
  type RunLimits,
} from "@ct/contracts";
import { featureUseMedians, type FeatureUseMedian } from "@ct/db";
import { resolveQlooEnv } from "@ct/qloo";
import { getDatabase } from "../../server/container";
import { QUESTION_HASH_PREFIX } from "../../server/question-hash";

/**
 * The cost-per-use facts /method prints (PLAN Part 10 "Done when"): each feature's plan figures from the
 * contracts' FEATURE_COSTS, each job's Qloo plan (§10.4) with one note's model cost (§4.2), and, beside
 * the plan, what this server's own live answers measured: the median Qloo calls and model cost of the
 * finished live runs of each job in the last 30 days, read from the runs table, and for the code-only
 * features that record each use (screens, brand profiles: the feature_uses table) their medians over the
 * same window with the number of uses. A feature with no recorded use shows its plan figures, labelled
 * "plan".
 */

/** One feature's row: Qloo calls cold and warm, and model USD, each an inclusive range. */
export interface FeatureCostRow {
  feature: Feature;
  label: string;
  per: string;
  plan: string;
  qlooCold: CostRange;
  /** Null where the plan gives no warm figure. */
  qlooWarm: CostRange | null;
  llmUsd: CostRange;
  /** True for a re-run: it costs one run of the followed note's job, so the range spans the jobs. */
  perJob: boolean;
  /** What this server's recorded uses measured (feature_uses); null where none were recorded. */
  measured: MeasuredFeatureCost | null;
}

/** One feature's recorded uses on this server: medians over `uses` uses. */
export interface MeasuredFeatureCost {
  uses: number;
  qlooNetwork: number;
  qlooCached: number;
  llmUsd: number;
}

/** What one job's run measured on this server: medians over `runs` finished live runs. */
export interface MeasuredJobCost {
  runs: number;
  qlooNetwork: number;
  qlooCached: number;
  llmUsd: number;
}

export type MeasuredCosts =
  | { state: "ok"; windowDays: number; jobs: Partial<Record<Job, MeasuredJobCost>>; features?: Partial<Record<Feature, MeasuredFeatureCost>> }
  /** QLOO_MOCK=1: the runs here read synthetic data, so nothing they count is a measurement. */
  | { state: "mock" }
  /** The database could not be read in time. */
  | { state: "unavailable" };

export interface JobCostRow {
  job: Job;
  qlooCold: CostRange;
  qlooWarm: CostRange | null;
  llmUsd: CostRange;
  measured: MeasuredJobCost | null;
}

export interface CostFacts {
  features: FeatureCostRow[];
  jobs: JobCostRow[];
  measured: MeasuredCosts;
  /** The per-answer limits this server runs with: the cap on Qloo calls and the turn-2 follow-ups. */
  limits: Pick<RunLimits, "qlooCalls" | "followupCalls">;
}

/** The days of live runs the measured figures read. */
export const MEASURED_WINDOW_DAYS = 30;
/** /method waits this long for the measured figures, then shows the plan alone. */
export const MEASURED_TIMEOUT_MS = 2_000;

const span = (ranges: readonly CostRange[]): CostRange => ({
  min: Math.min(...ranges.map((r) => r.min)),
  max: Math.max(...ranges.map((r) => r.max)),
});

/** Every feature, in the contracts' order; a re-run spans the jobs' plans, since it is one run of the followed job. */
export function featureCostRows(measured: MeasuredCosts = { state: "unavailable" }): FeatureCostRow[] {
  const plans = Job.options.map((job) => JOB_QLOO_PLAN[job]);
  // Over the jobs whose plan gives a warm figure (audience_discovery's does not).
  const warm = plans.flatMap((p) => (p.warm ? [p.warm] : []));
  return Feature.map((feature) => {
    const cost = FEATURE_COSTS[feature];
    const recorded = measured.state === "ok" ? (measured.features?.[feature] ?? null) : null;
    const base = { feature, label: cost.label, per: cost.per, plan: cost.plan, measured: recorded };
    if (cost.basis === "job_run") {
      return {
        ...base,
        qlooCold: span(plans.map((p) => p.cold)),
        qlooWarm: warm.length > 0 ? span(warm) : null,
        llmUsd: NOTE_LLM_USD,
        perJob: true,
      };
    }
    return { ...base, qlooCold: cost.qlooCold, qlooWarm: cost.qlooWarm, llmUsd: cost.llmUsd, perJob: false };
  });
}

export function jobCostRows(measured: MeasuredCosts): JobCostRow[] {
  return Job.options.map((job) => ({
    job,
    qlooCold: JOB_QLOO_PLAN[job].cold,
    qlooWarm: JOB_QLOO_PLAN[job].warm,
    llmUsd: NOTE_LLM_USD,
    measured: measured.state === "ok" ? (measured.jobs[job] ?? null) : null,
  }));
}

export function costFacts(measured: MeasuredCosts, limits: RunLimits = DEFAULT_RUN_LIMITS): CostFacts {
  return {
    features: featureCostRows(measured),
    jobs: jobCostRows(measured),
    measured,
    limits: { qlooCalls: limits.qlooCalls, followupCalls: limits.followupCalls },
  };
}

/** One row of the measured query, as postgres.js returns it. */
export interface MeasuredRow {
  job: string;
  runs: number | string;
  qloo_network: number | string | null;
  qloo_cached: number | string | null;
  llm_usd: number | string | null;
}

/** The query's rows as measured costs; rows of an unknown job or with no figures are left out. */
export function measuredFromRows(rows: readonly MeasuredRow[]): Partial<Record<Job, MeasuredJobCost>> {
  const out: Partial<Record<Job, MeasuredJobCost>> = {};
  for (const row of rows) {
    const job = Job.safeParse(row.job);
    const runs = Number(row.runs);
    if (!job.success || !Number.isFinite(runs) || runs < 1 || row.qloo_network === null || row.llm_usd === null) continue;
    out[job.data] = { runs, qlooNetwork: Number(row.qloo_network), qlooCached: Number(row.qloo_cached ?? 0), llmUsd: Number(row.llm_usd) };
  }
  return out;
}

/** The recorded feature uses as measured costs; unknown features and empty groups are left out. */
export function measuredFeatures(rows: readonly FeatureUseMedian[]): Partial<Record<Feature, MeasuredFeatureCost>> {
  const out: Partial<Record<Feature, MeasuredFeatureCost>> = {};
  for (const row of rows) {
    if (!(Feature as readonly string[]).includes(row.feature) || !(row.n >= 1)) continue;
    out[row.feature as Feature] = { uses: row.n, qlooNetwork: row.qlooNetworkMedian, qlooCached: row.qlooCachedMedian, llmUsd: row.llmUsdMedian };
  }
  return out;
}

export interface MeasuredDeps {
  env: NodeJS.ProcessEnv;
  /** Runs the measured query: finished live runs of real questions since `days` ago, grouped by job. */
  query: (days: number) => Promise<readonly MeasuredRow[]>;
  /** The recorded uses of the code-only features since `days` ago (feature_uses medians); none when omitted. */
  features?: (days: number) => Promise<readonly FeatureUseMedian[]>;
  timeoutMs: number;
}

/**
 * Medians, not means: one long answer with many follow-ups would pull a mean far from a typical run.
 * Only finished live (Sonnet) runs of real questions count: not economy runs, test runs (another hash
 * prefix) or runs that failed, were refused or cancelled.
 */
async function queryMeasured(days: number): Promise<readonly MeasuredRow[]> {
  const sql = getDatabase().$client;
  return sql<MeasuredRow[]>`
    select job,
           count(*)::int as runs,
           percentile_cont(0.5) within group (order by qloo_network)::float8 as qloo_network,
           percentile_cont(0.5) within group (order by qloo_cached)::float8 as qloo_cached,
           percentile_cont(0.5) within group (order by llm_usd)::float8 as llm_usd
    from runs
    where job is not null
      and mode = 'live'
      and status in ('completed', 'incomplete')
      and question_hash like ${`${QUESTION_HASH_PREFIX}%`}
      and created_at >= now() - make_interval(days => ${days})
    group by job`;
}

const queryFeatures = (days: number) => featureUseMedians(getDatabase(), { sinceMs: days * 86_400_000 });

const DEFAULT_DEPS: MeasuredDeps = { env: process.env, query: queryMeasured, features: queryFeatures, timeoutMs: MEASURED_TIMEOUT_MS };

/** What this server's live runs measured; never throws, and never holds the page past the timeout. */
export async function loadMeasuredCosts(deps: MeasuredDeps = DEFAULT_DEPS): Promise<MeasuredCosts> {
  if (resolveQlooEnv(deps.env) === "mock") return { state: "mock" };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), deps.timeoutMs);
  });
  try {
    const read = (async () => {
      const [rows, features] = await Promise.all([
        deps.query(MEASURED_WINDOW_DAYS),
        // A features read that fails leaves the feature rows on their plan; the job medians still show.
        deps.features ? deps.features(MEASURED_WINDOW_DAYS).catch(() => [] as readonly FeatureUseMedian[]) : Promise.resolve([] as readonly FeatureUseMedian[]),
      ]);
      return { rows, features };
    })();
    const got = await Promise.race([read, timeout]);
    if (got === null) return { state: "unavailable" };
    return { state: "ok", windowDays: MEASURED_WINDOW_DAYS, jobs: measuredFromRows(got.rows), features: measuredFeatures(got.features) };
  } catch {
    return { state: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}
