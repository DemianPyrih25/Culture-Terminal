// Home (N01, N02, N17): the hero, the question box with its suggestion list and inline states, and the
// how band. /ask renders the same view.
export { AskBox } from "./ask-box";
export type { AskBoxProps } from "./ask-box";
export { AskNoticeView } from "./ask-notice";
export type { AskNoticeViewProps } from "./ask-notice";
export { HOW_ITEMS, HowBand } from "./how-band";
export { HERO_LINES, HERO_SUBLINE, HomeView } from "./home-view";
export type { HomeViewProps } from "./home-view";
export { QUESTION_PLACEHOLDER, QuestionBox, questionKeyAction, questionText } from "./question-box";
export type { QuestionBoxProps, QuestionBoxState, QuestionCombobox, QuestionKey } from "./question-box";
export { SuggestionList, suggestionOptionId } from "./suggestion-list";
export type { SuggestionListProps } from "./suggestion-list";
export { looksLikeName, moveActive, PLACE_HINT, SUGGEST_MIN_CHARS, suggestionRows, suggestionsFor } from "./suggestions";
export type { Suggestion, SuggestionGroup } from "./suggestions";
export { TestRunButton } from "./test-run-button";
export type { TestRunButtonProps } from "./test-run-button";
