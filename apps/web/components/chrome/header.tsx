import Link from "next/link";
import { buttonClassName } from "../ui/button";
import { cx } from "../ui/cx";
import { Icon } from "../ui/icons";
import {
  BackButton,
  MenuSheetButton,
  NewQuestionLink,
  ShareIconButton,
  ShellAccount,
  SidebarNav,
  SidebarRecent,
  SlashShortcut,
  type MenuItem,
} from "./header-actions";
import { ANSWERS_HREF, SETTINGS_HREF, SITE_LINKS, type NavKey } from "./links";
import { InitialMark } from "./logo-mark";

/** home and working: sections only. inner: sections and the "New question" button. */
export type HeaderVariant = "home" | "inner" | "working";
/** default: logo, wordmark and the menu. answer: back and logo; share and the menu. */
export type MobileHeaderVariant = "default" | "answer";

export interface HeaderProps {
  variant?: HeaderVariant;
  /** The section the page belongs to (aria-current); default the one its path belongs to. */
  active?: NavKey | null;
  mobile?: MobileHeaderVariant;
  /** Phone answer bar: where back goes without history (default Your answers). */
  backHref?: string;
  /** Phone answer bar: the path Share copies (default the current URL). */
  sharePath?: string;
  /** Extra rows of the phone menu (answer pages: Share, Watch it being made). */
  menuItems?: readonly MenuItem[];
}

/** The page column: 1128 centred, with 24 px gutters below 1176 and 16 on phones. */
export const PAGE_COLUMN = "mx-auto w-full max-w-[1176px] px-6 max-md:px-4";

function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className={cx("flex min-w-0 items-center rounded-sm", compact ? "h-11 gap-2" : "gap-2.5")}>
      <InitialMark size={compact ? 24 : 22} />
      <span
        className={cx(
          "truncate font-display tracking-[-0.01em] text-ink",
          compact ? "text-[18px] leading-6 font-semibold" : "text-[16px] leading-5 font-medium",
        )}
      >
        Culture Terminal
      </span>
    </Link>
  );
}

/**
 * The app shell's navigation (Ledger). From 1024 px: a 232 px sidebar, sticky and full height, on surface
 * with a hairline right rule: the wordmark, "New question" on inner pages, the sections, and Settings,
 * Method and Status at the foot. Below 1024 px: a 56 px top bar with the wordmark and the menu sheet, or
 * the answer variant with back and share.
 */
export function Header({ variant = "inner", active: named, mobile = "default", backHref = ANSWERS_HREF, sharePath, menuItems }: HeaderProps) {
  // Home's variant is the Ask section; other pages name theirs or take it from their path.
  const active = named === undefined && variant === "home" ? "ask" : named;
  return (
    <header
      data-header={variant}
      className="shrink-0 border-b border-line bg-canvas lg:sticky lg:top-0 lg:h-dvh lg:w-[240px] lg:border-r lg:border-b-0 lg:bg-[#fbf9f5]"
    >
      <div className="flex h-full flex-col overflow-y-auto px-3 pt-4 pb-4 max-lg:hidden">
        <div className="px-2 pt-0.5 pb-3.5">
          <Wordmark />
        </div>
        {variant === "inner" ? (
          <NewQuestionLink shortcut className={buttonClassName("primary", "md", "mb-2.5 w-full justify-start font-semibold [&>svg]:size-[15px]")} />
        ) : null}
        <SlashShortcut />
        <SidebarNav active={active} />
        <SidebarRecent />
        <div className="mt-auto flex flex-col gap-2 pt-6">
          <p className="flex flex-wrap gap-x-4 gap-y-1 px-2.5 type-caption text-ink-2">
            {SITE_LINKS.map((link) =>
              link.href === SETTINGS_HREF ? (
                <Link key={link.href} href={link.href} className="inline-flex items-center gap-1.5 rounded-sm font-medium hover:text-ink">
                  <Icon name="user-round" size={13} className="text-ink-3" />
                  {link.label}
                </Link>
              ) : (
                <Link key={link.href} href={link.href} className="rounded-sm hover:text-ink">
                  {link.label}
                </Link>
              ),
            )}
          </p>
          <ShellAccount />
        </div>
      </div>
      {mobile === "answer" ? (
        <div className="flex h-[52px] items-center justify-between pr-2.5 pl-1 lg:hidden">
          <div className="flex items-center gap-1">
            <BackButton href={backHref} />
            <Link href="/" aria-label="Culture Terminal home" className="inline-flex size-11 items-center justify-center rounded-sm">
              <InitialMark size={24} />
            </Link>
          </div>
          <div className="flex items-center">
            <ShareIconButton path={sharePath} />
            <MenuSheetButton active={active} items={menuItems} />
          </div>
        </div>
      ) : (
        <div className="flex h-[52px] items-center justify-between gap-3 pr-1.5 pl-5 max-md:pl-4 lg:hidden">
          <Wordmark compact />
          <MenuSheetButton active={active} items={menuItems} />
        </div>
      )}
    </header>
  );
}
