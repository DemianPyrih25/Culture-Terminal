// Figure families (names frozen by PLAN §8.4), drawn in the redesign's ChartCard anatomy: the chart sheet
// and the Table views use them, and the answer pages use the maps (LiftMapCard, AreaMap). Hand-written
// SVG rendered on the server; only the Chart | Table switch and the maps run in the browser, and the
// WebGL map code is fetched on demand. The answer-page plots are in ../plots.
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
export { LiftMapCard } from "./lift-map-card";
export type { LiftMapCardProps } from "./lift-map-card";
export { AreaMap, AreaSchematic } from "./area-map";
export type { AreaMapProps } from "./area-map";
export { CORNER_LABEL, areaMapCaption, fitProjection, outlineBounds, outlinePath, outlineRings } from "./area-map-shape";
export type { GeoPoint } from "./area-map-shape";
export { CornerPin, MAP_CARD_KIND, MAP_CARD_TITLE, MAP_LEGEND_TEXT, MODE_TEXT, MapLegend, MapPinMark } from "./lift-map-parts";
export { outlinesUrl } from "./lift-outlines";
export type { OutlineCollection, OutlineFeature, OutlineGeometry } from "./lift-outlines";
export {
  LIFT_CLAMP,
  LIFT_MODES,
  LIFT_MODE_KEY,
  MAP_RAMP,
  cellFills,
  fewRivals,
  flagSize,
  flagValue,
  formatLift,
  heatPercentiles,
  pinRadius,
  liftRgb,
  liftT,
  mapPins,
  placeChips,
  precisionBadge,
} from "./lift-scale";
export type { LiftLabel, LiftMode } from "./lift-scale";
export { encodeGeohash, geohashBounds, geohashCentre, unionBounds } from "./geohash";
export { MomentumStrip, TREND_TEXT, momentumDomain, momentumTableSpec, stepPath, windowEndMonth } from "./momentum-strip";
export type { MomentumStripOptions, MomentumStripProps } from "./momentum-strip";
export { PeerStrip, PositionCard, positionTableSpec } from "./position-card";
export type { PositionCardOptions, PositionCardProps } from "./position-card";
export { TASTE_MAP_DRAW_MIN, TasteMap, dotRadius, nearestOnMap, stressText, tasteMapCaption, tasteMapModel, tasteMapTableSpec } from "./taste-map";
export type { TasteMapModel, TasteMapOptions, TasteMapProps } from "./taste-map";
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
