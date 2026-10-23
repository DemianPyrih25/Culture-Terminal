import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RUN_LIMITS, reduceRunEvents, stampEvent, type EventInput, type RunEvent } from "@ct/contracts";
import { ReplayPlayer, REPLAY_MAX_DELAY_MS, RunSession, sessionFor, useRunState, type ReplaySpeed } from "../lib/run-stream";
import { RunStreamClient, type EventSourceLike } from "../lib/sse-client";

const RUN = "run-replay-test";
const T0 = Date.UTC(2026, 9, 14, 9, 12, 0);

const stamp = (seq: number, offsetMs: number, input: EventInput): RunEvent =>
  stampEvent(input, { seq, ts: new Date(T0 + offsetMs).toISOString(), runId: RUN });
const note = (seq: number, offsetMs: number) => stamp(seq, offsetMs, { type: "note", text: `note ${seq}` });

/** Gaps of 1 s, 0 s (same moment), 2 s, 10 s and 0.5 s. */
const RECORDING: RunEvent[] = [
  stamp(1, 0, { type: "run.created", question: "Is Juniper Cola a taste island?", mode: "live", lane: "public", limits: DEFAULT_RUN_LIMITS, parentRunId: null, model: "fake" }),
  note(2, 1000),
  note(3, 1000),
  note(4, 3000),
  note(5, 13_000),
  stamp(6, 13_500, { type: "run.end", status: "completed", elapsedMs: 13_500, reason: null }),
];

function player(speed: ReplaySpeed, events: readonly RunEvent[] = RECORDING, autoplay = false) {
  const p = new ReplayPlayer(RUN, { speed, autoplay });
  for (const e of events) p.push(e);
  return p;
}
const applied = (p: ReplayPlayer) => p.getSnapshot().applied;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("ReplayPlayer pacing", () => {
  it("plays at 1× on the recording's own gaps, applying events of one moment together", () => {
    const p = player(1);
    const notified = vi.fn();
    p.subscribe(notified);
    p.play();
    expect(applied(p)).toBe(1);
    vi.advanceTimersByTime(999);
    expect(applied(p)).toBe(1);
    notified.mockClear();
    vi.advanceTimersByTime(1);
    expect(applied(p)).toBe(3);
    expect(notified).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(2000);
    expect(applied(p)).toBe(4);
    vi.advanceTimersByTime(9999);
    expect(applied(p)).toBe(4);
    vi.advanceTimersByTime(1);
    expect(applied(p)).toBe(5);
    vi.advanceTimersByTime(500);
    expect(p.getSnapshot()).toMatchObject({ applied: 6, done: true, playing: false, progress: 1, durationMs: 13_500 });
    expect(p.getSnapshot().state).toEqual(reduceRunEvents(RUN, RECORDING));
  });

  it("divides the gaps at 4× and 16×, capping long pauses", () => {
    const p4 = player(4);
    p4.play();
    vi.advanceTimersByTime(250);
    expect(applied(p4)).toBe(3);
    vi.advanceTimersByTime(500);
    expect(applied(p4)).toBe(4);
    // 10 s / 4 = 2.5 s, capped.
    vi.advanceTimersByTime(REPLAY_MAX_DELAY_MS - 1);
    expect(applied(p4)).toBe(4);
    vi.advanceTimersByTime(1);
    expect(applied(p4)).toBe(5);
    vi.advanceTimersByTime(125);
    expect(p4.getSnapshot().done).toBe(true);

    const p16 = player(16);
    p16.play();
    vi.advanceTimersByTime(62);
    expect(applied(p16)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(applied(p16)).toBe(3);
    vi.advanceTimersByTime(125 + REPLAY_MAX_DELAY_MS + 32);
    expect(p16.getSnapshot().done).toBe(true);
  });

  it("applies everything at once when instant", () => {
    const p = player("instant");
    const notified = vi.fn();
    p.subscribe(notified);
    p.play();
    expect(p.getSnapshot()).toMatchObject({ applied: 6, done: true });
    expect(notified).toHaveBeenCalledTimes(2);
  });

  it("reports progress in run time", () => {
    const p = player(1);
    p.play();
    vi.advanceTimersByTime(3000);
    expect(p.getSnapshot()).toMatchObject({ applied: 4, loaded: 6, complete: true, positionMs: 3000, durationMs: 13_500 });
    expect(p.getSnapshot().progress).toBeCloseTo(3000 / 13_500);
  });
});

describe("ReplayPlayer controls", () => {
  it("pauses and resumes with what was left of the wait", () => {
    const p = player(1);
    p.play();
    vi.advanceTimersByTime(400);
    p.pause();
    expect(p.getSnapshot().playing).toBe(false);
    vi.advanceTimersByTime(5000);
    expect(applied(p)).toBe(1);
    p.play();
    vi.advanceTimersByTime(599);
    expect(applied(p)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(applied(p)).toBe(3);
  });

  it("rescales the current wait when the speed changes", () => {
    const p = player(1);
    p.play();
    vi.advanceTimersByTime(200);
    p.setSpeed(4);
    expect(p.getSnapshot().speed).toBe(4);
    vi.advanceTimersByTime(199);
    expect(applied(p)).toBe(1);
    vi.advanceTimersByTime(1);
    expect(applied(p)).toBe(3);
    p.setSpeed("instant");
    expect(p.getSnapshot().done).toBe(true);
  });

  it("restarts from the empty state and skips to the end", () => {
    const p = player(1);
    p.play();
    vi.advanceTimersByTime(3000);
    expect(applied(p)).toBe(4);
    p.restart();
    expect(applied(p)).toBe(1);
    expect(p.getSnapshot().state.lastSeq).toBe(1);
    p.skipToEnd();
    expect(p.getSnapshot()).toMatchObject({ applied: 6, done: true, progress: 1 });
    // Play on a finished replay starts it over.
    p.play();
    expect(applied(p)).toBe(1);
    expect(p.getSnapshot().playing).toBe(true);
  });

  it("records only this run's events, in seq order", () => {
    const p = player(1, []);
    p.push(RECORDING[0] as RunEvent);
    p.push(RECORDING[0] as RunEvent);
    p.push({ ...(RECORDING[1] as RunEvent), runId: "another-run" });
    expect(p.getSnapshot()).toMatchObject({ loaded: 1, applied: 0, complete: false, done: false, progress: 0 });
  });

  it("waits only for what is left of a gap when events arrive while it plays", () => {
    const p = player(1, [], true);
    p.push(RECORDING[0] as RunEvent);
    expect(applied(p)).toBe(1);
    // The next event arrives late: its 1 s gap has already passed.
    vi.advanceTimersByTime(5000);
    p.push(RECORDING[1] as RunEvent);
    expect(applied(p)).toBe(2);
    p.push(RECORDING[3] as RunEvent);
    vi.advanceTimersByTime(1999);
    expect(applied(p)).toBe(2);
    vi.advanceTimersByTime(1);
    expect(applied(p)).toBe(3);
  });

  it("does nothing on its own until play when autoplay is off", () => {
    const p = player(4);
    vi.advanceTimersByTime(60_000);
    expect(p.getSnapshot()).toMatchObject({ applied: 0, playing: false, loaded: 6 });
  });
});

class FakeEventSource implements EventSourceLike {
  readyState = 0;
  onopen: EventSourceLike["onopen"] = null;
  onmessage: EventSourceLike["onmessage"] = null;
  onerror: EventSourceLike["onerror"] = null;
  close() {
    this.readyState = 2;
  }
  send(event: RunEvent) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(event) }));
  }
}

describe("RunStreamClient onEvent", () => {
  it("hands each applied event on, in order, without duplicates", () => {
    const sources: FakeEventSource[] = [];
    const seen: number[] = [];
    const client = new RunStreamClient(RUN, {
      createEventSource: () => {
        const s = new FakeEventSource();
        sources.push(s);
        return s;
      },
      probeRun: async () => ({ status: 200, ended: false, lastSeq: null }),
      onEvent: (e) => seen.push(e.seq),
    });
    client.start();
    const source = sources[0] as FakeEventSource;
    source.send(RECORDING[0] as RunEvent);
    source.send(RECORDING[0] as RunEvent);
    source.send(RECORDING[1] as RunEvent);
    expect(seen).toEqual([1, 2]);
    // A gap is repaired by a resume, not passed on.
    source.send(RECORDING[3] as RunEvent);
    expect(seen).toEqual([1, 2]);
    client.stop();
  });

  it("feeds a replay player that ends in the live state", () => {
    const sources: FakeEventSource[] = [];
    const p = new ReplayPlayer(RUN, { speed: "instant" });
    const client = new RunStreamClient(RUN, {
      createEventSource: () => {
        const s = new FakeEventSource();
        sources.push(s);
        return s;
      },
      onEvent: p.push,
    });
    client.start();
    for (const e of RECORDING) sources[0]?.send(e);
    expect(client.getSnapshot().connection).toBe("ended");
    expect(p.getSnapshot().state).toEqual(client.getSnapshot().state);
  });
});

describe("RunStreamClient event log", () => {
  const streamWith = (log?: boolean) => {
    const { sources, client: options } = fakeStream();
    const client = new RunStreamClient(RUN, { ...options, log });
    client.start();
    for (const e of RECORDING) sources[0]?.send(e);
    return client.getSnapshot();
  };

  it("keeps no log unless asked: the page reads the state", () => {
    const snap = streamWith();
    expect(snap.state.lastSeq).toBe(RECORDING.length);
    expect(snap.log).toEqual([]);
    expect(streamWith(false).log).toEqual([]);
  });

  it("logs every applied event, in seq order, when made with log: true", () => {
    expect(streamWith(true).log).toEqual(RECORDING.map((e) => ({ seq: e.seq, ts: e.ts, type: e.type })));
  });

  it("leaves the log off in useRunState's sessions", () => {
    const { sources, client } = fakeStream();
    const session = new RunSession(RUN, false, { client });
    session.attach(true);
    for (const e of RECORDING) sources[0]?.send(e);
    expect(session.client.getSnapshot()).toMatchObject({ connection: "ended", log: [] });
  });
});

/** A stream client that hands out fake EventSources and records the URLs it opened. */
function fakeStream() {
  const sources: FakeEventSource[] = [];
  const urls: string[] = [];
  const client = {
    createEventSource: (url: string) => {
      const s = new FakeEventSource();
      sources.push(s);
      urls.push(url);
      return s;
    },
    probeRun: async () => ({ status: 200, ended: false, lastSeq: null }),
  };
  return { sources, urls, client, latest: () => sources.at(-1) as FakeEventSource };
}

describe("RunSession: what useRunState's effects do", () => {
  it("streams a live run on attach and stops on detach, resuming from the last seq", () => {
    const fake = fakeStream();
    const session = new RunSession(RUN, false, { client: fake.client });
    expect(session.player).toBeNull();
    expect(fake.sources).toHaveLength(0);
    const detach = session.attach(true);
    expect(session.client.getSnapshot().connection).toBe("connecting");
    fake.latest().send(RECORDING[0] as RunEvent);
    fake.latest().send(RECORDING[1] as RunEvent);
    expect(session.client.getSnapshot().state.lastSeq).toBe(2);
    detach();
    expect(fake.latest().readyState).toBe(2);
    // React remounting the page (StrictMode, a fast refresh) attaches again and resumes.
    session.attach(true);
    expect(fake.urls).toEqual([`/api/runs/${RUN}/stream`, `/api/runs/${RUN}/stream?after=2`]);
    session.detach();
  });

  it("plays a replay as its events arrive when autoplay is on, and pauses on detach", () => {
    const fake = fakeStream();
    const session = new RunSession(RUN, true, { replay: { speed: 1 }, client: fake.client });
    const player = session.player as ReplayPlayer;
    session.attach(true);
    for (const e of RECORDING) fake.latest().send(e);
    expect(player.getSnapshot()).toMatchObject({ playing: true, applied: 1, loaded: 6 });
    vi.advanceTimersByTime(1000);
    expect(player.getSnapshot().applied).toBe(3);
    session.detach();
    expect(player.getSnapshot().playing).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(player.getSnapshot().applied).toBe(3);
    // Attached again, it picks up where it paused.
    session.attach(true);
    expect(player.getSnapshot().playing).toBe(true);
    vi.advanceTimersByTime(2000);
    expect(player.getSnapshot().applied).toBe(4);
    session.detach();
  });

  it("waits for play when autoplay is off", () => {
    const fake = fakeStream();
    const session = new RunSession(RUN, true, { replay: { speed: 4, autoplay: false }, client: fake.client });
    session.attach(false);
    for (const e of RECORDING) fake.latest().send(e);
    vi.advanceTimersByTime(60_000);
    expect(session.player?.getSnapshot()).toMatchObject({ playing: false, applied: 0, loaded: 6 });
    session.player?.play();
    expect(session.player?.getSnapshot().applied).toBe(1);
    session.detach();
  });

  it("follows a speed change, and a live session has no speed to follow", () => {
    const fake = fakeStream();
    const session = new RunSession(RUN, true, { replay: { speed: 4 }, client: fake.client });
    session.setSpeed(16);
    expect(session.player?.getSnapshot().speed).toBe(16);
    session.setSpeed(undefined);
    expect(session.player?.getSnapshot().speed).toBe(16);
    const liveSession = new RunSession(RUN, false, { client: fake.client });
    expect(() => liveSession.setSpeed(16)).not.toThrow();
  });

  it("keeps its session while the run and the mode stay, and starts a new one when either changes", () => {
    const fake = fakeStream();
    const first = sessionFor(null, RUN, { client: fake.client });
    expect(sessionFor(first, RUN, { client: fake.client })).toBe(first);
    const other = sessionFor(first, "run-replay-other", { client: fake.client });
    expect(other).not.toBe(first);
    expect(other.runId).toBe("run-replay-other");
    expect(other.client).not.toBe(first.client);
    const replay = sessionFor(other, "run-replay-other", { replay: { speed: 4 }, client: fake.client });
    expect(replay).not.toBe(other);
    expect(replay.player).not.toBeNull();
    // A speed change alone keeps the session; the effect passes it on.
    expect(sessionFor(replay, "run-replay-other", { replay: { speed: 16 }, client: fake.client })).toBe(replay);
  });
});

describe("useRunState", () => {
  function Probe(props: { replay: boolean }) {
    const handle = useRunState(RUN, props.replay ? { replay: { speed: 16 } } : {});
    return createElement(
      "p",
      null,
      `${handle.state.status} · ${handle.connection} · ${handle.replay ? `replay ${handle.replay.speed} ${handle.replay.applied}/${handle.replay.loaded}` : "live"}`,
    );
  }

  it("renders the empty run on the server, live or as a replay", () => {
    expect(renderToStaticMarkup(createElement(Probe, { replay: false }))).toBe("<p>queued · idle · live</p>");
    expect(renderToStaticMarkup(createElement(Probe, { replay: true }))).toBe("<p>queued · idle · replay 16 0/0</p>");
  });
});
