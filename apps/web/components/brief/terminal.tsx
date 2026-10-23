"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { plural, type BriefModel, type BriefTerminal } from "../../lib/brief";
import { rememberRun } from "../../lib/recent-briefs";
import { startRun, type StartRunOutcome } from "../../lib/start-run";
import { askHref } from "../ask/ask-href";
import { ButtonLink, cx, MiniMeter } from "../ui";

/**
 * How a run stopped short of a brief: the picker (needs_input), a refusal with a reframe, an incomplete
 * digest, a failure or a cancel. Each says why, and what of the brief still shows.
 */

function Card({ tone = "accent", label, children }: { tone?: "accent" | "negative" | "dim"; label: string; children: ReactNode }) {
  return (
    <section
      aria-label={label}
      className={cx(
        "flex w-full flex-col gap-3 border-l-2 py-1 pl-4",
        tone === "accent" ? "border-accent" : tone === "negative" ? "border-negative" : "border-line-strong",
      )}
    >
      {children}
    </section>
  );
}

const KICKER = "m-0 text-[11px] leading-4 font-semibold tracking-[1.3px] uppercase";

type Of<K extends BriefTerminal["kind"]> = Extract<BriefTerminal, { kind: K }>;

export interface PickDeps {
  start: (body: { pick: { runId: string; key: string } }, onRetry: (message: string) => void) => Promise<StartRunOutcome>;
  /** Records the new run as this browser's own brief, so Home and the library list it (D31). */
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

/**
 * The picker (D20): the name matched no single entity exactly, so the reader picks. Choosing posts the
 * opaque key and opens the new run; nothing is ever picked for them, and a name that was not found
 * offers no substitute. A replay shows the picks closed.
 */
export function Picker({
  terminal,
  runId,
  canPick,
  question,
  replay = false,
}: {
  terminal: Of<"needs_input">;
  runId: string;
  canPick: boolean;
  question: string | null;
  replay?: boolean;
}) {
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

  const found = terminal.candidates.length > 0;
  return (
    <Card label={found ? "Pick the one you mean" : "Name not found"}>
      <p className={cx(KICKER, "text-accent")}>{found ? "Which one do you mean?" : "Not found"}</p>
      <p className="m-0 font-serif text-[20px] leading-[28px] text-ink">
        {found ? `“${terminal.mention}”: ${terminal.reasonLabel.toLowerCase()}.` : `We could not find “${terminal.mention}”.`}
      </p>
      <p className="m-0 type-body text-text-2">{terminal.message}</p>
      {found ? (
        <ul className="m-0 flex list-none flex-col border-t border-line p-0" aria-label="Candidates">
          {terminal.candidates.map((c) => (
            <li key={c.key} className="border-b border-line">
              <button
                type="button"
                onClick={() => void pick(c.key)}
                disabled={!canPick || picking !== null}
                data-candidate={c.key}
                className="flex w-full items-center gap-4 py-2.5 text-left hover:bg-canvas disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] leading-[22px] font-medium text-ink">{c.name}</span>
                  <span className="block text-[12px] leading-[17px] text-dim">{c.disambiguation ?? "no other detail from Qloo"}</span>
                </span>
                {c.popularity !== null ? (
                  <span className="flex shrink-0 items-center gap-2 text-[12px] text-dim tabular-nums">
                    <span className="max-sm:sr-only">Popularity</span>
                    <MiniMeter value={c.popularity * 100} label={`Popularity of ${c.name}`} width={48} markerHeight={9} />
                    {c.popularity.toFixed(2).replace(/^0/, "")}
                  </span>
                ) : null}
                <span className="w-16 shrink-0 text-right text-[13px] font-medium text-accent">{picking === c.key ? "Starting…" : "Pick"}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="m-0 text-[12px] leading-[17px] text-dim">
        {found
          ? "Nothing was picked for you. Popularity helps you tell them apart; it never decides the match."
          : "Nothing was substituted: a near miss is never applied for you."}{" "}
        {question ? (
          <Link href={askHref(question)} className="font-medium text-accent hover:underline hover:underline-offset-4">
            Ask again with another name
          </Link>
        ) : null}
      </p>
      {found && replay ? (
        <p className="m-0 text-[12px] text-dim" data-picks="replay">
          Replay: the picks are closed here. Exit the replay to pick.
        </p>
      ) : !canPick && found ? (
        <p className="m-0 text-[12px] text-dim">The run is still finishing; the picks open in a moment.</p>
      ) : null}
      {/* Always in the accessibility tree, so the message is announced when it arrives. */}
      <p role="status" aria-live="polite" className={message ? "m-0 text-[12px] text-dim" : "sr-only"}>
        {message}
      </p>
    </Card>
  );
}

/** What a refusal cost in Qloo requests: none before CLERK refused, some when the ANALYST refused later. */
export function refusalRequestsLine(requests: number): string {
  return requests === 0
    ? "No Qloo request was made."
    : `${plural(requests, "Qloo request")} ${requests === 1 ? "was" : "were"} made before the refusal; ${requests === 1 ? "it is" : "they are"} listed in Sources.`;
}

export function RefusedCard({ terminal, requests }: { terminal: Of<"refused">; requests: number }) {
  // lib/brief words every refusal as made "before any data was requested"; after requests, say only what was refused.
  const headline =
    requests === 0 ? terminal.message : `This question was refused${terminal.categoryLabel ? `: ${terminal.categoryLabel.toLowerCase()}` : ""}.`;
  return (
    <Card tone="negative" label="Question refused">
      <p className={cx(KICKER, "text-negative")}>Not answered{terminal.categoryLabel ? ` · ${terminal.categoryLabel}` : ""}</p>
      <p className="m-0 font-serif text-[20px] leading-[28px] text-ink">{headline}</p>
      <p className="m-0 type-body text-text-2">
        Culture Terminal reads group-level taste only: no individuals, no politics, no buy or sell advice. {refusalRequestsLine(requests)}
      </p>
      {terminal.reframe ? (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-[12px] text-dim">A question we can answer:</p>
          <ButtonLink href={askHref(terminal.reframe)} variant="quiet" className="h-auto whitespace-normal text-left">
            {terminal.reframe}
          </ButtonLink>
        </div>
      ) : null}
    </Card>
  );
}

/** What of the brief still shows after a run stopped early. */
function whatStillShows(model: BriefModel): string {
  const parts: string[] = [];
  if (model.priors.items.length > 0) parts.push("the priors as written");
  const figures = model.evidence.keyFigures.filter((k) => k.state === "ready").length;
  if (figures > 0) parts.push(`${figures} key ${figures === 1 ? "figure" : "figures"}`);
  if (model.evidence.figures.length > 0) parts.push(`${model.evidence.figures.length} ${model.evidence.figures.length === 1 ? "figure" : "figures"}`);
  if (model.sources.items.length > 0) parts.push(`${model.sources.items.length} ${model.sources.items.length === 1 ? "request" : "requests"} in Sources`);
  return parts.length > 0 ? `What still shows: ${parts.join(", ")}. Nothing was checked or scored.` : "Nothing arrived before it stopped.";
}

export function StoppedCard({ terminal, model }: { terminal: Of<"failed"> | Of<"cancelled">; model: BriefModel }) {
  const failed = terminal.kind === "failed";
  return (
    <Card tone={failed ? "negative" : "dim"} label={failed ? "Run failed" : "Run stopped"}>
      <p className={cx(KICKER, failed ? "text-negative" : "text-dim")}>{failed ? "Failed" : "Stopped"}</p>
      <p className="m-0 font-serif text-[20px] leading-[28px] text-ink">{terminal.message}</p>
      {terminal.kind === "cancelled" && terminal.reason ? <p className="m-0 type-body text-text-2">{terminal.reason}</p> : null}
      {terminal.kind === "failed" && terminal.errors.length > 0 ? (
        <ul className="m-0 list-none p-0 text-[13px] leading-5 text-text-2">
          {terminal.errors.map((e, i) => (
            <li key={i}>
              <span className="font-mono text-[11px] text-dim">{e.code}</span> {e.message}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="m-0 text-[13px] leading-5 text-dim">{whatStillShows(model)}</p>
    </Card>
  );
}

/**
 * The INCOMPLETE marker. `explained`: the digest's own thesis already says why the run stopped, so the
 * card does not say it again.
 */
export function IncompleteCard({ terminal, explained = false }: { terminal: Of<"incomplete">; explained?: boolean }) {
  return (
    <Card tone="negative" label="Incomplete brief">
      <p className={cx(KICKER, "flex items-center gap-2 text-negative")}>
        <span className="rounded-brief border border-negative px-1 font-mono text-[10px] tracking-[0.6px]" data-marker="INCOMPLETE">
          {terminal.badge}
        </span>
        Evidence digest
      </p>
      {explained ? null : <p className="m-0 type-body text-text-2">{terminal.message}</p>}
    </Card>
  );
}
