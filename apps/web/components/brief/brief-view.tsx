"use client";

import { useMemo, useState } from "react";
import type { RunEvent, RunState } from "@ct/contracts";
import { buildBriefModel } from "../../lib/brief";
import { useRunState, type ReplaySpeed, type UseRunStateOptions } from "../../lib/run-stream";
import { BriefDocument } from "./brief-document";
import { useFreshCalls, useNow } from "./hooks";
import type { ReplayBarProps } from "./replay-bar";
import { recordedEventSource } from "./sample-source";

/**
 * The brief page's state (Concept A, D36). The server renders the first paint from the run's stored
 * events; then a live run keeps streaming (with reconnects) and is rebuilt into the brief as each event
 * lands, a finished run stays as it is, and a replay plays the stored events back at 1×, 4× or 16×.
 */

export type BriefViewMode = "live" | "replay" | "static";

export interface BriefLinks {
  /** The brief's own path, copied by Share. */
  permalink: string;
  /** The replay of a finished brief; null hides "Replay". */
  replay: string | null;
  /** Where "Exit replay" goes. */
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
  /** A reader's own question, not a curated showcase: marked "Unlisted · user question" (D31). */
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

/**
 * The state a live brief shows: the stream replays the run from its first event, so until it has caught
 * up with the server's first paint, that paint stays on screen.
 */
export function handOver(streamed: RunState, initial: RunState): RunState {
  return streamed.lastSeq > 0 && streamed.lastSeq >= initial.lastSeq ? streamed : initial;
}

const callIds = (state: RunState) => state.qloo.chips.map((c) => c.qlooCallId);

function StaticBrief({ initialState, serverNow, links, fallbackQuestion, unlisted }: BriefViewProps) {
  const model = useMemo(() => buildBriefModel(initialState, serverNow), [initialState, serverNow]);
  return (
    <BriefDocument
      model={model}
      state={initialState}
      view={model.live ? "live" : "final"}
      links={{ permalink: links.permalink, replay: model.live ? null : links.replay }}
      fallbackQuestion={fallbackQuestion}
      unlisted={unlisted}
    />
  );
}

function LiveBrief({ runId, initialState, serverNow, events, links, fallbackQuestion, unlisted }: BriefViewProps) {
  const client = useMemo(() => streamOptions(events), [events]);
  const handle = useRunState(runId, { client });
  const state = handOver(handle.state, initialState);
  // A call the first paint showed never flashes; one that lands while the reader watches flashes once.
  const [known] = useState(() => callIds(initialState));
  const isFresh = useFreshCalls(callIds(state), known);
  const now = useNow(serverNow, state.ended === null);
  const model = useMemo(() => buildBriefModel(state, now), [state, now]);
  return (
    <BriefDocument
      model={model}
      state={state}
      view={model.live ? "live" : "final"}
      connection={handle.connection}
      links={{ permalink: links.permalink, replay: model.live ? null : links.replay }}
      fallbackQuestion={fallbackQuestion}
      isFresh={isFresh}
      unlisted={unlisted}
    />
  );
}

function ReplayBrief({ runId, initialState, serverNow, events, links, fallbackQuestion, unlisted }: BriefViewProps) {
  const [speed, setSpeed] = useState<ReplaySpeed>(4);
  const client = useMemo(() => streamOptions(events), [events]);
  const handle = useRunState(runId, { replay: { speed }, client });
  const controls = handle.replay;
  const state = handle.state;
  // Everything in a replay lands while the reader watches, and flashes once as it does.
  const isFresh = useFreshCalls(callIds(state));
  const now = state.createdAt ? Date.parse(state.createdAt) + (controls?.positionMs ?? 0) : serverNow;
  const model = useMemo(() => buildBriefModel(state, now), [state, now]);
  const replay: ReplayBarProps | null = controls
    ? {
        playing: controls.playing,
        done: controls.done,
        speed,
        progress: controls.progress,
        positionMs: controls.positionMs,
        durationMs: controls.durationMs,
        onPlay: controls.play,
        onPause: controls.pause,
        onSpeed: setSpeed,
        onRestart: controls.restart,
        exitHref: links.exitReplay,
      }
    : null;
  return (
    <BriefDocument
      model={model}
      state={state}
      view="replay"
      replay={replay}
      links={{ permalink: links.permalink, replay: null }}
      fallbackQuestion={initialState.question ?? fallbackQuestion}
      isFresh={isFresh}
      unlisted={unlisted}
    />
  );
}
