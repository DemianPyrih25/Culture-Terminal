import { useEffect, useState, useSyncExternalStore } from "react";
import type { RunEvent, RunState } from "@ct/contracts";
import { applyEvent, initialRunState } from "@ct/contracts/values";
import { RunStreamClient, type ConnectionStatus, type RunStreamClientOptions, type RunStreamSnapshot } from "./sse-client";

/**
 * The run as React state: `useRunState` streams a run live, or replays a finished run's stored
 * events paced by their timestamps (D26: replays cost 0 Qloo calls and $0). Both feed the contracts
 * reducer, so a replay ends in exactly the state the live run ended in.
 */

export const REPLAY_SPEEDS = [1, 4, 8, 16, "instant"] as const;
export type ReplaySpeed = (typeof REPLAY_SPEEDS)[number];

/** Accelerated replays cap each pause at this much wall time, so a long model turn does not stall the show (SPEC §4.7). 1× stays true to time. */
export const REPLAY_MAX_DELAY_MS = 600;

export interface ReplayStatus {
  playing: boolean;
  speed: ReplaySpeed;
  /** Events applied so far. */
  applied: number;
  /** Events recorded so far; a run still streaming keeps adding to it. */
  loaded: number;
  /** The recording is whole: its run.end has arrived. */
  complete: boolean;
  /** Every recorded event is applied and the recording is whole. */
  done: boolean;
  /** Run time at the playhead, from the first event. */
  positionMs: number;
  /** The recording's length once complete. */
  durationMs: number | null;
  /** 0–1: run time once the length is known, else events applied. */
  progress: number;
}

export interface ReplaySnapshot extends ReplayStatus {
  state: RunState;
}

export interface ReplayPlayerOptions {
  speed?: ReplaySpeed;
  /** Start as soon as events arrive (default true). */
  autoplay?: boolean;
  maxDelayMs?: number;
}

const tsOf = (event: RunEvent | undefined) => (event ? Date.parse(event.ts) : Number.NaN);

// The run queue (D24) -----------------------------------------------------------------------------------

type QueuePlace = NonNullable<RunState["queue"]>;

/**
 * Where a queued run's work starts in its timeline: the first event after its first run.queued that is
 * not another run.queued (the agent's own run.created, or the end of a run that never started). -1 for
 * a run that never queued, null for one still waiting.
 */
function workStartIn(types: readonly RunEvent["type"][]): number | null {
  const queued = types.indexOf("run.queued");
  if (queued === -1) return -1;
  for (let i = queued + 1; i < types.length; i++) if (types[i] !== "run.queued") return i;
  return null;
}

/**
 * A run waiting for a slot: its place from the latest run.queued, or null once its work starts (the
 * agent's run.created follows the queue events) or it ends. Only a live run waits.
 */
export function queuedPlace(state: RunState): QueuePlace | null {
  if (state.ended !== null || state.status !== "queued" || state.queue === null) return null;
  return state.timeline.at(-1)?.type === "run.queued" ? state.queue : null;
}

/** Whole seconds a queued run may still wait at `now`: its last waitSMax, less the time since it was told. */
export function queueWaitLeftS(place: QueuePlace, now: number): number {
  const since = now - Date.parse(place.at);
  return Math.max(0, place.waitSMax - (Number.isFinite(since) ? Math.max(0, Math.floor(since / 1000)) : 0));
}

/** The run waited in the queue and ended there, before any work: a timeout, a cancel or a restart. */
export function endedInQueue(state: RunState): boolean {
  if (state.ended === null) return false;
  const types = state.timeline.map((t) => t.type);
  const start = workStartIn(types);
  return start !== -1 && (start === null || types[start] !== "run.created");
}

/**
 * Plays recorded events into a RunState at 1×, 4×, 8×, 16× or instantly: each event waits for the gap
 * since the one before it divided by the speed. Events that share a moment apply together, with one
 * notification. Pausing keeps what is left of the current wait; changing speed rescales it.
 */
export class ReplayPlayer {
  private events: RunEvent[] = [];
  private index = 0;
  private runState: RunState;
  private playing: boolean;
  private speed: ReplaySpeed;
  private readonly maxDelayMs: number;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** The wait in progress: when it started and how long it is. */
  private wait: { startedAt: number; delay: number } | null = null;
  /** What was left of a wait when playback paused. */
  private remaining: number | null = null;
  /**
   * The queue's part of the recording (D24): events up to this index play with no wait, and run time
   * counts from it, since waiting for a slot is not the run's work. -1 when the run never queued; null
   * while the recording is still in the queue.
   */
  private workStart: number | null = -1;
  /** Wall time the latest event applied. */
  private appliedAt = 0;
  private snapshot: ReplaySnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(
    readonly runId: string,
    options: ReplayPlayerOptions = {},
  ) {
    this.runState = initialRunState(runId);
    this.speed = options.speed ?? 4;
    this.playing = options.autoplay ?? true;
    this.maxDelayMs = options.maxDelayMs ?? REPLAY_MAX_DELAY_MS;
    this.snapshot = this.build();
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ReplaySnapshot => this.snapshot;

  /** Records an event; events for another run or at or below the last recorded seq are ignored. */
  push = (event: RunEvent): void => {
    const last = this.events.at(-1);
    if (event.runId !== this.runId || (last && event.seq <= last.seq)) return;
    this.events.push(event);
    if (this.workStart === null || (this.workStart === -1 && event.type === "run.queued")) {
      this.workStart = workStartIn(this.events.map((e) => e.type));
    }
    if (this.playing && this.timer === null && this.index === this.events.length - 1) this.schedule();
    else this.emit();
  };

  play = (): void => {
    if (this.playing && this.timer !== null) return;
    if (this.isDone()) this.reset();
    this.playing = true;
    this.schedule();
    this.emit();
  };

  pause = (): void => {
    if (!this.playing) return;
    this.playing = false;
    if (this.timer !== null && this.wait) this.remaining = Math.max(0, this.wait.delay - (Date.now() - this.wait.startedAt));
    this.clearTimer();
    this.emit();
  };

  setSpeed = (speed: ReplaySpeed): void => {
    if (speed === this.speed) return;
    const before = this.speed;
    this.speed = speed;
    if (this.timer !== null && this.wait) {
      // Rescale what is left of the current wait to the new speed.
      const left = Math.max(0, this.wait.delay - (Date.now() - this.wait.startedAt));
      this.clearTimer();
      this.remaining = speed === "instant" ? 0 : before === "instant" ? null : (left * before) / speed;
      this.schedule();
    } else if (this.remaining !== null) {
      this.remaining = speed === "instant" || before === "instant" ? 0 : (this.remaining * before) / speed;
    }
    this.emit();
  };

  /** Back to the empty state; keeps playing if it was. */
  restart = (): void => {
    this.reset();
    if (this.playing) this.schedule();
    this.emit();
  };

  /** Applies every recorded event now ("Skip to note"). */
  skipToEnd = (): void => {
    this.clearTimer();
    this.remaining = null;
    while (this.index < this.events.length) this.applyNext();
    this.appliedAt = Date.now();
    this.emit();
  };

  dispose = (): void => {
    this.playing = false;
    this.clearTimer();
  };

  private reset(): void {
    this.clearTimer();
    this.remaining = null;
    this.index = 0;
    this.runState = initialRunState(this.runId);
  }

  private isDone(): boolean {
    return this.index >= this.events.length && this.events.at(-1)?.type === "run.end";
  }

  /** The wall-time wait before event `i`: its gap from the previous event at the current speed. */
  private delayBefore(i: number): number {
    if (i === 0 || this.speed === "instant" || this.inQueue(i)) return 0;
    const gap = tsOf(this.events[i]) - tsOf(this.events[i - 1]);
    if (!Number.isFinite(gap) || gap <= 0) return 0;
    const scaled = Math.round(gap / this.speed);
    return this.speed === 1 ? scaled : Math.min(scaled, this.maxDelayMs);
  }

  /** Event `i` belongs to the queue's part of the recording. */
  private inQueue(i: number): boolean {
    return this.workStart === null || i <= this.workStart;
  }

  private schedule(): void {
    if (!this.playing || this.timer !== null || this.index >= this.events.length) return;
    // Counted from when the previous event applied, so an event that arrives late (a run still
    // streaming) waits only for what is left of its gap.
    const delay = this.remaining ?? Math.max(0, this.delayBefore(this.index) - (Date.now() - this.appliedAt));
    this.remaining = null;
    if (delay <= 0) {
      this.step();
      return;
    }
    this.wait = { startedAt: Date.now(), delay };
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wait = null;
      this.step();
    }, delay);
  }

  /** Applies the due event and every following one with no gap, notifies once, then waits for the next. */
  private step(): void {
    this.applyNext();
    while (this.index < this.events.length && this.delayBefore(this.index) <= 0) this.applyNext();
    this.appliedAt = Date.now();
    this.emit();
    this.schedule();
  }

  private applyNext(): void {
    const event = this.events[this.index];
    if (!event) return;
    this.runState = applyEvent(this.runState, event);
    this.index += 1;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.wait = null;
  }

  private build(): ReplaySnapshot {
    const loaded = this.events.length;
    const complete = this.events.at(-1)?.type === "run.end";
    // Run time starts with the work: a queued run's wait is left out of its length and its playhead.
    const start = tsOf(this.workStart === null ? this.events.at(-1) : this.events[Math.max(0, this.workStart)]);
    const durationMs = complete && loaded > 0 ? Math.max(0, tsOf(this.events.at(-1)) - start) : null;
    const positionMs = this.index > 0 && !this.inQueue(this.index - 1) ? Math.max(0, tsOf(this.events[this.index - 1]) - start) : 0;
    const done = complete && this.index >= loaded;
    const progress = done
      ? 1
      : durationMs !== null && durationMs > 0
        ? Math.min(1, positionMs / durationMs)
        : loaded > 0
          ? this.index / loaded
          : 0;
    return {
      state: this.runState,
      playing: this.playing && !done,
      speed: this.speed,
      applied: this.index,
      loaded,
      complete,
      done,
      positionMs: Number.isFinite(positionMs) ? positionMs : 0,
      durationMs: durationMs !== null && Number.isFinite(durationMs) ? durationMs : null,
      progress,
    };
  }

  private emit(): void {
    this.snapshot = this.build();
    for (const listener of this.listeners) listener();
  }
}

// React -------------------------------------------------------------------------------------------------

export interface ReplayControls extends ReplayStatus {
  play: () => void;
  pause: () => void;
  setSpeed: (speed: ReplaySpeed) => void;
  restart: () => void;
  skipToEnd: () => void;
}

export interface UseRunStateOptions {
  /** Replay the run's stored events instead of showing them as they stream. */
  replay?: { speed: ReplaySpeed; autoplay?: boolean };
  /** Passed to the stream client (tests inject a fake EventSource). */
  client?: Omit<RunStreamClientOptions, "onEvent">;
}

export interface RunStateHandle {
  state: RunState;
  connection: ConnectionStatus;
  /** The stream itself: reconnects, gaps and duplicates (the event log stays off here). */
  stream: RunStreamSnapshot;
  /** Replay controls, or null for a live view. */
  replay: ReplayControls | null;
}

/**
 * One run's stream and, for a replay, the player it feeds: what `useRunState` holds between renders.
 * The hook's effects only call `attach`, `detach` and `setSpeed`, so the session is tested without a DOM.
 */
export class RunSession {
  readonly client: RunStreamClient;
  readonly player: ReplayPlayer | null;

  constructor(
    readonly runId: string,
    readonly replay: boolean,
    options: UseRunStateOptions = {},
  ) {
    this.player = replay
      ? new ReplayPlayer(runId, { speed: options.replay?.speed, autoplay: options.replay?.autoplay })
      : null;
    const player = this.player;
    this.client = new RunStreamClient(runId, { ...options.client, onEvent: player ? player.push : undefined });
  }

  /** This session serves the run and mode asked for; otherwise the hook starts a new one. */
  serves(runId: string, replay: boolean): boolean {
    return this.runId === runId && this.replay === replay;
  }

  /** Opens the stream (resuming after a detach) and, for a replay with autoplay, starts playing. Returns `detach`. */
  attach(autoplay: boolean): () => void {
    this.client.start();
    if (this.player && autoplay) this.player.play();
    return () => this.detach();
  }

  /** Closes the stream and pauses the replay; a later attach picks up where they stopped. */
  detach(): void {
    this.client.stop();
    this.player?.pause();
  }

  /** Follows the speed the page asks for; a live session has nothing to pace. */
  setSpeed(speed: ReplaySpeed | undefined): void {
    if (this.player && speed !== undefined) this.player.setSpeed(speed);
  }
}

/** The session for these arguments: `current` while it still serves them, else a new one. */
export function sessionFor(current: RunSession | null, runId: string, options: UseRunStateOptions = {}): RunSession {
  const replay = options.replay !== undefined;
  return current?.serves(runId, replay) ? current : new RunSession(runId, replay, options);
}

const IDLE_PLAYER_SNAPSHOT = (runId: string): ReplaySnapshot => new ReplayPlayer(runId, { autoplay: false }).getSnapshot();
const noSubscribe = () => () => undefined;

/**
 * Streams a run into React state. With `replay`, the stored events are recorded as they stream (a
 * finished run sends all of them at once) and played back at the chosen speed with play, pause,
 * speed, restart and skip-to-end controls. For client components only.
 */
export function useRunState(runId: string, options: UseRunStateOptions = {}): RunStateHandle {
  const [session, setSession] = useState(() => sessionFor(null, runId, options));
  const next = sessionFor(session, runId, options);
  if (next !== session) setSession(next);

  const { client, player } = session;
  const autoplay = options.replay?.autoplay ?? true;
  useEffect(() => session.attach(autoplay), [session, autoplay]);

  const speed = options.replay?.speed;
  useEffect(() => session.setSpeed(speed), [session, speed]);

  const stream = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const [idle] = useState(() => IDLE_PLAYER_SNAPSHOT(runId));
  const played = useSyncExternalStore(
    player ? player.subscribe : noSubscribe,
    player ? player.getSnapshot : () => idle,
    player ? player.getSnapshot : () => idle,
  );

  const controls: ReplayControls | null = player
    ? {
        playing: played.playing,
        speed: played.speed,
        applied: played.applied,
        loaded: played.loaded,
        complete: played.complete,
        done: played.done,
        positionMs: played.positionMs,
        durationMs: played.durationMs,
        progress: played.progress,
        play: player.play,
        pause: player.pause,
        setSpeed: player.setSpeed,
        restart: player.restart,
        skipToEnd: player.skipToEnd,
      }
    : null;

  return { state: player ? played.state : stream.state, connection: stream.connection, stream, replay: controls };
}
