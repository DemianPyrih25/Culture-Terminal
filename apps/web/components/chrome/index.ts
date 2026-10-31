// Page chrome (design/redesign-v3.pen, Ledger): the header (the desktop sidebar, the phone bar and the menu
// sheet), the footer, the page head, the logo mark and the page shell.
export { Footer } from "./footer";
export { Header, PAGE_COLUMN } from "./header";
export type { HeaderProps, HeaderVariant, MobileHeaderVariant } from "./header";
export {
  BackButton,
  focusAskField,
  MenuSheetButton,
  NewQuestionLink,
  ShareIconButton,
  ShellAccount,
  SidebarNav,
  SidebarRecent,
  SlashShortcut,
  useShareLink,
} from "./header-actions";
export type { MenuItem } from "./header-actions";
export {
  ANSWERS_HREF,
  ASK_FIELD_ID,
  ASK_HREF,
  FOLLOWING_HREF,
  HOW_IT_WORKS_HREF,
  METHOD_HREF,
  navKeyForPath,
  NEW_QUESTION_HREF,
  PROFILES_HREF,
  SCREENER_HREF,
  SETTINGS_HREF,
  SITE_LINKS,
  SITE_NAV,
  STATUS_HREF,
} from "./links";
export type { NavItem, NavKey } from "./links";
export { InitialMark, LogoMark } from "./logo-mark";
export { PageHead } from "./page-head";
export type { PageHeadProps } from "./page-head";
export { SiteShell } from "./site-shell";
export type { SiteShellProps } from "./site-shell";
