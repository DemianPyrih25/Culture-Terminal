import "server-only";
import { RunEvent, unstampEvent } from "@ct/contracts";
import { appendEvents, lastSeq, listEvents, type Queryable, type RunEventRow } from "@ct/db";

/**
 * run_events keeps the envelope in columns (seq, ts) and the rest of the event in `payload`, so a
 * stored row and a live event rebuild to the same RunEvent.
 */
export function toEventRow(event: RunEvent): { seq: number; type: string; payload: unknown; ts: Date } {
  const { envelope, input } = unstampEvent(event);
  const { type, ...payload } = input;
  return { seq: envelope.seq, type, payload, ts: new Date(envelope.ts) };
}

export function fromEventRow(row: RunEventRow): RunEvent {
  const payload = typeof row.payload === "object" && row.payload !== null ? row.payload : {};
  return RunEvent.parse({ ...payload, type: row.type, seq: row.seq, ts: row.ts.toISOString(), runId: row.runId });
}

/** Stores one event. False when that seq already exists (a retried write, or another writer won it). */
export async function appendRunEvent(db: Queryable, event: RunEvent): Promise<boolean> {
  return (await appendEvents(db, event.runId, [toEventRow(event)])) === 1;
}

export const EVENT_PAGE = 500;

export async function readEventsAfter(
  db: Queryable,
  runId: string,
  afterSeq: number,
  limit: number = EVENT_PAGE,
): Promise<RunEvent[]> {
  const rows = await listEvents(db, runId, afterSeq, limit);
  return rows.map(fromEventRow);
}

export async function readAllEvents(db: Queryable, runId: string): Promise<RunEvent[]> {
  const all: RunEvent[] = [];
  for (;;) {
    const page = await readEventsAfter(db, runId, all.at(-1)?.seq ?? 0);
    all.push(...page);
    if (page.length < EVENT_PAGE) return all;
  }
}

/** The stored event at exactly this seq, or null. */
export async function readEventAt(db: Queryable, runId: string, seq: number): Promise<RunEvent | null> {
  const [row] = await listEvents(db, runId, seq - 1, 1);
  return row?.seq === seq ? fromEventRow(row) : null;
}

export async function readLastEvent(db: Queryable, runId: string): Promise<RunEvent | null> {
  const last = await lastSeq(db, runId);
  return last === null ? null : readEventAt(db, runId, last);
}

// jsonb reorders object keys, so compare with keys sorted.
const sortedKeys = (_key: string, value: unknown): unknown =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : value;

/** Whether two events are the same event, e.g. a stored row and the event a retried write carried. */
export function sameEvent(a: RunEvent, b: RunEvent): boolean {
  return JSON.stringify(a, sortedKeys) === JSON.stringify(b, sortedKeys);
}
