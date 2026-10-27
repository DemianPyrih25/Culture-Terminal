"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { PickerCandidate } from "@ct/contracts";
import { rememberRun } from "../../lib/recent-briefs";
import { startRun, type StartRunOutcome } from "../../lib/start-run";
import { ButtonLink, Card, cx, Icon, Monogram, Spinner } from "../ui";

/**
 * Which one? (N16 5): the name matched more than one entity, so the reader picks. A pick posts the
 * opaque key and opens the new run; nothing is ever picked for them. A replay shows the picks closed.
 */

export interface PickDeps {
  start: (body: { pick: { runId: string; key: string } }, onRetry: (message: string) => void) => Promise<StartRunOutcome>;
  /** Records the new run as this browser's own answer (D31). */
  remember: (runId: string) => void;
  navigate: (href: string) => void;
  onRetry: (message: string) => void;
}

/** Answers the picker: starts the run for the picked key, records it as the reader's own, and opens it. */
export async function pickCandidate(runId: string, key: string, deps: PickDeps): Promise<StartRunOutcome> {
  const outcome = await deps.start({ pick: { runId, key } }, deps.onRetry);
  if (outcome.ok) {
    deps.remember(outcome.runId);
    deps.navigate(`/run/${encodeURIComponent(outcome.runId)}`);
  }
  return outcome;
}

/** "Widely known" from a popularity of 0.5, else "Less known"; nothing without one. */
export function reachWord(popularity: number | null): string | null {
  if (popularity === null) return null;
  return popularity >= 0.5 ? "Widely known" : "Less known";
}

export interface WhichOneProps {
  runId: string;
  mention: string;
  candidates: readonly PickerCandidate[];
  /** The run has ended, so a pick can start the next one. */
  canPick: boolean;
  /** "Edit question" under the list. */
  editHref: string;
  replay?: boolean;
  className?: string;
}

export function WhichOneCard({ runId, mention, candidates, canPick, editHref, replay = false, className }: WhichOneProps) {
  const router = useRouter();
  const [picking, setPicking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function pick(key: string) {
    setPicking(key);
    setMessage(null);
    const outcome = await pickCandidate(runId, key, {
      start: (body, onRetry) => startRun(body, { onRetry }),
      remember: (id) => void rememberRun(id),
      navigate: (href) => router.push(href),
      onRetry: setMessage,
    });
    if (outcome.ok) return;
    setPicking(null);
    setMessage(outcome.error);
  }

  const closed = replay || !canPick;
  return (
    <Card aria-label="Which one?" data-state-card="pick" className={cx("flex flex-col gap-4", className)}>
      <h2 className="type-title text-ink max-md:type-title-sm">&quot;{mention}&quot; could mean a few things. Which one?</h2>
      <ul className="flex flex-col gap-2" aria-label="Candidates">
        {candidates.map((c) => {
          const reach = reachWord(c.popularity);
          return (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => void pick(c.key)}
                disabled={closed || picking !== null}
                aria-busy={picking === c.key ? true : undefined}
                data-candidate={c.key}
                className="flex min-h-14 w-full items-center gap-3 rounded-control border border-line bg-surface px-4 py-2 text-left transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-xs disabled:cursor-not-allowed disabled:hover:border-line disabled:hover:shadow-none"
              >
                <Monogram name={c.name} size={32} />
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[15px] leading-5 font-semibold text-ink">{c.name}</span>
                  {c.disambiguation ? <span className="truncate type-label text-ink-2">{c.disambiguation}</span> : null}
                </span>
                {reach ? <span className="shrink-0 type-label text-ink-2 max-sm:hidden">{reach}</span> : null}
                {picking === c.key ? <Spinner size={16} className="shrink-0 text-accent" /> : <Icon name="chevron-right" size={16} className="shrink-0 text-ink-3" />}
              </button>
            </li>
          );
        })}
      </ul>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 px-4 type-body text-ink-2">
        Not listed?
        <ButtonLink href={editHref}>Edit question</ButtonLink>
      </p>
      {replay ? (
        <p className="px-4 type-label text-ink-2" data-picks="replay">
          This is a recording, so picks are closed here.
        </p>
      ) : !canPick ? (
        <p className="px-4 type-label text-ink-2">Picks open in a moment.</p>
      ) : null}
      {/* Always in the accessibility tree, so the message is announced when it arrives. */}
      <p role="status" aria-live="polite" className={message ? "px-4 type-label text-ink-2" : "sr-only"}>
        {message}
      </p>
    </Card>
  );
}
