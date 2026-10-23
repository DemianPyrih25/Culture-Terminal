"use client";

import type { ReactNode } from "react";
import type { IncomingRequest, TraceNote } from "../../lib/brief";
import { CheckIcon, CrossIcon, cx, DashIcon } from "../ui";
import { useBrief } from "./brief-context";
import styles from "./brief.module.css";
import { NoteTrigger } from "./note-ref";
import { noteText, noteTitles, noteTrace } from "./note-text";
import { RequestStamp } from "./stamp";

/**
 * The sidenote column (A/Sidenote, A/Sidenote · incoming, A/Trace note): numbered notes level with the
 * paragraph that cites them, the requests still arriving during a live run, and the numbers-traced note
 * at the top.
 */

/**
 * One row's notes. From 1280 px the list takes no height in its row and sidenote-layout.ts moves it down
 * past the notes above; it stays hidden until that pass has placed it (so the first paint never prints
 * notes over each other) and sits a layer above the rows below, which it may run past, so its numbers
 * stay clickable. Below 1280 px it folds under its paragraph.
 */
export function NoteList({ children }: { children: ReactNode }) {
  return (
    <div className="xl:h-0 xl:overflow-visible" data-note-wrap="true">
      <div
        data-note-list="true"
        className={cx(
          "flex flex-col gap-4",
          "xl:invisible xl:relative xl:z-[1] xl:opacity-0 xl:data-[placed]:visible xl:data-[placed]:opacity-100",
          "motion-safe:transition-opacity motion-safe:duration-[120ms]",
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Without JavaScript nothing places the notes: from 1280 px they take their rows' height instead, so
 * they never print over each other.
 */
export const NO_SCRIPT_NOTES =
  "@media (min-width: 1280px) { [data-note-wrap] { height: auto !important; } [data-note-list] { visibility: visible !important; opacity: 1 !important; } }";

/**
 * A/Sidenote: the number, the short note and its mono trace line (the inspector has it all, and the
 * hover titles carry the long form). The note is written to fit two lines and the trace one, so from
 * 1280 px the note is held to two lines only as a backstop and the trace is never cut; a figure's
 * codes are the key to its plot and stay whole.
 */
export function Sidenote({ n, text }: { n: number; text?: string }) {
  const { footnotes, animate } = useBrief();
  const note = footnotes.get(n);
  if (!note) return null;
  const body = noteText(note, text);
  const trace = noteTrace(note);
  const titles = noteTitles(note, text);
  return (
    <div className={cx("flex gap-2", animate && styles.settle)} data-sidenote={n} id={`note-${n}`}>
      <NoteTrigger
        n={n}
        className="min-w-3 shrink-0 self-start rounded-brief text-left text-[11px] leading-[17px] font-semibold text-accent tabular-nums hover:underline"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className={cx("m-0 type-sidenote text-dim [overflow-wrap:anywhere]", note.kind !== "figure" && "xl:line-clamp-2")} title={titles.text}>
          {body}
        </p>
        <p className="m-0 type-trace text-dim [overflow-wrap:anywhere]" title={titles.trace}>
          {trace}
        </p>
      </div>
    </div>
  );
}

/** Notes for these footnote numbers, in order. */
export function Sidenotes({ numbers, texts }: { numbers: readonly number[]; texts?: Readonly<Record<number, string>> }) {
  if (numbers.length === 0) return null;
  return (
    <NoteList>
      {numbers.map((n) => (
        <Sidenote key={n} n={n} text={texts?.[n]} />
      ))}
    </NoteList>
  );
}

/** Only the call in flight carries the arrow; a call that arrived is complete and its stamp flashes as it lands. */
const INCOMING_GLYPH: Readonly<Record<IncomingRequest["state"], string>> = {
  fetching: "↓",
  queued: "·",
  received: "·",
};

/** A/Sidenote · incoming: a request in flight, queued, or landed with its stamp. */
export function IncomingNote({ request }: { request: IncomingRequest }) {
  const { sources, isFresh } = useBrief();
  const source = request.sourceIndex === null ? undefined : sources[request.sourceIndex];
  const active = request.state === "fetching";
  return (
    <div className="flex gap-2" data-incoming={request.state}>
      <span aria-hidden="true" className={cx("w-3 shrink-0 text-[11px] leading-[17px] font-semibold", active ? "text-accent" : "text-faint")}>
        {INCOMING_GLYPH[request.state]}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="m-0 type-sidenote text-dim [overflow-wrap:anywhere]">{request.text}</p>
        {request.state === "queued" && request.count <= 1 ? null : (
          <p className={cx("m-0 flex flex-wrap items-center gap-x-1.5 type-trace", request.state === "fetching" ? "text-accent" : "text-dim")}>
            {source ? <RequestStamp cache={source.cache} flash={isFresh(source.qlooCallId)} /> : null}
            <span className="[overflow-wrap:anywhere]">{request.trace}</span>
          </p>
        )}
      </div>
    </div>
  );
}

/** A plain margin note with a glyph instead of a number, e.g. the priors' lock time (A03). */
export function MarginNote({ glyph, children, trace }: { glyph: string; children: ReactNode; trace?: string }) {
  return (
    <div className="flex gap-2">
      <span aria-hidden="true" className="w-3 shrink-0 text-[11px] leading-[17px] font-semibold text-accent">
        {glyph}
      </span>
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="m-0 type-sidenote text-dim">{children}</p>
        {trace ? <p className="m-0 type-trace text-dim">{trace}</p> : null}
      </div>
    </div>
  );
}

/** A dashed ring: the check has not run yet. */
function PendingRing({ spinning }: { spinning: boolean }) {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true" className={cx("shrink-0 text-faint", spinning && "motion-safe:animate-spin")}>
      <circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.2 2" />
    </svg>
  );
}

/** A/Trace note: "25/25 numbers traced", the CHECKER and advice-term line, or "0 of ~27 numbers traced" while live. */
export function TraceNoteView({ trace, className }: { trace: TraceNote; className?: string }) {
  const icon =
    trace.state === "passed" ? (
      <CheckIcon className="shrink-0 text-accent" />
    ) : trace.state === "rejected" ? (
      <CrossIcon className="shrink-0 text-negative" />
    ) : trace.state === "skipped" || trace.state === "stopped" ? (
      <DashIcon className="shrink-0 text-faint" />
    ) : (
      <PendingRing spinning={trace.state === "checking"} />
    );
  return (
    <div className={cx("flex flex-col gap-1 border-b border-line pb-3", className)} data-trace={trace.state}>
      <p className="m-0 flex items-center gap-2">
        {icon}
        <span className={cx("text-[13px] leading-[16px] font-semibold", trace.state === "passed" ? "text-ink" : "text-text-2")}>
          {trace.headline}
        </span>
      </p>
      <p className="m-0 pl-[22px] text-[11px] leading-[15px] text-dim">{trace.detail}</p>
    </div>
  );
}
