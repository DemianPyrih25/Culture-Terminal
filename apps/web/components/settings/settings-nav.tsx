import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "../ui/cx";

/** The settings sections that exist. Only Plan & usage today: there are no accounts yet. */
export type SettingsKey = "plan";

const SECTIONS: readonly { key: SettingsKey; label: string; href: string }[] = [
  { key: "plan", label: "Plan & usage", href: "/settings" },
];

/** The small-caps section label used across settings (11 px, tracked, ink-3). */
export const SETTINGS_LABEL = "text-[11px] leading-4 font-medium uppercase tracking-[0.08em] text-ink-3";

/** The left sub-nav of /settings; a row of links above the content on phones. */
export function SettingsNav({ active }: { active: SettingsKey }) {
  return (
    <nav aria-label="Settings" className="flex flex-col gap-3">
      <p className={cx(SETTINGS_LABEL, "max-md:hidden")}>Settings</p>
      <ul className="flex flex-col gap-0.5 max-md:flex-row max-md:gap-2">
        {SECTIONS.map((s) => {
          const current = s.key === active;
          return (
            <li key={s.key}>
              <Link
                href={s.href}
                aria-current={current ? "page" : undefined}
                className={cx(
                  "flex h-9 items-center rounded-control px-3 text-[14px] leading-5 transition-colors",
                  current ? "bg-accent-soft font-medium text-accent" : "text-ink-2 hover:bg-sunken hover:text-ink",
                )}
              >
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
      <p className="px-3 text-[12px] leading-[18px] text-ink-3 max-md:px-0">
        Accounts are not available yet, so there are no profile, notification or privacy settings.
      </p>
    </nav>
  );
}

/** /settings: the sub-nav left (200 px), the section right, held to a readable width. */
export function SettingsLayout({ active, children }: { active: SettingsKey; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-12 pt-10 pb-20 max-md:grid-cols-1 max-md:gap-8 max-md:pt-6 max-md:pb-12">
      <SettingsNav active={active} />
      <div className="min-w-0 max-w-[720px]">{children}</div>
    </div>
  );
}
