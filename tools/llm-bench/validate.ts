import {
  extractEvidenceIds,
  extractMetricIds,
  parseToolInput,
  ReportDraftShape,
  stripTokens,
  SubmitPlanInputShape,
} from "./deps";
import type { Ledger } from "./scenario";

/**
 * Strict tool use guarantees the structural schema (what the API saw), so a Shape failure is a
 * real strict-mode failure. Id formats (V1-style, repairable by the CHECKER) and the counts and
 * lengths (V9) are stripped from that schema and enforced server-side, so they are recorded
 * separately: a limits miss is a quality signal, not a strict-mode failure.
 */
export interface SchemaCheck {
  structural: boolean;
  limits: boolean;
  issues: string[];
}

function issuesOf(limited: { ok: true } | { ok: false; error: string }): string[] {
  return limited.ok ? [] : limited.error.split("\n").filter((line) => line && line !== "INVALID_INPUT");
}

export function checkPlan(raw: unknown): SchemaCheck & { plan: SubmitPlanInputShape | null } {
  const shape = SubmitPlanInputShape.safeParse(raw);
  const limited = parseToolInput("submit_plan", raw);
  return { structural: shape.success, limits: limited.ok, issues: issuesOf(limited), plan: shape.success ? shape.data : null };
}

export function checkReport(raw: unknown): SchemaCheck & { report: ReportDraftShape | null } {
  const shape = ReportDraftShape.safeParse(raw);
  const limited = parseToolInput("submit_report", raw);
  return { structural: shape.success, limits: limited.ok, issues: issuesOf(limited), report: shape.success ? shape.data : null };
}

/** A cheap proxy for output quality: do the citations resolve, and is prose free of bare numbers? */
export interface ReportQuality {
  arguments: number;
  hypothesesPlanned: number;
  hypothesesJudged: number;
  unknownMetricIds: string[];
  unknownEvidenceIds: string[];
  unknownDatasetIds: string[];
  /** Decimals or percentages outside tokens (the core of CHECKER V3). */
  bareNumbers: number;
}

function proseOf(r: ReportDraftShape): string[] {
  return [
    r.headline,
    r.thesis,
    ...r.hypothesis_verdicts.map((v) => v.note),
    ...r.arguments.flatMap((a) => [a.qloo_fact, a.our_read]),
    ...r.exhibits.flatMap((e) => [e.title, e.caption]),
    ...r.bear_case.map((b) => b.text),
    ...r.recommendations.map((x) => x.action),
  ];
}

const BARE_NUMBER = /\d+\.\d+|\d+(?:\.\d+)?\s?%/g;

export function reportQuality(report: ReportDraftShape, ledger: Ledger, plannedHypotheses: readonly string[]): ReportQuality {
  const prose = proseOf(report);
  const metricIds = new Set<string>([
    ...prose.flatMap(extractMetricIds),
    ...report.hypothesis_verdicts.flatMap((v) => v.metric_ids),
    ...report.arguments.flatMap((a) => a.metric_ids),
    ...report.bear_case.flatMap((b) => b.metric_ids),
  ]);
  const evidenceIds = new Set<string>([...prose.flatMap(extractEvidenceIds), ...report.arguments.flatMap((a) => a.evidence_ids)]);
  const metrics = new Set<string>(ledger.metrics);
  const evidence = new Set<string>(ledger.evidence);
  const datasets = new Set<string>(ledger.datasets);
  const judged = new Set<string>(report.hypothesis_verdicts.map((v) => v.hypothesis_id));
  return {
    arguments: report.arguments.length,
    hypothesesPlanned: plannedHypotheses.length,
    hypothesesJudged: plannedHypotheses.filter((h) => judged.has(h)).length,
    unknownMetricIds: [...metricIds].filter((id) => !metrics.has(id)),
    unknownEvidenceIds: [...evidenceIds].filter((id) => !evidence.has(id)),
    unknownDatasetIds: report.exhibits.map((e) => e.dataset_id).filter((id) => !datasets.has(id)),
    bareNumbers: prose.reduce((n, text) => n + (stripTokens(text).match(BARE_NUMBER)?.length ?? 0), 0),
  };
}
