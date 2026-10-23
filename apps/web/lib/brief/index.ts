// The brief view-model (Concept A · Brief, D36): pure, framework-free TypeScript from a RunState to
// everything the brief page renders. Safe on the server and in the browser.
export * from "./types";
export * from "./format";
export { buildBriefModel, briefIdOf } from "./model";
export { FootnoteRegistry, createFootnoteRegistry, figureNoteText, inlineText, SHORT_NOTE_MAX } from "./footnotes";
export { buildLedger, metricView, cacheLabel, shortRequestTrace, SHORT_TRACE_MAX, type Ledger } from "./ledger";
export { figureLegend, figureSource, methodHrefFor, shortCodes } from "./figures";
export { KPI_SLOTS, skillForFormula, type KpiSlot } from "./kpi-slots";
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
