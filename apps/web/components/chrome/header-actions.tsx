"use client";

// The chrome's interactive parts: the "New question" link, the sidebar's section links, the phone bar's
// back and share buttons, and the phone menu sheet.
import Link from "next/link";
import { useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { buttonClassName, IconButton } from "../ui/button";
import { absoluteUrl, copyText } from "../ui/clipboard";
import { cx } from "../ui/cx";
import { DrawerShell } from "../ui/drawer-shell";
import { Icon, type IconName } from "../ui/icons";
import { useToast } from "../ui/toast";
import { ASK_FIELD_ID, navKeyForPath, NEW_QUESTION_HREF, SITE_LINKS, SITE_NAV, type NavKey } from "./links";

/** Puts the caret in Home's question box when it is on this page; true when it did. */
export function focusAskField(): boolean {
  const holder = document.getElementById(ASK_FIELD_ID);
  const field =
    holder instanceof HTMLTextAreaElement || holder instanceof HTMLInputElement
      ? holder
      : holder?.querySelector<HTMLElement>("textarea, input");
  if (!field) return false;
  field.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  field.focus({ preventScroll: true });
  return true;
}

/**
 * "New question": on Home it focuses the box in place; elsewhere it goes to Home with #ask, where the box
 * takes focus. A plain link without JavaScript.
 */
export function NewQuestionLink({ className, onNavigate }: { className?: string; onNavigate?: () => void }) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    onNavigate?.();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    if (focusAskField()) event.preventDefault();
  }
  return (
    <Link href={NEW_QUESTION_HREF} onClick={onClick} className={className ?? buttonClassName("secondary", "md")}>
      <Icon name="plus" size={18} />
      <span>New question</span>
    </Link>
  );
}

/** The phone answer header's back button: history back when the visitor came from this site, else `href`. */
export function BackButton({ href }: { href: string }) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    let sameSite = false;
    try {
      sameSite = document.referrer !== "" && new URL(document.referrer).origin === window.location.origin;
    } catch {
      sameSite = false;
    }
    if (sameSite && window.history.length > 1) {
      event.preventDefault();
      // The browser's own back: the app router follows popstate.
      window.history.back();
    }
  }
  return (
    <Link
      href={href}
      onClick={onClick}
      aria-label="Back"
      className="inline-flex size-11 shrink-0 items-center justify-center rounded-chip text-ink-2 transition-colors hover:bg-sunken hover:text-ink"
    >
      <Icon name="chevron-left" size={20} />
    </Link>
  );
}

/** Copies the page's link (or `path`'s) and shows "Link copied". */
export function useShareLink(path?: string): { share: () => void; toast: ReactNode } {
  const { show, toast } = useToast();
  const share = () => {
    const url = absoluteUrl(path ?? window.location.pathname + window.location.search);
    void copyText(url).then((ok) => show(ok ? "Link copied" : "Couldn't copy the link"));
  };
  return { share, toast };
}

/** The phone answer header's share button. */
export function ShareIconButton({ path }: { path?: string }) {
  const { share, toast } = useShareLink(path);
  return (
    <>
      <IconButton label="Share" icon="share-2" size="lg" onClick={share} />
      {toast}
    </>
  );
}

/** An extra row of the phone menu: a link, the copy-link action (`share`) or an action of the page (`onSelect`). */
export interface MenuItem {
  label: string;
  icon: IconName;
  href?: string;
  /** Copies this path's link instead of navigating. */
  share?: string | true;
  /** Runs after the sheet closes, e.g. opening the page's own drawer. Client components only. */
  onSelect?: () => void;
}

const NAV_ICON = {
  ask: "message-square-text",
  answers: "file-text",
  following: "list-checks",
  screener: "table-2",
  profiles: "users",
  how: "circle-question-mark",
} as const satisfies Record<NavKey, IconName>;

function subscribeToHistory(onChange: () => void): () => void {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

/**
 * The page's section: the one it names, else the one its path belongs to. Read from the location after
 * hydration (the server marks only a named section), so pages such as /d need not pass one.
 */
function useActiveKey(active: NavKey | null | undefined): NavKey | null {
  const path = useSyncExternalStore(
    subscribeToHistory,
    () => window.location.pathname,
    () => null,
  );
  return active === undefined ? navKeyForPath(path) : active;
}

const SIDE_ROW = "flex h-9 items-center gap-2.5 rounded-control px-2.5 text-[14px] leading-5 transition-colors";

/** The sidebar's sections (aria-label "Main"): the current one in the accent on its tint. */
export function SidebarNav({ active }: { active?: NavKey | null }) {
  const current = useActiveKey(active);
  return (
    <nav aria-label="Main">
      <ul className="flex flex-col gap-0.5">
        {SITE_NAV.map((item) => {
          const on = item.key === current;
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                data-nav={item.key}
                aria-current={on ? "page" : undefined}
                className={cx(SIDE_ROW, on ? "bg-accent-soft font-semibold text-accent" : "font-medium text-ink-2 hover:bg-sunken hover:text-ink")}
              >
                <Icon name={NAV_ICON[item.key]} size={16} className={on ? "text-accent" : "text-ink-3"} />
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

const ROW =
  "flex h-12 w-full items-center gap-3 rounded-control px-3 text-left text-[15px] leading-6 font-medium text-ink transition-colors hover:bg-sunken";

/**
 * The phone menu: a full-height sheet with Ask, Your answers, Following, Screener, Profiles and How it works,
 * the primary "New question", the page's extras, then Settings, Method and Status.
 */
export function MenuSheetButton({ active, items = [] }: { active?: NavKey | null; items?: readonly MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  const current = useActiveKey(active);
  const shareItem = items.find((i) => i.share !== undefined);
  const { share, toast } = useShareLink(typeof shareItem?.share === "string" ? shareItem.share : undefined);
  return (
    <>
      <IconButton label="Menu" icon="menu" size="lg" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)} />
      <DrawerShell open={open} onClose={close} title="Menu" width={320}>
        <nav aria-label="Menu" className="flex flex-col gap-6">
          <ul className="flex flex-col gap-0.5">
            {SITE_NAV.map((item) => (
              <li key={item.key}>
                <Link
                  href={item.href}
                  onClick={close}
                  aria-current={item.key === current ? "page" : undefined}
                  className={cx(ROW, item.key === current && "bg-accent-soft font-semibold text-accent")}
                >
                  <Icon name={NAV_ICON[item.key]} size={18} className={item.key === current ? "text-accent" : "text-ink-3"} />
                  {item.label}
                </Link>
              </li>
            ))}
          </ul>
          <NewQuestionLink onNavigate={close} className={buttonClassName("primary", "lg", "w-full justify-center")} />
          {items.length > 0 ? (
            <ul className="flex flex-col gap-0.5 border-t border-line pt-4">
              {items.map((item) => (
                <li key={item.label}>
                  {item.share !== undefined ? (
                    <button
                      type="button"
                      className={ROW}
                      onClick={() => {
                        close();
                        share();
                      }}
                    >
                      <Icon name={item.icon} size={18} className="text-ink-3" />
                      {item.label}
                    </button>
                  ) : item.onSelect ? (
                    <button
                      type="button"
                      className={ROW}
                      onClick={() => {
                        close();
                        item.onSelect?.();
                      }}
                    >
                      <Icon name={item.icon} size={18} className="text-ink-3" />
                      {item.label}
                    </button>
                  ) : (
                    <Link href={item.href ?? "/"} onClick={close} className={ROW}>
                      <Icon name={item.icon} size={18} className="text-ink-3" />
                      {item.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          ) : null}
          <ul className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line pt-4">
            {SITE_LINKS.map((link) => (
              <li key={link.href}>
                <Link href={link.href} onClick={close} className="rounded-sm type-label text-ink-2 hover:text-ink">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </DrawerShell>
      {shareItem ? toast : null}
    </>
  );
}
