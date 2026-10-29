// The brief view-model (Concept A · Brief, D36): pure, framework-free TypeScript from a RunState to
// everything the brief page renders. Safe on the server and in the browser.
export * from "./types";
export * from "./format";
export { plainDisplay, plainPiece, plainWords } from "./plain";
export { buildBriefModel, briefIdOf, findingOf } from "./model";
export { FootnoteRegistry, createFootnoteRegistry, fallbackTrace, figureNoteText, inlineText, SHORT_NOTE_MAX } from "./footnotes";
export { buildLedger, metricView, cacheLabel, shortRequestTrace, SHORT_TRACE_MAX, type Ledger } from "./ledger";
export { figureLegend, figureSource, methodHrefFor, shortCodes } from "./figures";
export { inMarket, KPI_SLOTS, pickMatches, skillForFormula, slotFor, type KpiFocus, type KpiPick, type KpiSlot } from "./kpi-slots";
export { KEY_FIGURE_LABEL_MAX, KEY_FIGURE_SPECS, keyFigureLabel, keyFigureText, type KeyFigureText } from "./key-figures";
export { areaReads, buildLocation, datasetPlace, LOCATION_METHOD_LABEL, type AreaRead, type DatasetPlace } from "./location";
export { buildNextMoves, nextMoveDesk, nextMoveHref, nextMoveLabel } from "./next-moves";
export {
  stageStrip,
  progressLabel,
  progressFraction,
  sourceCounts,
  draftNumbers,
  meters,
  incomingRequests,
  traceNote,
  uncheckedDigest,
  stoppedEarly,
  elapsedMs,
} from "./live";
export { methodSteps, methodPivots, methodFallbacks, interpretation, checkerLine, buildMethod, buildSources } from "./method";
export {
  buildGhostView,
  ghostOf,
  markClaims,
  type GhostCategory,
  type GhostFigure,
  type GhostHeadlinePart,
  type GhostName,
  type GhostRun,
  type GhostStatus,
  type GhostView,
} from "./ghost";
