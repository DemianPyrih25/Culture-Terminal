"use client";

import Link from "next/link";
import { useMemo, useRef, useState, type ReactNode } from "react";
import type { RunState } from "@ct/contracts";
import type { BriefAnswer, BriefModel, BriefSectionId, BriefTerminal } from "../../lib/brief";
import type { ConnectionStatus } from "../../lib/sse-client";
import { FAKE_MODEL } from "../../lib/test-run";
// Straight from its file: the ask barrel would bring the whole Ask panel into this page's bundle.
import { TopBarAsk } from "../ask/top-bar-ask";
import { ConvictionMark, HONESTY_SHORT, RunningHead, StatusLine, TopBar } from "../chrome";
import { BriefGrid, BriefRow, Outline, SCROLL_ANCHOR_CLASS, type OutlineItem } from "../layout";
import { cx, MetaLine, SectionHead } from "../ui";
import { ExportButton, FollowUpBar, ShareButton } from "./actions";
import { BriefProvider, briefContextValue } from "./brief-context";
import styles from "./brief.module.css";
import { ConvictionStrip, PriorItem, PriorsKicker } from "./conviction";
import { argumentsKicker, ArgumentItem, BlockKicker, KeyFigures, Recommendations } from "./evidence";
import { FigureRow } from "./figure-row";
import { useMedia, useScrolledPast } from "./hooks";
import { ProgressLine, RunMeters, StopRunButton, useStopRun } from "./live";
import { IncomingNote, MarginNote, NO_SCRIPT_NOTES, NoteList, Sidenotes, TraceNoteView } from "./margin";
import { MethodBlock } from "./method";
import { sentenceCase } from "./note-text";
import { expectedRivalRefs, figureRows, placeNotes, ROW } from "./plan";
import { sameProgress, steadyProgress, type SteadyProgress } from "./progress";
import { Prose } from "./prose";
import { ReplayBar, ReplayMarker, ReplayMini, type ReplayBarProps } from "./replay-bar";
import { ChangeHeader, ChangeItem, hasTriggers, Limitations, risksAside } from "./risks";
import { useSidenoteLayout } from "./sidenote-layout";
import { SourcesList } from "./sources";
import { IncompleteCard, Picker, RefusedCard, StoppedCard } from "./terminal";

/**
 * The brief page (Concept A · Brief, D36): A03 while it is written, A05 once finished, in place. Answer
 * first, evidence second, mechanics last; every number a button to the Qloo request behind it, and
 * each sidenote level with the paragraph that cites it. Rendered from a BriefModel, so a live stream, a
 * replay and a stored run print alike.
 */

/** live: the run is being written; replay: a finished run played back; final: a finished or stopped brief. */
export type BriefDocumentView = "live" | "replay" | "final";

export interface BriefDocumentProps {
  model: BriefModel;
  /** The state the model was built from: the evidence bundles, the resolved names and the last event. */
  state: Pick<RunState, "evidence" | "resolves" | "model" | "lastSeq">;
  view: BriefDocumentView;
  /** The stream's connection, while live. */
  connection?: ConnectionStatus;
  /** Replay controls, for view "replay". */
  replay?: ReplayBarProps | null;
  /** The brief's own path (Share) and its replay (null hides "Replay"). */
  links: { permalink: string; replay: string | null };
  /** Shown while the first event has not arrived. */
  fallbackQuestion?: string | null;
  /** A Qloo call that is landing now: its stamp flashes once. */
  isFresh?: (qlooCallId: string) => boolean;
  /** A reader's own question, not a curated showcase: marked "Unlisted · user question" (D31). */
  unlisted?: boolean;
}

/** The top bar and the running head under it, which shows once the page head has scrolled away. */
const TOP_BAR_HEIGHT = 56;
const RUNNING_HEAD_HEIGHT = 44;

/** From here the running head has room for the signal tag over the reading column. */
const WIDE = "(min-width: 1280px)";

const CONNECTION_NOTE: Partial<Record<ConnectionStatus, string>> = {
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  failed: "Live updates stopped · refresh to resume",
  not_found: "This run no longer exists",
};

/** Which sections the page draws: a picker or a refusal has no conviction, evidence or risks to show. */
function shownSections(model: BriefModel): Set<BriefSectionId> {
  const shown = new Set<BriefSectionId>(model.outline.filter((o) => o.available).map((o) => o.id));
  const kind = model.terminal?.kind;
  if (kind === "needs_input" || kind === "refused") {
    shown.delete("conviction");
    shown.delete("evidence");
    shown.delete("risks");
    if (model.method.interpretation === null) shown.delete("method");
    if (model.sources.items.length > 0) shown.add("sources");
  }
  return shown;
}

/** The running head's tag: the signal once written, otherwise where the run stands. */
function headTag(model: BriefModel, view: BriefDocumentView): string {
  // A replay's REPLAY marker sits beside its controls in the head's right slot.
  if (view === "replay") return model.header.signal?.label ?? "";
  switch (model.terminal?.kind) {
    case "needs_input":
      return "Needs a pick";
    case "refused":
      return "Refused";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Stopped";
    case "incomplete":
      return `Incomplete · ${model.header.signal?.label ?? "evidence digest"}`;
    default:
      return model.header.signal?.label ?? (model.live ? "Being written" : "");
  }
}

/** The answer's tag; a run that waits for a pick or was refused did not stop, so it does not say "run stopped". */
export function answerTag(answer: BriefAnswer, terminal: BriefTerminal | null): string {
  if (answer.state === "final") return answer.tag;
  if (terminal?.kind === "needs_input") return "Waiting for your pick";
  if (terminal?.kind === "refused") return "Question refused";
  return answer.tag;
}

/**
 * What the polite live region says: where the run is (the headline that only moves forward), never the
 * ticking clock or who happens to be working this second. A replay says it is one.
 */
export function announcement(model: BriefModel, view: BriefDocumentView, progress: string | null): string {
  const text = model.live
    ? `${progress ?? model.live.progress.label}.`
    : model.terminal
      ? model.terminal.message
      : model.mode === "final"
        ? `Brief ready. ${model.trace.headline}.`
        : "";
  return view === "replay" && text !== "" ? `Replay: ${text}` : text;
}

/** The progress headline, kept from stepping back as the run's stage moves (see ./progress). */
function useSteadyProgress(label: string | null, seq: number): string | null {
  const [steady, setSteady] = useState<SteadyProgress | null>(null);
  const next = label === null ? null : steadyProgress(steady, label, seq);
  if (!sameProgress(next, steady) && next !== null) setSteady(next);
  return next?.label ?? null;
}

function AnswerBlock({
  model,
  view,
  question,
  connectionNote,
  progress,
  stop,
}: {
  model: BriefModel;
  view: BriefDocumentView;
  question: string | null;
  connectionNote: string | null;
  progress: string | null;
  stop: ReactNode;
}) {
  const { answer, terminal } = model;
  const final = answer.state === "final";
  // While the run is written the tag only promises the answer, so it reads lighter (A03): a lighter weight,
  // not a fainter colour, so it keeps its contrast.
  const tagTone = final ? "font-semibold text-ink" : model.live ? "font-normal text-dim" : "font-semibold text-dim";
  return (
    <div className="flex w-full flex-col gap-3.5" data-answer={answer.state}>
      {/* A/Answer block: the kicker sits 10 px over the answer, 14 px over a progress line or a card. */}
      <div className="flex flex-col gap-2.5">
        <h2 className="m-0 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] leading-4 font-normal tracking-[1.3px] uppercase">
          <span className="font-semibold text-dim">The answer</span>
          <span aria-hidden="true" className="tracking-normal text-faint">
            —
          </span>
          <span className={tagTone}>{answerTag(answer, terminal)}</span>
          {model.header.incomplete && terminal?.kind !== "incomplete" ? (
            <span className="rounded-brief border border-negative px-1 font-mono text-[10px] leading-4 tracking-[0.6px] text-negative" data-marker="INCOMPLETE">
              INCOMPLETE
            </span>
          ) : null}
        </h2>
        {final ? (
          <>
            <p className="m-0 font-serif text-[24px] leading-[32px] font-medium text-ink" data-headline="true">
              <Prose inlines={answer.headline} />
            </p>
            {answer.thesis && answer.thesis.length > 0 ? (
              <p className="m-0 type-answer text-ink" data-thesis="true">
                <Prose inlines={answer.thesis} />
              </p>
            ) : null}
          </>
        ) : null}
      </div>
      {model.live ? <ProgressLine live={model.live} note={connectionNote} label={progress ?? undefined} /> : null}
      {view === "live" && stop ? <div className="md:hidden">{stop}</div> : null}
      {terminal?.kind === "needs_input" ? (
        <Picker terminal={terminal} runId={model.runId} canPick={model.live === null && view !== "replay"} question={question} replay={view === "replay"} />
      ) : terminal?.kind === "refused" ? (
        <RefusedCard terminal={terminal} requests={model.sources.items.length} />
      ) : terminal?.kind === "failed" || terminal?.kind === "cancelled" ? (
        <StoppedCard terminal={terminal} model={model} />
      ) : terminal?.kind === "incomplete" ? (
        // A digest's own thesis already says why the run stopped.
        <IncompleteCard terminal={terminal} explained={final} />
      ) : null}
    </div>
  );
}

/** Every footnote, for paper: the sidenotes print here instead of in the margin. */
function Endnotes({ model }: { model: BriefModel }) {
  if (model.footnotes.length === 0) return null;
  return (
    <section aria-label="Notes" className="hidden flex-col gap-2 pt-10 print:flex">
      <h2 className="m-0 border-t border-line-strong pt-2.5 text-[11px] font-semibold tracking-[1.3px] text-ink uppercase">Notes</h2>
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0">
        {model.footnotes.map((f) => (
          <li key={f.n} className="flex gap-2 text-[11px] leading-4">
            <span className="w-5 shrink-0 font-semibold text-accent">{f.n}</span>
            <span className="text-text-2">
              {sentenceCase(f.text)} <span className="font-mono text-[10px] text-dim">{f.trace}</span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** D31: a reader's own run is unlisted; the marker says so at the head of the brief. */
function UnlistedMarker({ test }: { test: boolean }) {
  return (
    <span className="rounded-brief border border-line-strong px-1 font-mono text-[10px] leading-4 tracking-[0.4px] text-dim" data-marker="UNLISTED">
      Unlisted · {test ? "test run" : "user question"}
    </span>
  );
}

export function BriefDocument({
  model,
  state,
  view,
  connection,
  replay = null,
  links,
  fallbackQuestion = null,
  isFresh,
  unlisted = false,
}: BriefDocumentProps) {
  const context = useMemo(() => briefContextValue(model, state, isFresh, view !== "final"), [model, state, isFresh, view]);
  const notes = useMemo(() => placeNotes(model), [model]);
  const rows = useMemo(() => figureRows(model.evidence.figures), [model]);
  const rivals = useMemo(() => expectedRivalRefs(state.resolves), [state.resolves]);
  const shown = shownSections(model);
  const progress = useSteadyProgress(model.live?.progress.label ?? null, state.lastSeq);
  const answered = model.answer.state === "final";

  // Once the answer is written there is nothing left to stop, though run.end may still be on its way.
  const cancellable = view === "live" && (model.live?.cancellable ?? false) && !answered;
  const stopRun = useStopRun(model.runId, cancellable);
  const stop = cancellable ? <StopRunButton {...stopRun} /> : null;

  const [heading, setHeading] = useState<HTMLHeadingElement | null>(null);
  const past = useScrolledPast(heading, TOP_BAR_HEIGHT);
  const wide = useMedia(WIDE);
  const mainRef = useRef<HTMLElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  useSidenoteLayout(mainRef, gridRef, model);

  const { header } = model;
  const question = header.question ?? fallbackQuestion;
  const tag = headTag(model, view);
  const final = model.mode === "final";
  const connectionNote = view === "live" && connection ? (CONNECTION_NOTE[connection] ?? null) : null;
  const testRun = state.model === FAKE_MODEL;

  const outlineItems: OutlineItem[] = model.outline.map((o) => ({ id: o.id, label: o.label, pending: !shown.has(o.id) }));
  const metaExtra: ReactNode[] = [];
  if (header.parentRunId) {
    metaExtra.push(
      <Link key="parent" href={`/run/${encodeURIComponent(header.parentRunId)}`} className="hover:text-accent hover:underline">
        Follow-up of #{header.parentRunId.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase()}
      </Link>,
    );
  }
  if (unlisted) metaExtra.push(<UnlistedMarker key="unlisted" test={testRun} />);
  else if (testRun) metaExtra.push("Test run");
  if (view === "replay") metaExtra.push(<ReplayMarker key="replay" />);

  // A row with no notes of its own passes none, so it draws no empty margin.
  const notesAt = (key: string) => {
    const numbers = notes.get(key) ?? [];
    return numbers.length > 0 ? <Sidenotes numbers={numbers} /> : null;
  };
  const changes = model.risks.changes;
  const triggers = hasTriggers(changes);
  const priorsLock = model.priors.lockedAt ? (
    <NoteList>
      <MarginNote glyph="†" trace="priors before data">
        Locked at {model.priors.lockedAt}, before the data that tests them. Scored against it, never edited.
      </MarginNote>
    </NoteList>
  ) : null;
  // Requests in flight sit beside the answer until it is written; then its own numbered notes do.
  const answerNotes =
    model.live && !answered && model.live.incoming.length > 0 ? (
      <NoteList>
        {model.live.incoming.map((r) => (
          <IncomingNote key={r.key} request={r} />
        ))}
      </NoteList>
    ) : (
      notesAt(ROW.answer)
    );

  const outline = (
    <div className="flex flex-col gap-11 print:hidden">
      <Outline
        items={outlineItems}
        meta={{
          trace: model.live || !header.date ? header.briefLabel : `${header.briefLabel} · ${header.date}`,
          text: view === "replay" ? (header.date ? `Replay of a run recorded ${header.date}` : "Replay of a recorded run") : header.footer,
        }}
      />
      {view !== "final" && model.live ? <RunMeters live={model.live} stop={stop} /> : null}
      {view === "final" && links.replay ? (
        <Link href={links.replay} className="pl-[14px] text-[13px] font-medium text-accent hover:underline hover:underline-offset-4" data-replay-link="true">
          Replay this run <span aria-hidden="true">▶</span>
        </Link>
      ) : null}
    </div>
  );

  // The running head's right slot: in a replay, its controls (the bar above has scrolled away); else the
  // conviction and the actions. Between 1024 and 1279 px the tag sits here too, where it is never cut
  // short; below 1024 the question needs the room, and the tag stays on the page.
  const headRight =
    view === "replay" && replay ? (
      <>
        <ReplayMini {...replay} />
        <span className="ml-auto flex items-center gap-0.5">
          <ShareButton path={links.permalink} />
        </span>
      </>
    ) : (
      <>
        {tag ? (
          // A hairline keeps the tag apart from the conviction beside it (A04's divider).
          <span className="hidden items-center gap-2 lg:inline-flex xl:hidden">
            <span className="text-[11px] leading-[14px] font-semibold tracking-[1.3px] whitespace-nowrap text-accent uppercase" title={tag}>
              {tag}
            </span>
            <span aria-hidden="true" className="h-3 w-px bg-line-strong" />
          </span>
        ) : null}
        <ConvictionMark band={header.conviction?.bandLabel ?? null} score={header.conviction?.score ?? null} />
        <span className="ml-auto flex items-center gap-0.5">
          <ExportButton />
          <ShareButton path={links.permalink} />
        </span>
      </>
    );

  return (
    <BriefProvider value={context}>
      <div className={cx(styles.page, "flex min-h-screen flex-col bg-paper")}>
        <a
          href="#answer"
          className="sr-only rounded-brief bg-ink px-3 py-2 text-[13px] font-medium text-on-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50 print:hidden"
        >
          Skip to the brief
        </a>
        <noscript>
          <style>{NO_SCRIPT_NOTES}</style>
        </noscript>
        <TopBar command={<TopBarAsk parentRunId={model.runId} />} active="briefs" className="print:hidden" />
        <div
          className={cx(
            "fixed inset-x-0 top-0 z-20 transition-[transform,opacity] duration-[240ms] md:top-14 print:hidden",
            past ? "translate-y-0 opacity-100" : "pointer-events-none -translate-y-2 opacity-0",
          )}
          aria-hidden={!past}
          inert={!past}
          data-running-head={past ? "shown" : "hidden"}
        >
          <RunningHead
            sticky={false}
            desk={header.deskLabel ?? "Brief"}
            job={header.jobLabel ?? header.briefLabel}
            question={question ?? header.briefLabel}
            // Below 1280 px the tag moves into the right slot, so it is never truncated.
            finding={wide && tag ? tag : undefined}
            right={headRight}
          />
        </div>

        <main id="brief" ref={mainRef} className="flex-1 pb-20">
          <p className="hidden px-4 pt-2 text-[10px] text-dim print:block">{model.statusLine.honesty}</p>
          <div ref={gridRef}>
            <BriefGrid outline={outline} stickyTop={past ? TOP_BAR_HEIGHT + RUNNING_HEAD_HEIGHT : TOP_BAR_HEIGHT}>
              {view === "replay" && replay ? (
                <BriefRow className="pt-6 max-md:pt-0">
                  <ReplayBar {...replay} />
                </BriefRow>
              ) : null}
              <BriefRow
                // Below 768 px the Report | Sources switch above already leaves its 24 px.
                className={cx("pt-7", !(view === "replay" && replay) && "max-md:pt-1")}
                notes={
                  <NoteList>
                    <TraceNoteView trace={model.trace} />
                  </NoteList>
                }
              >
                <div className="flex flex-col gap-3.5">
                  <MetaLine
                    desk={header.deskLabel ?? "New brief"}
                    job={header.jobLabel ?? undefined}
                    briefId={header.briefLabel}
                    date={header.date ?? undefined}
                    extra={metaExtra}
                  />
                  <h1 ref={setHeading} className="m-0 type-question tracking-[-0.6px] text-ink [overflow-wrap:anywhere] max-md:text-[30px] max-md:leading-[37px]">
                    {question ?? "Waiting for the question…"}
                  </h1>
                </div>
              </BriefRow>

              <BriefRow id="answer" className={cx("pt-7", SCROLL_ANCHOR_CLASS)} notes={answerNotes}>
                <AnswerBlock model={model} view={view} question={question} connectionNote={connectionNote} progress={progress} stop={stop} />
              </BriefRow>

              {shown.has("conviction") ? (
                <>
                  <BriefRow className="pt-9">
                    <SectionHead id="conviction" className={SCROLL_ANCHOR_CLASS} number="02" title="Conviction" aside={model.conviction.aside} />
                    <div className="pt-4">
                      <ConvictionStrip conviction={model.conviction} />
                    </div>
                  </BriefRow>
                  {model.priors.items.length > 0 ? (
                    <BriefRow className="pt-7" notes={priorsLock}>
                      <PriorsKicker priors={model.priors} />
                    </BriefRow>
                  ) : null}
                  {model.priors.items.map((p, i) => (
                    <BriefRow key={p.id} notes={notesAt(ROW.prior(p.id))}>
                      <PriorItem prior={p} hero={i === 0 && final} />
                    </BriefRow>
                  ))}
                </>
              ) : null}

              {shown.has("evidence") ? (
                <>
                  <BriefRow className="pt-10">
                    <SectionHead id="evidence" className={SCROLL_ANCHOR_CLASS} number="03" title="Evidence" aside={model.evidence.aside} />
                  </BriefRow>
                  {model.evidence.keyFigures.length > 0 ? (
                    <BriefRow className="pt-4" notes={notesAt(ROW.keyFigures)}>
                      <KeyFigures figures={model.evidence.keyFigures} live={model.live !== null} />
                    </BriefRow>
                  ) : null}
                  {rows.map((row, i) => (
                    <FigureRow
                      key={ROW.figures(row)}
                      figures={row}
                      notes={notes.get(ROW.figures(row)) ?? []}
                      rivals={rivals}
                      first={i === 0 && model.evidence.keyFigures.length === 0}
                      // A dataset not streamed inline is stored with the run's ledger, before run.end.
                      ready={view === "replay" || model.live === null}
                    />
                  ))}
                  {model.evidence.arguments.length > 0 ? (
                    <BriefRow className="pt-9">
                      <BlockKicker title={argumentsKicker(model.evidence.arguments.length)} />
                    </BriefRow>
                  ) : null}
                  {model.evidence.arguments.map((a) => (
                    <BriefRow key={a.id} notes={notesAt(ROW.argument(a.id))}>
                      <ArgumentItem argument={a} />
                    </BriefRow>
                  ))}
                  {model.evidence.recommendations.length > 0 ? (
                    <BriefRow className="pt-8">
                      <Recommendations items={model.evidence.recommendations} />
                    </BriefRow>
                  ) : null}
                </>
              ) : null}

              {shown.has("risks") ? (
                <>
                  <BriefRow className="pt-10">
                    <SectionHead
                      id="risks"
                      className={SCROLL_ANCHOR_CLASS}
                      number="04"
                      title="Risks"
                      aside={risksAside(changes.length, model.risks.limitations)}
                    />
                    {changes.length > 0 ? <ChangeHeader triggers={triggers} /> : null}
                  </BriefRow>
                  {changes.map((c) => (
                    <BriefRow key={c.n} notes={notesAt(ROW.change(c.n))}>
                      <ChangeItem change={c} triggers={triggers} />
                    </BriefRow>
                  ))}
                  {model.risks.limitations.length > 0 ? (
                    <BriefRow className="pt-7">
                      <Limitations items={model.risks.limitations} />
                    </BriefRow>
                  ) : null}
                </>
              ) : null}

              {shown.has("method") ? (
                <BriefRow className="pt-10">
                  <SectionHead id="method" className={SCROLL_ANCHOR_CLASS} number="05" title="Method" aside="Mechanics last" />
                  <div className="pt-1">
                    <MethodBlock method={model.method} />
                  </div>
                </BriefRow>
              ) : null}

              {shown.has("sources") ? (
                <BriefRow className="pt-10" notes={notesAt(ROW.sources)}>
                  <SectionHead id="sources" className={SCROLL_ANCHOR_CLASS} number="06" title="Sources" aside={model.sources.line} />
                  <div className="pt-2">
                    <SourcesList sources={model.sources} />
                  </div>
                  <ul className="m-0 flex list-none flex-col gap-0.5 p-0 pt-4 text-[11px] leading-4 text-dim">
                    {model.disclaimers.map((d) => (
                      <li key={d}>{d}</li>
                    ))}
                  </ul>
                </BriefRow>
              ) : null}

              {model.live === null && view !== "replay" ? (
                // Paper has no follow-up bar, so its row leaves no gap before the endnotes either.
                <BriefRow className="pt-12 print:hidden">
                  <FollowUpBar runId={model.runId} permalinkPath={links.permalink} nextMoves={model.nextMoves} replayHref={links.replay} />
                </BriefRow>
              ) : null}

              <BriefRow>
                <Endnotes model={model} />
              </BriefRow>
            </BriefGrid>
          </div>
        </main>

        {past ? (
          <div
            aria-hidden="true"
            inert
            // Level with the outline's heading (30 px under the chrome), with room below its rule so the
            // notes scrolling under it never touch it.
            className="fixed z-10 hidden w-[300px] bg-paper pt-7 pb-4 xl:block print:hidden"
            style={{ top: TOP_BAR_HEIGHT + RUNNING_HEAD_HEIGHT, right: "max(24px, calc((100% - 1300px) / 2))" }}
            data-trace-pinned="true"
          >
            <TraceNoteView trace={model.trace} />
          </div>
        ) : null}

        <StatusLine
          className="print:hidden"
          left={model.statusLine.honesty}
          compact={HONESTY_SHORT}
          right={
            <>
              {model.statusLine.window ? <span>{model.statusLine.window}</span> : null}
              <span className="font-mono">{model.statusLine.requests}</span>
            </>
          }
        />
        <p className="sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement(model, view, progress)}
        </p>
      </div>
    </BriefProvider>
  );
}
