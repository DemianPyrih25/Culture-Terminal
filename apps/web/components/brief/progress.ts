/**
 * The progress headline of a brief being written (A03) only moves forward. The run's own stage can step
 * back (the opening scan ends while the ANALYST is still writing priors, a follow-up call runs after the
 * draft is under way), and a headline and polite announcement that flip back and forth tell the reader
 * nothing. Who is working right now stays in the stage strip. Pure.
 */

/** The headlines lib/brief writes, in the order a run moves through them; a re-check ranks with the repair. */
const RANK: Readonly<Record<string, number>> = {
  "Reading the question": 0,
  "Matching names": 1,
  "Writing priors": 2,
  "Gathering evidence": 3,
  "Writing the answer": 4,
  "Checking every number": 5,
  "Repairing the draft": 5,
  "Assembling the brief": 6,
  "Brief ready": 7,
};

export interface SteadyProgress {
  /** The headline to show. */
  label: string;
  /** The furthest headline reached in the known order. */
  furthest: { label: string; rank: number } | null;
  /** The run's last event when it was worked out: a replay that restarts starts over. */
  seq: number;
}

/** The headline once `label` arrives at event `seq`: never one the run has already moved past. */
export function steadyProgress(previous: SteadyProgress | null, label: string, seq: number): SteadyProgress {
  const top = previous !== null && seq >= previous.seq ? previous.furthest : null;
  const rank = RANK[label];
  // A headline outside the known order (a stop, a pick) shows as it is.
  if (rank === undefined) return { label, furthest: top, seq };
  if (top !== null && rank < top.rank) return { label: top.label, furthest: top, seq };
  return { label, furthest: { label, rank }, seq };
}

export const sameProgress = (a: SteadyProgress | null, b: SteadyProgress | null): boolean =>
  a === b ||
  (a !== null && b !== null && a.label === b.label && a.seq === b.seq && a.furthest?.label === b.furthest?.label && a.furthest?.rank === b.furthest?.rank);
