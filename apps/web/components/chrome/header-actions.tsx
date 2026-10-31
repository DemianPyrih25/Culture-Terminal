"use client";

// The chrome's interactive parts: the "New question" link and its "/" key, the sidebar's section links and
// recent answers, the phone bar's back and share buttons, and the phone menu sheet.
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type MouseEvent, type ReactNode } from "react";
import { readRecentRunIds } from "../../lib/recent-briefs";
import { SignOutButton } from "../account/sign-out-button";
import { loadYourAnswers, type AnswerItem } from "../library/answers";
import { buttonClassName, IconButton } from "../ui/button";
import { absoluteUrl, copyText } from "../ui/clipboard";
import { cx } from "../ui/cx";
import { DrawerShell } from "../ui/drawer-shell";
import { Icon, type IconName } from "../ui/icons";
import { isTextField } from "../ui/shortcut";
import { useToast } from "../ui/toast";
import { ANSWERS_HREF, ASK_FIELD_ID, navKeyForPath, NEW_QUESTION_HREF, SITE_LINKS, SITE_NAV, type NavKey } from "./links";

/** Puts the caret in Home's question box when it is on this page; true when it did. */
export function focusAskField(): boolean {
  const holder = document.getElementById(ASK_FIELD_ID);
  const field =
    holder instanceof HTMLTextAreaElement || holder instanceof HTMLInputElement ? holder : holder?.querySelector<HTMLElement>("textarea, input");
  if (!field) return false;
  field.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  field.focus({ preventScroll: true });
  return true;
}

/**
 * "New question": on Home it focuses the box in place; elsewhere it goes to Home with #ask, where the box
 * takes focus. A plain link without JavaScript.
 */
export function NewQuestionLink({ className, onNavigate, shortcut = false }: { className?: string; onNavigate?: () => void; shortcut?: boolean }) {
  function onClick(event: MouseEvent<HTMLAnchorElement>) {
    onNavigate?.();
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    if (focusAskField()) event.preventDefault();
  }
  return (
    <Link href={NEW_QUESTION_HREF} onClick={onClick} className={className ?? buttonClassName("secondary", "md")}>
      <Icon name="plus" size={18} />
      <span>New question</span>
      {shortcut ? (
        <kbd
          aria-hidden="true"
          className="ml-auto rounded-[3px] bg-white/15 px-[5px] py-px font-mono text-[10px] leading-[13px] font-normal text-white"
        >
          /
        </kbd>
      ) : null}
    </Link>
  );
}

/**
 * The "/" key: puts the caret in the question box from anywhere outside a text field (on Home in place,
 * elsewhere by going to Home's box). Mounted once, in the desktop sidebar.
 */
export function SlashShortcut() {
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented || event.isComposing) return;
      if (isTextField(document.activeElement as HTMLElement | null)) return;
      event.preventDefault();
      if (!focusAskField()) window.location.assign(NEW_QUESTION_HREF);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return null;
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

const SIDE_ROW = "flex h-[34px] items-center gap-2.5 rounded-sm px-2.5 text-[13px] leading-4 transition-colors";

/** How many items the visitor follows, once the tab has read them (null before, or on an error). */
function useFollowCount(): number | null {
  const [count, setCount] = useState<number | null>(null);
  useEffect(() => {
    // Loaded on demand: the follows client carries zod, which Home's first bundle leaves out.
    let unsubscribe: (() => void) | undefined;
    let live = true;
    void import("../following/client").then(({ sharedFollows }) => {
      if (!live) return;
      const store = sharedFollows();
      const read = () => {
        const state = store.getSnapshot();
        setCount(state.kind === "ready" ? state.follows.length : null);
      };
      unsubscribe = store.subscribe(read);
      read();
      void store.load(false);
    });
    return () => {
      live = false;
      unsubscribe?.();
    };
  }, []);
  return count;
}

/** The sidebar's sections (aria-label "Main"): the current one in the accent on its tint; Following carries its count. */
export function SidebarNav({ active }: { active?: NavKey | null }) {
  const current = useActiveKey(active);
  const follows = useFollowCount();
  return (
    <nav aria-label="Main">
      <ul className="flex flex-col gap-1">
        {SITE_NAV.map((item) => {
          const on = item.key === current;
          return (
            <li key={item.key}>
              <Link
                href={item.href}
                data-nav={item.key}
                aria-current={on ? "page" : undefined}
                className={cx(
                  SIDE_ROW,
                  on ? "bg-accent-soft font-semibold text-accent" : "font-medium text-[#33363d] hover:bg-sunken hover:text-ink",
                )}
              >
                <Icon name={NAV_ICON[item.key]} size={16} className={on ? "text-accent" : "text-ink-3"} />
                {item.label}
                {item.key === "following" && follows ? (
                  <span className="ml-auto rounded-lg bg-ink px-1.5 py-px font-mono text-[10px] leading-[13px] font-semibold text-white tabular-nums">
                    <span className="sr-only">(</span>
                    {follows}
                    <span className="sr-only"> followed)</span>
                  </span>
                ) : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** How many of the visitor's answers the sidebar lists. */
const SIDEBAR_RECENT_MAX = 3;

// One read per tab and set of ids: the sidebar remounts on every page, the list rarely changes in between.
let recentCache: { key: string; items: Promise<AnswerItem[]> } | null = null;
function sidebarAnswers(ids: readonly string[]): Promise<AnswerItem[]> {
  const key = ids.join(",");
  if (recentCache?.key !== key) {
    const items = loadYourAnswers(ids).then((list) => list.slice(0, SIDEBAR_RECENT_MAX));
    items.catch(() => {
      if (recentCache?.key === key) recentCache = null;
    });
    recentCache = { key, items };
  }
  return recentCache.items;
}

/**
 * "Your recent answers" under the sections: this browser's three newest answers, each a link to its
 * answer. Nothing for a visitor with no answers yet, or when they cannot be read (Your answers says why).
 */
export function SidebarRecent() {
  const [items, setItems] = useState<AnswerItem[]>([]);
  useEffect(() => {
    const ids = readRecentRunIds().slice(0, SIDEBAR_RECENT_MAX * 2);
    if (ids.length === 0) return;
    let live = true;
    sidebarAnswers(ids)
      .then((list) => {
        if (live) setItems(list);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="sidebar-recent" className="flex flex-col gap-1 px-2.5 pt-[18px]">
      <h2 id="sidebar-recent" className="mb-1 type-overline tracking-[0.12em] text-ink-3">
        <Link href={ANSWERS_HREF} className="rounded-sm hover:text-ink">
          Your recent answers
        </Link>
      </h2>
      <ul className="flex flex-col gap-0.5">
        {items.map((item) => (
          <li key={item.runId}>
            <Link
              href={`/run/${encodeURIComponent(item.runId)}`}
              title={item.question}
              className="block truncate rounded-sm py-[3px] text-[12px] leading-[18px] text-ink-2 hover:text-ink"
            >
              {item.question}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

const ROW =
  "flex h-12 w-full items-center gap-3 rounded-sm px-3 text-left text-[16px] leading-6 font-normal text-ink transition-colors hover:bg-sunken";

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
      <DrawerShell open={open} onClose={close} title="Menu" width={320} phone="side">
        <div className="flex min-h-full flex-col">
          <nav aria-label="Menu" className="-mx-2.5 -mt-2.5 flex flex-col gap-4 max-md:-mx-1.5">
            <ul className="flex flex-col gap-0.5">
              {SITE_NAV.map((item) => (
                <li key={item.key}>
                  <Link
                    href={item.href}
                    onClick={close}
                    aria-current={item.key === current ? "page" : undefined}
                    className={cx(ROW, item.key === current && "bg-accent-soft font-semibold text-accent")}
                  >
                    <Icon name={NAV_ICON[item.key]} size={18} className={item.key === current ? "text-accent" : "text-[#33363d]"} />
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <div className="px-2.5 max-md:px-1.5">
              <NewQuestionLink onNavigate={close} className={buttonClassName("primary", "lg", "w-full justify-center [&>svg]:size-4")} />
            </div>
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
                        <Icon name={item.icon} size={18} className="text-[#33363d]" />
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
                        <Icon name={item.icon} size={18} className="text-[#33363d]" />
                        {item.label}
                      </button>
                    ) : (
                      <Link href={item.href ?? "/"} onClick={close} className={ROW}>
                        <Icon name={item.icon} size={18} className="text-[#33363d]" />
                        {item.label}
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            ) : null}
            <ul className="flex flex-wrap gap-x-5 gap-y-2 border-t border-line px-3 pt-4">
              {SITE_LINKS.map((link) => (
                <li key={link.href}>
                  <Link href={link.href} onClick={close} className="rounded-sm type-label text-ink-2 hover:text-ink">
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="-mx-6 mt-auto -mb-6 pt-6 max-md:-mx-4">
            <ShellAccount size="lg" />
          </div>
        </div>
      </DrawerShell>
      {shareItem ? toast : null}
    </>
  );
}

interface ShellUser {
  name: string;
  email: string;
}

// One read of the signed-in user per tab: the shell remounts on every page.
let userCache: Promise<ShellUser | null> | null = null;
function shellUser(): Promise<ShellUser | null> {
  userCache ??= fetch("/api/auth/me", { credentials: "same-origin" })
    .then(async (res) => {
      if (!res.ok) return null;
      const body = (await res.json()) as { user?: ShellUser | null };
      return body.user && typeof body.user.name === "string" ? body.user : null;
    })
    .catch(() => {
      userCache = null;
      return null;
    });
  return userCache;
}

/**
 * The signed-in person at the foot of the sidebar and the menu sheet (the client twin of AccountSlot, as
 * some pages render the shell on the client): initial, name (to account settings) and Sign out. Nothing
 * when no one is signed in.
 */
export function ShellAccount({ size = "sm" }: { size?: "sm" | "lg" }) {
  const [user, setUser] = useState<ShellUser | null>(null);
  useEffect(() => {
    let live = true;
    void shellUser().then((u) => {
      if (live) setUser(u);
    });
    return () => {
      live = false;
    };
  }, []);
  if (!user) return null;
  const initial = (user.name.trim()[0] ?? user.email[0] ?? "?").toUpperCase();
  return (
    <div data-testid="account-slot" className={cx("flex items-center gap-2.5 border-t border-line", size === "lg" ? "px-5 py-3" : "px-1.5 pt-3")}>
      <span
        aria-hidden="true"
        className={cx(
          "inline-flex shrink-0 items-center justify-center rounded-full bg-[#b8c4e5] font-bold text-accent",
          size === "lg" ? "size-8 text-[12px]" : "size-7 text-[10px]",
        )}
      >
        {initial}
      </span>
      <Link
        href="/settings/account"
        title={user.email}
        className={cx(
          "min-w-0 flex-1 truncate rounded-sm text-ink hover:underline",
          size === "lg" ? "text-[14px] font-medium" : "text-[12px] font-semibold",
        )}
      >
        {user.name}
      </Link>
      <SignOutButton className="h-7 px-2 text-[12px]" />
    </div>
  );
}
