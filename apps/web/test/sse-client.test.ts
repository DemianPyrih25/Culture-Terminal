import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { stampEvent, type EventInput, type RunEvent } from "@ct/contracts";
import { RunStreamClient, streamUrl, type EventSourceLike, type RunProbe } from "../lib/sse-client";

const RUN = "run-client-test";

const at = (seq: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString();
const stamp = (seq: number, input: EventInput): RunEvent => stampEvent(input, { seq, ts: at(seq), runId: RUN });
const created = stamp(1, {
  type: "run.created",
  question: "Is Juniper Cola a taste island?",
  mode: "live",
  lane: "public",
  limits: {
    qlooCalls: 40,
    qlooWarnAt: 30,
    followupCalls: 8,
    followupMs: 40_000,
    softMs: 120_000,
    hardMs: 180_000,
    usdNudge: 0.4,
    usdHard: 0.6,
    modelResponses: 5,
  },
  parentRunId: null,
  model: "fake",
});
const note = (seq: number) => stamp(seq, { type: "note", text: `note ${seq}` });
const end = (seq: number) => stamp(seq, { type: "run.end", status: "completed", elapsedMs: 5000, reason: null });

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: EventSourceLike["onopen"] = null;
  onmessage: EventSourceLike["onmessage"] = null;
  onerror: EventSourceLike["onerror"] = null;
  closed = false;
  constructor(readonly url: string) {}
  open() {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }
  send(event: RunEvent | string) {
    const data = typeof event === "string" ? event : JSON.stringify(event);
    this.onmessage?.(new MessageEvent("message", { data }));
  }
  /** A network blip: the browser keeps the source and retries with Last-Event-ID. */
  blip() {
    this.readyState = 0;
    this.onerror?.(new Event("error"));
  }
  /** A non-200 answer: the browser gives up on this source. */
  giveUp() {
    this.readyState = 2;
    this.onerror?.(new Event("error"));
  }
  close() {
    this.readyState = 2;
    this.closed = true;
  }
}

let sources: FakeEventSource[];
let probe: RunProbe;

function makeClient(options: { log?: boolean } = { log: true }) {
  return new RunStreamClient(RUN, {
    ...options,
    createEventSource: (url) => {
      const source = new FakeEventSource(url);
      sources.push(source);
      return source;
    },
    probeRun: async () => probe,
    retryDelayMs: 10,
    maxManualRetries: 2,
  });
}

const latest = () => sources.at(-1)!;

beforeEach(() => {
  sources = [];
  probe = { status: 200, ended: false, lastSeq: null };
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RunStreamClient", () => {
  it("builds stream URLs with a cursor only when it has one", () => {
    expect(streamUrl("abc12345", 0)).toBe("/api/runs/abc12345/stream");
    expect(streamUrl("abc12345", 42)).toBe("/api/runs/abc12345/stream?after=42");
  });

  it("applies events in order, logs them and closes on run.end", () => {
    const client = makeClient();
    client.start();
    expect(client.getSnapshot().connection).toBe("connecting");
    latest().open();
    latest().send(created);
    latest().send(note(2));
    latest().send(end(3));
    const snap = client.getSnapshot();
    expect(snap.state.lastSeq).toBe(3);
    expect(snap.state.status).toBe("completed");
    expect(snap.log.map((l) => l.type)).toEqual(["run.created", "note", "run.end"]);
    expect(snap.connection).toBe("ended");
    expect(latest().closed).toBe(true);
    expect(sources).toHaveLength(1);
  });

  it("keeps no event log unless asked for one", () => {
    const client = makeClient({});
    client.start();
    latest().send(created);
    latest().send(end(2));
    expect(client.getSnapshot().state.status).toBe("completed");
    expect(client.getSnapshot().log).toEqual([]);
  });

  it("counts a browser auto-reconnect and keeps the same source", () => {
    const client = makeClient();
    client.start();
    latest().open();
    latest().send(created);
    latest().blip();
    expect(client.getSnapshot().connection).toBe("reconnecting");
    latest().open();
    expect(client.getSnapshot()).toMatchObject({ connection: "open", reconnects: 1 });
    expect(sources).toHaveLength(1);
  });

  it("ignores duplicates and repairs a gap by resuming after the last seq", () => {
    const client = makeClient();
    client.start();
    latest().open();
    latest().send(created);
    latest().send(created);
    expect(client.getSnapshot().duplicates).toBe(1);
    latest().send(note(3));
    expect(client.getSnapshot()).toMatchObject({ gaps: 1 });
    expect(client.getSnapshot().state.lastSeq).toBe(1);
    expect(sources).toHaveLength(2);
    expect(sources[0]?.closed).toBe(true);
    expect(latest().url).toBe(`/api/runs/${RUN}/stream?after=1`);
  });

  it("drops and resumes on demand", () => {
    const client = makeClient();
    client.start();
    latest().open();
    latest().send(created);
    latest().send(note(2));
    client.forceReconnect();
    expect(latest().url).toBe(`/api/runs/${RUN}/stream?after=2`);
    latest().open();
    latest().send(note(3));
    expect(client.getSnapshot()).toMatchObject({ reconnects: 1, gaps: 0, duplicates: 0 });
    expect(client.getSnapshot().state.lastSeq).toBe(3);
  });

  it("reopens with ?after when the browser gives up, and stops on a missing run", async () => {
    const client = makeClient();
    client.start();
    latest().open();
    latest().send(created);
    latest().giveUp();
    await vi.advanceTimersByTimeAsync(20);
    expect(sources).toHaveLength(2);
    expect(latest().url).toBe(`/api/runs/${RUN}/stream?after=1`);

    probe = { status: 404, ended: false, lastSeq: null };
    latest().giveUp();
    await vi.advanceTimersByTimeAsync(20);
    expect(client.getSnapshot().connection).toBe("not_found");
    expect(sources).toHaveLength(2);
  });

  it("counts messages that fail the contracts", () => {
    const client = makeClient();
    client.start();
    latest().open();
    latest().send("{not json");
    latest().send(JSON.stringify({ seq: 1, type: "nope" }));
    expect(client.getSnapshot().invalid).toBe(2);
    expect(client.getSnapshot().state.lastSeq).toBe(0);
  });

  describe("a newer connection opened while the probe is pending wins", () => {
    function withDeferredProbe() {
      let answer: (probe: RunProbe) => void = () => {};
      const client = new RunStreamClient(RUN, {
        createEventSource: (url) => {
          const source = new FakeEventSource(url);
          sources.push(source);
          return source;
        },
        probeRun: () => new Promise<RunProbe>((resolve) => (answer = resolve)),
        retryDelayMs: 10,
        maxManualRetries: 2,
      });
      return { client, answer: (probe: RunProbe) => answer(probe) };
    }

    it.each([
      ["a forced drop", (client: RunStreamClient) => client.forceReconnect()],
      [
        "a stop and start",
        (client: RunStreamClient) => {
          client.stop();
          client.start();
        },
      ],
    ])("%s", async (_name, interfere) => {
      const { client, answer } = withDeferredProbe();
      client.start();
      latest().open();
      latest().send(created);
      latest().giveUp();
      interfere(client);
      answer({ status: 200, ended: false, lastSeq: null });
      await vi.advanceTimersByTimeAsync(50);
      expect(sources.filter((s) => !s.closed)).toHaveLength(1);
      expect(latest().closed).toBe(false);
      expect(latest().url).toBe(`/api/runs/${RUN}/stream?after=1`);
    });
  });

  it("resumes from its last seq after stop and start, without counting a reconnect", () => {
    const client = makeClient();
    client.start();
    latest().open();
    latest().send(created);
    client.stop();
    expect(sources[0]?.closed).toBe(true);
    client.start();
    expect(latest().url).toBe(`/api/runs/${RUN}/stream?after=1`);
    latest().open();
    expect(client.getSnapshot().reconnects).toBe(0);
  });
});
