import type { ReportDraftShape } from "@ct/contracts";
import type { AnswerChart } from "../../lib/answer";
import { ChartBodyView } from "../answer/chart-bodies";
import { ChartCard, ChartTable } from "../ui";

/** The title a draft chart wears before the answer has written one: plain words, never a dataset name. */
export const DRAFT_CHART_TITLE = "What the data shows so far";

/** The draft's own title for this chart's exhibit, once the answer is drafted; otherwise the plain one. */
export function draftChartTitle(chart: Pick<AnswerChart, "datasetId">, draft: Pick<ReportDraftShape, "exhibits"> | null | undefined): string {
  const title = draft?.exhibits.find((e) => e.dataset_id === chart.datasetId)?.title.trim();
  return title ? title : DRAFT_CHART_TITLE;
}

/**
 * C/ChartCard · draft (N04): the answer's main chart while the run is still checking its numbers. The
 * Draft tag, Source disabled, the Chart | Table switch; drawn with the answer page's own chart bodies.
 * The title is the drafted exhibit's when the answer is drafted, a plain line before that.
 */
export function DraftChartCard({ chart, draft, className }: { chart: AnswerChart; draft?: Pick<ReportDraftShape, "exhibits"> | null; className?: string }) {
  if (chart.body.type === "map") return null;
  const title = draftChartTitle(chart, draft);
  const table = chart.table ? <ChartTable label={title} columns={chart.table.columns} rows={chart.table.rows} /> : undefined;
  return (
    <ChartCard kind={chart.kind} title={title} titleAs="h2" legend={chart.legend} table={table} stacked={chart.stacked} caption={chart.caption} draft className={className}>
      <ChartBodyView body={chart.body} label={title} />
    </ChartCard>
  );
}
