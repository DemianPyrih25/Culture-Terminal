import type { ReactNode } from "react";
import { DONT_BULLETS, DONT_CLOSING, DONT_TITLE, HOW_NOTES, HOW_PAGE, HOW_STEPS, READING_TITLE, readingBullets } from "../../content/how-it-works";
import { NEW_QUESTION_HREF } from "../chrome/links";
import { ButtonLink } from "../ui/button";
import { Icon } from "../ui/icons";
import { EYEBROW } from "./reference";

/**
 * How it works (Ledger rwetX): a reading column with the intro, the three steps, how to read an answer
 * and what we don't do, coverage and the data behind it, then "Ask a question" and the analysts'
 * reference; a margin rail beside it with the page index and the current trend window.
 */

/** A section's h2: serif, 28 on desktop. */
const H2 = "font-display text-[28px] leading-[34px] font-normal tracking-[-0.01em] text-ink max-md:text-[22px] max-md:leading-[28px]";

/** Bullets: 15 ink, a 5 px ink-3 dot. */
export function Bullets({ items }: { items: readonly ReactNode[] }) {
  return (
    <ul className="flex flex-col gap-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-3 type-body text-ink">
          <span aria-hidden="true" className="mt-[10px] size-[5px] shrink-0 rounded-full bg-ink-3" />
          <span className="min-w-0">{item}</span>
        </li>
      ))}
    </ul>
  );
}

/** One section of the reading column: an eyebrow, the h2, then its body. */
function HowSection({ id, eyebrow, title, label, children }: { id: string; eyebrow: string; title: string; label?: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} aria-label={label} className="flex scroll-mt-6 flex-col gap-5">
      <div className="flex flex-col gap-2">
        <p className={EYEBROW}>{eyebrow}</p>
        <h2 id={`${id}-title`} className={H2}>
          {title}
        </h2>
      </div>
      {children}
    </section>
  );
}

const INDEX: readonly { id: string; label: string }[] = [
  { id: "steps", label: "Three steps" },
  { id: "reading", label: READING_TITLE },
  { id: "dont", label: DONT_TITLE },
  ...HOW_NOTES.map((n) => ({ id: noteId(n.title), label: n.title })),
];

function noteId(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function HowItWorksView({ trendWindow }: { trendWindow: string }) {
  return (
    <div className="grid gap-12 pt-14 pb-20 max-md:gap-10 max-md:pt-8 max-md:pb-10 lg:grid-cols-[minmax(0,760px)_minmax(0,1fr)] lg:gap-16">
      <div className="flex min-w-0 flex-col gap-16 max-md:gap-12">
        <header className="flex flex-col gap-5">
          <p className={EYEBROW}>Help · How it works</p>
          <h1 className="type-display-l text-ink max-md:type-display-l-sm">{HOW_PAGE.title}</h1>
          <p className="font-display text-[21px] leading-[31px] text-ink-2 max-md:text-[18px] max-md:leading-[27px]">{HOW_PAGE.lead}</p>
        </header>

        <section id="steps" aria-label="Three steps" className="flex scroll-mt-6 flex-col gap-6">
          <p className={EYEBROW}>Three steps, every time</p>
          <ol aria-label="How an answer is made" className="grid grid-cols-3 border-t border-line max-lg:grid-cols-1">
            {HOW_STEPS.map((step, i) => (
              <li
                key={step.title}
                className="border-line pt-6 max-lg:border-b max-lg:pb-6 lg:pr-7 lg:not-first:border-l lg:not-first:pl-7"
              >
                <section aria-label={step.title} className="flex h-full flex-col gap-3">
                  <div className="flex items-center justify-between text-accent">
                    <span className="font-mono text-[12px] leading-4">{String(i + 1).padStart(2, "0")}</span>
                    <Icon name={step.icon} size={18} />
                  </div>
                  <h2 className="font-display text-[22px] leading-[28px] text-ink">{step.title}</h2>
                  <p className="text-[14px] leading-[22px] text-ink-2">{step.text}</p>
                </section>
              </li>
            ))}
          </ol>
        </section>

        <HowSection id="reading" eyebrow="Reading an answer" title={READING_TITLE}>
          <Bullets items={readingBullets(trendWindow)} />
        </HowSection>

        <HowSection id="dont" eyebrow="Scope" title={DONT_TITLE}>
          <ul className="grid grid-cols-2 overflow-hidden rounded-card border border-line bg-surface max-md:grid-cols-1">
            {DONT_BULLETS.map((item, i) => (
              <li
                key={item}
                className={`flex gap-3 px-5 py-4 type-body text-ink ${i % 2 === 1 ? "md:border-l md:border-line" : ""} ${i >= 2 ? "md:border-t md:border-line" : ""} ${i > 0 ? "max-md:border-t max-md:border-line" : ""}`}
              >
                <Icon name="ban" size={16} className="mt-1 shrink-0 text-ink-3" />
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
          <p className="type-body text-ink-2">{DONT_CLOSING}</p>
        </HowSection>

        {HOW_NOTES.map((note) => (
          <section key={note.title} id={noteId(note.title)} aria-label={note.title} className="flex scroll-mt-6 flex-col gap-4 border-t border-line pt-8">
            <h2 className={H2}>{note.title}</h2>
            <p className="type-body text-ink-2">{note.text}</p>
          </section>
        ))}

        <div className="flex flex-col gap-5 border-t border-line pt-8">
          <p className="font-display text-[26px] leading-[32px] text-ink max-md:text-[22px] max-md:leading-[28px]">Ready when you are.</p>
          <div className="flex flex-wrap items-center gap-3 max-md:flex-col max-md:items-stretch">
            <ButtonLink href={NEW_QUESTION_HREF} variant="primary" className="max-md:w-full max-md:justify-center">
              {HOW_PAGE.ask}
            </ButtonLink>
            <ButtonLink href="/method" variant="secondary" className="max-md:w-full max-md:justify-center">
              {HOW_PAGE.analystsLink}
            </ButtonLink>
          </div>
        </div>
      </div>

      <aside className="max-lg:hidden">
        <div className="sticky top-6 flex flex-col gap-7 pt-2">
          <nav aria-label="On this page" className="flex flex-col gap-2">
            <p className={EYEBROW}>On this page</p>
            <ol className="flex flex-col border-l border-line">
              {INDEX.map((item) => (
                <li key={item.id}>
                  <a href={`#${item.id}`} className="-ml-px block border-l border-transparent py-1.5 pl-3 type-label text-ink-2 transition-colors hover:border-accent hover:text-accent">
                    {item.label}
                  </a>
                </li>
              ))}
            </ol>
          </nav>
          <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
            <p className="flex items-center gap-2 type-caption font-medium text-ink">
              <Icon name="clock-4" size={14} className="text-ink-3" />
              Current trend window
            </p>
            <p className="font-mono text-[13px] leading-5 text-ink">{trendWindow}</p>
            <p className="type-caption text-ink-3">Set by Qloo&apos;s latest data. Momentum in an answer is historical within this window.</p>
          </div>
        </div>
      </aside>
    </div>
  );
}
