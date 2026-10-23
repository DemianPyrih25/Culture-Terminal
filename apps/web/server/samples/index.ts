import "server-only";
import { reduceRunEvents, RunEvent, type RunState } from "@ct/contracts";
import brandHealthIncomplete from "./brand-health-incomplete.events.json";
import brandHealth from "./brand-health.events.json";
import needsInput from "./needs-input.events.json";

/**
 * Synthetic sample runs for local demos, UI tests and the replay player. tools/dev/sample-run.ts
 * writes them from the real runAgent with a scripted model and the mock Qloo transport, on a fixed
 * clock with invented entities (D29); regenerate them with `pnpm exec tsx tools/dev/sample-run.ts`
 * and never edit the JSON by hand. Each file is one run's stamped events, run.created to run.end.
 *
 * - brand-health: the finished brief for "Is the Juniper Cola audience a moat or a niche?": CLERK,
 *   the gate, the opening scan alongside wave 1, an ANALYST PIVOT on the outside-category
 *   neighbour, and a report the CHECKER passed with every number traced. Its Qloo calls take every
 *   cache status (miss, hit, reused, stale, coalesced). About 46 s.
 * - brand-health-incomplete: the same question stopped at the 180 s hard wall clock while the
 *   report was being written; code published the INCOMPLETE evidence digest.
 * - needs-input: a brand name with two exact matches; the resolution gate ends the run with a picker.
 */

export const SAMPLE_NAMES = ["brand-health", "brand-health-incomplete", "needs-input"] as const;
export type SampleName = (typeof SAMPLE_NAMES)[number];

const RAW: Readonly<Record<SampleName, unknown>> = {
  "brand-health": brandHealth,
  "brand-health-incomplete": brandHealthIncomplete,
  "needs-input": needsInput,
};

const parsed = new Map<SampleName, readonly RunEvent[]>();

/** A sample's events, run.created to run.end, checked against the RunEvent schema. Shared: never mutate them. */
export function sampleEvents(name: SampleName): readonly RunEvent[] {
  let events = parsed.get(name);
  if (events === undefined) {
    events = Object.freeze(RunEvent.array().parse(RAW[name]));
    parsed.set(name, events);
  }
  return events;
}

/** The run id every event of a sample carries. */
export function sampleRunId(name: SampleName): string {
  const first = sampleEvents(name)[0];
  if (first === undefined) throw new Error(`sample ${name} has no events`);
  return first.runId;
}

/** The run state after the whole sample, as the browser's reducer builds it from the stream. */
export function sampleState(name: SampleName): RunState {
  return reduceRunEvents(sampleRunId(name), sampleEvents(name));
}
