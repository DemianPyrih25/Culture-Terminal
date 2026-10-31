// Where the chrome links go. The question box on Home carries the id ASK_FIELD_ID; Home focuses it when
// the URL hash is #ask, so "New question" from any page lands with the caret in the box.

/** The id of the element holding Home's question field (the field itself or a wrapper around it). */
export const ASK_FIELD_ID = "ask";

/** Home: the question box (signed-in visitors; "/" is the landing page). */
export const ASK_HREF = "/home";

/** "New question": Home with the question box focused. */
export const NEW_QUESTION_HREF = `${ASK_HREF}#${ASK_FIELD_ID}`;

/** The visitor's own answers. */
export const ANSWERS_HREF = "/briefs";

/** The visitor's followed brands, places and questions (§2.4). */
export const FOLLOWING_HREF = "/following";

/** The brand screener (§5.5). */
export const SCREENER_HREF = "/screener";

/** Look up an audience profile. */
export const PROFILES_HREF = "/d";

export const HOW_IT_WORKS_HREF = "/how-it-works";

/** Every formula and rule. */
export const METHOD_HREF = "/method";

/** Operations status. */
export const STATUS_HREF = "/status";

/** Account settings, plan and usage: the only place limits are shown. */
export const SETTINGS_HREF = "/settings";

/** The sidebar's sections, in order. */
export type NavKey = "ask" | "answers" | "following" | "screener" | "profiles" | "how";

export interface NavItem {
  key: NavKey;
  label: string;
  href: string;
}

export const SITE_NAV: readonly NavItem[] = [
  { key: "ask", label: "Ask", href: ASK_HREF },
  { key: "answers", label: "Your answers", href: ANSWERS_HREF },
  { key: "following", label: "Following", href: FOLLOWING_HREF },
  { key: "screener", label: "Screener", href: SCREENER_HREF },
  { key: "profiles", label: "Profiles", href: PROFILES_HREF },
  { key: "how", label: "How it works", href: HOW_IT_WORKS_HREF },
];

/** The quiet links at the foot of the sidebar and the menu sheet. */
export const SITE_LINKS: readonly { label: string; href: string }[] = [
  { label: "Settings", href: SETTINGS_HREF },
  { label: "Method", href: METHOD_HREF },
  { label: "Status", href: STATUS_HREF },
];

/** The section a path belongs to, for pages that do not name one. /method counts as How it works. */
export function navKeyForPath(path: string | null | undefined): NavKey | null {
  if (!path) return null;
  if (path === "/" || path === ASK_HREF || path === "/ask") return "ask";
  if (path.startsWith(ANSWERS_HREF)) return "answers";
  if (path.startsWith(FOLLOWING_HREF)) return "following";
  if (path.startsWith(SCREENER_HREF)) return "screener";
  if (path === PROFILES_HREF || path.startsWith(`${PROFILES_HREF}/`)) return "profiles";
  if (path.startsWith(HOW_IT_WORKS_HREF) || path.startsWith(METHOD_HREF)) return "how";
  return null;
}
