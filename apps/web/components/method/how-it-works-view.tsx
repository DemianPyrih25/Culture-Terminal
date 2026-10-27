import type { ReactNode } from "react";
import { DONT_BULLETS, DONT_CLOSING, DONT_TITLE, HOW_NOTES, HOW_PAGE, HOW_STEPS, READING_TITLE, readingBullets } from "../../content/how-it-works";
import { NEW_QUESTION_HREF } from "../chrome/links";
import { ButtonLink } from "../ui/button";
import { Card } from "../ui/card";
import { Icon } from "../ui/icons";

/**
 * How it works (N15 OcwxT): the intro, the three steps, how to read an answer and what we don't do,
 * coverage and the data behind it, then a link to the analysts' reference and "Ask a question".
 */

const CARD_TITLE = "type-title text-ink max-md:type-title-sm";

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

export function HowItWorksView({ trendWindow }: { trendWindow: string }) {
  return (
    <div className="flex flex-col gap-6 pt-12 pb-6 max-md:gap-4 max-md:pt-6 max-md:pb-2">
      <header className="flex flex-col gap-3 pb-5 max-md:pb-2">
        <h1 className="type-display-m text-ink max-md:type-display-m-sm">{HOW_PAGE.title}</h1>
        <p className="max-w-[744px] type-lead text-ink-2 max-md:text-[16px] max-md:leading-6">{HOW_PAGE.lead}</p>
      </header>

      <ol aria-label="How an answer is made" className="grid grid-cols-3 gap-6 max-lg:grid-cols-1 max-md:gap-4">
        {HOW_STEPS.map((step) => (
          <li key={step.title}>
            <Card as="section" aria-label={step.title} className="flex h-full flex-col gap-5">
              <div className="flex items-center gap-4">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-tile bg-sunken text-ink-2">
                  <Icon name={step.icon} size={20} />
                </span>
                <h2 className={CARD_TITLE}>{step.title}</h2>
              </div>
              <p className="type-body text-ink-2">{step.text}</p>
            </Card>
          </li>
        ))}
      </ol>

      <div className="grid grid-cols-2 gap-6 max-lg:grid-cols-1 max-md:gap-4">
        <Card aria-labelledby="reading" className="flex flex-col gap-5">
          <h2 id="reading" className={CARD_TITLE}>
            {READING_TITLE}
          </h2>
          <Bullets items={readingBullets(trendWindow)} />
        </Card>
        <Card aria-labelledby="dont" className="flex flex-col gap-5">
          <h2 id="dont" className={CARD_TITLE}>
            {DONT_TITLE}
          </h2>
          <Bullets items={DONT_BULLETS} />
          <p className="type-body text-ink-2">{DONT_CLOSING}</p>
        </Card>
      </div>

      <div className="grid grid-cols-2 gap-6 max-lg:grid-cols-1 max-md:gap-4">
        {HOW_NOTES.map((note) => (
          <Card key={note.title} aria-label={note.title} className="flex flex-col gap-5">
            <h2 className={CARD_TITLE}>{note.title}</h2>
            <p className="type-body text-ink-2">{note.text}</p>
          </Card>
        ))}
      </div>

      <div className="flex flex-col items-start gap-7 pt-2 max-md:items-stretch max-md:gap-6">
        <ButtonLink href="/method" variant="link">
          {HOW_PAGE.analystsLink}
        </ButtonLink>
        <ButtonLink href={NEW_QUESTION_HREF} variant="primary" className="max-md:w-full max-md:justify-center">
          {HOW_PAGE.ask}
        </ButtonLink>
      </div>
    </div>
  );
}
