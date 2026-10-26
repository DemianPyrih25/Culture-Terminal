// Figure families for the brief (Concept A, D36; names frozen by PLAN §8.4). Hand-written SVG,
// rendered on the server; only the ⧉ table toggle and the LiftMap's controls run in the browser,
// and the LiftMap's WebGL map code is fetched on demand.
export { FigureFrame, Legend, figureLabel, methodHref } from "./figure-frame";
export type { FigureMeta, FigureSource, LegendItem } from "./figure-frame";
export { FigureTable } from "./figure-table";
export type { TableCell, TableColumn, TableRow, TableSpec } from "./figure-table";
export { MatrixGrid, matrixCodes, matrixRamp, matrixTableSpec } from "./matrix-grid";
export type { MatrixGridOptions, MatrixGridProps } from "./matrix-grid";
export { FLAG_LABEL, RankedTable, comparisonSet, rankedTableSpec, slateToRanked } from "./ranked-table";
export type { RankedTableOptions, RankedTableProps, RankedVariant } from "./ranked-table";
export { DivergingBars, barsTableSpec } from "./diverging-bars";
export type { BarsDisplay, DivergingBarsOptions, DivergingBarsProps } from "./diverging-bars";
export { QuadrantScatter, quadrantTableSpec } from "./quadrant-scatter";
export type { QuadrantScatterOptions, QuadrantScatterProps } from "./quadrant-scatter";
export { PRIOR_STATE, PriorRow, ScorecardList, ScorecardTable, expectedText, scorecardTableSpec } from "./scorecard-table";
export type { PriorState, ScorecardOptions, ScorecardTableProps } from "./scorecard-table";
export { SlopeChart, shiftHead, shiftText, slopeShift, slopeTableSpec, slopeValueText, spreadLabels } from "./slope-chart";
export type { SlopeChartOptions, SlopeChartProps } from "./slope-chart";
export { LiftMap, geoLiftBars, liftCaption, liftTableSpec } from "./lift-map";
export type { LiftMapOptions, LiftMapProps } from "./lift-map";
export { outlinesUrl } from "./lift-outlines";
export type { OutlineCollection, OutlineFeature, OutlineGeometry } from "./lift-outlines";
export {
  LIFT_CLAMP,
  LIFT_MODES,
  LIFT_MODE_KEY,
  cellFills,
  formatLift,
  heatPercentiles,
  liftLabels,
  liftRadius,
  liftRgb,
  liftT,
  placeChips,
  precisionBadge,
} from "./lift-scale";
export type { LiftLabel, LiftMode } from "./lift-scale";
export { encodeGeohash, geohashBounds, geohashCentre, unionBounds } from "./geohash";
export { MomentumStrip, TREND_TEXT, momentumDomain, momentumTableSpec, stepPath, windowEndMonth } from "./momentum-strip";
export type { MomentumStripOptions, MomentumStripProps } from "./momentum-strip";
export { PeerStrip, PositionCard, positionTableSpec } from "./position-card";
export type { PositionCardOptions, PositionCardProps } from "./position-card";
export { Constellation, constellationTableSpec, layoutConstellation } from "./constellation";
export type { ConstellationData, ConstellationOptions, ConstellationProps, ConstellationSeed } from "./constellation";
export { CategoryMap, categoryMapTableSpec, layoutCategoryMap, mapLabelKinds, stressReading } from "./category-map";
export type { CategoryMapOptions, CategoryMapProps, TasteMapPayload, TasteMapPoint } from "./category-map";
export { TwinCards, twinRows, twinTableSpec } from "./twin-cards";
export type { TwinArea, TwinCandidate, TwinCardsOptions, TwinCardsProps, TwinPayload, TwinTag } from "./twin-cards";
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
