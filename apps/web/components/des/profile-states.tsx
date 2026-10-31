import Link from "next/link";
import type { ReactNode } from "react";
import { ButtonLink } from "../ui/button";
import { Card } from "../ui/card";
import { cx } from "../ui/cx";
import { Icon, type IconName } from "../ui/icons";
import { InlineState } from "../ui/inline-state";
import { Monogram } from "../ui/monogram";
import { Skeleton } from "../ui/skeleton";
import { DES_TYPE_LABEL, desHref, type DesType } from "./des-href";
import { DesSearch } from "./des-search";
import { CHIP, EYEBROW } from "./eyebrow";
import type { DesCandidate, DesOutcome } from "./model";

/**
 * Every profile page that is not a ready profile (built from N16): which one, not found, refused,
 * paused or limited, failed, an address that cannot be read, and the /d search page. One line and one
 * button where the reader acts, then the search box.
 */

/** Popularity from here reads "Widely known". */
const WIDELY_KNOWN = 0.5;

export const LOOK_UP_ID = "look-up";

/** Candidates: one white list with hairline rows, each opening its own profile. */
function Candidates({ candidates, label }: { candidates: readonly DesCandidate[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
      {candidates.map((c, i) => (
        <li key={c.key} className="animate-rise" style={{ animationDelay: `${Math.min(i, 8) * 30}ms` }}>
          <Link
            href={c.href}
            prefetch={false}
            className="group flex min-h-16 items-center gap-4 px-5 py-3 transition-colors duration-150 hover:bg-canvas active:bg-sunken max-sm:gap-3 max-sm:px-4"
            data-candidate={c.key}
          >
            <Monogram name={c.name} size={32} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate type-body-strong text-ink group-hover:text-accent">{c.name}</span>
              <span className="truncate text-[12px] leading-4 text-ink-2">{c.disambiguation ?? "No other detail from Qloo"}</span>
            </span>
            {c.popularity !== null ? (
              <span className={cx(CHIP, "max-sm:hidden", c.popularity >= WIDELY_KNOWN ? "bg-accent-soft font-semibold text-accent" : "bg-sunken font-semibold text-ink-2")}>
                {c.popularity >= WIDELY_KNOWN ? "Widely known" : "Less known"}
              </span>
            ) : null}
            <Icon name="arrow-right" size={16} className="shrink-0 text-ink-2 transition-transform duration-150 group-hover:translate-x-0.5 group-hover:text-accent" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function StateCard({
  icon,
  tone = "neutral",
  title,
  children,
  label,
}: {
  icon: IconName;
  tone?: "neutral" | "danger";
  title: ReactNode;
  children?: ReactNode;
  label: string;
}) {
  return (
    <Card padding="lg" aria-label={label} data-state-card={label} className={cx("flex flex-col gap-3", tone === "danger" && "!border-danger/40")}>
      <div className="flex items-start gap-3">
        <Icon name={icon} size={20} className={cx("mt-[3px] shrink-0", tone === "danger" ? "text-danger" : "text-ink-2")} />
        <h2 className={cx("type-display-s break-words max-md:type-display-s-sm", tone === "danger" ? "text-danger-ink" : "text-ink")}>{title}</h2>
      </div>
      {children ? <div className="flex flex-col gap-4 pl-8 max-sm:pl-0">{children}</div> : null}
    </Card>
  );
}

const lookUpLink = (
  <a href={`#${LOOK_UP_ID}`} className="inline-flex items-center gap-1.5 font-medium text-accent hover:text-accent-hover hover:underline">
    Look up another
    <Icon name="arrow-right" size={14} />
  </a>
);

function OutcomeCard({ outcome, retry }: { outcome: Exclude<DesOutcome, { kind: "ready" }>; retry: string | null }) {
  switch (outcome.kind) {
    case "pick":
      return (
        <section aria-label="Which one" data-state-card="Which one" className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
              <h2 className="font-display text-[20px] leading-7 font-medium break-words text-ink">
                “{outcome.query.name}” could mean a few things. Which one?
              </h2>
              <p className="type-caption text-ink-2">
                {DES_TYPE_LABEL[outcome.query.type]} · {outcome.candidates.length} {outcome.candidates.length === 1 ? "name" : "names"} in Qloo&apos;s data
              </p>
            </div>
          </div>
          <Candidates candidates={outcome.candidates} label="Candidates" />
          <p className="type-label font-normal text-ink-2">Not listed? {lookUpLink}</p>
        </section>
      );
    case "not_found":
      return (
        <StateCard icon="search-x" label="Name not found" title={`“${outcome.query.name}” isn't in Qloo's data.`}>
          <p className="type-body text-ink-2">Check the spelling or use the full name.</p>
          {outcome.candidates.length > 0 ? (
            <div className="flex flex-col gap-3 pt-1">
              <h3 className={EYEBROW}>Closest names in Qloo</h3>
              <Candidates candidates={outcome.candidates} label="Closest names" />
            </div>
          ) : null}
        </StateCard>
      );
    case "refused":
      return (
        <StateCard icon="ban" label="Not looked up" title="We only profile public figures.">
          <p className="type-body text-ink-2">{outcome.message}</p>
        </StateCard>
      );
    case "unavailable":
      return (
        <InlineState
          tone="neutral"
          icon="circle-pause"
          data-state-card="Paused"
          action={
            // A spent daily budget is a limit: the plan page says what it is and when it resets.
            outcome.cause === "budget" ? (
              <Link href="/settings" prefetch={false} className="type-label text-accent hover:text-accent-hover hover:underline">
                See plan
              </Link>
            ) : undefined
          }
        >
          {outcome.message}
        </InlineState>
      );
    case "limited":
      return (
        <InlineState
          tone="neutral"
          icon="clock-4"
          data-state-card="Too many lookups"
          action={
            retry ? (
              <ButtonLink href={retry} prefetch={false} variant="secondary" icon="rotate-ccw" trailing={null}>
                Try again
              </ButtonLink>
            ) : undefined
          }
        >
          {outcome.message}
        </InlineState>
      );
    case "failed":
      return (
        <StateCard icon="circle-x" tone="danger" label="Not finished" title="This profile couldn't be finished.">
          <p className="type-body text-ink">{outcome.message}</p>
          {retry ? (
            <div>
              <ButtonLink
                href={retry}
                prefetch={false}
                variant="primary"
                icon="rotate-ccw"
                trailing={null}
                className="max-md:w-full max-md:justify-center"
              >
                Try again
              </ButtonLink>
            </div>
          ) : null}
        </StateCard>
      );
  }
}

/** The search card, which every state ends on. */
function LookUp({ title, name, type, error }: { title: string; name?: string; type?: DesType; error?: string | null }) {
  return (
    <Card id={LOOK_UP_ID} aria-labelledby={`${LOOK_UP_ID}-title`} className="flex scroll-mt-6 flex-col gap-4 p-6 max-md:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 id={`${LOOK_UP_ID}-title`} className="font-display text-[18px] leading-6 font-medium text-ink">
          {title}
        </h2>
      </div>
      <DesSearch name={name} type={type} error={error} />
    </Card>
  );
}

function Page({
  title,
  labelLine,
  children,
}: {
  title: string;
  labelLine?: string;
  children: ReactNode;
}) {
  return (
    <div className="pt-10 pb-16 max-md:pt-6 max-md:pb-10">
      <div className="flex min-w-0 max-w-[820px] flex-col gap-10 max-md:gap-6 [&>*]:animate-rise [&>*:nth-child(2)]:[animation-delay:60ms] [&>*:nth-child(3)]:[animation-delay:120ms]">
        <header className="flex flex-col gap-3">
          {labelLine ? <p className={EYEBROW}>{labelLine}</p> : null}
          <h1 className="font-display text-[40px] leading-[46px] font-medium tracking-[-0.01em] break-words text-ink max-md:type-display-m-sm">
            {title}
          </h1>
        </header>
        {children}
      </div>
    </div>
  );
}

export interface ProfileStateViewProps {
  /** What was asked, when the address named something a profile can look up. */
  query: { name: string; type: DesType } | null;
  /** The outcome; null when there is nothing to look up (the search page, or an address it cannot read). */
  outcome: Exclude<DesOutcome, { kind: "ready" }> | null;
  /** Shown above the search box when the address or the form could not be read. */
  error?: string | null;
}

export function ProfileStateView({ query, outcome, error = null }: ProfileStateViewProps) {
  if (query === null || outcome === null) {
    return (
      <Page
        title="Look up a profile"
        labelLine="Audience profiles"
      >
        <LookUp title="Name and type" name={query?.name} type={query?.type} error={error} />
      </Page>
    );
  }
  // A refused name is never repeated back: the heading and the search box stay neutral.
  const refused = outcome.kind === "refused";
  const retry = outcome.kind === "failed" || outcome.kind === "limited" ? desHref(query) : null;
  return (
    <Page
      title={refused ? "Look up a profile" : query.name}
      labelLine={refused ? undefined : `${DES_TYPE_LABEL[query.type]} · Audience profile`}
    >
      <OutcomeCard outcome={outcome} retry={retry} />
      <LookUp title="Look up another" name={refused ? "" : undefined} type={query.type} />
    </Page>
  );
}

/** While a profile is computed: the header and the cards as skeletons. */
export function ProfileSkeleton() {
  return (
    <div className="flex flex-col gap-10 pt-12 pb-16 max-md:gap-6 max-md:pt-6" role="status" aria-live="polite" data-profile-loading="true">
      <span className="sr-only">Reading Qloo…</span>
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 rounded-tile max-md:size-12" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-56 max-md:w-40" />
          <Skeleton className="h-9 w-64 max-md:w-44" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-px overflow-hidden rounded-card border border-line bg-line max-md:grid-cols-1">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-3 bg-surface p-5">
            <Skeleton className="h-3 w-28" />
            <Skeleton className="h-8 w-36" />
            <Skeleton className="h-3 w-48" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-6 max-lg:grid-cols-1">
        <Skeleton className="h-[416px] rounded-card" />
        <Skeleton className="h-[416px] rounded-card max-lg:hidden" />
      </div>
    </div>
  );
}
