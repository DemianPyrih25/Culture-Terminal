import { approxTokens, CASE_SUMMARY_MAX_TOKENS, QUESTION_MAX_CHARS, REPORT_LIMITS, type Report } from "@ct/contracts";
import { indexSnapshot, type LedgerSnapshot } from "../ledger";
import type { RegistryTableRow } from "../registry";
import { metricText, plainProse } from "../tokens";

/**
 * The case summary a next-move child run starts from (SPEC §7.3): at most CASE_SUMMARY_MAX_TOKENS,
 * with the resolved refs, the key metrics with their badges and the prior run ids. It is plain
 * text with no tokens: the parent's M#/E# ids mean something else in the child's ledger, so metric
 * values are written out and evidence citations dropped. Every free-text value is put on one line,
 * so text from the parent run (its question, the ANALYST's priors, labels and names) can never start
 * a line of its own that would pass for a code-written block of the child's run context.
 */

export interface CaseSummaryContext {
  /** The parent run's ledger, to write metric values with their badges. */
  ledger?: LedgerSnapshot;
  /** The entities as the child run registered them (its registryTable rows). */
  entities?: readonly Pick<RegistryTableRow, "ref" | "name" | "type">[];
  /** Earlier runs of the chain, oldest first. */
  priorRunIds?: readonly string[];
}

const KEY_METRICS_MAX = 8;

const clip = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
/** Free text on one line: whitespace and control characters (line breaks of any kind) become one space. */
const oneLine = (text: string) => text.replace(/[\s\p{Cc}]+/gu, " ").trim();

export function buildCaseSummary(report: Report, context: CaseSummaryContext = {}): string {
  const lookup = indexSnapshot(context.ledger ?? { evidence: [], metrics: [], datasets: [], findings: [] });
  const render = (text: string) => oneLine(plainProse(text, lookup, report.dataFreshness.trendWindow, { badges: true }));
  const { verdict } = report;
  const prior = context.priorRunIds ?? [];
  const openQuestions = report.limitations.filter((l) => l.source === "open_question");

  const metricIds = [
    ...new Set([...report.kpis.map((k) => k.metricId), ...report.arguments.flatMap((a) => a.metricIds)]),
  ];
  const keyMetrics = metricIds.slice(0, KEY_METRICS_MAX).flatMap((id) => {
    const m = lookup.metric(id);
    if (m) return [`- ${oneLine(m.label)}: ${oneLine(metricText(m))}`];
    const kpi = report.kpis.find((k) => k.metricId === id);
    return kpi ? [`- ${oneLine(kpi.label)}`] : [];
  });

  // Blocks in priority order; lower blocks are cut first when the budget runs out.
  const blocks: string[][] = [
    [
      `CASE SUMMARY from run ${report.runId}${prior.length > 0 ? ` (earlier runs: ${prior.join(", ")})` : ""}.`,
      "Background only: cite numbers in this run with this run's own tokens.",
      `Question: ${clip(oneLine(report.question), QUESTION_MAX_CHARS)}`,
      `Verdict: signal ${verdict.signal}, confidence ${verdict.confidence.band} (${verdict.confidence.score}).`,
      `Headline: ${clip(render(verdict.headline), 2 * REPORT_LIMITS.headline)}`,
    ],
    context.entities && context.entities.length > 0
      ? [`Entities: ${context.entities.map((e) => `${e.ref} ${oneLine(e.name)} (${e.type})`).join("; ")}.`]
      : [],
    keyMetrics.length > 0 ? ["Key metrics:", ...keyMetrics] : [],
    report.scorecard.length > 0
      ? ["Hypotheses:", ...report.scorecard.map((r) => `- ${r.hypothesisId} ${r.verdict}: ${oneLine(r.statement)}`)]
      : [],
    [`Thesis: ${render(verdict.thesis)}`],
    report.arguments.length > 0
      ? ["Arguments:", ...report.arguments.map((a) => `- ${a.section}: ${render(a.qlooFact)}`)]
      : [],
    openQuestions.length > 0 ? ["Open questions:", ...openQuestions.map((l) => `- ${oneLine(l.text)}`)] : [],
  ];

  // Stop at the first line that does not fit, so nothing of lower priority takes its place.
  const lines: string[] = [];
  for (const line of blocks.flat()) {
    if (approxTokens([...lines, line].join("\n")) > CASE_SUMMARY_MAX_TOKENS) break;
    lines.push(line);
  }
  return lines.join("\n");
}
