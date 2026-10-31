import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark } from "../chrome/logo-mark";
import { Icon } from "../ui/icons";
import { cx } from "../ui/cx";
import {
  ALSO,
  ALSO_TITLE,
  APART,
  ASK_HREF,
  CANNOT,
  CANNOT_TITLE,
  COVERAGE,
  DESKS,
  DESKS_HEAD,
  DONT,
  DONT_TITLE,
  FAQ,
  FAQ_HEAD,
  FIGURES,
  FINAL,
  FOOTER_COLUMNS,
  FOOTER_NOTES,
  HERO,
  HONESTY,
  HONESTY_POINTS,
  HOW,
  LIMITS,
  NAV_LINKS,
  SOURCES,
  SOURCES_TITLE,
  START_LABEL,
  STEPS,
  type LandingDesk,
} from "./content";

/**
 * The marketing landing (/welcome), direction A "Ledger": nav, hero with the product visual, sources,
 * how it works, the four desks, the figures, honesty, limits and coverage, questions, final call to
 * action and footer. Static; every call to action leads to the ask box on Home (no accounts).
 */
export function LandingPage() {
  return (
    <div className="flex min-h-full flex-col bg-canvas text-ink" data-testid="landing">
      <LandingNav />
      <main id="main" className="flex flex-col">
        <Hero />
        <Sources />
        <HowItWorks />
        <Desks />
        <Figures />
        <Honesty />
        <Limits />
        <Questions />
        <FinalCta />
      </main>
      <LandingFooter />
    </div>
  );
}

/* ---------- shared bits ---------- */

const GUTTER = "px-4 sm:px-8 lg:px-20";
const INNER = "mx-auto w-full max-w-[1280px]";

function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cx("font-sans text-[11px] font-medium tracking-[0.14em] text-ink-3 uppercase", className)}>
      {children}
    </p>
  );
}

function PrimaryLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex h-11 items-center justify-center gap-2 rounded-control bg-accent px-5 text-[15px] font-medium text-surface transition-colors hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        className,
      )}
    >
      {children}
    </Link>
  );
}

function SecondaryLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cx(
        "inline-flex h-11 items-center justify-center gap-2 rounded-control border border-line-strong bg-surface px-5 text-[15px] font-medium text-ink transition-colors hover:border-ink-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        className,
      )}
    >
      {children}
    </Link>
  );
}

function SectionHead({ eyebrow, title, lead, id }: { eyebrow: string; title: string; lead?: string; id?: string }) {
  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-end lg:gap-16">
      <div className="flex flex-col gap-4">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h2 id={id} className="max-w-[780px] font-display text-[30px] leading-[1.12] tracking-[-0.01em] sm:text-[44px]">
          {title}
        </h2>
      </div>
      {lead ? <p className="text-base leading-relaxed text-ink-2">{lead}</p> : null}
    </div>
  );
}

/* ---------- nav ---------- */

function LandingNav() {
  return (
    <header className={cx("sticky top-0 z-30 border-b border-line bg-canvas/95 backdrop-blur", GUTTER)}>
      <nav aria-label="Landing" className={cx(INNER, "flex h-16 items-center justify-between gap-6")}>
        <Link href="/welcome" className="flex items-center gap-3" aria-label="Culture Terminal, welcome">
          <LogoMark />
          <span className="font-display text-lg font-medium">Culture Terminal</span>
        </Link>
        <ul className="hidden items-center gap-8 lg:flex">
          {NAV_LINKS.map((l) => (
            <li key={l.label}>
              <Link href={l.href} className="text-sm text-ink-2 transition-colors hover:text-ink">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <Link
          href={ASK_HREF}
          className="inline-flex h-9 items-center gap-1.5 rounded-control bg-accent px-4 text-[13px] font-medium text-surface transition-colors hover:bg-accent-hover"
        >
          {START_LABEL}
          <Icon name="arrow-right" size={14} />
        </Link>
      </nav>
    </header>
  );
}

/* ---------- hero ---------- */

function Hero() {
  return (
    <section id="product" aria-labelledby="landing-title" className={cx("scroll-mt-16 pt-14 sm:pt-[88px]", GUTTER)}>
      <div className={cx(INNER, "flex flex-col gap-12 sm:gap-14")}>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-end lg:gap-16">
          <div className="flex flex-col gap-5">
            <Eyebrow>{HERO.eyebrow}</Eyebrow>
            <h1
              id="landing-title"
              className="font-display text-[38px] leading-[1.06] tracking-[-0.02em] text-ink sm:text-[56px] xl:text-[68px]"
            >
              {HERO.title}
            </h1>
          </div>
          <div className="flex flex-col gap-6">
            <p className="text-[17px] leading-relaxed text-ink-2">{HERO.lead}</p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <PrimaryLink href={ASK_HREF}>
                {START_LABEL}
                <Icon name="arrow-right" size={16} />
              </PrimaryLink>
              <SecondaryLink href="#how">{HERO.secondary}</SecondaryLink>
            </div>
            <p className="text-[13px] text-ink-3">{HERO.fine}</p>
          </div>
        </div>
        <figure className="flex flex-col gap-3">
          <div className="overflow-hidden rounded-card border border-line bg-surface">
            <Image
              src="/landing/product-answer.webp"
              alt={HERO.visualAlt}
              width={2560}
              height={1520}
              sizes="(min-width: 1440px) 1280px, 100vw"
              fetchPriority="high"
              loading="eager"
              className="h-auto w-full"
            />
          </div>
          <figcaption className="font-mono text-[11px] text-ink-3">{HERO.visualNote}</figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ---------- sources ---------- */

function Sources() {
  return (
    <section aria-labelledby="landing-sources" className={cx("pt-10 pb-16 sm:pb-[72px]", GUTTER)}>
      <div className={cx(INNER, "flex flex-col gap-5")}>
        <h2 id="landing-sources" className="font-sans text-[11px] font-medium tracking-[0.14em] text-ink-3 uppercase">
          {SOURCES_TITLE}
        </h2>
        <ul className="grid border-y border-line sm:grid-cols-2 lg:grid-cols-5">
          {SOURCES.map((s, i) => (
            <li
              key={s.name}
              className={cx(
                "flex flex-col gap-2 py-5 lg:px-6",
                i > 0 && "border-t border-line sm:border-t-0 lg:border-l",
                i === 0 && "lg:pl-0",
                i >= 2 && "sm:border-t lg:border-t-0",
              )}
            >
              <span className="font-display text-xl">{s.name}</span>
              <span className="text-[13px] leading-snug text-ink-2">{s.text}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

/* ---------- how it works ---------- */

function HowItWorks() {
  return (
    <section
      id="how"
      aria-labelledby="landing-how"
      className={cx("scroll-mt-16 border-y border-line bg-surface py-16 sm:py-24", GUTTER)}
    >
      <div className={cx(INNER, "flex flex-col gap-12")}>
        <SectionHead id="landing-how" eyebrow={HOW.eyebrow} title={HOW.title} lead={HOW.lead} />
        <ol className="grid gap-10 md:grid-cols-3 md:gap-8">
          {STEPS.map((s, i) => (
            <li key={s.n} className="flex flex-col gap-4 border-t border-line pt-6">
              <span className="font-mono text-[13px] font-semibold text-accent">{s.n}</span>
              <h3 className="font-display text-[26px] leading-tight">{s.title}</h3>
              <p className="text-[15px] leading-relaxed text-ink-2">{s.text}</p>
              <StepVisual index={i} />
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

/** A small, static picture of each step. Invented question and figures, styled like the product. */
function StepVisual({ index }: { index: number }) {
  if (index === 0) {
    return (
      <div aria-hidden="true" className="mt-2 flex flex-col gap-2">
        <div className="rounded-control border border-line-strong bg-surface px-3 py-2.5 text-[13px] text-ink">
          Where should a coffee brand open its next Chicago café?
        </div>
        <p className="font-mono text-[10.5px] text-ink-3">Read as: Where to open · Chicago, IL</p>
      </div>
    );
  }
  if (index === 1) {
    const rows: [string, "done" | "run"][] = [
      ["Read as Where to open, Chicago", "done"],
      ["Guesses written before data", "done"],
      ["Scanning Chicago areas", "run"],
    ];
    return (
      <ul aria-hidden="true" className="mt-2 flex flex-col gap-2 rounded-control border border-line bg-canvas p-3">
        {rows.map(([t, st]) => (
          <li key={t} className="flex items-center gap-2 text-[12.5px] text-ink-2">
            <Icon
              name={st === "done" ? "circle-check" : "circle-dot"}
              size={14}
              className={st === "done" ? "text-good" : "text-accent"}
            />
            {t}
          </li>
        ))}
      </ul>
    );
  }
  return (
    <div aria-hidden="true" className="mt-2 flex flex-col gap-2 rounded-control border border-line bg-canvas p-3">
      <div className="flex items-center justify-between text-[12.5px] text-ink-2">
        <span>Top area lift</span>
        <span className="rounded-xs bg-accent-soft px-1.5 py-0.5 font-mono text-xs font-semibold text-accent-ink">
          1.42×
        </span>
      </div>
      <p className="font-mono text-[10.5px] text-ink-3">Qloo · area affinity · retrieved with the answer</p>
      <p className="flex items-center gap-2 text-[12.5px] font-medium text-good-ink">
        <Icon name="badge-check" size={14} />
        Every number checked
      </p>
    </div>
  );
}

/* ---------- desks ---------- */

function Desks() {
  return (
    <section id="desks" aria-labelledby="landing-desks" className={cx("scroll-mt-16 py-16 sm:py-[104px]", GUTTER)}>
      <div className={cx(INNER, "flex flex-col gap-16 sm:gap-[88px]")}>
        <div className="flex flex-col gap-4">
          <Eyebrow>{DESKS_HEAD.eyebrow}</Eyebrow>
          <h2 id="landing-desks" className="max-w-[820px] font-display text-[30px] leading-[1.12] tracking-[-0.01em] sm:text-[44px]">
            {DESKS_HEAD.title}
          </h2>
        </div>
        {DESKS.map((d, i) => (
          <Desk key={d.id} desk={d} flip={i % 2 === 1} />
        ))}
        <div className="flex flex-col gap-5">
          <Eyebrow>{ALSO_TITLE}</Eyebrow>
          <ul className="grid gap-px overflow-hidden rounded-card border border-line bg-line md:grid-cols-3">
            {ALSO.map((a) => (
              <li key={a.title} className="bg-surface">
                <Link href={a.href} className="group flex h-full flex-col gap-3 p-6 transition-colors hover:bg-canvas">
                  <span className="flex items-center justify-between font-display text-[22px]">
                    {a.title}
                    <Icon name="arrow-right" size={16} className="text-ink-3 transition-colors group-hover:text-accent" />
                  </span>
                  <span className="text-sm leading-relaxed text-ink-2">{a.text}</span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

function Desk({ desk, flip }: { desk: LandingDesk; flip: boolean }) {
  return (
    <article
      aria-labelledby={`desk-${desk.id}`}
      className="grid items-center gap-8 lg:grid-cols-2 lg:gap-[72px]"
      data-desk={desk.id}
    >
      <div className={cx("overflow-hidden rounded-md bg-sunken", flip && "lg:order-2")}>
        <Image
          src={desk.image}
          alt={desk.imageAlt}
          width={1200}
          height={880}
          sizes="(min-width: 1024px) 600px, 100vw"
          className="h-auto w-full"
        />
      </div>
      <div className="flex flex-col gap-5">
        <p className="font-mono text-[11px] tracking-[0.08em] text-ink-3 uppercase">{desk.eyebrow}</p>
        <h3 id={`desk-${desk.id}`} className="font-display text-[28px] leading-tight sm:text-[34px]">
          {desk.title}
        </h3>
        <p className="text-base leading-relaxed text-ink-2">{desk.text}</p>
        <ul aria-label={`${desk.title}: jobs`} className="border-t border-line">
          {desk.jobs.map((j) => (
            <li key={j.code} className="flex items-center justify-between border-b border-line py-3">
              <span className="text-[15px] font-medium text-ink">{j.name}</span>
              <span className="font-mono text-[11px] text-ink-3">{j.code}</span>
            </li>
          ))}
        </ul>
        <p className="flex items-center gap-2 text-[13px] text-ink-3">
          <Icon name="circle-question-mark" size={14} />
          {desk.limit}
        </p>
      </div>
    </article>
  );
}

/* ---------- figures ---------- */

function Figures() {
  return (
    <section aria-labelledby="landing-figures" className={cx("border-t border-line py-16 sm:py-[104px]", GUTTER)}>
      <div className={cx(INNER, "flex flex-col gap-10")}>
        <SectionHead id="landing-figures" eyebrow={FIGURES.eyebrow} title={FIGURES.title} lead={FIGURES.lead} />
        <figure className="overflow-hidden rounded-md border border-line bg-surface">
          <Image
            src="/landing/figure-map.webp"
            alt={FIGURES.mapAlt}
            width={2560}
            height={1040}
            sizes="(min-width: 1440px) 1280px, 100vw"
            className="h-auto w-full"
          />
        </figure>
        <figure className="flex flex-col gap-3">
          <Image
            src="/landing/figure-table.webp"
            alt={FIGURES.tableAlt}
            width={2560}
            height={1702}
            sizes="(min-width: 1440px) 1280px, 100vw"
            className="h-auto w-full"
          />
          <figcaption className="font-mono text-[11px] text-ink-3">{HERO.visualNote}</figcaption>
        </figure>
      </div>
    </section>
  );
}

/* ---------- honesty ---------- */

function Honesty() {
  return (
    <section
      id="honesty"
      aria-labelledby="landing-honesty"
      className={cx("scroll-mt-16 border-t border-line bg-surface py-16 sm:py-28", GUTTER)}
    >
      <div className={cx(INNER, "flex flex-col gap-16")}>
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-[72px]">
          <div className="flex flex-col gap-5">
            <Eyebrow>{HONESTY.eyebrow}</Eyebrow>
            <h2 id="landing-honesty" className="font-display text-[34px] leading-[1.08] tracking-[-0.01em] sm:text-[52px]">
              {HONESTY.title}
            </h2>
            <p className="text-[17px] leading-relaxed text-ink-2">{HONESTY.lead}</p>
            <ul className="mt-4 flex flex-col">
              {HONESTY_POINTS.map((p) => (
                <li key={p.title} className="flex gap-4 border-t border-line py-5">
                  <Icon name="shield-check" size={18} className="mt-0.5 shrink-0 text-accent" />
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-base font-semibold">{p.title}</h3>
                    <p className="text-sm leading-relaxed text-ink-2">{p.text}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
          <div className="flex flex-col gap-4">
            <p className="font-mono text-[10.5px] tracking-[0.08em] text-ink-3 uppercase">{APART.label}</p>
            <div className="flex flex-col gap-3 rounded-card border border-line bg-accent-soft/40 p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">{APART.aiTitle}</h3>
                <span className="font-mono text-[11px] text-ink-3">{APART.aiSub}</span>
              </div>
              <p className="text-sm leading-relaxed text-ink-2">{APART.aiText}</p>
              <p className="text-xs text-ink-3">{APART.aiNote}</p>
            </div>
            <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Icon name="external-link" size={14} className="text-ink-3" />
                  {APART.webTitle}
                </h3>
                <span className="font-mono text-[11px] text-ink-3">{APART.webSub}</span>
              </div>
              <p className="text-sm leading-relaxed text-ink-2">{APART.webText}</p>
            </div>
            <div className="flex flex-col gap-2 rounded-card border border-line border-l-[3px] border-l-caution bg-surface p-5">
              <h3 className="font-display text-lg">{APART.confTitle}</h3>
              <p className="text-[13px] leading-relaxed text-ink-2">{APART.confText}</p>
            </div>
          </div>
        </div>
        <div className="grid gap-6 md:grid-cols-2">
          <BoundaryList title={DONT_TITLE} items={DONT} />
          <BoundaryList title={CANNOT_TITLE} items={CANNOT} />
        </div>
      </div>
    </section>
  );
}

function BoundaryList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="flex flex-col gap-4 rounded-card bg-sunken p-6 sm:p-8">
      <h3 className="font-display text-2xl">{title}</h3>
      <ul className="flex flex-col gap-3">
        {items.map((t) => (
          <li key={t} className="flex gap-3 text-[15px] leading-snug text-ink-2">
            <span aria-hidden="true" className="mt-2 h-px w-3 shrink-0 bg-ink-3" />
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------- limits and coverage ---------- */

function Limits() {
  return (
    <section
      id="limits"
      aria-labelledby="landing-limits"
      className={cx("scroll-mt-16 border-t border-line py-16 sm:py-[104px]", GUTTER)}
    >
      <div className={cx(INNER, "flex flex-col gap-12")}>
        <div className="flex flex-col gap-4">
          <Eyebrow>{LIMITS.eyebrow}</Eyebrow>
          <h2 id="landing-limits" className="max-w-[780px] font-display text-[30px] leading-[1.12] tracking-[-0.01em] sm:text-[44px]">
            {LIMITS.title}
          </h2>
        </div>
        <div className="grid gap-6 lg:grid-cols-2">
          <div className="flex flex-col gap-6 rounded-card border border-line bg-surface p-6 sm:p-8">
            <div className="flex items-start justify-between gap-4">
              <div className="flex flex-col gap-1.5">
                <h3 className="font-display text-[30px] leading-tight">{LIMITS.planName}</h3>
                <p className="text-[15px] text-ink-2">{LIMITS.planText}</p>
              </div>
              <span className="rounded-xs bg-good-soft px-2 py-1 text-[10.5px] font-semibold tracking-[0.08em] text-good-ink uppercase">
                {LIMITS.planBadge}
              </span>
            </div>
            <dl className="border-t border-line">
              {LIMITS.rows.map((r) => (
                <div key={r.a} className="grid gap-1 border-b border-line py-3 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4">
                  <dt className="text-sm font-medium">{r.a}</dt>
                  <dd className="text-sm text-ink-2">{r.b}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <PrimaryLink href={ASK_HREF}>{START_LABEL}</PrimaryLink>
              <Link href={LIMITS.planHref} className="text-sm font-medium text-accent hover:text-accent-hover">
                {LIMITS.planLink}
              </Link>
            </div>
            <p className="text-[13px] text-ink-3">{LIMITS.note}</p>
            <div className="flex flex-col gap-1.5 rounded-control bg-canvas p-4">
              <p className="font-mono text-[9.5px] tracking-[0.08em] text-ink-3 uppercase">{LIMITS.hitLabel}</p>
              <p className="text-[13px] text-ink-2">{LIMITS.hitText}</p>
            </div>
          </div>
          <div className="flex flex-col gap-6 rounded-card border border-line bg-surface p-6 sm:p-8">
            <h3 className="font-display text-[26px]">{COVERAGE.title}</h3>
            <dl className="grid grid-cols-2 gap-6">
              {COVERAGE.stats.map((s) => (
                <div key={s.n} className="flex flex-col gap-1">
                  <dt className="order-2 text-[13px] text-ink-2">{s.label}</dt>
                  <dd className="order-1 font-mono text-[40px] leading-none font-medium text-ink">{s.n}</dd>
                </div>
              ))}
            </dl>
            <p className="text-sm leading-relaxed text-ink">{COVERAGE.cities}</p>
            <ul className="flex flex-col gap-2.5 border-t border-line pt-5">
              {COVERAGE.notes.map((n) => (
                <li key={n} className="flex gap-2.5 text-[13.5px] text-ink-2">
                  <Icon name="map-pin" size={14} className="mt-0.5 shrink-0 text-ink-3" />
                  {n}
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ---------- questions ---------- */

function Questions() {
  return (
    <section aria-labelledby="landing-faq" className={cx("border-t border-line bg-surface py-16 sm:py-[104px]", GUTTER)}>
      <div className={cx(INNER, "grid gap-10 lg:grid-cols-[360px_minmax(0,1fr)] lg:gap-[72px]")}>
        <div className="flex flex-col gap-5">
          <Eyebrow>{FAQ_HEAD.eyebrow}</Eyebrow>
          <h2 id="landing-faq" className="font-display text-[30px] leading-[1.12] sm:text-[40px]">
            {FAQ_HEAD.title}
          </h2>
          <p className="text-[15px] text-ink-2">{FAQ_HEAD.lead}</p>
          <Link href="/method" className="inline-flex items-center gap-1.5 text-[15px] font-medium text-accent hover:text-accent-hover">
            {FAQ_HEAD.link}
            <Icon name="arrow-right" size={14} />
          </Link>
        </div>
        <div className="border-t border-line">
          {FAQ.map((f, i) => (
            <details key={f.q} open={i === 0} className="group border-b border-line">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 [&::-webkit-details-marker]:hidden">
                <span className="font-display text-[19px] sm:text-[21px]">{f.q}</span>
                <Icon name="chevron-down" size={18} className="shrink-0 text-ink-3 transition-transform group-open:rotate-180" />
              </summary>
              <p className="max-w-[680px] pb-6 text-[15px] leading-relaxed text-ink-2">{f.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ---------- final call to action ---------- */

function FinalCta() {
  return (
    <section aria-labelledby="landing-final" className={cx("border-t border-line py-16 sm:py-24", GUTTER)}>
      <div className={cx(INNER, "flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between lg:gap-16")}>
        <div className="flex max-w-[780px] flex-col gap-6">
          <h2 id="landing-final" className="font-display text-[34px] leading-[1.08] tracking-[-0.01em] sm:text-[48px]">
            {FINAL.title}
          </h2>
          <p className="text-[17px] leading-relaxed text-ink-2">{FINAL.lead}</p>
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <PrimaryLink href={ASK_HREF}>
            {START_LABEL}
            <Icon name="arrow-right" size={16} />
          </PrimaryLink>
          <SecondaryLink href="/method">{FINAL.secondary}</SecondaryLink>
        </div>
      </div>
    </section>
  );
}

/* ---------- footer ---------- */

function LandingFooter() {
  return (
    <footer className={cx("border-t border-line bg-surface pt-12 pb-10", GUTTER)}>
      <div className={cx(INNER, "flex flex-col gap-8")}>
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="flex items-center gap-3">
            <LogoMark />
            <span className="font-display text-lg font-medium">Culture Terminal</span>
          </div>
          <div className="grid grid-cols-2 gap-10 sm:gap-16">
            {FOOTER_COLUMNS.map((c) => (
              <nav key={c.title} aria-label={c.title} className="flex flex-col gap-3">
                <p className="font-mono text-[10.5px] tracking-[0.08em] text-ink-3 uppercase">{c.title}</p>
                <ul className="flex flex-col gap-2.5">
                  {c.links.map((l) => (
                    <li key={l.label}>
                      <Link href={l.href} className="text-sm text-ink-2 hover:text-ink">
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t border-line pt-5 text-[12.5px] text-ink-3 lg:flex-row lg:justify-between lg:gap-8">
          <p>{FOOTER_NOTES.caption}</p>
          <p>{FOOTER_NOTES.licences}</p>
        </div>
      </div>
    </footer>
  );
}
