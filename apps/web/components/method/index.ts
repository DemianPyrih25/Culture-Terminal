// /method (A11 · Method & sources) and the reference-page layout /trust shares. Server components and
// pure helpers; the outline is the one client part.
export { MethodView } from "./method-view";
export type { MethodViewProps } from "./method-view";
export {
  Colophon,
  NoteRef,
  REFERENCE_ANCHOR,
  REFERENCE_STICKY_TOP,
  ReferenceChrome,
  ReferenceGrid,
  ReferenceHead,
  SideNote,
  SideNotes,
  TraceNote,
  noteId,
} from "./reference";
export type { ColophonRow, ReferenceChromeProps, ReferenceGridProps, ReferenceHeadProps, SideNoteProps, TraceNoteProps } from "./reference";
export { TexFormula, parseTex, texClauses, texToText } from "./tex";
export type { TexFormulaProps, TexNode } from "./tex";
export { EvalMetric, EvalSummary, EvalUnit, formatEvalValue, parseEvalSummary } from "./eval-summary";
export type { EvalState } from "./eval-summary";
export { bandRanges, endpointLabel, modelLabel, penaltyText, windowEndMonth } from "./facts";
