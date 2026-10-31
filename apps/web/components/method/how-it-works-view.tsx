import type { ReactNode } from "react";
import { DONT_BULLETS, DONT_CLOSING, DONT_TITLE, HOW_NOTES, HOW_PAGE, HOW_STEPS, READING_TITLE, readingBullets } from "../../content/how-it-works";
import { NEW_QUESTION_HREF } from "../chrome/links";
import { ButtonLink } from "../ui/button";
import { Icon, type IconName } from "../ui/icons";
import { EYEBROW } from "./reference";

/**
 * How it works (Ledger rwetX): a reading column with the intro, the three steps, how to read an answer
 * and what we don't do, coverage and the data behind it, then "Ask a question" and the analysts'
 * reference; a margin rail beside it with the page index and the current trend window.
 */

/** A section's h2: serif, 28 on desktop. */
const H2 = "font-display text-[28px] leading-[34px] font-medium tracking-[-0.01em] text-ink max-md:text-[22px] max-md:leading-[28px]";

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

/** The seven pipeline steps and who owns each: the model reads and writes, our code does every number. */
const PIPELINE: readonly { n: string; title: string; lane: "model" | "code"; owner: string; text: string }[] = [
  { n: "01", title: "Interpret", lane: "model", owner: "Clerk", text: "Finds the names and the job" },
  { n: "02", title: "Resolve", lane: "code", owner: "Gate", text: "Exact names; you pick if unsure" },
  { n: "03", title: "Plan", lane: "model", owner: "Analyst", text: "Writes what it expects before data" },
  { n: "04", title: "Fetch", lane: "code", owner: "Quant", text: "Capped calls to the sources" },
  { n: "05", title: "Compute", lane: "code", owner: "Formulas", text: "One named formula per number" },
  { n: "06", title: "Check", lane: "code", owner: "Checker", text: "Rules trace every number" },
  { n: "07", title: "Write", lane: "model", owner: "Analyst", text: "Prose only; code places numbers" },
];

const SOURCES: readonly { name: string; what: string }[] = [
  { name: "Qloo", what: "taste" },
  { name: "SEC EDGAR", what: "filings" },
  { name: "Census ACS", what: "residents" },
  { name: "OpenStreetMap", what: "places" },
];

const CHIP = "rounded-control border border-line bg-surface px-2 py-1 font-mono text-[12px] leading-4";

/** The marks on an answer, one per "Reading an answer" bullet, in the same order. */
const READING_MARKS: readonly { title: string; specimen: (trendWindow: string) => ReactNode }[] = [
  {
    title: "Confidence",
    specimen: () => <span className="rounded-control bg-caution-soft px-2 py-1 text-[12px] leading-4 font-semibold text-caution-ink">High · Medium · Low</span>,
  },
  { title: "Affinity", specimen: () => <span className={`${CHIP} text-ink`}>Affinity ×</span> },
  { title: "Trends", specimen: (w) => <span className={`${CHIP} text-ink-2`}>Window {w}</span> },
  { title: "SEC figures", specimen: () => <span className={`${CHIP} text-ink`}>Fiscal period</span> },
  { title: "Census figures", specimen: () => <span className={`${CHIP} text-ink-2`}>ACS 5-year</span> },
  {
    title: "Missing data",
    specimen: () => (
      <span className="bg-hatch inline-flex h-6 w-24 items-center justify-center rounded-control border border-line bg-sunken">
        <span className="rounded-[2px] bg-sunken px-1.5 text-[11px] leading-4 font-semibold text-ink-2">No data</span>
      </span>
    ),
  },
];

const TOOLS: readonly { icon: IconName; title: string; text: string; where: string }[] = [
  {
    icon: "user-round",
    title: "Profiles",
    text: "Search a brand, artist, public figure, podcast, TV show or film by its exact name for a one-page taste profile. Open one from the search bar.",
    where: "Search bar",
  },
  {
    icon: "table-2",
    title: "Screener",
    text: "Rank brands in a category by taste across markets. Each row links to that brand's profile.",
    where: "Sidebar · Screener",
  },
  {
    icon: "list-checks",
    title: "Following",
    text: "Keep questions in this browser and re-run them when you choose. Each run is shown as it is; it does not claim what changed.",
    where: "Sidebar · Following",
  },
];

const DATA_ROWS: readonly { name: string; what: string; note: string }[] = [
  { name: "Qloo", what: "Taste affinities, trends and audience indices", note: "Group level only" },
  { name: "SEC EDGAR", what: "Reported figures of listed companies", note: "Company-wide, by fiscal period" },
  { name: "Census ACS", what: "Who lives in an area: population, age, households, income", note: "Not endorsed or certified by the Census Bureau" },
  { name: "OpenStreetMap", what: "Named places near a location", note: "© OpenStreetMap contributors, ODbL. Counts are a floor" },
  { name: "Claude by Anthropic", what: "Reads the question, plans and writes the prose", note: "Never types a number" },
  { name: "Our own code", what: "Fetches, computes and checks every number", note: "The same code for every answer" },
];

const INDEX: readonly { id: string; label: string }[] = [
  { id: "steps", label: "Three steps" },
  { id: "pipeline", label: "The pipeline" },
  { id: "reading", label: READING_TITLE },
  { id: "dont", label: DONT_TITLE },
  { id: "tools", label: "Profiles, Screener, Following" },
  ...HOW_NOTES.map((n) => ({ id: noteId(n.title), label: n.title })),
];

function noteId(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

export function HowItWorksView({ trendWindow }: { trendWindow: string }) {
  return (
    <div className="grid animate-rise gap-12 pt-14 pb-20 max-md:gap-10 max-md:pt-8 max-md:pb-10 lg:grid-cols-[minmax(0,760px)_minmax(0,1fr)] lg:gap-16">
      <div className="flex min-w-0 flex-col gap-20 max-md:gap-12">
        <header className="flex flex-col gap-5">
          <p className={EYEBROW}>Help · How it works</p>
          <h1 className="font-display text-[52px] leading-[60px] font-medium tracking-[-0.02em] text-ink max-md:text-[36px] max-md:leading-[42px]">{HOW_PAGE.title}</h1>
          <p className="font-display text-[21px] leading-[31px] text-ink-2 max-md:text-[18px] max-md:leading-[27px]">{HOW_PAGE.lead}</p>
        </header>

        <section id="steps" aria-label="Three steps" className="flex scroll-mt-6 flex-col gap-6">
          <h2 className={H2}>Three steps, every time</h2>
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
                  <h3 className="font-display text-[22px] leading-[28px] font-medium text-ink">{step.title}</h3>
                  <p className="text-[14px] leading-[22px] text-ink-2">{step.text}</p>
                </section>
              </li>
            ))}
          </ol>
        </section>

        <HowSection id="pipeline" eyebrow="The pipeline" title="Seven steps, the same for every answer">
          <p className="text-[15px] leading-6 text-ink-2">
            The model reads your question, plans and writes. Our code does everything that touches a number. The lanes
            below show who owns each step.
          </p>
          <div className="flex flex-col rounded-card border border-line bg-surface px-6 pt-7 pb-6 max-md:px-4 max-md:pt-5">
            <ol aria-label="The pipeline" className="grid grid-cols-7 gap-1.5 max-lg:grid-cols-1 max-lg:gap-2">
              {PIPELINE.map((step) => (
                <li key={step.n} className="flex flex-col gap-2 max-lg:flex-row max-lg:items-center max-lg:gap-3">
                  <div className="flex flex-col gap-2 max-lg:w-28 max-lg:shrink-0">
                    <span aria-hidden className="flex items-center max-lg:hidden">
                      <span className="size-[7px] shrink-0 rounded-full bg-accent" />
                      {step.n !== "07" ? <span className="h-px flex-1 bg-line-strong" /> : null}
                    </span>
                    <span className="flex items-baseline gap-1.5">
                      <span className="font-mono text-[10px] leading-4 text-ink-3">{step.n}</span>
                      <span className="text-[12px] leading-4 font-semibold text-ink">{step.title}</span>
                    </span>
                  </div>
                  <div
                    className={`flex min-h-[88px] flex-col gap-1 rounded-control border p-2 max-lg:min-h-0 max-lg:flex-1 ${
                      step.lane === "code" ? "border-accent/25 bg-accent-soft" : "border-line bg-sunken"
                    }`}
                  >
                    <span className={`font-mono text-[10px] leading-4 ${step.lane === "code" ? "text-accent" : "text-ink-2"}`}>
                      {step.lane === "code" ? "Code" : "Model"} · {step.owner}
                    </span>
                    <span className="text-[11px] leading-4 text-ink-2">{step.text}</span>
                  </div>
                </li>
              ))}
            </ol>
            <div className="mt-6 flex flex-wrap items-center gap-3 border-t border-line pt-[18px]">
              <span className="text-[11px] leading-4 font-semibold text-ink-2">Fetch draws on</span>
              {SOURCES.map((src) => (
                <span key={src.name} className="inline-flex items-center gap-1.5 rounded-control border border-line bg-surface px-2.5 py-1 text-[12px] leading-4">
                  <span aria-hidden className="size-1.5 rounded-[1px] bg-accent" />
                  <span className="font-semibold text-ink">{src.name}</span>
                  <span className="text-ink-2">{src.what}</span>
                </span>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 max-md:grid-cols-1">
            <div className="flex flex-col gap-2 rounded-control bg-second-soft px-[18px] py-4">
              <p className="flex items-center gap-2 text-[13px] leading-5 font-semibold text-second-ink">
                <Icon name="bot" size={14} />
                What AI knows · not verified
              </p>
              <p className="text-[13px] leading-5 text-ink-2">
                Background from the model, labelled with its name and date. It may not state numbers and never changes
                the measured answer.
              </p>
            </div>
            <div className="flex flex-col gap-2 rounded-control bg-accent-soft px-[18px] py-4">
              <p className="flex items-center gap-2 text-[13px] leading-5 font-semibold text-accent-ink">
                <Icon name="link" size={14} />
                From the web
              </p>
              <p className="text-[13px] leading-5 text-ink-2">
                A few searches at most. Every sentence links to its source with publisher and dates. Not checked by us.
              </p>
            </div>
          </div>
        </HowSection>

        <HowSection id="reading" eyebrow="Reading an answer" title="What the marks on an answer mean">
          <ul className="flex flex-col border-t border-line">
            {readingBullets(trendWindow).map((text, i) => {
              const mark = READING_MARKS[i];
              return (
                <li key={text} className="grid grid-cols-[200px_minmax(0,1fr)] gap-6 border-b border-line py-[18px] max-md:grid-cols-1 max-md:gap-3">
                  <div className="pt-0.5">{mark ? mark.specimen(trendWindow) : null}</div>
                  <div className="flex flex-col gap-1">
                    {mark ? <h3 className="text-[15px] leading-[22px] font-semibold text-ink">{mark.title}</h3> : null}
                    <p className="text-[14px] leading-[22px] text-ink-2">{text}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </HowSection>

        <HowSection id="dont" eyebrow="Scope" title={DONT_TITLE}>
          <ul className="grid grid-cols-2 overflow-hidden rounded-card border border-line bg-surface max-md:grid-cols-1">
            {DONT_BULLETS.map((item, i) => (
              <li
                key={item}
                className={`flex gap-3.5 px-[22px] py-5 text-[14px] leading-[22px] font-medium text-ink ${i % 2 === 1 ? "md:border-l md:border-line" : ""} ${i >= 2 ? "md:border-t md:border-line" : ""} ${i > 0 ? "max-md:border-t max-md:border-line" : ""}`}
              >
                <Icon name="ban" size={18} className="mt-0.5 shrink-0 text-danger" />
                <span className="min-w-0">{item}</span>
              </li>
            ))}
          </ul>
          <p className="type-body text-ink-2">{DONT_CLOSING}</p>
        </HowSection>

        <HowSection id="tools" eyebrow="Also in the product" title="Profiles, the Screener and Following">
          <ul className="flex flex-col border-t border-line">
            {TOOLS.map((tool) => (
              <li key={tool.title} className="flex items-start gap-[18px] border-b border-line py-[18px] max-md:flex-wrap">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent">
                  <Icon name={tool.icon} size={16} />
                </span>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <h3 className="text-[15px] leading-[22px] font-semibold text-ink">{tool.title}</h3>
                  <p className="text-[14px] leading-[22px] text-ink-2">{tool.text}</p>
                </div>
                <span className="shrink-0 pt-1 font-mono text-[11px] leading-4 text-ink-2 max-md:pl-[50px]">{tool.where}</span>
              </li>
            ))}
          </ul>
        </HowSection>

        {HOW_NOTES.map((note) => (
          <section key={note.title} id={noteId(note.title)} aria-label={note.title} className="flex scroll-mt-6 flex-col gap-5">
            <div className="flex flex-col gap-2">
              <p className={EYEBROW}>{note.title}</p>
              <h2 className={H2}>{note.title === "Coverage" ? "Where and what we can answer" : "Where every part comes from"}</h2>
            </div>
            <p className="text-[15px] leading-6 text-ink-2">{note.text}</p>
            {note.title === "Data and models" ? (
              <dl className="flex flex-col border-t border-line">
                {DATA_ROWS.map((row) => (
                  <div key={row.name} className="grid grid-cols-[170px_minmax(0,1fr)_220px] gap-5 border-b border-line py-3.5 max-md:grid-cols-1 max-md:gap-1">
                    <dt className="text-[14px] leading-5 font-semibold text-ink">{row.name}</dt>
                    <dd className="text-[14px] leading-5 text-ink-2">{row.what}</dd>
                    <dd className="text-[12px] leading-[18px] text-ink-2">{row.note}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
          </section>
        ))}

        <div className="flex flex-col gap-5 border-t border-line pt-8">
          <p className="font-display text-[26px] leading-[32px] font-medium text-ink max-md:text-[22px] max-md:leading-[28px]">Ready when you are.</p>
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
            <p className="flex items-center gap-2 text-[12px] leading-4 font-semibold text-ink">
              <Icon name="clock-4" size={14} className="text-ink-2" />
              Current trend window
            </p>
            <p className="font-mono text-[14px] leading-5 text-ink">{trendWindow}</p>
            <p className="text-[12px] leading-[18px] text-ink-2">Set by Qloo&apos;s latest data. Momentum in an answer is historical within this window, not a forecast.</p>
          </div>
          <div className="flex flex-col gap-2 rounded-card border border-line bg-surface p-4">
            <p className="flex items-center gap-2 text-[12px] leading-4 font-semibold text-ink">
              <Icon name="shield-check" size={14} className="text-ink-2" />
              Not financial advice
            </p>
            <p className="text-[12px] leading-[18px] text-ink-2">
              Answers describe taste and public figures. They are not investment, credit or legal advice.
            </p>
          </div>
        </div>
      </aside>
    </div>
  );
}
