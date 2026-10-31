import Link from "next/link";
import type { ReactNode } from "react";
import { cx } from "../ui/cx";
import { Icon, type IconName } from "../ui/icons";

/** The settings sections that exist: Account (sign-in, password) and Plan & usage. */
export type SettingsKey = "account" | "plan";

const SECTIONS: readonly { key: SettingsKey; label: string; href: string; icon: IconName }[] = [
  { key: "account", label: "Account", href: "/settings/account", icon: "user-round" },
  { key: "plan", label: "Plan & usage", href: "/settings", icon: "chart-bar" },
];

/** The small-caps section label used across settings (11 px, semibold, tracked, ink-2). */
export const SETTINGS_LABEL = "text-[11px] leading-4 font-semibold uppercase tracking-[0.08em] text-ink-2";

/** The left sub-nav of /settings (Ledger RLTl8); a row of links above the content on phones. */
export function SettingsNav({ active }: { active: SettingsKey }) {
  return (
    <nav aria-label="Settings" className="flex flex-col gap-1">
      <p className={cx(SETTINGS_LABEL, "mb-2.5 max-md:hidden")}>Settings</p>
      <ul className="flex flex-col gap-1 max-md:flex-row max-md:gap-2">
        {SECTIONS.map((s) => {
          const current = s.key === active;
          return (
            <li key={s.key}>
              <Link
                href={s.href}
                aria-current={current ? "page" : undefined}
                className={cx(
                  "flex h-[34px] items-center gap-2.5 rounded-control px-2.5 text-[13px] leading-5 transition-[color,background-color,transform] duration-150 active:scale-[0.98]",
                  current ? "bg-accent-soft font-semibold text-accent" : "font-medium text-ink-2 hover:bg-sunken hover:text-ink",
                )}
              >
                <Icon name={s.icon} size={15} className={current ? "text-accent" : "text-ink-3"} />
                {s.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** /settings: the sub-nav left (200 px), the section right, held to a readable width (720 px). */
export function SettingsLayout({ active, children }: { active: SettingsKey; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[200px_minmax(0,1fr)] gap-[72px] pt-14 pb-16 max-lg:gap-10 max-md:grid-cols-1 max-md:gap-8 max-md:pt-6 max-md:pb-12">
      <SettingsNav active={active} />
      <div className="min-w-0 max-w-[720px]">{children}</div>
    </div>
  );
}
