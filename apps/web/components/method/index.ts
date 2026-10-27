// /method (the analysts' reference) and /how-it-works. Server components and pure helpers.
export { MethodView } from "./method-view";
export type { MethodViewProps } from "./method-view";
export { HowItWorksView, Bullets } from "./how-it-works-view";
export { RulesSections, RULES_INDEX, audienceLabel, familyLabel } from "./rules-sections";
export type { AudienceAllowlistView, RulesFacts } from "./rules-sections";
export { Colophon, REFERENCE_ANCHOR, ReferenceLayout, RefNote, RefSection, TermList } from "./reference";
export type { ColophonRow, IndexItem, RefNoteProps, RefSectionProps } from "./reference";
export { TexFormula, parseTex, texClauses, texToText } from "./tex";
export type { TexFormulaProps, TexNode } from "./tex";
export { EvalMetric, EvalSummary, EvalUnit, formatEvalValue, parseEvalSummary } from "./eval-summary";
export type { EvalState } from "./eval-summary";
export { bandRanges, endpointLabel, modelLabel, penaltyText, windowEndMonth } from "./facts";
