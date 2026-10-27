import type { RunState } from "@ct/contracts";

/**
 * The state a live page shows: the stream replays the run from its first event, so until it has caught
 * up with the server's first paint, that paint stays on screen.
 */
export function handOver(streamed: RunState, initial: RunState): RunState {
  return streamed.lastSeq > 0 && streamed.lastSeq >= initial.lastSeq ? streamed : initial;
}
