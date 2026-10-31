import Link from "next/link";
import type { ReactNode } from "react";
import { InitialMark } from "../chrome/logo-mark";
import { Icon, type IconName } from "../ui/icons";

/** What the right-hand panel says: true statements about the product, no sample answers. */
const POINTS: readonly { icon: IconName; title: string; text: string }[] = [
  {
    icon: "chart-bar",
    title: "Measured, not guessed",
    text: "Every number comes from a named source: Qloo taste data, the US Census Bureau, SEC filings or OpenStreetMap.",
  },
  {
    icon: "list-checks",
    title: "Every figure shows its working",
    text: "Answers carry the formula, the inputs and how sure we are, so you can check them before you act.",
  },
  {
    icon: "shield-check",
    title: "Honest about its limits",
    text: "When the data cannot answer a question, the answer says so plainly instead of filling the gap.",
  },
];

/**
 * The sign-in and create-account frame (D9e5SY, B9vRTo): the brand and the form on paper at the left,
 * a quiet panel on what the product is at the right (hidden below 1024 px).
 */
export function AuthLayout({ eyebrow, title, lead, children }: { eyebrow: string; title: string; lead: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-full flex-1 bg-canvas">
      <div className="flex min-w-0 flex-1 flex-col px-4 py-6 sm:px-10 lg:max-w-[640px] lg:px-16 lg:py-8">
        <Link href="/" className="inline-flex w-fit items-center gap-2.5 rounded-sm" aria-label="Culture Terminal home">
          <InitialMark size={24} />
          <span className="font-display text-[17px] text-ink">Culture Terminal</span>
        </Link>
        <main id="main" className="flex flex-1 flex-col justify-center py-10">
          <div className="mx-auto w-full max-w-[440px] animate-rise">
            <p className="type-overline text-ink-3">{eyebrow}</p>
            <h1 className="type-display-m mt-2 text-ink max-sm:type-display-m-sm">{title}</h1>
            <div className="type-body mt-3 text-ink-2">{lead}</div>
            <div className="mt-8">{children}</div>
          </div>
        </main>
        <footer className="type-caption flex flex-wrap items-center justify-between gap-3 text-ink-3">
          <span>© {new Date().getFullYear()} Culture Terminal</span>
          <span className="flex gap-4">
            <Link href="/method" className="transition-colors duration-150 hover:text-ink">
              Method
            </Link>
            <Link href="/trust" className="transition-colors duration-150 hover:text-ink">
              Trust
            </Link>
            <Link href="/status" className="transition-colors duration-150 hover:text-ink">
              Status
            </Link>
          </span>
        </footer>
      </div>
      <aside className="hidden flex-1 flex-col justify-center border-l border-line bg-sunken px-14 py-12 lg:flex">
        <div className="mx-auto w-full max-w-[520px]">
          <p className="type-overline text-ink-3">Culture Terminal</p>
          <p className="type-display-s mt-3 text-ink">Answers about brands, places and audiences, with the evidence attached.</p>
          <ul className="mt-10 flex flex-col divide-y divide-line border-y border-line">
            {POINTS.map((p, i) => (
              <li key={p.title} className="flex animate-rise gap-4 py-5" style={{ animationDelay: `${120 + i * 60}ms` }}>
                <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-sm border border-line bg-surface text-accent">
                  <Icon name={p.icon} size={16} />
                </span>
                <span>
                  <span className="type-body-strong block text-ink">{p.title}</span>
                  <span className="type-body mt-1 block text-ink-2">{p.text}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </aside>
    </div>
  );
}
