// Figure families for the brief (Concept A, D36; names frozen by PLAN §8.4). Hand-written SVG,
// rendered on the server; only the ⧉ table toggle runs in the browser.
export { FigureFrame, Legend, figureLabel, methodHref } from "./figure-frame";
export type { FigureMeta, FigureSource, LegendItem } from "./figure-frame";
export { FigureTable } from "./figure-table";
export type { TableCell, TableColumn, TableRow, TableSpec } from "./figure-table";
export { MatrixGrid, matrixRamp, matrixTableSpec } from "./matrix-grid";
export type { MatrixGridOptions, MatrixGridProps } from "./matrix-grid";
export { FLAG_LABEL, RankedTable, rankedTableSpec, slateToRanked } from "./ranked-table";
export type { RankedTableOptions, RankedTableProps, RankedVariant } from "./ranked-table";
export { DivergingBars, barsTableSpec } from "./diverging-bars";
export type { BarsDisplay, DivergingBarsOptions, DivergingBarsProps } from "./diverging-bars";
export { QuadrantScatter, quadrantTableSpec } from "./quadrant-scatter";
export type { QuadrantScatterOptions, QuadrantScatterProps } from "./quadrant-scatter";
export { PRIOR_STATE, PriorRow, ScorecardList, ScorecardTable, expectedText, scorecardTableSpec } from "./scorecard-table";
export type { PriorState, ScorecardOptions, ScorecardTableProps } from "./scorecard-table";
export { Exhibit, FigurePending } from "./exhibit";
export type { ExhibitDisplay, ExhibitProps } from "./exhibit";
export { plainProse, renderProse } from "./prose";
export type { ProseBindings, ProseRenderer } from "./prose";
export { sourceFromEvidence } from "./source";
export {
  COMPARATOR_NOUN,
  COMPARATOR_PHRASE,
  MINUS,
  REASON_LABEL,
  abbreviateRequestId,
  axisCodes,
  cellText,
  comparatorHead,
  formatNumber,
  formatTick,
  reasonLabel,
} from "./format";
export type { CellText, NumberStyle } from "./format";
