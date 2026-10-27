import type { WorkingStep, WorkingStepState } from "../../lib/brief/steps";
import { ButtonLink, Card, cx, Icon, Spinner } from "../ui";

/**
 * C/ProgressCard (N03 early, N04 late, replay): the status title and the time, the progress track, the
 * five steps, how the question was read with "Edit question", and late in the run what it noticed.
 */

/** The Ask page with the question in the box, to change it and run again. */
export function editQuestionHref(question: string | null): string {
  return question ? `/ask?${new URLSearchParams({ q: question }).toString()}` : "/#ask";
}

function StepIcon({ state }: { state: WorkingStepState }) {
  if (state === "active") return <Spinner size={18} className="shrink-0 text-accent" />;
  if (state === "done") return <Icon name="circle-check" size={18} className="shrink-0 text-accent" />;
  return <Icon name="circle" size={18} className="shrink-0 text-ink-3" />;
}

/** The five steps: one row spread across the card on desktop, stacked on phones. */
export function StepList({ steps, className }: { steps: readonly WorkingStep[]; className?: string }) {
  return (
    <ol aria-label="Steps" className={cx("flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-4", className)}>
      {steps.map((step) => (
        <li
          key={step.key}
          data-step={step.key}
          data-state={step.state}
          aria-current={step.state === "active" ? "step" : undefined}
          className="flex min-w-0 items-center gap-2"
        >
          <StepIcon state={step.state} />
          <span
            className={cx(
              "text-[15px] leading-6",
              step.state === "active" ? "font-semibold text-ink" : step.state === "done" ? "text-ink" : "text-ink-2",
            )}
          >
            {step.label}
          </span>
        </li>
      ))}
    </ol>
  );
}

/** The 6 px track: accent fill over sunken, width from the run's forward-only fraction. */
export function ProgressTrack({ fraction, label = "Progress" }: { fraction: number; label?: string }) {
  const pct = Math.round(Math.min(1, Math.max(0, fraction)) * 100);
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-1.5 w-full overflow-hidden rounded-xs bg-sunken"
    >
      <div className="h-full rounded-xs bg-accent transition-[width] duration-[240ms] ease-out motion-reduce:transition-none" style={{ width: `${pct}%` }} />
    </div>
  );
}

export interface ProgressCardProps {
  /** The status title: "Comparing audiences". */
  title: string;
  /** "Usually under a minute · 0:06", or a replay's "Recording · 0:12 of 0:26". */
  time: string;
  fraction: number;
  steps: readonly WorkingStep[];
  /** "Real competitors · Liquid Death and 5 similar brands"; null before the question is read. */
  readingAs: string | null;
  /** Where "Edit question" goes; null hides it (a replay). */
  editHref: string | null;
  /** "Noticed: … Looking closer."; null hides the line. */
  noticed: string | null;
  /** The polite announcement: the active step only, never the ticking time. */
  announcement: string;
  /** recording: a replay. */
  variant?: "live" | "replay";
}

export function ProgressCard({ title, time, fraction, steps, readingAs, editHref, noticed, announcement, variant = "live" }: ProgressCardProps) {
  return (
    <Card padding="lg" aria-label="Progress" data-progress-card={variant} className="flex flex-col gap-7 max-md:gap-5">
      <div className="flex flex-col gap-1 md:flex-row md:items-end md:justify-between md:gap-6">
        <h2 className="type-title-l text-ink max-md:type-title-l-sm" data-status-title>
          {title}
        </h2>
        <p className="type-label text-ink-2 tabular-nums md:pb-1" data-time>
          {time}
        </p>
      </div>
      <ProgressTrack fraction={fraction} label={variant === "replay" ? "Recording progress" : "Progress"} />
      <StepList steps={steps} />
      {readingAs || editHref || noticed ? (
        <div className="flex flex-col gap-3">
          {readingAs || editHref ? (
            <div className="flex flex-col items-start gap-x-5 gap-y-2 md:flex-row md:flex-wrap md:items-center">
              {readingAs ? (
                <p className="type-body text-ink-2" data-reading-as>
                  Reading it as: {readingAs}
                </p>
              ) : null}
              {editHref ? (
                <ButtonLink href={editHref} variant="quiet" icon="pencil" trailing={null} className={cx(readingAs ? "-ml-3 md:ml-0" : "-ml-3")}>
                  Edit question
                </ButtonLink>
              ) : null}
            </div>
          ) : null}
          {noticed ? (
            <p className="flex items-start gap-2 type-body text-ink" data-noticed>
              <span className="flex h-6 shrink-0 items-center">
                <Icon name="lightbulb" size={16} className="text-ink-2" />
              </span>
              {noticed}
            </p>
          ) : null}
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="sr-only">
        {announcement}
      </p>
    </Card>
  );
}

/**
 * ProgressCard · not found (N16 4): the name is not in Qloo's data. The steps stacked, step 1 done, step
 * 2 says so, and "Edit question" under it.
 */
export function NotFoundCard({ mention, editHref, className }: { mention: string; editHref: string; className?: string }) {
  return (
    <Card padding="lg" aria-label="Name not found" data-state-card="not_found" className={cx("flex flex-col gap-3", className)}>
      <p className="flex items-center gap-2 type-body text-ink">
        <Icon name="circle-check" size={18} className="shrink-0 text-accent" />
        Read your question
      </p>
      <p className="flex items-start gap-2 type-body text-ink">
        <span className="flex h-6 shrink-0 items-center">
          <Icon name="search-x" size={18} className="text-ink" />
        </span>
        <span>
          &quot;{mention}&quot; isn&apos;t in Qloo&apos;s data. Check the spelling or use the full name.
        </span>
      </p>
      <div className="pt-3 md:pl-[26px]">
        <ButtonLink href={editHref} variant="primary" trailing="pencil" className="max-md:w-full">
          Edit question
        </ButtonLink>
      </div>
    </Card>
  );
}
