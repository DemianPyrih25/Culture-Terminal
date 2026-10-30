/**
 * Zod-free event helpers (PLAN §4.7); ../events.ts holds the event schemas. Typed structurally on the
 * envelope so this file stays zod-free; ../events.ts re-exports them typed on RunEvent.
 */

interface Envelope {
  seq: number;
  ts: string;
  runId: string;
}

/** Adds the envelope to an event input. */
export function stampEvent<I extends object>(input: I, envelope: Envelope): I & Envelope {
  return { ...input, ...envelope };
}

/** Splits an event into its envelope and input, e.g. to store `type` and the payload in run_events. */
export function unstampEvent<E extends Envelope>(event: E): { envelope: Envelope; input: Omit<E, keyof Envelope> } {
  const { seq, ts, runId, ...input } = event;
  return { envelope: { seq, ts, runId }, input };
}

/**
 * One SSE frame. There is deliberately no `event:` line: named events never reach
 * EventSource.onmessage, so clients read `type` from the JSON instead.
 */
export function encodeSseEvent(event: { seq: number }): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
}
