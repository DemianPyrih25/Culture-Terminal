"use client";

import type { ReplaySpeed } from "../../lib/run-stream";
import { Button, Segmented, Tag } from "../ui";

/**
 * The replay's controls in the page head (N03 replay): the Recording tag, play or pause, and the speed
 * switch, 1× or 4×. A replay makes no Qloo or model call.
 */

/** The speeds a reader can pick. */
export const REPLAY_SPEEDS_SHOWN = [1, 4] as const satisfies readonly ReplaySpeed[];

export type ShownSpeed = (typeof REPLAY_SPEEDS_SHOWN)[number];

const SPEED_OPTIONS = REPLAY_SPEEDS_SHOWN.map((s) => ({ value: String(s) as `${ShownSpeed}`, label: `${s}×` }));

export interface ReplayControlsProps {
  playing: boolean;
  done: boolean;
  speed: ShownSpeed;
  onPlay: () => void;
  onPause: () => void;
  onSpeed: (speed: ShownSpeed) => void;
}

export function ReplayControls({ playing, done, speed, onPlay, onPause, onSpeed }: ReplayControlsProps) {
  const action = playing ? "Pause" : done ? "Play again" : "Play";
  return (
    <div className="flex items-center gap-3" data-replay={playing ? "playing" : done ? "done" : "paused"}>
      <Tag preset="recording" className="max-sm:hidden" />
      <Button variant="quiet" icon={playing ? "pause" : "play"} onClick={playing ? onPause : onPlay} aria-label={`${action} the recording`}>
        <span className="max-sm:sr-only">{action}</span>
      </Button>
      <Segmented label="Speed" options={SPEED_OPTIONS} value={String(speed) as `${ShownSpeed}`} onChange={(v) => onSpeed(Number(v) as ShownSpeed)} />
    </div>
  );
}
