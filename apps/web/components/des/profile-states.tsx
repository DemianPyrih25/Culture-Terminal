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
import type { DesCandidate, DesOutcome } from "./model";

/**
 * Every profile page that is not a ready profile (built from N16): which one, not found, refused,
 * paused or limited, failed, an address that cannot be read, and the /d search page. One line and one
 * button where the reader acts, then the search box.
 */

/** Popularity from here reads "Widely known". */
const WIDELY_KNOWN = 0.5;

export const LOOK_UP_ID = "look-up";

function Candidates({ candidates, label }: { candidates: readonly DesCandidate[]; label: string }) {
  return (
    <ul aria-label={label} className="flex flex-col gap-2">
      {candidates.map((c) => (
        <li key={c.key}>
          <Link
            href={c.href}
            prefetch={false}
            className="flex min-h-14 items-center gap-3 rounded-control border border-line bg-surface px-4 py-2 transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-md"
            data-candidate={c.key}
          >
            <Monogram name={c.name} size={32} />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-[15px] leading-6 font-semibold text-ink">{c.name}</span>
              <span className="truncate type-label text-ink-2">{c.disambiguation ?? "No other detail from Qloo"}</span>
            </span>
            {c.popularity !== null ? (
              <span className="shrink-0 type-label text-ink-2 max-sm:hidden">{c.popularity >= WIDELY_KNOWN ? "Widely known" : "Less known"}</span>
            ) : null}
            <Icon name="chevron-right" size={16} className="shrink-0 text-ink-3" />
          </Link>
        </li>
      ))}
    </ul>
  );
}

function StateCard({ icon, tone = "neutral", title, children, label }: { icon: IconName; tone?: "neutral" | "danger"; title: ReactNode; children?: ReactNode; label: string }) {
  return (
    <Card
      padding="lg"
      aria-label={label}
      data-state-card={label}
      className={cx("flex flex-col gap-5", tone === "danger" && "!border-transparent !bg-danger-soft")}
    >
      <Icon name={icon} size={28} className={tone === "danger" ? "text-danger" : "text-ink-2"} />
      <h2 className={cx("type-title-l max-md:type-title-l-sm", tone === "danger" ? "text-danger-ink" : "text-ink")}>{title}</h2>
      {children}
    </Card>
  );
}

const lookUpLink = (
  <a href={`#${LOOK_UP_ID}`} className="inline-flex items-center gap-1.5 font-medium text-accent hover:text-accent-hover">
    Look up another
    <Icon name="arrow-right" size={14} />
  </a>
);

function OutcomeCard({ outcome, retry }: { outcome: Exclude<DesOutcome, { kind: "ready" }>; retry: string | null }) {
  switch (outcome.kind) {
    case "pick":
      return (
        <Card padding="lg" aria-label="Which one" data-state-card="Which one" className="flex flex-col gap-4">
          <h2 className="type-title text-ink max-md:type-title-sm">“{outcome.query.name}” could mean a few things. Which one?</h2>
          <Candidates candidates={outcome.candidates} label="Candidates" />
          <p className="type-label text-ink-2">Not listed? {lookUpLink}</p>
        </Card>
      );
    case "not_found":
      return (
        <StateCard icon="search-x" label="Name not found" title={`“${outcome.query.name}” isn't in Qloo's data.`}>
          <p className="type-body text-ink-2">Check the spelling or use the full name. Nothing was swapped in for you.</p>
          {outcome.candidates.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-[13px] leading-[18px] font-semibold text-ink-2">Closest names in Qloo</h3>
              <Candidates candidates={outcome.candidates} label="Closest names" />
            </div>
          ) : null}
        </StateCard>
      );
    case "refused":
      return (
        <StateCard icon="ban" label="Not looked up" title="We only profile public figures.">
          <p className="type-body text-ink-2">{outcome.message}</p>
          <p className="type-label text-ink-2">Group-level taste only: no individuals.</p>
        </StateCard>
      );
    case "unavailable":
      return (
        <InlineState tone="neutral" icon="circle-pause" data-state-card="Paused">
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
              <ButtonLink href={retry} prefetch={false} variant="primary" icon="rotate-ccw" trailing={null} className="max-md:w-full max-md:justify-center">
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
    <Card id={LOOK_UP_ID} aria-labelledby={`${LOOK_UP_ID}-title`} className="flex scroll-mt-6 flex-col gap-4">
      <h2 id={`${LOOK_UP_ID}-title`} className="type-title text-ink max-md:type-title-sm">
        {title}
      </h2>
      <DesSearch name={name} type={type} error={error} />
    </Card>
  );
}

function Page({ title, labelLine, lead, children }: { title: string; labelLine?: string; lead?: string; children: ReactNode }) {
  return (
    <div className="flex max-w-[744px] flex-col gap-6 pt-10 pb-12 max-md:gap-4 max-md:pt-6 max-md:pb-8">
      <header className="flex flex-col gap-2 pb-3">
        <h1 className="type-display-m break-words text-ink max-md:type-display-m-sm">{title}</h1>
        {labelLine ? <p className="type-label text-ink-2">{labelLine}</p> : null}
        {lead ? <p className="type-lead text-ink-2 max-md:text-[16px] max-md:leading-6">{lead}</p> : null}
      </header>
      {children}
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
      <Page title="Look up a profile" lead="See who a brand's, artist's or show's fans are, what else they love, and where their taste travels.">
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
    <div className="flex flex-col gap-9 pt-10 pb-12 max-md:gap-6 max-md:pt-6" role="status" aria-live="polite" data-profile-loading="true">
      <span className="sr-only">Reading Qloo…</span>
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 rounded-[14px]" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-9 w-64 max-md:w-44" />
          <Skeleton className="h-4 w-80 max-md:w-56" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-6 max-md:grid-cols-1 max-md:gap-4">
        {[0, 1, 2].map((i) => (
          <Skeleton key={i} className="h-[148px] rounded-card max-md:h-[114px]" />
        ))}
      </div>
      <div className="grid grid-cols-2 gap-6 max-lg:grid-cols-1">
        <Skeleton className="h-[416px] rounded-card" />
        <Skeleton className="h-[416px] rounded-card max-lg:hidden" />
      </div>
    </div>
  );
}
