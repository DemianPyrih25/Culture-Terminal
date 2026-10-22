import type { RunRecord } from "./analyst-run";
import type { BenchConfigId } from "./config";
import { formatUsd } from "./pricing";
import { p50 } from "./stats";

export interface ConfigSummary {
  config: BenchConfigId;
  runs: number;
  /** Runs that reached the end of the loop (completed or incomplete): the latency and cost sample. */
  finished: number;
  completed: number;
  outcomes: Partial<Record<RunRecord["outcome"], number>>;
  p50WallSeconds: number | null;
  /** Measured usage only; estimates charged for failed requests are counted apart, below. */
  p50UsdPerRun: number | null;
  /** Finished runs that also carry worst-case estimates for failed, possibly billed requests. */
  runsWithEstimatedCharges: number;
  estimatedChargesUsd: number;
  /** Requests whose real prompt was larger than the budget estimate assumed. */
  estimateShortfalls: number;
  p50OutputTokens: number | null;
  p50FirstDeltaSeconds: number | null;
  /** First-request cache reads of runs after the first: > 0 means the identical prefix was cached. */
  secondRunCacheRead: number[];
  planValid: number;
  reportValid: number;
  reportWithinLimits: number;
  thinkingNonEmpty: number;
  nudges: number;
}

const finishedRun = (r: RunRecord): boolean => r.outcome === "completed" || r.outcome === "incomplete";

export function summarize(config: BenchConfigId, runs: readonly RunRecord[]): ConfigSummary {
  const mine = runs.filter((r) => r.config === config);
  const finished = mine.filter(finishedRun);
  const outcomes: ConfigSummary["outcomes"] = {};
  for (const r of mine) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  return {
    config,
    runs: mine.length,
    finished: finished.length,
    completed: mine.filter((r) => r.outcome === "completed").length,
    outcomes,
    p50WallSeconds: p50(finished.map((r) => r.wallMs / 1000)),
    p50UsdPerRun: p50(finished.map((r) => r.usd)),
    runsWithEstimatedCharges: finished.filter((r) => r.estimatedChargesUsd > 0).length,
    estimatedChargesUsd: finished.reduce((n, r) => n + r.estimatedChargesUsd, 0),
    estimateShortfalls: mine.reduce((n, r) => n + r.turns.filter((t) => t.estimateShortfallTokens > 0).length, 0),
    p50OutputTokens: p50(finished.map((r) => r.usage.output)),
    p50FirstDeltaSeconds: p50(
      mine.flatMap((r) => {
        const ms = r.turns[0]?.firstDeltaMs;
        return ms == null ? [] : [ms / 1000];
      }),
    ),
    secondRunCacheRead: mine.filter((r) => r.run > 1 && r.firstRequestCacheRead !== null).map((r) => r.firstRequestCacheRead ?? 0),
    planValid: mine.filter((r) => r.plan.structural === true).length,
    reportValid: mine.filter((r) => r.report.structural === true).length,
    reportWithinLimits: mine.filter((r) => r.report.limits === true).length,
    thinkingNonEmpty: mine.filter((r) => r.thinkingNonEmpty).length,
    nudges: mine.reduce((n, r) => n + Number(r.nudges.plan) + Number(r.nudges.report), 0),
  };
}

/** PLAN §4.2: Sonnet-medium if its p50 is at most 100 s and its cost at most $0.30 per run, else Sonnet-low. */
export const DECISION_RULE = { maxP50Seconds: 100, maxUsdPerRun: 0.3 } as const;

export interface Decision {
  pick: "sonnet-medium" | "sonnet-low";
  reason: string;
  /** Things the rule does not weigh but a reviewer should see before accepting the pick. */
  warnings: string[];
}

export function decide(summaries: readonly ConfigSummary[]): Decision {
  const sm = summaries.find((s) => s.config === "sonnet-medium");
  const warnings: string[] = [];
  for (const s of summaries) {
    if (s.runs > 0 && s.reportValid < s.runs) warnings.push(`${s.config}: ${s.runs - s.reportValid} of ${s.runs} runs without a schema-valid submit_report`);
    if (s.runs > 1 && s.secondRunCacheRead.length > 0 && s.secondRunCacheRead.every((n) => n === 0)) {
      warnings.push(`${s.config}: cache_read_input_tokens was 0 on every later run's first request (prefix not cached)`);
    }
    if (s.runsWithEstimatedCharges > 0) {
      warnings.push(
        `${s.config}: ${s.runsWithEstimatedCharges} finished run(s) had a failed request that may have been billed; ` +
          `p50 $/run counts measured usage only, without up to ${formatUsd(s.estimatedChargesUsd)} of estimates`,
      );
    }
    if (s.estimateShortfalls > 0) {
      warnings.push(
        `${s.config}: ${s.estimateShortfalls} request(s) had a larger prompt than the budget estimate assumed; ` +
          "lower ESTIMATE_CHARS_PER_TOKEN before trusting the cap as a hard bound",
      );
    }
  }
  if (!sm || sm.p50WallSeconds === null || sm.p50UsdPerRun === null) {
    return { pick: "sonnet-low", reason: "no finished sonnet-medium run to measure, so the rule falls back to sonnet-low", warnings };
  }
  const fast = sm.p50WallSeconds <= DECISION_RULE.maxP50Seconds;
  const cheap = sm.p50UsdPerRun <= DECISION_RULE.maxUsdPerRun;
  const facts = `sonnet-medium p50 ${sm.p50WallSeconds.toFixed(1)} s (limit ${DECISION_RULE.maxP50Seconds} s), ${formatUsd(sm.p50UsdPerRun)} per run (limit ${formatUsd(DECISION_RULE.maxUsdPerRun)})`;
  return fast && cheap
    ? { pick: "sonnet-medium", reason: `${facts}: both within the rule`, warnings }
    : { pick: "sonnet-low", reason: `${facts}: ${fast ? "" : "too slow"}${!fast && !cheap ? " and " : ""}${cheap ? "" : "too costly"}`, warnings };
}

function cell(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

const num = (n: number | null, digits = 1): string => (n === null ? "n/a" : n.toFixed(digits));

export function formatTable(summaries: readonly ConfigSummary[]): string {
  const header = ["config", "finished", "p50 wall s", "p50 $/run", "p50 out tok", "p50 TTFT s", "cache read run>1", "plan ok", "report ok", "in limits", "thinking", "nudges"];
  const rows = summaries.map((s) => [
    s.config,
    `${s.finished}/${s.runs}`,
    num(s.p50WallSeconds),
    s.p50UsdPerRun === null ? "n/a" : formatUsd(s.p50UsdPerRun),
    num(s.p50OutputTokens, 0),
    num(s.p50FirstDeltaSeconds),
    s.secondRunCacheRead.length ? s.secondRunCacheRead.map((n) => n.toLocaleString("en-US")).join(", ") : "n/a",
    `${s.planValid}/${s.runs}`,
    `${s.reportValid}/${s.runs}`,
    `${s.reportWithinLimits}/${s.runs}`,
    `${s.thinkingNonEmpty}/${s.runs}`,
    `${s.nudges}`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)) + 2);
  return [header, ...rows].map((r) => r.map((v, i) => cell(v, widths[i] ?? 0)).join("").trimEnd()).join("\n");
}
