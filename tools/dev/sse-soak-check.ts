// The pass/fail rules of the SSE soak (sse-soak.ts), as a pure function over what the soak
// recorded, so the rules themselves are tested (sse-soak.test.ts).

/** One event as it arrived, duplicates included. */
export interface SoakEvent {
  seq: number;
  type: string;
  status?: string;
  /** The event's own timestamp (server clock), ms since the epoch. */
  tsMs: number;
  /** Local arrival time, ms since the epoch. */
  arrivedAt: number;
  /** 1-based connection that delivered it. */
  connection: number;
}

/** How a connection ended. Only "run.end" and "forced" are planned. */
export type SoakClose = "run.end" | "forced" | "server-closed" | "error" | "bad-status" | "timeout";

export interface SoakConnection {
  /** 1-based. */
  index: number;
  /** Local time the request was sent. */
  openedAt: number;
  /** The Last-Event-ID header this request actually sent, or null when it sent none. */
  lastEventId: string | null;
  close: SoakClose;
  detail?: string;
}

export interface SoakRecord {
  /** Local time the run was started. */
  startedAt: number;
  events: SoakEvent[];
  connections: SoakConnection[];
  /** The one forced disconnect: local time, the last seq received before it, and its connection. */
  drop: { at: number; seq: number; connection: number } | null;
  /** Problems seen on the wire while reading (headers, frame ids, foreign run ids). */
  wireProblems: string[];
  /** GET /api/runs/[id] after the stream ended, or null when it was not fetched. */
  snapshot: { lastSeq?: number; status?: string } | null;
}

export interface SoakCheckOptions {
  /** A quick run: skip the minimum-duration rule. */
  short?: boolean;
  /** Tolerate server or proxy closes before run.end (they are still counted). */
  allowUnplannedCloses?: boolean;
  /** The Part 1 "Done when" asks for a 200 s stream; a little slack for clocks. */
  minDurationMs?: number;
  /** How much later than its peers an event may arrive before it counts as buffered. */
  maxLagMs?: number;
  /** How long the first event may take after the first request. */
  maxFirstEventMs?: number;
}

export interface SoakResult {
  problems: string[];
  /** Events in order with duplicates removed. */
  accepted: SoakEvent[];
  duplicates: number;
  gaps: number;
  /** First request to the arrival of run.end (or of the last event). */
  durationMs: number;
  /** Worst arrival delay of an event sent while its connection was open, after removing clock skew. */
  worstLagMs: number | null;
  unplannedCloses: number;
}

const DEFAULTS = { minDurationMs: 190_000, maxLagMs: 5000, maxFirstEventMs: 5000 };

const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

export function checkSoak(record: SoakRecord, options: SoakCheckOptions = {}): SoakResult {
  const opts = { ...DEFAULTS, ...options };
  const problems = [...record.wireProblems];

  const accepted: SoakEvent[] = [];
  let duplicates = 0;
  let gaps = 0;
  let last = 0;
  for (const event of record.events) {
    if (event.seq <= last) {
      duplicates += 1;
      continue;
    }
    if (event.seq !== last + 1) gaps += 1;
    last = event.seq;
    accepted.push(event);
  }
  if (!accepted.every((e, i) => e.seq === i + 1)) problems.push("sequence is not 1..N in order");
  if (duplicates > 0) problems.push(`${duplicates} duplicate events`);
  if (gaps > 0) problems.push(`${gaps} gaps`);
  const first = accepted[0];
  const final = accepted.at(-1);
  if (first?.type !== "run.created") problems.push(`first event was ${first?.type ?? "none"}`);
  if (final?.type !== "run.end") problems.push(`last event was ${final?.type ?? "none"}`);

  // Resume: the forced drop came after at least one event, and the next request resumed from it.
  const drop = record.drop;
  if (!drop) {
    problems.push("no forced disconnect happened before run.end; lower --drop-at");
  } else if (drop.seq === 0) {
    problems.push("the forced disconnect came before any event arrived, so it proves no resume");
  } else {
    const resumed = record.connections.find((c) => c.index === drop.connection + 1);
    const resumedFirst = record.events.find((e) => e.connection === drop.connection + 1);
    if (!resumed) problems.push("no reconnect happened after the forced disconnect");
    else if (resumed.lastEventId !== String(drop.seq)) {
      problems.push(`the reconnect sent Last-Event-ID ${resumed.lastEventId ?? "(none)"}, expected ${drop.seq}`);
    }
    if (resumed && resumedFirst?.seq !== drop.seq + 1) {
      problems.push(`the reconnect's first event was seq ${resumedFirst?.seq ?? "none"}, expected ${drop.seq + 1}`);
    }
  }

  const unplanned = record.connections.filter((c) => c.close !== "run.end" && c.close !== "forced");
  if (unplanned.length > 0 && !opts.allowUnplannedCloses) {
    for (const c of unplanned) {
      problems.push(`connection ${c.index} ended unplanned (${c.close}${c.detail ? `: ${c.detail}` : ""})`);
    }
  }

  // Buffering: an event sent while its connection was open should arrive about as fast as the
  // fastest event did. The fastest (arrival - ts) is network latency plus clock skew, so subtracting
  // it makes the rule independent of the two clocks. Events sent before their connection opened
  // (the replay after a reconnect) are expected to arrive late and are skipped.
  let worstLagMs: number | null = null;
  if (accepted.length > 0) {
    const offset = Math.min(...accepted.map((e) => e.arrivedAt - e.tsMs));
    const openedAt = new Map(record.connections.map((c) => [c.index, c.openedAt]));
    let late = 0;
    for (const e of accepted) {
      const sentLocal = e.tsMs + offset;
      if (sentLocal < (openedAt.get(e.connection) ?? Number.NEGATIVE_INFINITY)) continue;
      const lag = e.arrivedAt - sentLocal;
      worstLagMs = Math.max(worstLagMs ?? 0, lag);
      if (lag > opts.maxLagMs) late += 1;
    }
    if (late > 0) {
      problems.push(
        `${late} events arrived more than ${secs(opts.maxLagMs)} after they were sent (worst ${secs(worstLagMs ?? 0)}): the stream is buffered`,
      );
    }
    const firstConnection = record.connections[0];
    if (first && firstConnection && first.arrivedAt - firstConnection.openedAt > opts.maxFirstEventMs) {
      problems.push(`the first event took ${secs(first.arrivedAt - firstConnection.openedAt)} to arrive: the stream is buffered`);
    }
  }

  const streamStart = record.connections[0]?.openedAt ?? record.startedAt;
  const durationMs = final ? final.arrivedAt - streamStart : 0;
  if (!opts.short && durationMs < opts.minDurationMs) {
    problems.push(`the stream lasted ${secs(durationMs)}, under ${secs(opts.minDurationMs)}; run a 200 s run or pass --short`);
  }

  if (final && record.snapshot) {
    if (record.snapshot.lastSeq !== final.seq) problems.push(`snapshot lastSeq ${record.snapshot.lastSeq} != ${final.seq}`);
    if (final.status && record.snapshot.status !== final.status) {
      problems.push(`snapshot status ${record.snapshot.status} != ${final.status}`);
    }
  }

  return { problems, accepted, duplicates, gaps, durationMs, worstLagMs, unplannedCloses: unplanned.length };
}
