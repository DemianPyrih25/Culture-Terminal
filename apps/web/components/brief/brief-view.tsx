"use client";

import { useMemo, useState, type ReactNode } from "react";
import type { RunEvent, RunState } from "@ct/contracts";
import { buildAnswerModel } from "../../lib/answer";
import { buildBriefModel, type BriefModel } from "../../lib/brief";
import { useRunState, type UseRunStateOptions } from "../../lib/run-stream";
import { PermalinkAnswer } from "../answer/permalink-answer";
import { DraftChartCard } from "../working/draft-chart";
import { draftKeyNumber } from "../working/draft-numbers";
import { handOver } from "../working/hand-over";
import { useConnectionLost, useNow } from "../working/use-now";
import { REPLAY_SPEEDS_SHOWN, type ShownSpeed } from "../working/replay-controls";
import { WorkingView, type WorkingReplay } from "../working/working-view";
import { recordedEventSource } from "./sample-source";

/**
 * /run/[id] (design/redesign.pen N03, N04, N16; the answer N05–N12): the server renders the first paint
 * from the run's stored events; then a live run streams (with reconnects) and is rebuilt as each event
 * lands, a finished run stays as it is, and a replay plays the stored events back at 1× or 4×. While the
 * answer is being made it is the working view; once its report arrives it swaps in place to the answer.
 */

export type BriefViewMode = "live" | "replay" | "static";

export interface BriefLinks {
  /** The answer's own path, copied by Share. */
  permalink: string;
  /** The replay of a finished answer; null hides "Watch it being made". */
  replay: string | null;
  /** Where leaving the replay goes. */
  exitReplay: string;
}

export interface BriefViewProps {
  runId: string;
  /** The run as stored when the page rendered. */
  initialState: RunState;
  /** The server's clock at render: the first client render uses it too, so the markup matches. */
  serverNow: number;
  /** live: stream the run; replay: play its stored events; static: show `initialState` as it is. */
  mode: BriefViewMode;
  /** Recorded events served instead of the server's stream (the dev sample viewer). */
  events?: readonly RunEvent[] | null;
  /** The question from the run row, until run.created arrives. */
  fallbackQuestion?: string | null;
  links: BriefLinks;
  /** A reader's own question, not a curated showcase (D31): the page is unlisted (noindex). */
  unlisted?: boolean;
}

export function BriefView(props: BriefViewProps) {
  switch (props.mode) {
    case "replay":
      return <ReplayBrief {...props} />;
    case "live":
      return <LiveBrief {...props} />;
    case "static":
      return <StaticBrief {...props} />;
  }
}

function streamOptions(events: readonly RunEvent[] | null | undefined): UseRunStateOptions["client"] {
  return events ? { createEventSource: recordedEventSource(events) } : undefined;
}

export { handOver };

interface PageProps {
  runId: string;
  model: BriefModel;
  state: RunState;
  mode: BriefViewMode;
  links: BriefLinks;
  fallbackQuestion: string | null;
  elapsedMs: number;
  connectionLost?: boolean;
  replay?: WorkingReplay | null;
}

/** The working view until the report arrives; then the answer, with its How we know drawer. */
function RunPage({ runId, model, state, mode, links, fallbackQuestion, elapsedMs, connectionLost, replay }: PageProps) {
  // While the answer is made: its key numbers and main chart so far, worded as the answer will word them.
  const answer = useMemo(
    () => (state.report === null ? buildAnswerModel(model, { resolves: state.resolves, ghost: state.ghost, report: null, metrics: state.metrics }, { fallbackQuestion }) : null),
    [model, state, fallbackQuestion],
  );

  // The report is in: the answer, with its How we know drawer.
  if (state.report !== null || answer === null) {
    return <PermalinkAnswer model={model} state={state} runId={runId} mode={mode} links={links} fallbackQuestion={fallbackQuestion} />;
  }

  const chart: ReactNode = answer.charts.main ? <DraftChartCard chart={answer.charts.main} draft={state.draft} /> : null;
  return (
    <WorkingView
      runId={runId}
      model={model}
      state={state}
      mode={mode}
      fallbackQuestion={fallbackQuestion}
      elapsedMs={elapsedMs}
      replay={replay}
      connectionLost={connectionLost}
      keyNumbers={answer.keyNumbers.map(draftKeyNumber)}
      chart={chart}
      sharePath={links.permalink}
    />
  );
}

function StaticBrief({ runId, initialState, serverNow, links, fallbackQuestion = null }: BriefViewProps) {
  const model = useMemo(() => buildBriefModel(initialState, serverNow), [initialState, serverNow]);
  return (
    <RunPage
      runId={runId}
      model={model}
      state={initialState}
      mode="static"
      links={links}
      fallbackQuestion={fallbackQuestion}
      elapsedMs={initialState.ended?.elapsedMs ?? 0}
    />
  );
}

function LiveBrief({ runId, initialState, serverNow, events, links, fallbackQuestion = null }: BriefViewProps) {
  const client = useMemo(() => streamOptions(events), [events]);
  const handle = useRunState(runId, { client });
  const state = handOver(handle.state, initialState);
  const now = useNow(serverNow, state.ended === null);
  const model = useMemo(() => buildBriefModel(state, now), [state, now]);
  const lost = useConnectionLost(handle.connection);
  return (
    <RunPage
      runId={runId}
      model={model}
      state={state}
      mode="live"
      links={links}
      fallbackQuestion={fallbackQuestion}
      elapsedMs={model.live?.progress.elapsedMs ?? state.ended?.elapsedMs ?? 0}
      connectionLost={lost}
    />
  );
}

function ReplayBrief({ runId, initialState, serverNow, events, links, fallbackQuestion = null }: BriefViewProps) {
  const [speed, setSpeed] = useState<ShownSpeed>(REPLAY_SPEEDS_SHOWN[1]);
  const client = useMemo(() => streamOptions(events), [events]);
  const handle = useRunState(runId, { replay: { speed }, client });
  const controls = handle.replay;
  const state = handle.state;
  const now = state.createdAt ? Date.parse(state.createdAt) + (controls?.positionMs ?? 0) : serverNow;
  const model = useMemo(() => buildBriefModel(state, now), [state, now]);
  const replay: WorkingReplay | null = controls
    ? {
        playing: controls.playing,
        done: controls.done,
        speed,
        onPlay: controls.play,
        onPause: controls.pause,
        onSpeed: setSpeed,
        positionMs: controls.positionMs,
        durationMs: controls.durationMs,
        progress: controls.progress,
      }
    : null;
  return (
    <RunPage
      runId={runId}
      model={model}
      state={state}
      mode="replay"
      links={links}
      fallbackQuestion={initialState.question ?? fallbackQuestion}
      elapsedMs={controls?.positionMs ?? 0}
      replay={replay}
    />
  );
}
