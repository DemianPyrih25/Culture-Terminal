"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import type { BriefTerminal } from "../../lib/brief";
import { refusalSentence } from "../../lib/brief/steps";
import { rememberRun } from "../../lib/recent-briefs";
import { startRun, type StartRunOutcome } from "../../lib/start-run";
import { Button, ChipLink, cx, Icon, InlineState, type IconName } from "../ui";
import { editQuestionHref } from "./progress-card";

/**
 * The end-state cards (N16): when a run ends early, its card takes the progress card's slot. One line and
 * one button, where the reader acts: stopped, failed, partial and refused. Numbers and charts that
 * already arrived stay below.
 */

type Of<K extends BriefTerminal["kind"]> = Extract<BriefTerminal, { kind: K }>;

export interface RunAgainDeps {
  start: (body: { question: string }) => Promise<StartRunOutcome>;
  remember: (runId: string) => void;
  navigate: (href: string) => void;
}

/** Starts the same question again, records it as the reader's own and opens it. */
export async function runAgain(question: string, deps: RunAgainDeps): Promise<StartRunOutcome> {
  const outcome = await deps.start({ question });
  if (outcome.ok) {
    deps.remember(outcome.runId);
    deps.navigate(`/run/${encodeURIComponent(outcome.runId)}`);
  }
  return outcome;
}

/** "Try again" / "Run it again": starts the run, spinning until the new run opens. */
function useRunAgain(question: string | null): { press: () => void; busy: boolean; error: string | null } {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const press = () => {
    if (!question) {
      router.push("/#ask");
      return;
    }
    setBusy(true);
    setError(null);
    void runAgain(question, {
      start: (body) => startRun(body),
      remember: (id) => void rememberRun(id),
      navigate: (href) => router.push(href),
    }).then((outcome) => {
      if (outcome.ok) return;
      setBusy(false);
      setError(outcome.error);
    });
  };
  return { press, busy, error };
}

function AgainButton({ question, label = "Try again", size = "md" }: { question: string | null; label?: string; size?: "sm" | "md" }) {
  const { press, busy, error } = useRunAgain(question);
  return (
    <>
      <Button variant="primary" size={size} trailing="rotate-ccw" onClick={press} loading={busy} loadingLabel="Starting…" className="max-md:w-full" data-again="true">
        {label}
      </Button>
      <p role="status" aria-live="polite" className={error ? "basis-full type-label text-danger-ink" : "sr-only"}>
        {error}
      </p>
    </>
  );
}

type Tone = "plain" | "danger" | "caution";

const TONE: Readonly<Record<Tone, string>> = {
  plain: "border border-line bg-surface shadow-xs",
  danger: "bg-danger-soft",
  caution: "bg-caution-soft",
};

/** VerdictCard shell: padding 28, gap 20, an optional 28 px icon beside the display-m heading. */
function EndCard({
  state,
  tone,
  icon,
  iconClass,
  heading,
  headingClass,
  children,
  className,
}: {
  state: string;
  tone: Tone;
  icon?: IconName;
  iconClass?: string;
  heading: ReactNode;
  headingClass?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section aria-label={typeof heading === "string" ? heading : undefined} data-state-card={state} className={cx("flex flex-col gap-5 rounded-card p-7 max-md:p-5", TONE[tone], className)}>
      <h2 className={cx("flex items-start gap-3 type-display-m max-md:type-display-m-sm", headingClass ?? "text-ink")}>
        {icon ? (
          <span className="flex h-10 shrink-0 items-center max-md:h-8">
            <Icon name={icon} size={28} className={iconClass} />
          </span>
        ) : null}
        <span className="min-w-0">{heading}</span>
      </h2>
      {children}
    </section>
  );
}

/** Stopped: "You stopped this answer." and "Run it again". */
export function StoppedCard({ question, className }: { question: string | null; className?: string }) {
  return (
    <EndCard state="cancelled" tone="plain" heading="You stopped this answer." className={className}>
      <div className="flex flex-wrap items-center gap-3">
        <AgainButton question={question} label="Run it again" />
      </div>
    </EndCard>
  );
}

/** The run's reason and errors, for "Details". */
function failureDetails(terminal: Of<"failed">): string[] {
  const lines = terminal.reason ? [terminal.reason] : [];
  for (const e of terminal.errors) if (!lines.includes(e.message)) lines.push(e.message);
  return lines;
}

/** Failed: "This answer couldn't be finished.", "Try again" and the "Details" disclosure. */
export function FailedCard({ terminal, question, className }: { terminal: Of<"failed">; question: string | null; className?: string }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const details = failureDetails(terminal);
  return (
    <EndCard
      state="failed"
      tone="danger"
      icon="circle-x"
      iconClass="text-danger"
      heading="This answer couldn't be finished."
      headingClass="text-danger-ink"
      className={className}
    >
      <p className="type-lead text-ink">Please try again.</p>
      <div className="flex flex-wrap items-center gap-3">
        <AgainButton question={question} />
        {details.length > 0 ? (
          <Button
            variant="quiet"
            icon={open ? "chevron-up" : "chevron-down"}
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((v) => !v)}
          >
            Details
          </Button>
        ) : null}
      </div>
      {details.length > 0 ? (
        <ul id={id} hidden={!open} className="flex list-disc flex-col gap-1 pl-5 type-label text-ink-2">
          {details.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </EndCard>
  );
}

/**
 * Not started (D24): the question waited for a live slot and ended there, when its wait ran out or the
 * server restarted. The run's own reason says which; nothing was spent.
 */
export function NotStartedCard({ reason, question, className }: { reason: string | null; question: string | null; className?: string }) {
  return (
    <EndCard state="not_started" tone="plain" icon="clock-4" iconClass="text-ink-2" heading="This question didn't start." className={className}>
      <p className="type-lead text-ink">{reason ?? "No live slot freed up in time. Nothing was spent."}</p>
      <div className="flex flex-wrap items-center gap-3">
        <AgainButton question={question} label="Ask again" />
      </div>
    </EndCard>
  );
}

/** Partial: the evidence is here, the analysis ran out of time, nothing was checked. */
export function PartialCard({ question, className }: { question: string | null; className?: string }) {
  return (
    <EndCard state="incomplete" tone="caution" icon="triangle-alert" iconClass="text-caution" heading="Partial answer" className={className}>
      <p className="type-lead text-ink">The evidence is here, but the analysis ran out of time to conclude.</p>
      <p className="type-label text-ink-2">This partial answer was not checked.</p>
      <div className="flex flex-wrap items-center gap-3">
        <AgainButton question={question} />
      </div>
    </EndCard>
  );
}

/** Refused in the run: what we don't answer, and a question we can. */
export function RefusedCard({ terminal, className }: { terminal: Of<"refused">; className?: string }) {
  return (
    <EndCard state="refused" tone="plain" icon="ban" iconClass="text-ink-2" heading={refusalSentence(terminal.category)} className={className}>
      {terminal.reframe ? (
        <div className="flex flex-col items-start gap-3">
          <p className="type-lead text-ink-2">Try this instead:</p>
          <ChipLink
            href={editQuestionHref(terminal.reframe)}
            className="h-auto! min-h-9 py-2 text-left whitespace-normal! [&>span]:whitespace-normal"
            data-reframe
          >
            {terminal.reframe}
          </ChipLink>
        </div>
      ) : null}
    </EndCard>
  );
}

/** The compact failed state, when numbers had already arrived: the line and "Try again". */
export function FailedInline({ question }: { question: string | null }) {
  return (
    <InlineState tone="danger" data-state-card="failed" action={<AgainButton question={question} size="sm" />}>
      This answer couldn&apos;t be finished. Please try again.
    </InlineState>
  );
}

/** The live stream stopped: reload to catch up. */
export function ReconnectingState() {
  return (
    <InlineState
      tone="neutral"
      icon="wifi-off"
      data-state-card="reconnecting"
      action={
        <Button variant="secondary" size="sm" icon="rotate-ccw" onClick={() => window.location.reload()}>
          Reload
        </Button>
      }
    >
      Live updates stopped. Reload to catch up.
    </InlineState>
  );
}

export interface StateCardProps {
  terminal: BriefTerminal;
  question: string | null;
  /** Numbers or charts already arrived: a failure shows as the compact line. */
  compact?: boolean;
  /** The run ended in the queue before any work (endedInQueue): a failure shows as not started. */
  unstarted?: boolean;
  className?: string;
}

/**
 * The end-state card of a terminal: stopped, failed, partial or refused. A pick (needs_input) is the
 * which-one card, not this one; it renders nothing here.
 */
export function StateCard({ terminal, question, compact = false, unstarted = false, className }: StateCardProps) {
  switch (terminal.kind) {
    case "cancelled":
      return <StoppedCard question={question} className={className} />;
    case "failed":
      if (unstarted) return <NotStartedCard reason={terminal.reason} question={question} className={className} />;
      return compact ? <FailedInline question={question} /> : <FailedCard terminal={terminal} question={question} className={className} />;
    case "incomplete":
      return <PartialCard question={question} className={className} />;
    case "refused":
      return <RefusedCard terminal={terminal} className={className} />;
    case "needs_input":
      return null;
  }
}
