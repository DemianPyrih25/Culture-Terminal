import { describe, expect, it } from "vitest";
import { checkSoak, type SoakConnection, type SoakEvent, type SoakRecord } from "./sse-soak-check";

// Local and server clocks disagree on purpose: the rules must not depend on them agreeing.
const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const SKEW = 7_300;
const LATENCY = 40;

interface Plan {
  /** Run length in seconds; one event every 2 s, run.end at the end. */
  seconds?: number;
  /** Forced drop after this many seconds (after the event due then), or null for none. */
  dropAt?: number | null;
  /** Seconds between the drop and the reconnect. */
  reconnectAfter?: number;
  /** Sends no Last-Event-ID on the reconnect and the server replays from seq 1. */
  resumeIgnored?: boolean;
  /** Everything arrives at once when the run ends (a buffering proxy). */
  buffered?: boolean;
}

/** Builds what the soak would record for a run against a server behaving as described. */
function soak(plan: Plan = {}): SoakRecord {
  const { seconds = 200, dropAt = 60, reconnectAfter = 2, resumeIgnored = false, buffered = false } = plan;
  const sent = Array.from({ length: seconds / 2 + 1 }, (_, i) => ({
    seq: i + 1,
    type: i === 0 ? "run.created" : i === seconds / 2 ? "run.end" : "note",
    // Server clock: a run that starts 100 ms after the soak and emits every 2 s.
    tsMs: T0 + SKEW + 100 + i * 2000,
  }));
  const localSent = (e: { tsMs: number }) => e.tsMs - SKEW;
  const connections: SoakConnection[] = [{ index: 1, openedAt: T0 + 150, lastEventId: null, close: "run.end" }];
  const events: SoakEvent[] = [];
  let drop: SoakRecord["drop"] = null;
  const deliver = (e: (typeof sent)[number], connection: number, arrivedAt: number) =>
    events.push({ ...e, arrivedAt, connection, ...(e.type === "run.end" ? { status: "completed" } : {}) });

  if (buffered) {
    for (const e of sent) deliver(e, 1, localSent(sent.at(-1)!) + LATENCY);
  } else {
    const dropTime = dropAt === null ? Number.POSITIVE_INFINITY : T0 + dropAt * 1000 + 500;
    for (const e of sent) if (localSent(e) < dropTime) deliver(e, 1, Math.max(localSent(e), T0 + 150) + LATENCY);
    if (dropAt !== null) {
      const lastSeq = events.at(-1)!.seq;
      connections[0]!.close = "forced";
      drop = { at: dropTime, seq: lastSeq, connection: 1 };
      const openedAt = dropTime + reconnectAfter * 1000;
      connections.push({ index: 2, openedAt, lastEventId: resumeIgnored ? null : String(lastSeq), close: "run.end" });
      const from = resumeIgnored ? 0 : lastSeq;
      for (const e of sent.slice(from)) deliver(e, 2, Math.max(localSent(e), openedAt) + LATENCY);
    }
  }
  const last = sent.at(-1)!;
  return {
    startedAt: T0,
    events,
    connections,
    drop,
    wireProblems: [],
    snapshot: { lastSeq: last.seq, status: "completed" },
  };
}

describe("checkSoak", () => {
  it("passes a 200 s stream that arrives as it happens and resumes after the forced drop", () => {
    const result = checkSoak(soak());
    expect(result.problems).toEqual([]);
    expect(result.accepted.map((e) => e.seq)).toEqual(Array.from({ length: 101 }, (_, i) => i + 1));
    expect(result.durationMs).toBeGreaterThanOrEqual(199_000);
    expect(result.worstLagMs).toBeLessThan(1000);
  });

  it("fails a buffered body that arrives in one burst at the end", () => {
    const result = checkSoak(soak({ seconds: 40, buffered: true }), { short: true });
    expect(result.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("the stream is buffered"),
        expect.stringContaining("first event took"),
        expect.stringContaining("no forced disconnect"),
      ]),
    );
  });

  it("fails a forced drop before any event, which proves no resume", () => {
    const record = soak({ seconds: 40, dropAt: 10 });
    record.drop = { ...record.drop!, seq: 0 };
    expect(checkSoak(record, { short: true }).problems).toContainEqual(expect.stringContaining("before any event arrived"));
  });

  it("fails a reconnect that did not send Last-Event-ID and was replayed from the start", () => {
    const { problems, duplicates } = checkSoak(soak({ resumeIgnored: true }));
    expect(duplicates).toBeGreaterThan(0);
    expect(problems).toContainEqual(expect.stringContaining("sent Last-Event-ID (none)"));
    expect(problems).toContainEqual(expect.stringMatching(/first event was seq 1, expected \d+/));
  });

  it("fails an unplanned close unless told to allow it", () => {
    const record = soak();
    record.connections[0]!.close = "server-closed";
    expect(checkSoak(record).problems).toContainEqual(expect.stringContaining("connection 1 ended unplanned (server-closed)"));
    const allowed = checkSoak(record, { allowUnplannedCloses: true });
    expect(allowed.problems).toEqual([]);
    expect(allowed.unplannedCloses).toBe(1);
  });

  it("fails a run shorter than about 200 s unless --short", () => {
    const record = soak({ seconds: 40, dropAt: 16 });
    expect(checkSoak(record).problems).toContainEqual(expect.stringContaining("pass --short"));
    expect(checkSoak(record, { short: true }).problems).toEqual([]);
  });

  it("does not count the replay after a slow reconnect as buffering", () => {
    expect(checkSoak(soak({ reconnectAfter: 20 })).problems).toEqual([]);
  });

  it("fails gaps, a missing run.end and a snapshot that disagrees", () => {
    const record = soak();
    record.events = record.events.filter((e) => e.seq !== 50 && e.type !== "run.end");
    record.snapshot = { lastSeq: 101, status: "completed" };
    const { problems, gaps } = checkSoak(record, { short: true });
    expect(gaps).toBe(1);
    expect(problems).toEqual(
      expect.arrayContaining([
        "1 gaps",
        "last event was note",
        expect.stringContaining("snapshot lastSeq 101 != 100"),
      ]),
    );
  });
});
