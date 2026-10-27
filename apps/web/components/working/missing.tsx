import { NEW_QUESTION_HREF, SiteShell } from "../chrome";
import { ButtonLink, Card, Icon, type IconName } from "../ui";

/**
 * A link with no answer to show (N16 "Link not found"): one centred card, one line and one button. Also
 * the store not answering, a permalink whose run has not finished or ended without an answer, and any
 * unknown URL (app/not-found.tsx).
 */

export type MissingKind = "not_found" | "no_page" | "unavailable" | "running" | "no_answer";

const COPY: Readonly<Record<MissingKind, { icon: IconName; line: string; detail: string | null; action: string }>> = {
  not_found: { icon: "search-x", line: "There's no answer at this link.", detail: null, action: "Ask a question" },
  no_page: { icon: "search-x", line: "There's no page at this link.", detail: null, action: "Ask a question" },
  unavailable: { icon: "wifi-off", line: "We couldn't load this answer right now.", detail: "Please try again in a moment.", action: "Try again" },
  running: { icon: "loader-circle", line: "This answer is still being made.", detail: "This link works as soon as it's finished.", action: "Follow it live" },
  no_answer: { icon: "circle-pause", line: "This answer wasn't finished.", detail: "The run shows where it stopped and what to do next.", action: "Open the run" },
};

export function AnswerMissing({ kind, runId }: { kind: MissingKind; runId?: string }) {
  const copy = COPY[kind];
  const runHref = runId ? `/run/${encodeURIComponent(runId)}` : null;
  const href = kind === "not_found" || kind === "no_page" ? NEW_QUESTION_HREF : kind === "unavailable" ? (runHref ?? "/") : (runHref ?? NEW_QUESTION_HREF);
  return (
    <SiteShell header="inner" mainClassName="flex flex-col items-center py-24 max-md:py-12">
      <Card padding="lg" data-missing={kind} className="flex w-full max-w-[552px] flex-col items-center gap-4 text-center">
        <Icon name={copy.icon} size={32} className="text-ink-3" />
        <h1 className="type-title text-ink">{copy.line}</h1>
        {copy.detail ? <p className="type-body text-ink-2">{copy.detail}</p> : null}
        <ButtonLink href={href} variant="primary" className="mt-2 max-md:w-full" data-missing-action={kind}>
          {copy.action}
        </ButtonLink>
      </Card>
    </SiteShell>
  );
}
