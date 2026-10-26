"use client";

import Link from "next/link";
import { formatClock } from "../../lib/brief";
import type { ReplaySpeed } from "../../lib/run-stream";
import { cx, SortToggle } from "../ui";

/**
 * The replay controls (D26: a replay makes 0 Qloo calls and costs $0): a REPLAY marker so a replay is
 * never taken for a live run, play and pause, 1× 4× 8× 16× (PLAN Part 6: 8× replay), restart, the
 * progress bar and the clock.
 */

export const REPLAY_BAR_SPEEDS = [1, 4, 8, 16] as const satisfies readonly ReplaySpeed[];

const SPEED_OPTIONS = REPLAY_BAR_SPEEDS.map((s) => ({ value: String(s), label: `${s}×` }));

export interface ReplayBarProps {
  playing: boolean;
  done: boolean;
  speed: ReplaySpeed;
  /** 0–1. */
  progress: number;
  positionMs: number;
  durationMs: number | null;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (speed: ReplaySpeed) => void;
  onRestart: () => void;
  /** Back to the finished brief. */
  exitHref: string;
}

/** The REPLAY marker: accent on accent-soft, mono. */
export function ReplayMarker({ className }: { className?: string }) {
  return (
    <span
      data-marker="REPLAY"
      className={cx("inline-flex h-[18px] items-center rounded-brief bg-accent-soft px-1.5 font-mono text-[10px] leading-none font-medium tracking-[1px] text-accent", className)}
    >
      REPLAY
    </span>
  );
}

/**
 * The replay controls the running head carries once the bar has scrolled away: play or pause, the speed,
 * and the progress, so a reader can steer the replay while reading further down.
 */
export function ReplayMini(props: ReplayBarProps) {
  const { playing, done, speed, progress } = props;
  const action = playing ? "Pause" : done ? "Play again" : "Play";
  return (
    <span className="inline-flex items-center gap-2" data-replay-mini={playing ? "playing" : done ? "done" : "paused"}>
      <ReplayMarker />
      <button
        type="button"
        onClick={playing ? props.onPause : props.onPlay}
        aria-label={`${action} the replay`}
        title={`${action} the replay`}
        className="inline-flex size-7 shrink-0 items-center justify-center rounded-brief bg-ink font-mono text-[10px] text-on-ink hover:bg-text-2"
      >
        <span aria-hidden="true">{playing ? "❚❚" : "▶"}</span>
      </button>
      <span role="group" aria-label="Replay speed" className="inline-flex overflow-hidden rounded-brief border border-line-strong">
        {REPLAY_BAR_SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={s === speed}
            aria-label={`${s}× speed`}
            onClick={() => props.onSpeed(s)}
            className={cx("h-6 px-1.5 font-mono text-[10px] tabular-nums", s === speed ? "bg-accent-soft text-accent" : "text-dim hover:text-ink")}
          >
            {s}×
          </button>
        ))}
      </span>
      <span
        role="progressbar"
        aria-label="Replay progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(progress * 100)}
        className="h-0.5 w-10 bg-line max-md:hidden"
      >
        <span className="block h-0.5 bg-accent" style={{ width: `${Math.min(1, Math.max(0, progress)) * 100}%` }} />
      </span>
    </span>
  );
}

export function ReplayBar(props: ReplayBarProps) {
  const { playing, done, speed, progress, positionMs, durationMs } = props;
  const action = playing ? "Pause" : done ? "Play again" : "Play";
  return (
    <section aria-label="Replay" className="flex w-full flex-col gap-2.5 border-y border-line py-3 print:hidden" data-replay={playing ? "playing" : done ? "done" : "paused"}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <ReplayMarker />
        <p className="m-0 min-w-0 flex-1 text-[12px] leading-4 text-dim">Replaying a finished run from its record · 0 Qloo calls · $0</p>
        <Link href={props.exitHref} className="text-[12px] font-medium text-accent hover:underline hover:underline-offset-4">
          Exit replay
        </Link>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button
          type="button"
          onClick={playing ? props.onPause : props.onPlay}
          className="inline-flex h-8 min-w-[92px] items-center justify-center gap-2 rounded-brief bg-ink px-3 text-[13px] font-medium text-on-ink hover:bg-text-2"
        >
          <span aria-hidden="true" className="font-mono text-[11px]">
            {playing ? "❚❚" : "▶"}
          </span>
          {action}
        </button>
        <SortToggle
          label="Speed"
          options={SPEED_OPTIONS}
          value={String(speed)}
          onChange={(v) => props.onSpeed(Number(v) as ReplaySpeed)}
        />
        <button type="button" onClick={props.onRestart} className="text-[13px] font-medium text-accent hover:underline hover:underline-offset-4">
          Restart
        </button>
        <div className="flex min-w-[160px] flex-1 items-center gap-3">
          <div
            role="progressbar"
            aria-label="Replay progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(progress * 100)}
            className="h-0.5 flex-1 bg-line"
          >
            <div className="h-0.5 bg-accent" style={{ width: `${Math.min(1, Math.max(0, progress)) * 100}%` }} />
          </div>
          <span className="font-mono text-[11px] text-dim tabular-nums">
            {formatClock(positionMs)}
            {durationMs !== null ? ` / ${formatClock(durationMs)}` : ""}
          </span>
        </div>
      </div>
    </section>
  );
}
