import type { ReactNode } from "react";
import { cx } from "../ui/cx";
import { Footer } from "./footer";
import { Header, PAGE_COLUMN, type HeaderProps } from "./header";

export interface SiteShellProps extends Omit<HeaderProps, "variant" | "mobile"> {
  /** The header variant (default inner). */
  header?: HeaderProps["variant"];
  /** The phone header (default default). */
  mobileHeader?: HeaderProps["mobile"];
  /** Classes for <main> (padding, gaps). */
  mainClassName?: string;
  /** full: main is not held to the 1128 column (pages that lay out their own width). */
  width?: "page" | "full";
  children: ReactNode;
}

/**
 * Every page: canvas, the Header, a centred 1128 main and the Footer. A skip link jumps to the main content.
 */
export function SiteShell({
  header = "inner",
  mobileHeader = "default",
  active,
  backHref,
  sharePath,
  menuItems,
  mainClassName,
  width = "page",
  children,
}: SiteShellProps) {
  return (
    <div className="flex min-h-full flex-1 flex-col bg-canvas">
      <a
        href="#main"
        className="sr-only z-50 rounded-control bg-surface px-4 py-2 text-[15px] font-medium text-ink shadow-md focus:not-sr-only focus:fixed focus:top-3 focus:left-3"
      >
        Skip to content
      </a>
      <Header
        variant={header}
        mobile={mobileHeader}
        active={active}
        backHref={backHref}
        sharePath={sharePath}
        menuItems={menuItems}
      />
      <main id="main" tabIndex={-1} className={cx("flex-1 outline-none", width === "page" && PAGE_COLUMN, mainClassName)}>
        {children}
      </main>
      <Footer />
    </div>
  );
}
