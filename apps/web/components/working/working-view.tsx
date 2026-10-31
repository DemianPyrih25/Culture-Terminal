"use client";

import type { ReactNode } from "react";
import type { RunState } from "@ct/contracts";
import type { BriefModel } from "../../lib/brief";
import { endedInQueue, queuedPlace, queueWaitLeftS } from "../../lib/run-stream";
import { noticed, readingAs, replayTime, WORKING_JOB_LABEL, workingProgress } from "../../lib/brief/steps";
import { formatClockShort } from "../../lib/brief/format";
import type { IncomingRequest } from "../../lib/brief/types";
import { ANSWERS_HREF, PageHead, SiteShell } from "../chrome";
import { cx, Icon, KeyNumber, Spinner, Tag, topicForPillar, type KeyNumberProps } from "../ui";
import { GuessesCard } from "./guesses";
import { editQuestionHref, NotFoundCard, ProgressCard, QueuedCard } from "./progress-card";
import { ReplayControls, type ReplayControlsProps } from "./replay-controls";
import { lookupChips, type LookupChip } from "./sources";
import { ReconnectingState, StateCard } from "./state-cards";
import { StopButton, useStopRun } from "./stop";
import { WhichOneCard } from "./which-one";
import { buildAnswerContext } from "../../lib/answer/context";
import { ContextRow } from "../answer/context-cards";

/**
 * The working view (N03 early, N04 late, N16 end states): the page while an answer is being made, and
 * the page of a run that ended before its answer. The page head with Stop (or the replay controls and
 * the replay bar), the progress card (or the end-state card in its slot), then "Evidence so far": draft
 * key numbers, a draft chart and the guesses, and the context cards ("What AI knows (not verified)",
 * "From the web") as soon as each block settles. While live, a margin rail lists the lookups arriving.
 */

export interface WorkingReplay extends ReplayControlsProps {
  positionMs: number;
  durationMs: number | null;
  /** 0–1 of the recording. */
  progress: number;
}

export interface WorkingViewProps {
  runId: string;
  model: BriefModel;
  /** The run's state the model was built from. */
  state: RunState;
  /** live: streaming (Stop works); replay: a recording; static: a run that ended without an answer. */
  mode: "live" | "replay" | "static";
  /** The question from the run row, until run.created arrives. */
  fallbackQuestion?: string | null;
  /** Run time so far (live) or at the playhead (replay). */
  elapsedMs: number;
  /** Replay controls, for mode replay. */
  replay?: WorkingReplay | null;
  /** The live stream stopped: the reconnecting line shows. */
  connectionLost?: boolean;
  /** The draft key numbers that have arrived (Draft tags, no Source). */
  keyNumbers?: readonly KeyNumberProps[];
  /** The draft main chart, once its data is in. */
  chart?: ReactNode;
  /** The path Share copies on phones. */
  sharePath?: string;
}

const RISE = "motion-safe:animate-rise";

/** A small entrance stagger for a row of cards (40 ms apart). */
const STAGGER = ["", "[animation-delay:40ms]", "[animation-delay:80ms]", "[animation-delay:120ms]"] as const;
const stagger = (i: number): string => STAGGER[Math.min(i, STAGGER.length - 1)] ?? "";

/** One lookup in the live evidence rail: what it fetched, then its trace in mono. */
function FeedRow({ row }: { row: IncomingRequest }) {
  // "Qloo /v2/insights · tags for a brand": the source and endpoint, then what it asked for.
  const cut = row.text.indexOf(" · ");
  const head = cut > 0 ? row.text.slice(0, cut) : row.text;
  const rest = cut > 0 ? row.text.slice(cut + 3).replace(/ · (fetching|queued)$/, "") : null;
  return (
    <li className="flex min-w-0 gap-3 py-3 motion-safe:animate-rise" data-incoming={row.state}>
      <span className="flex h-[18px] w-4 shrink-0 items-center">
        {row.state === "fetching" ? (
          <Spinner size={12} className="text-accent" />
        ) : (
          <Icon name={row.state === "queued" ? "circle-dashed" : "circle-check"} size={12} className={row.state === "queued" ? "text-ink-3" : "text-good"} />
        )}
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="flex min-w-0 items-baseline justify-between gap-2">
          <span className="min-w-0 text-[12px] leading-[18px] font-medium text-ink [overflow-wrap:anywhere]">{head}</span>
          {row.state === "fetching" ? <span className="shrink-0 font-mono text-[10px] leading-4 text-accent">running</span> : null}
        </p>
        {rest ? <p className="text-[11px] leading-4 text-ink-2 [overflow-wrap:anywhere]">{rest}</p> : null}
        <p className="font-mono text-[10px] leading-4 text-ink-3 [overflow-wrap:anywhere]">{row.trace}</p>
      </div>
    </li>
  );
}

/** The live evidence rail: the lookups in flight and the latest to arrive, newest first. */
function EvidenceFeed({ rows, lookups }: { rows: readonly IncomingRequest[]; lookups: readonly LookupChip[] }) {
  const total = lookups.reduce((n, l) => n + l.count, 0);
  return (
    <aside aria-label="Live evidence" data-evidence-feed className="flex min-w-0 flex-col gap-2 xl:sticky xl:top-6 xl:self-start">
      <div className="flex items-baseline justify-between gap-3 border-b border-line pb-2">
        <h2 className="type-overline text-ink-2">Live evidence</h2>
        <p className="font-mono text-[11px] leading-4 text-ink-2 tabular-nums">
          {total} {total === 1 ? "lookup" : "lookups"}
        </p>
      </div>
      {rows.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line">
          {rows.map((row) => (
            <FeedRow key={row.key} row={row} />
          ))}
        </ul>
      ) : (
        <p className="py-3 type-label text-ink-2">Nothing fetched yet.</p>
      )}
    </aside>
  );
}

/** "7 sources so far", or "7 of ~12 sources" once the plan gave an estimate. */
function sourceCount(n: number, expected: number | null): string {
  return expected !== null && expected > n ? `${n} of ~${expected} sources` : `${n} ${n === 1 ? "source" : "sources"} so far`;
}

/** An end-state card spans 8 of 12 columns (744 at 1440), as the verdict card does. */
const END_CARD = "lg:max-w-[744px]";

export function WorkingView({
  runId,
  model,
  state,
  mode,
  fallbackQuestion = null,
  elapsedMs,
  replay = null,
  connectionLost = false,
  keyNumbers = [],
  chart = null,
  sharePath,
}: WorkingViewProps) {
  const question = state.question ?? model.header.question ?? fallbackQuestion;
  const live = mode === "live" && state.ended === null;
  const cancellable = live && (state.status === "queued" || state.status === "running");
  const stop = useStopRun(runId, cancellable);

  const pillar = state.intent?.pillar ?? model.header.pillar;
  const topic = pillar ? topicForPillar(pillar) : null;
  const job = state.intent?.job ?? model.header.job;
  const eyebrowText = topic ? [topic.label, job ? WORKING_JOB_LABEL[job] : null].filter(Boolean).join(" · ") : "";
  const eyebrow = live ? (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1">
      {eyebrowText ? <span>{eyebrowText}</span> : null}
      <span className="inline-flex items-center gap-1.5 rounded-sm bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] leading-3 font-medium tracking-[0.06em] text-accent" data-live-tag>
        <span aria-hidden className="size-1.5 rounded-full bg-accent motion-safe:animate-pulse" />
        LIVE
      </span>
    </span>
  ) : mode === "replay" ? (
    <span className="inline-flex flex-wrap items-center gap-x-2.5 gap-y-1" data-replay-bar>
      {eyebrowText ? <span>{eyebrowText}</span> : null}
      <Tag preset="recording" />
    </span>
  ) : (
    eyebrowText
  );

  const stopButton = cancellable ? <StopButton phase={stop.phase} press={stop.press} /> : null;
  const replayControls = replay ? <ReplayControls {...replay} /> : null;
  const actions = replayControls ?? stopButton;

  const progress = workingProgress(state);
  const terminal = model.terminal;
  const editHref = editQuestionHref(question);
  const hasEvidence = keyNumbers.length > 0 || chart !== null;
  const priors = model.priors.items;
  const lookups = lookupChips(state);
  // Waiting for a live slot (D24): only a live run waits; a replay plays its queue part instantly.
  const place = mode === "live" ? queuedPlace(state) : null;
  // The live evidence rail: only while the run is being made (a replay or an ended run has no feed).
  const feed = live && terminal === null ? (model.live?.incoming ?? []) : null;

  let slot: ReactNode;
  if (terminal?.kind === "needs_input") {
    slot =
      terminal.candidates.length > 0 ? (
        <WhichOneCard runId={runId} mention={terminal.mention} candidates={terminal.candidates} canPick={state.ended !== null} editHref={editHref} replay={mode === "replay"} className={END_CARD} />
      ) : (
        <NotFoundCard mention={terminal.mention} editHref={editHref} className={END_CARD} />
      );
  } else if (terminal && state.ended !== null) {
    slot = <StateCard terminal={terminal} question={question} compact={hasEvidence} unstarted={endedInQueue(state)} className={END_CARD} />;
  } else if (place) {
    // The clock the page reads, as an instant: the run's first event plus the time since it.
    const now = Date.parse(state.createdAt ?? place.at) + elapsedMs;
    slot = <QueuedCard position={place.position} waitLeftS={queueWaitLeftS(place, now)} editHref={editHref} />;
  } else {
    slot = (
      <ProgressCard
        title={progress.title}
        time={replay ? replayTime(replay.positionMs, replay.durationMs) : formatClockShort(elapsedMs)}
        fraction={replay ? replay.progress : (model.live?.progress.fraction ?? 0)}
        steps={progress.steps}
        readingAs={readingAs(state)}
        editHref={mode === "replay" ? null : editHref}
        noticed={noticed(state)}
        readAsLine={model.method.interpretation?.readAs?.line ?? null}
        lookups={lookups}
        since={live ? (model.live?.since ?? null) : null}
        count={!replay && model.live && model.live.progress.sourcesIn > 0 ? sourceCount(model.live.progress.sourcesIn, model.live.progress.sourcesExpected) : null}
        fetching={live ? (model.live?.incoming.find((r) => r.state === "fetching") ?? null) : null}
        announcement={progress.announcement}
        variant={replay ? "replay" : "live"}
      />
    );
  }

  const evidence = hasEvidence ? (
    <>
      {keyNumbers.length > 0 ? (
        <div className="grid gap-4 md:grid-cols-3" data-key-numbers="draft">
          {keyNumbers.map((k, i) => (
            <KeyNumber key={k.label} {...k} draft onSource={undefined} className={cx(RISE, stagger(i), k.className)} />
          ))}
        </div>
      ) : null}
      <div className={cx("grid gap-4", chart !== null && priors.length > 0 && "lg:grid-cols-[minmax(0,1fr)_300px]")}>
        {chart ? <div className={cx("min-w-0", RISE)}>{chart}</div> : null}
        {priors.length > 0 ? <GuessesCard priors={priors} variant={chart ? "side" : "full"} className={RISE} /> : null}
      </div>
    </>
  ) : priors.length > 0 ? (
    <GuessesCard priors={priors} variant="full" className={RISE} />
  ) : null;
  const evidenceTag = state.ended !== null || mode === "replay" ? "Not checked" : "Draft · not checked";

  return (
    <SiteShell header="working" mobileHeader="answer" backHref={ANSWERS_HREF} sharePath={sharePath} mainClassName="pt-8 pb-16 max-md:pt-4 max-md:pb-12">
      <div className={cx("flex flex-col gap-10 max-md:gap-8", feed !== null && "xl:grid xl:grid-cols-[minmax(0,1fr)_300px] xl:items-start xl:gap-10")}>
        <div className="flex min-w-0 flex-col gap-10 max-md:gap-8">
          <div data-working={mode} data-run={runId} className="flex flex-col gap-6 max-md:gap-4">
            <PageHead topic={topic?.key ?? null} eyebrow={eyebrow} question={question ?? "Your question"} actions={actions} mobileActions={actions} />
            <div className={RISE}>{slot}</div>
            {connectionLost && live ? <ReconnectingState /> : null}
          </div>
          {evidence ? (
            <section aria-label="Evidence so far" className={cx("flex flex-col gap-4", RISE)}>
              <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1 border-b border-line pb-3">
                <h2 className="type-title-sm text-ink">Evidence so far</h2>
                <Tag tone="muted">
                  {evidenceTag}
                </Tag>
              </div>
              {evidence}
            </section>
          ) : null}
          <ContextRow context={buildAnswerContext(state)} className={RISE} />
        </div>
        {feed !== null ? <EvidenceFeed rows={feed} lookups={lookups} /> : null}
      </div>
    </SiteShell>
  );
}
