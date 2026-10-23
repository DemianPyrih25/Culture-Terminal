import Link from "next/link";
import type { ReactNode } from "react";
import { ROUTE_LIVE } from "../../lib/routes";
import { PAGE_GUTTER } from "../layout/grid";
import { cx } from "../ui/cx";

export type NavKey = "briefs" | "following" | "method";

export interface NavItem {
  key: NavKey;
  label: string;
  href: string;
}

/** The top bar's sections, in order. */
export const TOP_NAV: readonly NavItem[] = [
  { key: "briefs", label: "Briefs", href: "/briefs" },
  { key: "following", label: "Following", href: "/following" },
  { key: "method", label: "Method", href: "/method" },
];

/**
 * Which sections have a page yet (ROUTE_LIVE); the rest render visibly disabled (a link role with
 * aria-disabled and a spoken "not available yet"). Pages override this with `enabled`.
 */
export const NAV_ENABLED: Readonly<Record<NavKey, boolean>> = { briefs: true, following: ROUTE_LIVE.following, method: ROUTE_LIVE.method };

export interface TopBarProps {
  /** The centred command slot, usually a connected <CommandField>. */
  command?: ReactNode;
  /** The section the page belongs to; it carries the accent underline. */
  active?: NavKey | null;
  /** Overrides NAV_ENABLED per section. */
  enabled?: Partial<Record<NavKey, boolean>>;
  /** Sticks to the viewport top from 768 px up (default true). */
  sticky?: boolean;
  className?: string;
}

/**
 * A/Top bar: 56 px on canvas. The CULTURE TERMINAL wordmark links home, the command field sits centred,
 * and Briefs · Following · Method sit right, the active one underlined in accent. There are no accounts,
 * so there is no avatar. Below 768 px the command field takes a second row.
 */
export function TopBar({ command, active = null, enabled, sticky = true, className }: TopBarProps) {
  const on = { ...NAV_ENABLED, ...enabled };
  return (
    <header
      className={cx(
        "z-30 grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-line bg-canvas md:gap-x-6",
        "md:h-14 md:grid-cols-[minmax(max-content,1fr)_minmax(0,520px)_minmax(max-content,1fr)]",
        PAGE_GUTTER,
        sticky && "md:sticky md:top-0",
        className,
      )}
    >
      <Link
        href="/"
        className="h-14 min-w-0 self-start truncate text-[12px] leading-[56px] font-semibold tracking-[2.4px] whitespace-nowrap text-ink uppercase max-md:text-[11px] max-md:tracking-[1.4px] md:self-auto"
      >
        Culture Terminal
      </Link>
      <div className="col-span-2 row-start-2 min-w-0 pb-3 md:col-span-1 md:col-start-2 md:row-start-1 md:pb-0">
        {command}
      </div>
      <nav aria-label="Main" className="flex h-14 items-stretch justify-end gap-3 self-stretch md:col-start-3 md:gap-7">
        {TOP_NAV.map((item) => {
          const isActive = item.key === active;
          const base = "-mb-px flex items-center border-b-2 text-[13px] leading-none font-medium whitespace-nowrap";
          if (!on[item.key]) {
            // A link without a destination: announced as a disabled link with its reason, and out of the
            // tab order so the keyboard never stops on a dead end.
            return (
              <a
                key={item.key}
                role="link"
                aria-disabled="true"
                title={`${item.label} is not available yet`}
                data-nav={item.key}
                className={cx(base, "cursor-not-allowed border-transparent text-faint")}
              >
                {item.label}
                <span className="sr-only"> (not available yet)</span>
              </a>
            );
          }
          return (
            <Link
              key={item.key}
              href={item.href}
              data-nav={item.key}
              aria-current={isActive ? "page" : undefined}
              className={cx(
                base,
                "focus-visible:-outline-offset-2",
                isActive ? "border-accent text-ink" : "border-transparent text-text-2 hover:text-ink",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </header>
  );
}
