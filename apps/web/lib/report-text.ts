import { tokenizeProse, type RunState, type TrendWindow } from "@ct/contracts";

/** Metrics by id, as the run state keeps them. */
export type MetricsById = RunState["metrics"];

/**
 * Report prose as plain text (D6): a {{M#}} token becomes the metric's display value and badge, the
 * window token the trending window, and [E#] stays a citation. A metric the run has not streamed
 * renders as "n/a", so no unbound number appears. The text is never parsed as markdown or HTML.
 */
export function proseText(text: string, metrics: MetricsById = {}, window: TrendWindow | null = null): string {
  return tokenizeProse(text)
    .map((segment) => {
      switch (segment.kind) {
        case "text":
          return segment.text;
        case "metric": {
          const metric = metrics[segment.id];
          return metric ? `${metric.display} (${metric.badge})` : "n/a";
        }
        case "evidence":
          return `[${segment.id}]`;
        case "window":
          return window ? `${window.start}..${window.end}` : "the trending window";
      }
    })
    .join("");
}
