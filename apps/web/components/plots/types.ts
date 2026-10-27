import type { ReactNode } from "react";
import type { TagPreset, TagTone } from "../ui/tag";

/**
 * The seam between the answer and profile pages and the plots (spec §4, "plots/index.ts"): plain rows
 * the page builds from its data, each with the value, the words to print and an optional tag. The plots
 * never read datasets, so the same rows also feed their Table views.
 */

/** A tag beside a value: one of the design's presets ("hidden-gem") or free words with a tone. */
export type PlotTag = TagPreset | { tone: TagTone; label: string };

/** Bar colours: the subject (accent), the comparison or "less" side (second), everything else (muted). */
export type PlotTone = "accent" | "second" | "muted";

/** What every plot takes besides its rows. */
export interface PlotBaseProps {
  /** The chart's title in plain words: the accessible name of the plot and its table. */
  label: string;
  /** What an empty plot says on its hatch (default "No data"). */
  emptyLabel?: string;
  className?: string;
}

/** A Table view: column heads and rows of printable cells, for `<ChartTable>` from components/ui. */
export interface PlotTable {
  columns: { label: string; numeric?: boolean }[];
  rows: ReactNode[][];
}
