// Where the chrome links go. The question box on Home carries the id ASK_FIELD_ID; Home focuses it when
// the URL hash is #ask, so "New question" from any page lands with the caret in the box.

/** The id of the element holding Home's question field (the field itself or a wrapper around it). */
export const ASK_FIELD_ID = "ask";

/** "New question": Home with the question box focused. */
export const NEW_QUESTION_HREF = `/#${ASK_FIELD_ID}`;

/** The visitor's own answers. */
export const ANSWERS_HREF = "/briefs";

/** The visitor's followed brands, places and questions (§2.4). */
export const FOLLOWING_HREF = "/following";

/** The brand screener (§5.5). */
export const SCREENER_HREF = "/screener";

export const HOW_IT_WORKS_HREF = "/how-it-works";

/** The header's sections, in order. */
export type NavKey = "answers" | "following" | "screener" | "how";

export interface NavItem {
  key: NavKey;
  label: string;
  href: string;
}

export const SITE_NAV: readonly NavItem[] = [
  { key: "answers", label: "Your answers", href: ANSWERS_HREF },
  { key: "following", label: "Following", href: FOLLOWING_HREF },
  { key: "screener", label: "Screener", href: SCREENER_HREF },
  { key: "how", label: "How it works", href: HOW_IT_WORKS_HREF },
];
