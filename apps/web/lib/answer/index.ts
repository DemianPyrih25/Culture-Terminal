// The answer page's view-model (design/redesign.pen N05, N07–N12, N18): pure, framework-free TypeScript from
// a finished run's BriefModel to everything the answer page prints. Safe on the server and in the browser.
export * from "./types";
export * from "./copy";
export { LEAN_THRESHOLD, ageLeanWord, fansLeanTitle, genderLeanWord, peakAge, positiveAgeSpan, signed, type AgeBand } from "./dna";
export { datasetOf, formatValue, moreChartName, moreCharts, selectFigures, shapeChart, type ChartContext, type ChartSlot } from "./charts";
export { marketState } from "./markets";
export { KEY_NUMBER_MAX, buildKeyNumbers } from "./key-numbers";
export {
  answerArea,
  answerLayout,
  answerPlace,
  answerSubjects,
  areaName,
  buildAnswerModel,
  buildChanges,
  buildGhost,
  buildSteps,
  headlineWithPeriod,
  layoutRows,
  type AnswerLayout,
  type BuildAnswerOptions,
} from "./build";
