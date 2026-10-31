import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { LogoMark } from "../chrome/logo-mark";
import { Icon } from "../ui/icons";
import { cx } from "../ui/cx";
import { Faq, HeroParallax, LandingMotion, Reveal, RevealItem, RevealList } from "./motion-bits";
import {
  ALSO,
  ALSO_TITLE,
  APART,
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
  LOGIN_HREF,
  LOGIN_LABEL,
  NAV_LINKS,
  SIGNUP_HREF,
  SIGNUP_LABEL,
  SOURCES,
  SOURCES_TITLE,
  STEPS,
  type LandingDesk,
} from "./content";

/**
 * The marketing landing (/welcome), direction A "Ledger": nav, hero with the product visual, sources,
 * how it works, the four desks, the figures, honesty, limits and coverage, questions, final call to
 * action and footer. Static apart from light entrance motion. The calls to action lead to account
 * creation (/signup) and sign-in (/login). Rendered at /welcome and, for signed-out visitors, at "/".
 */
export function LandingPage() {
  return (
    <LandingMotion>
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
    </LandingMotion>
  );
}

/* ---------- shared bits ---------- */

const GUTTER = "px-4 sm:px-8 lg:px-20";
const INNER = "mx-auto w-full max-w-[1280px]";

function Eyebrow({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return (
    <p
      className={cx(
        "flex items-center gap-2.5 font-mono text-[12px] font-medium tracking-[0.12em] uppercase",
        dark ? "text-[#a9b8ea]" : "text-accent",
      )}
    >
      <span aria-hidden="true" className="h-px w-6 bg-current" />
      {children}
    </p>
  );
}

function PrimaryLink({ href, children, className }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={cx(
        "group inline-flex h-12 items-center justify-center gap-2.5 rounded-control bg-accent px-[22px] text-[15px] font-medium text-surface shadow-md transition-[background-color,transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:bg-accent-hover hover:shadow-lg active:translate-y-0 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
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
        "inline-flex h-12 items-center justify-center gap-2.5 rounded-control border border-line-strong bg-surface px-5 text-[15px] font-medium text-ink transition-[border-color,background-color,transform] duration-150 ease-out hover:border-ink-3 hover:bg-canvas active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        className,
      )}
    >
      {children}
    </Link>
  );
}

function SectionHead({
  eyebrow,
  title,
  lead,
  id,
  dark = false,
}: {
  eyebrow: string;
  title: string;
  lead?: string;
  id?: string;
  dark?: boolean;
}) {
  return (
    <Reveal className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px] lg:items-end lg:gap-16">
      <div className="flex flex-col gap-4">
        <Eyebrow dark={dark}>{eyebrow}</Eyebrow>
        <h2
          id={id}
          className={cx(
            "max-w-[780px] font-display text-[32px] leading-[1.1] tracking-[-0.015em] sm:text-[46px]",
            dark && "text-canvas",
          )}
        >
          {title}
        </h2>
      </div>
      {lead ? <p className={cx("text-base leading-relaxed", dark ? "text-[#c9cbd1]" : "text-ink-2")}>{lead}</p> : null}
    </Reveal>
  );
}

/* ---------- nav ---------- */

function LandingNav() {
  return (
    <header className={cx("sticky top-0 z-30 border-b border-line bg-canvas/90 backdrop-blur-md", GUTTER)}>
      <nav aria-label="Landing" className={cx(INNER, "flex h-[68px] items-center justify-between gap-6")}>
        <Link href="/welcome" className="flex items-center gap-3" aria-label="Culture Terminal, welcome">
          <LogoMark />
          <span className="hidden font-display text-lg font-medium sm:inline">Culture Terminal</span>
        </Link>
        <ul className="hidden items-center gap-8 lg:flex">
          {NAV_LINKS.map((l) => (
            <li key={l.label}>
              <Link href={l.href} className="text-sm text-ink-2 transition-colors duration-150 hover:text-ink">
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
        <div className="flex items-center gap-2">
          <Link
            href={LOGIN_HREF}
            className="inline-flex h-9 items-center rounded-control px-3.5 text-[13px] font-medium text-ink transition-colors duration-150 hover:bg-sunken active:bg-line"
          >
            {LOGIN_LABEL}
          </Link>
          <Link
            href={SIGNUP_HREF}
            className="group inline-flex h-9 items-center gap-2 rounded-control bg-accent px-4 text-[13px] font-medium text-surface transition-[background-color,transform] duration-150 ease-out hover:bg-accent-hover active:scale-[0.97]"
          >
            {SIGNUP_LABEL}
            <Icon name="arrow-right" size={14} className="transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
          </Link>
        </div>
      </nav>
    </header>
  );
}

/* ---------- hero ---------- */

function Hero() {
  return (
    <section
      id="product"
      aria-labelledby="landing-title"
      className={cx("relative scroll-mt-16 overflow-hidden pt-12 sm:pt-[88px]", GUTTER)}
    >
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[46%] border-t border-line bg-sunken"
      />
      <div className={cx(INNER, "relative flex flex-col gap-12 sm:gap-14")}>
        <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-end lg:gap-16">
          <div className="flex flex-col gap-6">
            <div className="animate-rise">
              <Eyebrow>{HERO.eyebrow}</Eyebrow>
            </div>
            <h1
              id="landing-title"
              style={{ animationDelay: "60ms" }}
              className="animate-rise font-display text-[40px] leading-[1.04] tracking-[-0.025em] text-ink sm:text-[58px] xl:text-[68px]"
            >
              {HERO.title}
            </h1>
          </div>
          <div className="flex flex-col gap-6 lg:pb-2">
            <p style={{ animationDelay: "120ms" }} className="animate-rise text-[17px] leading-relaxed text-ink-2">
              {HERO.lead}
            </p>
            <div style={{ animationDelay: "180ms" }} className="animate-rise flex flex-col gap-2.5 sm:flex-row">
              <PrimaryLink href={SIGNUP_HREF}>
                {SIGNUP_LABEL}
                <Icon name="arrow-right" size={16} className="transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
              </PrimaryLink>
              <SecondaryLink href="#how">
                <Icon name="circle-play" size={14} />
                {HERO.secondary}
              </SecondaryLink>
            </div>
          </div>
        </div>
        <HeroParallax className="animate-rise flex flex-col gap-3 pb-12 [animation-delay:240ms] [animation-duration:420ms] sm:pb-20">
          <figure className="overflow-hidden rounded-t-[10px] rounded-b-md border border-line-strong/70 bg-surface shadow-[0_40px_80px_-24px_#16181d40,0_12px_28px_-12px_#16181d24]">
            <div aria-hidden="true" className="flex h-10 items-center gap-4 border-b border-line bg-sunken px-4">
              <span className="flex gap-1.5">
                <span className="size-2.5 rounded-full bg-line-strong" />
                <span className="size-2.5 rounded-full bg-line-strong" />
                <span className="size-2.5 rounded-full bg-line-strong" />
              </span>
              <span className="flex h-6 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-control bg-surface px-3 font-mono text-[11px] text-ink-3">
                <svg
                  width="11"
                  height="11"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <rect width="18" height="11" x="3" y="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
                <span className="truncate">cultureterminal.com/r/northwind-chicago-site</span>
              </span>
              <span className="hidden w-[46px] sm:block" />
            </div>
            <Image
              src="/landing/hero-app.webp"
              alt={HERO.visualAlt}
              width={2560}
              height={1440}
              sizes="(min-width: 1440px) 1280px, 100vw"
              fetchPriority="high"
              loading="eager"
              className="h-auto w-full"
            />
            <figcaption className="sr-only">{HERO.visualNote}</figcaption>
          </figure>
          <p aria-hidden="true" className="font-mono text-[11px] text-ink-2">
            {HERO.visualNote}
          </p>
        </HeroParallax>
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
        <RevealList className="grid border-y border-line sm:grid-cols-2 lg:grid-cols-5">
          {SOURCES.map((s, i) => (
            <RevealItem
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
            </RevealItem>
          ))}
        </RevealList>
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
        <RevealList as="ol" className="grid gap-10 md:grid-cols-3 md:gap-8">
          {STEPS.map((s, i) => (
            <RevealItem key={s.n} className="flex flex-col gap-4 border-t-2 border-ink pt-6">
              <span className="font-mono text-[13px] font-semibold text-accent">{s.n}</span>
              <h3 className="font-display text-[26px] leading-tight">{s.title}</h3>
              <p className="text-[15px] leading-relaxed text-ink-2">{s.text}</p>
              <StepVisual index={i} />
            </RevealItem>
          ))}
        </RevealList>
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
        <Reveal className="flex flex-col gap-4">
          <Eyebrow>{DESKS_HEAD.eyebrow}</Eyebrow>
          <h2
            id="landing-desks"
            className="max-w-[820px] font-display text-[32px] leading-[1.1] tracking-[-0.015em] sm:text-[46px]"
          >
            {DESKS_HEAD.title}
          </h2>
        </Reveal>
        {DESKS.map((d, i) => (
          <Desk key={d.id} desk={d} flip={i % 2 === 1} />
        ))}
        <Reveal className="flex flex-col gap-5">
          <Eyebrow>{ALSO_TITLE}</Eyebrow>
          <RevealList className="grid gap-px overflow-hidden rounded-card border border-line bg-line shadow-xs md:grid-cols-3">
            {ALSO.map((a) => (
              <RevealItem key={a.title} className="bg-surface">
                <Link
                  href={a.href}
                  className="group flex h-full flex-col gap-3 p-6 transition-colors duration-150 hover:bg-canvas active:bg-sunken"
                >
                  <span className="flex items-center justify-between font-display text-[22px]">
                    {a.title}
                    <Icon
                      name="arrow-right"
                      size={16}
                      className="text-ink-3 transition-[color,transform] duration-150 ease-out group-hover:translate-x-0.5 group-hover:text-accent"
                    />
                  </span>
                  <span className="text-sm leading-relaxed text-ink-2">{a.text}</span>
                </Link>
              </RevealItem>
            ))}
          </RevealList>
        </Reveal>
      </div>
    </section>
  );
}

function Desk({ desk, flip }: { desk: LandingDesk; flip: boolean }) {
  return (
    <Reveal>
      <article
        aria-labelledby={`desk-${desk.id}`}
        className="grid items-center gap-8 lg:grid-cols-2 lg:gap-[72px]"
        data-desk={desk.id}
      >
        <div className={cx("group overflow-hidden rounded-md bg-sunken shadow-lg", flip && "lg:order-2")}>
          <Image
            src={desk.image}
            alt={desk.imageAlt}
            width={1200}
            height={880}
            sizes="(min-width: 1024px) 600px, 100vw"
            className="h-auto w-full transition-transform duration-500 ease-out group-hover:scale-[1.02] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
          />
        </div>
        <div className="flex flex-col gap-5">
          <p className="font-mono text-[11px] font-medium tracking-[0.1em] text-accent uppercase">{desk.eyebrow}</p>
          <h3
            id={`desk-${desk.id}`}
            className="font-display text-[30px] leading-tight tracking-[-0.01em] sm:text-[38px]"
          >
            {desk.title}
          </h3>
          <p className="text-base leading-relaxed text-ink-2">{desk.text}</p>
          <RevealList label={`${desk.title}: jobs`} className="border-t border-line">
            {desk.jobs.map((j) => (
              <RevealItem key={j.code} className="flex items-center justify-between border-b border-line py-3">
                <span className="text-[15px] font-medium text-ink">{j.name}</span>
                <span className="font-mono text-[11px] text-ink-3">{j.code}</span>
              </RevealItem>
            ))}
          </RevealList>
          <p className="flex items-center gap-2 text-[13px] text-ink-2">
            <Icon name="circle-question-mark" size={14} className="shrink-0 text-ink-3" />
            {desk.limit}
          </p>
        </div>
      </article>
    </Reveal>
  );
}

/* ---------- figures ---------- */

function Figures() {
  return (
    <section aria-labelledby="landing-figures" className={cx("bg-ink py-16 text-canvas sm:py-[104px]", GUTTER)}>
      <div className={cx(INNER, "flex flex-col gap-10")}>
        <SectionHead dark id="landing-figures" eyebrow={FIGURES.eyebrow} title={FIGURES.title} lead={FIGURES.lead} />
        <Reveal>
          <figure className="overflow-hidden rounded-md bg-surface shadow-[0_30px_60px_-20px_#000a]">
            <Image
              src="/landing/figure-map.webp"
              alt={FIGURES.mapAlt}
              width={2560}
              height={1040}
              sizes="(min-width: 1440px) 1280px, 100vw"
              className="h-auto w-full"
            />
          </figure>
        </Reveal>
        <Reveal>
          <figure className="flex flex-col gap-3">
            <div className="overflow-hidden rounded-md bg-surface p-4 shadow-[0_30px_60px_-20px_#000a] sm:p-6">
              <Image
                src="/landing/figure-table.webp"
                alt={FIGURES.tableAlt}
                width={2560}
                height={1702}
                sizes="(min-width: 1440px) 1280px, 100vw"
                className="h-auto w-full"
              />
            </div>
            <figcaption className="font-mono text-[11px] text-[#c9cbd1]">{HERO.visualNote}</figcaption>
          </figure>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- honesty ---------- */

function Honesty() {
  return (
    <section id="honesty" aria-labelledby="landing-honesty" className={cx("scroll-mt-16 py-16 sm:py-28", GUTTER)}>
      <div className={cx(INNER, "flex flex-col gap-16")}>
        <Reveal className="grid gap-12 lg:grid-cols-2 lg:gap-[72px]">
          <div className="flex flex-col gap-5">
            <Eyebrow>{HONESTY.eyebrow}</Eyebrow>
            <h2
              id="landing-honesty"
              className="font-display text-[36px] leading-[1.06] tracking-[-0.02em] sm:text-[56px]"
            >
              {HONESTY.title}
            </h2>
            <p className="text-[17px] leading-relaxed text-ink-2">{HONESTY.lead}</p>
            <RevealList className="mt-4 flex flex-col">
              {HONESTY_POINTS.map((p) => (
                <RevealItem key={p.title} className="flex gap-4 border-t border-line py-5">
                  <Icon name="shield-check" size={18} className="mt-0.5 shrink-0 text-accent" />
                  <div className="flex flex-col gap-1.5">
                    <h3 className="text-base font-semibold">{p.title}</h3>
                    <p className="text-sm leading-relaxed text-ink-2">{p.text}</p>
                  </div>
                </RevealItem>
              ))}
            </RevealList>
          </div>
          <div className="flex flex-col gap-4 lg:pt-2">
            <p className="font-mono text-[11px] tracking-[0.08em] text-ink-2 uppercase">{APART.label}</p>
            <div className="flex flex-col gap-3 rounded-card border border-[#cfd6ee] bg-accent-soft p-5 shadow-xs">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-sm font-semibold">{APART.aiTitle}</h3>
                <span className="font-mono text-[11px] text-ink-3">{APART.aiSub}</span>
              </div>
              <p className="text-sm leading-relaxed text-ink-2">{APART.aiText}</p>
            </div>
            <div className="flex flex-col gap-3 rounded-card border border-line bg-surface p-5 shadow-xs">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className="flex items-center gap-2 text-sm font-semibold">
                  <Icon name="external-link" size={14} className="text-ink-3" />
                  {APART.webTitle}
                </h3>
                <span className="font-mono text-[11px] text-ink-3">{APART.webSub}</span>
              </div>
              <p className="text-sm leading-relaxed text-ink-2">{APART.webText}</p>
            </div>
            <div className="flex flex-col gap-2 rounded-card border border-line border-l-[3px] border-l-caution bg-surface p-5 shadow-xs">
              <h3 className="font-display text-lg">{APART.confTitle}</h3>
              <p className="text-[13px] leading-relaxed text-ink-2">{APART.confText}</p>
            </div>
          </div>
        </Reveal>
        <Reveal className="grid gap-6 md:grid-cols-2">
          <BoundaryList title={DONT_TITLE} items={DONT} />
          <BoundaryList title={CANNOT_TITLE} items={CANNOT} />
        </Reveal>
      </div>
    </section>
  );
}

function BoundaryList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <div className="flex flex-col gap-4 rounded-card border border-line bg-sunken p-6 sm:p-8">
      <h3 className="font-display text-[26px]">{title}</h3>
      <ul className="flex flex-col gap-3">
        {items.map((t) => (
          <li key={t} className="flex gap-3 text-[15px] leading-snug text-ink-2">
            <span aria-hidden="true" className="mt-2.5 h-px w-3 shrink-0 bg-ink-2" />
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
      className={cx("scroll-mt-16 border-y border-line bg-surface py-16 sm:py-[104px]", GUTTER)}
    >
      <div className={cx(INNER, "flex flex-col gap-12")}>
        <Reveal className="flex flex-col gap-4">
          <Eyebrow>{LIMITS.eyebrow}</Eyebrow>
          <h2
            id="landing-limits"
            className="max-w-[780px] font-display text-[32px] leading-[1.1] tracking-[-0.015em] sm:text-[46px]"
          >
            {LIMITS.title}
          </h2>
        </Reveal>
        <Reveal className="grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-6 rounded-card border border-line-strong bg-surface p-6 shadow-md sm:p-8">
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
                <div
                  key={r.a}
                  className="grid gap-1 border-b border-line py-3 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-4"
                >
                  <dt className="text-sm font-medium">{r.a}</dt>
                  <dd className="text-sm text-ink-2">{r.b}</dd>
                </div>
              ))}
            </dl>
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <PrimaryLink href={SIGNUP_HREF}>
                {SIGNUP_LABEL}
                <Icon name="arrow-right" size={16} className="transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
              </PrimaryLink>
              <Link
                href={LIMITS.planHref}
                className="text-sm font-medium text-accent underline-offset-4 transition-colors duration-150 hover:text-accent-hover hover:underline"
              >
                {LIMITS.planLink}
              </Link>
            </div>
            <p className="text-[13px] text-ink-2">{LIMITS.note}</p>
          </div>
          <div className="flex flex-col gap-6 rounded-card border border-line bg-sunken p-6 sm:p-8">
            <h3 className="font-display text-[26px] italic">{COVERAGE.title}</h3>
            <RevealList as="dl" className="grid grid-cols-2 gap-6">
              {COVERAGE.stats.map((s) => (
                <RevealItem as="div" key={s.n} className="flex flex-col gap-1">
                  <dt className="order-2 text-[13px] text-ink-2">{s.label}</dt>
                  <dd className="order-1 font-mono text-[40px] leading-none font-medium text-ink">{s.n}</dd>
                </RevealItem>
              ))}
            </RevealList>
            <p className="text-sm leading-relaxed text-ink">{COVERAGE.cities}</p>
            <ul className="flex flex-col gap-2.5 border-t border-line pt-5">
              {COVERAGE.notes.map((n) => (
                <li key={n} className="flex gap-2.5 text-[13.5px] text-ink-2">
                  <Icon name="map-pin" size={14} className="mt-0.5 shrink-0 text-accent" />
                  {n}
                </li>
              ))}
            </ul>
          </div>
        </Reveal>
      </div>
    </section>
  );
}

/* ---------- questions ---------- */

function Questions() {
  return (
    <section aria-labelledby="landing-faq" className={cx("py-16 sm:py-[104px]", GUTTER)}>
      <div className={cx(INNER, "grid gap-10 lg:grid-cols-[360px_minmax(0,1fr)] lg:gap-[72px]")}>
        <Reveal className="flex flex-col gap-5">
          <Eyebrow>{FAQ_HEAD.eyebrow}</Eyebrow>
          <h2 id="landing-faq" className="font-display text-[32px] leading-[1.1] tracking-[-0.015em] sm:text-[42px]">
            {FAQ_HEAD.title}
          </h2>
          <p className="text-[15px] text-ink-2">{FAQ_HEAD.lead}</p>
          <Link
            href="/method"
            className="group inline-flex items-center gap-1.5 text-[15px] font-medium text-accent transition-colors duration-150 hover:text-accent-hover"
          >
            {FAQ_HEAD.link}
            <Icon name="arrow-right" size={14} className="transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
          </Link>
        </Reveal>
        <Faq items={FAQ} />
      </div>
    </section>
  );
}

/* ---------- final call to action ---------- */

function FinalCta() {
  return (
    <section aria-labelledby="landing-final" className={cx("bg-accent py-16 text-surface sm:py-24", GUTTER)}>
      <Reveal className={cx(INNER, "flex flex-col gap-8 lg:flex-row lg:items-end lg:justify-between lg:gap-16")}>
        <div className="flex max-w-[780px] flex-col gap-6">
          <h2 id="landing-final" className="font-display text-[36px] leading-[1.06] tracking-[-0.02em] sm:text-[52px]">
            {FINAL.title}
          </h2>
          <p className="text-[17px] leading-relaxed text-[#dfe5f7]">{FINAL.lead}</p>
        </div>
        <div className="flex shrink-0 flex-col gap-2.5 whitespace-nowrap sm:flex-row sm:items-center">
          <Link
            href={SIGNUP_HREF}
            className="group inline-flex h-12 items-center justify-center gap-2.5 rounded-control bg-surface px-[22px] text-[15px] font-medium text-accent shadow-md transition-[transform,box-shadow] duration-150 ease-out hover:-translate-y-px hover:shadow-lg active:translate-y-0 active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-surface"
          >
            {SIGNUP_LABEL}
            <Icon name="arrow-right" size={16} className="transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
          </Link>
          <Link
            href={LOGIN_HREF}
            className="inline-flex h-12 items-center justify-center rounded-control border border-[#ffffff80] px-5 text-[15px] font-medium text-surface transition-[background-color,transform] duration-150 ease-out hover:bg-[#ffffff14] active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-surface"
          >
            {LOGIN_LABEL}
          </Link>
          <Link
            href="/method"
            className="inline-flex h-12 items-center justify-center px-3 text-[15px] font-medium text-[#dfe5f7] underline-offset-4 hover:underline"
          >
            {FINAL.secondary}
          </Link>
        </div>
      </Reveal>
    </section>
  );
}

/* ---------- footer ---------- */

function LandingFooter() {
  return (
    <footer className={cx("bg-canvas pt-14 pb-10", GUTTER)}>
      <div className={cx(INNER, "flex flex-col gap-8")}>
        <div className="flex flex-col gap-10 md:flex-row md:justify-between">
          <div className="flex items-center gap-3 self-start">
            <LogoMark />
            <span className="font-display text-lg font-medium">Culture Terminal</span>
          </div>
          <div className="grid grid-cols-2 gap-10 sm:gap-16">
            {FOOTER_COLUMNS.map((c) => (
              <nav key={c.title} aria-label={c.title} className="flex flex-col gap-3">
                <p className="font-mono text-[11px] tracking-[0.08em] text-ink-2 uppercase">{c.title}</p>
                <ul className="flex flex-col gap-2.5">
                  {c.links.map((l) => (
                    <li key={l.label}>
                      <Link href={l.href} className="text-sm text-ink-2 transition-colors duration-150 hover:text-ink">
                        {l.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-2 border-t border-line pt-5 text-[12.5px] text-ink-2 lg:flex-row lg:justify-between lg:gap-8">
          <p>{FOOTER_NOTES.caption}</p>
          <p>{FOOTER_NOTES.licences}</p>
        </div>
      </div>
    </footer>
  );
}
