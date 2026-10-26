import { formatUtcDate } from "../../lib/brief/format";
import { formatEvalValue, type EvalMetric, type EvalSummary } from "../method/eval-summary";

/**
 * The eval and Reality Check aggregates the proof strip shows (SPEC §6.6, §6.7), from the one summary
 * the eval writes to apps/web/content/eval-summary.json and /method#eval reads too: the schema and its
 * parser are components/method/eval-summary.ts. Aggregates only, never a single answer. The strip shows
 * the figures the summary has, and nothing at all without the file.
 */

/** The metrics the strip reads from summary.metrics, by id; the eval writes them under these ids. */
export const EVAL_METRIC_IDS = {
  /** Hypotheses refuted or qualified by the data, of all planned ones. */
  refuted: "refutation_rate",
  /** Numbers bound to a request: grounded, and GHOST (the same model without Qloo) in `ghost`. */
  traced: "traceability",
  /** Adversarial questions handled as pre-registered. */
  adversarial: "adversarial_accuracy",
} as const;

/** "81st", "52nd", "3rd", "11th". */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  const suffix = ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
}

/** One aggregate as the proof strip prints it: the number, what it measures, and against what. */
export interface EvalFigure {
  key: string;
  value: string;
  label: string;
  note: string;
}

function metric(summary: EvalSummary, id: string): (EvalMetric & { grounded: number }) | null {
  const found = summary.metrics.find((m) => m.id === id);
  return found && found.grounded !== null && Number.isFinite(found.grounded) ? { ...found, grounded: found.grounded } : null;
}

/** The figures a summary holds, Reality Check first; a figure whose number is missing is left out. */
export function evalFigures(summary: EvalSummary): EvalFigure[] {
  const out: EvalFigure[] = [];
  const rc = summary.realityCheck;
  const { total, adversarial } = summary.questions;
  if (rc && rc.medianPercentile !== null) {
    out.push({
      key: "reality-check",
      value: ordinal(Math.round(rc.medianPercentile * 100)),
      label: "Median percentile of the real-world choice",
      note: `Reality Check · random 50th · n = ${rc.cases}`,
    });
  }
  const traced = metric(summary, EVAL_METRIC_IDS.traced);
  if (traced) {
    out.push({
      key: "traced",
      value: formatEvalValue(traced.grounded, traced.unit),
      label: "Numbers traced to a request",
      note: traced.ghost !== null ? `The model alone: ${formatEvalValue(traced.ghost, traced.unit)}` : "Checked before a brief is shown",
    });
  }
  const refuted = metric(summary, EVAL_METRIC_IDS.refuted);
  if (refuted) {
    out.push({
      key: "refuted",
      value: formatEvalValue(refuted.grounded, refuted.unit),
      label: "Priors refuted or qualified",
      note: `Across ${total} eval questions`,
    });
  }
  if (rc && rc.ghostHitRate !== null) {
    out.push({
      key: "ghost-hit",
      value: formatEvalValue(rc.ghostHitRate, "rate"),
      label: "Real choices the model alone named",
      note: "Reality Check · GHOST hit rate",
    });
  }
  const handled = metric(summary, EVAL_METRIC_IDS.adversarial);
  if (handled) {
    out.push({
      key: "adversarial",
      value: formatEvalValue(handled.grounded, handled.unit),
      label: "Adversarial questions handled",
      note: adversarial > 0 ? `${adversarial} questions · private person, politics, religion, injection` : "Private person, politics, religion, injection",
    });
  }
  return out;
}

/** "Eval of 30 Oct 2026". */
export function evalAsOfText(summary: EvalSummary): string {
  return `Eval of ${formatUtcDate(summary.ranAt)}`;
}
