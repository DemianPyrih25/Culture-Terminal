import { MAP_CITIES, wordList } from "../../lib/answer/copy";
import { cleanDesName, desHref } from "../des/des-href";
import type { IconName } from "../ui/icons";
import type { TagPreset } from "../ui/tag";

/**
 * What the suggestion list under the question box offers while the visitor types (N02). Pure, so it is
 * tested without a browser. There are no canned or example questions: the only row is the instant
 * audience profile of a name the visitor typed, and the list stays closed for anything that reads as a
 * question.
 */

export interface Suggestion {
  /** Stable within the list, for aria-activedescendant. */
  key: string;
  label: string;
  href: string;
  tag: TagPreset;
}

export interface SuggestionGroup {
  key: "profile";
  label: string;
  icon: IconName;
  rows: Suggestion[];
}

/** Characters typed before the list opens. */
export const SUGGEST_MIN_CHARS = 2;

/** Words a question starts with: such text is asked, not looked up. */
const QUESTION_WORDS = new Set(["who", "what", "where", "which", "how", "why", "is", "are", "does", "do", "can", "should"]);

/** Most words a name can have before the text reads as a question. */
const NAME_MAX_WORDS = 4;

/** Whether the text reads as a name: no "?", at most four words, and no leading question word. */
export function looksLikeName(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < SUGGEST_MIN_CHARS || trimmed.includes("?")) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > NAME_MAX_WORDS) return false;
  return !QUESTION_WORDS.has((words[0] ?? "").toLowerCase());
}

/** The groups for what is typed; empty when the list stays closed. */
export function suggestionsFor(text: string): SuggestionGroup[] {
  if (!looksLikeName(text)) return [];
  const name = cleanDesName(text);
  if (name === null) return [];
  return [
    {
      key: "profile",
      label: "Profile",
      icon: "user-round",
      rows: [{ key: "profile-0", label: `${name} · audience profile`, href: desHref({ name, type: "brand" }), tag: "instant" }],
    },
  ];
}

/** Every row of the groups, in order: the list's arrow keys walk this. */
export function suggestionRows(groups: readonly SuggestionGroup[]): Suggestion[] {
  return groups.flatMap((g) => g.rows);
}

/** "Place questions cover 13 US cities: Atlanta, Austin, … and Seattle." */
export const PLACE_HINT = `Place questions cover ${MAP_CITIES.length} US cities: ${wordList(MAP_CITIES, "and")}.`;

/** The active row after an arrow key: down from none is the first, and both ends wrap. */
export function moveActive(active: number, count: number, key: "ArrowDown" | "ArrowUp"): number {
  if (count === 0) return -1;
  if (key === "ArrowDown") return active < 0 || active >= count - 1 ? 0 : active + 1;
  return active <= 0 ? count - 1 : active - 1;
}
