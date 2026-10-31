// Home (Ledger A): the statement, the question box with its suggestion list, "Understood as" line and
// inline states, the visitor's recent answers and how every answer is made. /ask renders the same view.
export { AskBox } from "./ask-box";
export type { AskBoxProps } from "./ask-box";
export { AskNoticeView, DAILY_CAP_TEXT, isDailyCap, PLAN_HREF } from "./ask-notice";
export type { AskNoticeViewProps } from "./ask-notice";
export { HOW_ITEMS, HowBand } from "./how-band";
export { FOLLOW_UP_SUBLINE, FOLLOW_UP_TITLE, HERO_LINES, HERO_SUBLINE, HomeView } from "./home-view";
export type { HomeViewProps } from "./home-view";
export { RECENT_ANSWERS_MAX, RecentAnswers } from "./recent-answers";
export { UnderstoodLine, understoodParts } from "./understood-line";
export type { UnderstoodParts } from "./understood-line";
export { QUESTION_PLACEHOLDER, QuestionBox, questionKeyAction, questionText } from "./question-box";
export type { QuestionBoxProps, QuestionBoxState, QuestionCombobox, QuestionKey } from "./question-box";
export { SuggestionList, suggestionOptionId } from "./suggestion-list";
export type { SuggestionListProps } from "./suggestion-list";
export { looksLikeName, moveActive, PLACE_HINT, SUGGEST_MIN_CHARS, suggestionRows, suggestionsFor } from "./suggestions";
export type { Suggestion, SuggestionGroup } from "./suggestions";
export { TestRunButton } from "./test-run-button";
export type { TestRunButtonProps } from "./test-run-button";
