import {
  isId,
  makeId,
  toScorecardVerdict,
  type DatasetOf,
  type EvidenceId,
  type MetricId,
  type ReportDraftShape,
  type ScorecardPayload,
  type ScorecardRow,
  type SubmitPlanInputShape,
} from "@ct/contracts";
import { indexSnapshot, type LedgerSnapshot, type RunLedger } from "./ledger";
import { citedIds } from "./tokens";

/**
 * The Hypothesis Scorecard (SPEC §6.6, layer 1 of the "Without Qloo" proof): the priors the ANALYST
 * wrote in submit_plan before any data, each judged against cited metrics. It is always the first
 * exhibit (§7.2). Code keeps the model honest: a hypothesis without a verdict, or a CONFIRMED or
 * REFUTED verdict that no measured metric backs, is INCONCLUSIVE.
 */

export const SCORECARD_TITLE = "Hypothesis Scorecard";
export const NO_VERDICT_NOTE = "No verdict was submitted for this hypothesis.";
export const UNBACKED_VERDICT_NOTE = "Marked inconclusive by code: none of the cited metrics has a value.";

export function buildScorecard(
  plan: SubmitPlanInputShape | null,
  draft: ReportDraftShape | null,
  ledger: LedgerSnapshot,
): ScorecardPayload {
  const lookup = indexSnapshot(ledger);
  const rows = (plan?.hypotheses ?? []).map((h, i): ScorecardRow => {
    const base = {
      hypothesisId: isId("H", h.id) ? h.id : makeId("H", i + 1),
      statement: h.statement,
      expectation: h.expectation,
      testTool: h.test_tool,
    };
    const verdict = draft?.hypothesis_verdicts.find((v) => v.hypothesis_id === h.id);
    if (!verdict) return { ...base, verdict: "INCONCLUSIVE", metricIds: [], evidenceIds: [], note: NO_VERDICT_NOTE };

    const metrics = citedIds("M", verdict.metric_ids, [verdict.note]).flatMap((id) => lookup.metric(id) ?? []);
    const metricIds: MetricId[] = metrics.map((m) => m.id);
    const evidenceIds = [
      ...new Set<EvidenceId>([
        ...metrics.flatMap((m) => m.evidenceIds),
        ...citedIds("E", [], [verdict.note]).filter((id) => lookup.evidence(id) !== undefined),
      ]),
    ];
    const backed = metrics.some((m) => m.value !== null);
    const claimed = toScorecardVerdict(verdict.verdict);
    if (claimed !== "INCONCLUSIVE" && !backed) {
      const note = `${UNBACKED_VERDICT_NOTE} ${verdict.note}`;
      return { ...base, verdict: "INCONCLUSIVE", metricIds, evidenceIds, note };
    }
    return { ...base, verdict: claimed, metricIds, evidenceIds, note: verdict.note };
  });
  return { rows };
}

/**
 * Builds the Scorecard and records it as a dataset, so it streams as `dataset.ready` and the report
 * can show it as its first exhibit. Call it with the CHECKER's patchedDraft before assembleReport,
 * or with a null draft before buildIncompleteReport; both refuse a plan with hypotheses and no
 * Scorecard. Null when there is no plan with hypotheses.
 */
export function recordScorecard(
  ledger: RunLedger,
  plan: SubmitPlanInputShape | null,
  draft: ReportDraftShape | null,
): DatasetOf<"Scorecard"> | null {
  const payload = buildScorecard(plan, draft, ledger.snapshot());
  if (payload.rows.length === 0) return null;
  const dataset = ledger.addDataset({
    kind: "Scorecard",
    title: SCORECARD_TITLE,
    evidenceIds: [...new Set(payload.rows.flatMap((r) => r.evidenceIds))],
    formulaIds: [],
    payload,
  });
  return dataset as DatasetOf<"Scorecard">;
}
