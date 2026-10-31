import type { ReactNode } from "react";
import type { WorkingStep, WorkingStepState } from "../../lib/brief/steps";
import { ButtonLink, cx, Icon, Spinner } from "../ui";
import type { LookupChip } from "./sources";

/**
 * C/ProgressCard (N03 early, N04 late, replay): the status title and the elapsed clock, the progress
 * track, the five steps, how the question was read with "Edit question", and late in the run what it
 * noticed. A white surface with hairline rules between its parts, no shadow.
 */

/** The Ask page with the question in the box, to change it and run again. */
export function editQuestionHref(question: string | null): string {
  return question ? `/ask?${new URLSearchParams({ q: question }).toString()}` : "/#ask";
}

/** The card surface shared by the progress, queued and not-found cards. */
const SURFACE = "flex flex-col overflow-hidden rounded-card border border-line bg-surface";

function StepIcon({ state }: { state: WorkingStepState }) {
  if (state === "active") return <Spinner size={16} className="shrink-0 text-accent" />;
  if (state === "done") return <Icon name="circle-check" size={16} className="shrink-0 text-accent" />;
  return <Icon name="circle" size={16} className="shrink-0 text-ink-3" />;
}

/** The five steps: five cells in a row on desktop, a calm vertical list on phones. */
export function StepList({ steps, className }: { steps: readonly WorkingStep[]; className?: string }) {
  return (
    <ol aria-label="Steps" className={cx("grid grid-cols-1 divide-y divide-line md:grid-cols-5 md:divide-x md:divide-y-0", className)}>
      {steps.map((step, i) => (
        <li
          key={step.key}
          data-step={step.key}
          data-state={step.state}
          aria-current={step.state === "active" ? "step" : undefined}
          className={cx(
            "flex min-w-0 items-center gap-3 px-5 py-3 md:flex-col md:items-stretch md:gap-2 md:py-4",
            step.state === "active" && "bg-accent-soft",
          )}
        >
          <span className="flex items-center justify-between gap-2 md:w-full">
            <StepIcon state={step.state} />
            <span className={cx("font-mono text-[11px] leading-4 tabular-nums max-md:hidden", step.state === "active" ? "text-accent-ink" : "text-ink-3")}>
              {step.state === "active" ? "now" : i + 1}
            </span>
          </span>
          <span
            className={cx(
              "min-w-0 text-[14px] leading-5",
              step.state === "active" ? "font-semibold text-ink" : step.state === "done" ? "text-ink" : "text-ink-3",
            )}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The 4 px track: accent fill over sunken, width from the run's forward-only fraction. */
export function ProgressTrack({ fraction, label = "Progress" }: { fraction: number; label?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-1 w-full overflow-hidden rounded-xs bg-sunken"
    >
      <div className="h-full rounded-xs bg-accent transition-[width] duration-[240ms] ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
    </div>
  );
}

/** The card head: the status title, the clock under it, anything set to its right, then its body. */
function CardHead({ title, queued = false, time, aside, children }: { title: string; queued?: boolean; time: ReactNode; aside?: ReactNode; children?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 px-6 pt-6 pb-5 max-md:px-5 max-md:pt-5">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between md:gap-6">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="flex items-center gap-2 type-title text-ink max-md:type-title-sm" data-status-title>
            {queued ? <Icon name="clock-4" size={18} className="shrink-0 text-ink-3" /> : null}
            {title}
          </h2>
          {time}
        </div>
        {aside}
      </div>
      {children}
    </div>
  );
}

export interface ProgressCardProps {
  /** The status title: "Comparing audiences". */
  title: string;
  /** The elapsed clock "0:06", or a replay's "Recording · 0:12 of 0:26". */
  time: string;
  fraction: number;
  steps: readonly WorkingStep[];
  /** "Real competitors · Liquid Death and 5 similar brands"; null before the question is read. */
  readingAs: string | null;
  /** Where "Edit question" goes; null hides it (a replay). */
  editHref: string | null;
  /** "Noticed: … Looking closer."; null hides the line. */
  noticed: string | null;
  /**
   * D41: the question was read as the nearest job; the plain sentence of what is not covered. Null or
   * absent hides it.
   */
  readAsLine?: string | null;
  /**
   * Lookups so far by source ("Qloo 12", "SEC EDGAR 2"). Shown once public data is among them, so a
   * reader sees that filings or Census figures joined the taste data.
   */
  lookups?: readonly LookupChip[];
  /** "Being written · since 09:12:04"; null or absent hides the line. */
  since?: string | null;
  /** The polite announcement: the active step only, never the ticking time. */
  announcement: string;
  /** recording: a replay. */
  variant?: "live" | "replay";
}

const SOURCE_NAME: Readonly<Record<LookupChip["source"], string>> = { qloo: "Qloo", sec: "SEC EDGAR", census: "US Census", osm: "OpenStreetMap" };

export function ProgressCard({
  title,
  time,
  fraction,
  steps,
  readingAs,
  editHref,
  noticed,
  readAsLine = null,
  lookups = [],
  since = null,
  announcement,
  variant = "live",
}: ProgressCardProps) {
  const showLookups = lookups.some((l) => l.source !== "qloo");
  const foot = since !== null || editHref !== null;
  return (
    <section aria-label="Progress" data-progress-card={variant} className={SURFACE}>
      <CardHead
        title={title}
        time={
          <p className="font-mono text-[13px] leading-5 text-ink-2 tabular-nums" data-time>
            {time}
          </p>
        }
        aside={
          showLookups ? (
            <ul aria-label="Lookups so far" className="flex flex-wrap gap-2 md:justify-end" data-lookups>
              {lookups.map((l) => (
                <li
                  key={l.source}
                  data-lookup={l.source}
                  aria-label={l.label}
                  className="flex items-center gap-1.5 rounded-sm border border-line px-2 py-0.5 type-caption text-ink-2"
                >
                  {SOURCE_NAME[l.source]}
                  <span className="font-mono text-ink tabular-nums">{l.count}</span>
                </li>
              ))}
            </ul>
          ) : null
        }
      >
        <ProgressTrack fraction={fraction} label={variant === "replay" ? "Recording progress" : "Progress"} />
      </CardHead>
      <StepList steps={steps} className="border-y border-line" />
      {readingAs || readAsLine || noticed || foot ? (
        <div className="flex flex-col gap-4 px-6 py-5 max-md:px-5">
          {readingAs ? (
            <p className="type-body text-ink-2" data-reading-as>
              <span className="font-semibold text-ink">Reading it as:</span> {readingAs}
            </p>
          ) : null}
          {readAsLine ? (
            <p className="type-body text-ink-2" data-read-as>
              {readAsLine}
            </p>
          ) : null}
          {noticed ? (
            <p className="flex items-start gap-2 rounded-control border border-line px-3 py-2 type-body text-ink" data-noticed>
              <span className="flex h-6 shrink-0 items-center">
                <Icon name="lightbulb" size={16} className="text-accent" />
              </span>
              {noticed}
            </p>
          ) : null}
          {foot ? (
            <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
              {since ? <p className="type-caption text-ink-3">{since}</p> : <span />}
              {editHref ? (
                <ButtonLink href={editHref} variant="quiet" size="sm" icon="pencil" trailing={null} className="-mr-3 max-md:-ml-3">
                  Edit question
                </ButtonLink>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </section>
  );
}

/** "1:45": whole seconds as a short clock. */
export function waitClock(s: number): string {
  const total = Math.max(0, Math.round(s));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * ProgressCard · queued (§8.1 Queued, D24): every live slot is busy, so the question waits its turn. Its
 * place and the longest it may still wait, never a guess of when it starts. The progress card takes
 * this slot as soon as the run starts.
 */
export function QueuedCard({ position, waitLeftS, editHref }: { position: number; waitLeftS: number; editHref: string | null }) {
  return (
    <section aria-label="Queued" data-progress-card="queued" className={SURFACE}>
      <CardHead
        title={`Queued · position ${position}`}
        queued
        time={
          <p className="text-[13px] leading-5 text-ink-2" data-time>
            Up to <span className="font-mono text-ink tabular-nums">{waitClock(waitLeftS)}</span> wait
          </p>
        }
      >
        <ProgressTrack fraction={0} />
        <p className="type-body text-ink-2" data-queue-note>
          Every live slot is busy right now. Your question starts on its own when one frees up.
        </p>
      </CardHead>
      {editHref ? (
        <div className="flex justify-end border-t border-line px-6 py-3 max-md:justify-start max-md:px-5">
          <ButtonLink href={editHref} variant="quiet" size="sm" icon="pencil" trailing={null} className="-mr-3 max-md:-ml-3">
            Edit question
          </ButtonLink>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="sr-only">
        Queued, position {position}
      </p>
    </section>
  );
}

/**
 * ProgressCard · not found (N16 4): the name is not in Qloo's data. Step 1 done on a hairline row, then
 * the line and "Edit question" under it.
 */
export function NotFoundCard({ mention, editHref, className }: { mention: string; editHref: string; className?: string }) {
  return (
    <section aria-label="Name not found" data-state-card="not_found" className={cx(SURFACE, className)}>
      <p className="flex items-center gap-2 border-b border-line px-6 py-3 type-label text-ink max-md:px-5">
        <Icon name="circle-check" size={16} className="shrink-0 text-accent" />
        Read your question
      </p>
      <div className="flex items-start gap-4 p-6 max-md:p-5">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-caution-soft">
          <Icon name="search-x" size={18} className="text-caution-ink" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h2 className="type-title text-ink max-md:type-title-sm">&quot;{mention}&quot; isn&apos;t in Qloo&apos;s data.</h2>
          <p className="type-body text-ink-2">Check the spelling or use the full name.</p>
          <div className="pt-4">
            <ButtonLink href={editHref} variant="primary" icon="pencil" trailing={null} className="max-md:w-full">
              Edit question
            </ButtonLink>
          </div>
        </div>
      </div>
    </section>
  );
}
