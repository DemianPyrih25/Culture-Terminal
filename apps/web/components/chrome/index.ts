// Page chrome (design/redesign.pen, N·C Components): the header (desktop and phone variants, the menu
// sheet), the footer, the page head, the logo mark and the page shell.
export { Footer } from "./footer";
export { Header, PAGE_COLUMN } from "./header";
export type { HeaderProps, HeaderVariant, MobileHeaderVariant } from "./header";
export { BackButton, focusAskField, MenuSheetButton, NewQuestionLink, ShareIconButton, useShareLink } from "./header-actions";
export type { MenuItem } from "./header-actions";
export { ANSWERS_HREF, ASK_FIELD_ID, HOW_IT_WORKS_HREF, NEW_QUESTION_HREF, SITE_NAV } from "./links";
export type { NavItem, NavKey } from "./links";
export { LogoMark } from "./logo-mark";
export { PageHead } from "./page-head";
export type { PageHeadProps } from "./page-head";
export { SiteShell } from "./site-shell";
export type { SiteShellProps } from "./site-shell";
