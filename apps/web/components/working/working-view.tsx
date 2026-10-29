"use client";

import type { ReactNode } from "react";
import type { RunState } from "@ct/contracts";
import type { BriefModel } from "../../lib/brief";
import { noticed, readingAs, replayTime, WORKING_JOB_LABEL, workingProgress, workingTime } from "../../lib/brief/steps";
import { ANSWERS_HREF, PageHead, SiteShell } from "../chrome";
import { cx, KeyNumber, topicForPillar, type KeyNumberProps } from "../ui";
import { GuessesCard } from "./guesses";
import { editQuestionHref, NotFoundCard, ProgressCard } from "./progress-card";
import { ReplayControls, type ReplayControlsProps } from "./replay-controls";
import { lookupChips } from "./sources";
import { ReconnectingState, StateCard } from "./state-cards";
import { StopButton, useStopRun } from "./stop";
import { WhichOneCard } from "./which-one";

/**
 * The working view (N03 early, N04 late, N16 end states): the page while an answer is being made, and
 * the page of a run that ended before its answer. The page head with Stop, the progress card (or the
 * end-state card in its slot), then what has arrived: draft key numbers, a draft chart and the guesses.
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
  const eyebrow = topic ? [topic.label, job ? WORKING_JOB_LABEL[job] : null].filter(Boolean).join(" · ") : "";

  const stopButton = cancellable ? <StopButton phase={stop.phase} press={stop.press} /> : null;
  const replayControls = replay ? <ReplayControls {...replay} /> : null;
  const actions = replayControls ?? stopButton;

  const progress = workingProgress(state);
  const terminal = model.terminal;
  const editHref = editQuestionHref(question);
  const hasEvidence = keyNumbers.length > 0 || chart !== null;
  const priors = model.priors.items;
  // A run that stopped will not score its guesses: the caption does not promise it.
  const guessCaption = state.ended !== null ? "Written before any data." : undefined;

  let slot: ReactNode;
  if (terminal?.kind === "needs_input") {
    slot =
      terminal.candidates.length > 0 ? (
        <WhichOneCard runId={runId} mention={terminal.mention} candidates={terminal.candidates} canPick={state.ended !== null} editHref={editHref} replay={mode === "replay"} className={END_CARD} />
      ) : (
        <NotFoundCard mention={terminal.mention} editHref={editHref} className={END_CARD} />
      );
  } else if (terminal && state.ended !== null) {
    slot = <StateCard terminal={terminal} question={question} compact={hasEvidence} className={END_CARD} />;
  } else {
    slot = (
      <ProgressCard
        title={progress.title}
        time={replay ? replayTime(replay.positionMs, replay.durationMs) : workingTime(state, elapsedMs)}
        fraction={replay ? replay.progress : (model.live?.progress.fraction ?? 0)}
        steps={progress.steps}
        readingAs={readingAs(state)}
        editHref={mode === "replay" ? null : editHref}
        noticed={noticed(state)}
        readAsLine={model.method.interpretation?.readAs?.line ?? null}
        lookups={lookupChips(state)}
        announcement={progress.announcement}
        variant={replay ? "replay" : "live"}
      />
    );
  }

  return (
    <SiteShell header="working" mobileHeader="answer" backHref={ANSWERS_HREF} sharePath={sharePath} mainClassName="flex flex-col gap-6 pt-6 pb-12 max-md:gap-4 max-md:pt-4">
      <div data-working={mode} data-run={runId} className="flex flex-col gap-5 max-md:gap-4">
        <PageHead topic={topic?.key ?? null} eyebrow={eyebrow} question={question ?? "Your question"} actions={actions} mobileActions={actions} />
        {slot}
      </div>
      {connectionLost && live ? <ReconnectingState /> : null}
      {hasEvidence ? (
        <>
          {keyNumbers.length > 0 ? (
            <div className="grid gap-6 max-md:gap-4 md:grid-cols-3" data-key-numbers="draft">
              {keyNumbers.map((k) => (
                <KeyNumber key={k.label} {...k} draft onSource={undefined} className={cx(RISE, k.className)} />
              ))}
            </div>
          ) : null}
          <div className="grid gap-6 max-md:gap-4 lg:grid-cols-12">
            {chart ? <div className={cx("min-w-0 lg:col-span-8", RISE)}>{chart}</div> : null}
            {priors.length > 0 ? (
              <GuessesCard priors={priors} variant={chart ? "side" : "full"} caption={guessCaption} className={cx(chart ? "lg:col-span-4" : "lg:col-span-12", RISE)} />
            ) : null}
          </div>
        </>
      ) : priors.length > 0 ? (
        <GuessesCard priors={priors} variant="full" caption={guessCaption} className={RISE} />
      ) : null}
    </SiteShell>
  );
}
