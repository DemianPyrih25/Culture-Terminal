"use client";

import type { ReplaySpeed } from "../../lib/run-stream";
import { Button, ButtonLink, Segmented } from "../ui";

/**
 * The replay's controls in the page head (N03 replay): play or pause, the speed switch (1× or 4×) and
 * Exit replay when the page knows where the answer lives. The "Recording" tag sits in the replay bar
 * under the head. A replay makes no Qloo or model call.
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
  /** Where leaving the replay goes (the run's own page); null or absent hides Exit replay. */
  exitHref?: string | null;
}

export function ReplayControls({ playing, done, speed, onPlay, onPause, onSpeed, exitHref = null }: ReplayControlsProps) {
  const action = playing ? "Pause" : done ? "Play again" : "Play";
  return (
    <div className="flex items-center gap-2" data-replay={playing ? "playing" : done ? "done" : "paused"}>
      <Button variant="secondary" size="sm" icon={playing ? "pause" : "play"} onClick={playing ? onPause : onPlay} aria-label={`${action} the recording`}>
        <span className="max-sm:sr-only">{action}</span>
      </Button>
      <Segmented label="Speed" options={SPEED_OPTIONS} value={String(speed) as `${ShownSpeed}`} onChange={(v) => onSpeed(Number(v) as ShownSpeed)} />
      {exitHref ? (
        <ButtonLink href={exitHref} variant="quiet" size="sm" icon="x" trailing={null} data-exit-replay>
          <span className="max-sm:sr-only">Exit replay</span>
        </ButtonLink>
      ) : null}
    </div>
  );
}
