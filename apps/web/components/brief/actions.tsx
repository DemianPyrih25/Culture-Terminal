"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { QUESTION_MAX_CHARS } from "@ct/contracts";
import type { BriefNextMove } from "../../lib/brief";
import { askHref } from "../ask/ask-href";
import { Button, ButtonLink, cx, DownloadIcon, IconButton, LinkIcon } from "../ui";
import { useCopied } from "./copy-button";

/**
 * The brief's actions: Share copies the permalink, Export PDF prints the brief (the print stylesheet
 * drops the chrome and turns sidenotes into endnotes), and the A/Follow-up bar with the next-move chips.
 */

function permalink(path: string): string {
  return typeof window === "undefined" ? path : new URL(path, window.location.origin).toString();
}

function printBrief() {
  window.print();
}

const COPIED_TEXT = { idle: "", copied: "Link copied", failed: "Could not copy the link" } as const;

/** Share as the running head's 28 px icon, or the follow-up bar's secondary button. */
export function ShareButton({ path, variant = "icon" }: { path: string; variant?: "icon" | "button" }) {
  const [state, copy] = useCopied();
  return (
    <span className="relative inline-flex items-center">
      {variant === "icon" ? (
        <IconButton label="Copy link to this brief" onClick={() => copy(permalink(path))}>
          <LinkIcon size={16} />
        </IconButton>
      ) : (
        <Button size="sm" icon={<LinkIcon />} onClick={() => copy(permalink(path))}>
          Share
        </Button>
      )}
      {/* Always in the accessibility tree (never display: none), so "Link copied" is announced. */}
      <span
        role="status"
        aria-live="polite"
        className={
          state === "idle"
            ? "sr-only"
            : cx(
                "pointer-events-none text-[11px] whitespace-nowrap text-dim",
                variant === "icon" ? "absolute top-full right-0 mt-1 rounded-brief border border-line bg-paper px-1.5 py-0.5" : "ml-2",
              )
        }
      >
        {COPIED_TEXT[state]}
      </span>
    </span>
  );
}

export function ExportButton({ variant = "icon" }: { variant?: "icon" | "button" }) {
  return variant === "icon" ? (
    <IconButton label="Export PDF" onClick={printBrief}>
      <DownloadIcon size={16} />
    </IconButton>
  ) : (
    <Button size="sm" icon={<DownloadIcon />} onClick={printBrief}>
      Export PDF
    </Button>
  );
}

export interface FollowUpBarProps {
  runId: string;
  /** The brief's own path, copied by Share. */
  permalinkPath: string;
  /** The report's next moves as chips, each with its desk and its Ask link (lib/brief next-moves). */
  nextMoves: readonly BriefNextMove[];
  /** Where "Replay" goes; null hides it (a run still being written). */
  replayHref?: string | null;
}

/**
 * A next move as a chip (SPEC §7.3): the desk it reads as, its short label and an arrow. It opens Ask with
 * the question filled in and this brief as the parent; the full question is its title and accessible name.
 */
function NextMoveChip({ move }: { move: BriefNextMove }) {
  return (
    <li className="min-w-0">
      <Link
        href={move.href}
        title={move.question}
        aria-label={`${move.deskLabel} · ${move.label}: ask “${move.question}”`}
        className="group inline-flex h-8 max-w-full items-center gap-2 rounded-brief border border-line-strong bg-paper pr-2.5 pl-2 hover:border-accent focus-visible:border-accent"
        data-next-move={move.label}
        data-desk={move.pillar}
      >
        <span className="shrink-0 text-[10px] leading-none font-semibold tracking-[1.1px] text-accent uppercase">{move.deskLabel}</span>
        <span aria-hidden="true" className="h-3 w-px shrink-0 bg-line-strong" />
        <span className="min-w-0 truncate text-[13px] leading-none text-ink group-hover:underline group-hover:underline-offset-4">{move.label}</span>
        <span aria-hidden="true" className="shrink-0 text-[12px] leading-none text-accent">
          →
        </span>
      </Link>
    </li>
  );
}

/** A/Follow-up bar: the next moves, a follow-up question field, Export PDF, Share, Replay, and Follow (not yet). */
export function FollowUpBar({ runId, permalinkPath, nextMoves, replayHref = null }: FollowUpBarProps) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const example = nextMoves[0]?.question;
  return (
    <section aria-label="Follow up" className="flex w-full flex-col gap-3 border-t border-line-strong pt-[18px] print:hidden">
      {nextMoves.length > 0 ? (
        <div className="flex flex-col gap-2">
          <h2 className="m-0 text-[11px] leading-4 font-semibold tracking-[1.3px] text-dim uppercase">Next moves</h2>
          <ul className="m-0 flex list-none flex-wrap gap-2 p-0" data-next-moves={nextMoves.length}>
            {nextMoves.map((m) => (
              <NextMoveChip key={m.question} move={m} />
            ))}
          </ul>
        </div>
      ) : null}
      <form
        role="search"
        aria-label="Ask a follow-up"
        className="flex h-[46px] w-full items-center gap-2.5 rounded-brief border border-line-strong bg-paper pr-1.5 pl-3.5 focus-within:border-accent"
        onSubmit={(event) => {
          event.preventDefault();
          const question = value.trim();
          // Ask stays inked as in A/Follow-up bar; with nothing typed it hands the field the focus.
          if (question === "") input.current?.focus();
          else router.push(askHref(question, runId));
        }}
      >
        <input
          ref={input}
          type="text"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          aria-label="Ask a follow-up on this brief"
          placeholder={example ? `Ask a follow-up, e.g. ${example}` : "Ask a follow-up on this brief"}
          maxLength={QUESTION_MAX_CHARS}
          className="h-full min-w-0 flex-1 bg-transparent text-[14px] text-ink outline-none placeholder:text-dim"
        />
        <Button type="submit" variant="primary" className="h-[34px]">
          Ask
        </Button>
      </form>
      <div className="flex flex-wrap items-center gap-2.5">
        <ExportButton variant="button" />
        <ShareButton path={permalinkPath} variant="button" />
        {replayHref ? (
          <ButtonLink
            href={replayHref}
            variant="secondary"
            size="sm"
            hint={null}
            data-replay-link="true"
            icon={
              <span aria-hidden="true" className="font-mono text-[10px] text-text-2">
                ▶
              </span>
            }
          >
            Replay
          </ButtonLink>
        ) : null}
        <Button variant="quiet" size="sm" hint={null} disabled title="Following is not available yet" className="ml-auto">
          Follow this subject
          <span className="sr-only"> (not available yet)</span>
        </Button>
      </div>
    </section>
  );
}
