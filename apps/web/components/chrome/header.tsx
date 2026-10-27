import Link from "next/link";
import { cx } from "../ui/cx";
import { BackButton, MenuSheetButton, NewQuestionLink, ShareIconButton, type MenuItem } from "./header-actions";
import { ANSWERS_HREF, SITE_NAV, type NavKey } from "./links";
import { LogoMark } from "./logo-mark";

/** home and working: links only. inner: links and the "New question" button. */
export type HeaderVariant = "home" | "inner" | "working";
/** default: logo, wordmark and the menu. answer: back and logo; share and the menu. */
export type MobileHeaderVariant = "default" | "answer";

export interface HeaderProps {
  variant?: HeaderVariant;
  /** The section the page belongs to (aria-current, 15/600 ink). */
  active?: NavKey | null;
  mobile?: MobileHeaderVariant;
  /** Phone answer header: where back goes without history (default Your answers). */
  backHref?: string;
  /** Phone answer header: the path Share copies (default the current URL). */
  sharePath?: string;
  /** Extra rows of the phone menu (answer pages: Share, Watch it being made). */
  menuItems?: readonly MenuItem[];
}

/** The page column: 1128 centred, with 24 px gutters below 1176 and 16 on phones. */
export const PAGE_COLUMN = "mx-auto w-full max-w-[1176px] px-6 max-md:px-4";

function Wordmark({ compact = false }: { compact?: boolean }) {
  return (
    <Link href="/" className={cx("flex min-w-0 items-center gap-2.5 rounded-sm", compact && "h-11")}>
      <LogoMark size={compact ? 20 : 22} />
      <span className={cx("truncate font-semibold text-ink", compact ? "text-[15px] leading-5" : "text-[16px] leading-6")}>
        Culture Terminal
      </span>
    </Link>
  );
}

/**
 * C/Header: 64 tall (the 1 px line included) on surface. The wordmark left; Your answers and How it
 * works right (gap 28), and on inner pages the secondary "New question". Below 768 px it is the 56 px
 * phone header with the menu sheet, or the answer variant with back and share.
 */
export function Header({ variant = "inner", active = null, mobile = "default", backHref = ANSWERS_HREF, sharePath, menuItems }: HeaderProps) {
  return (
    <header data-header={variant} className="border-b border-line bg-surface">
      <div className={cx(PAGE_COLUMN, "flex h-[63px] items-center justify-between gap-6 max-md:hidden")}>
        <Wordmark />
        <div className="flex items-center gap-5">
          <nav aria-label="Main" className="flex items-center gap-7">
            {SITE_NAV.map((item) => {
              const on = item.key === active;
              return (
                <Link
                  key={item.key}
                  href={item.href}
                  data-nav={item.key}
                  aria-current={on ? "page" : undefined}
                  className={cx(
                    "rounded-sm text-[15px] leading-5 whitespace-nowrap transition-colors",
                    on ? "font-semibold text-ink" : "font-medium text-ink-2 hover:text-ink",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
          {variant === "inner" ? <NewQuestionLink /> : null}
        </div>
      </div>
      {mobile === "answer" ? (
        <div className="flex h-[55px] items-center justify-between pr-3 pl-1 md:hidden">
          <div className="flex items-center gap-1">
            <BackButton href={backHref} />
            <Link href="/" aria-label="Culture Terminal home" className="inline-flex size-11 items-center justify-center rounded-sm">
              <LogoMark size={20} />
            </Link>
          </div>
          <div className="flex items-center">
            <ShareIconButton path={sharePath} />
            <MenuSheetButton active={active} items={menuItems} />
          </div>
        </div>
      ) : (
        <div className="flex h-[55px] items-center justify-between gap-3 pr-2 pl-4 md:hidden">
          <Wordmark compact />
          <MenuSheetButton active={active} items={menuItems} />
        </div>
      )}
    </header>
  );
}
