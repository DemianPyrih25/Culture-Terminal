// A recorded run through the stand-in stream the dev sample viewer uses (D26: a replay makes no Qloo or
// model call): it serves the events after the cursor, and the replay plays them into the run's final state.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reduceRunEvents } from "@ct/contracts";
import { recordedEventSource } from "../../components/brief/sample-source";
import { RunSession } from "../../lib/run-stream";
import { events } from "./support";

vi.mock("server-only", () => ({}));

const SAMPLE = events("brand-health");

describe("a recorded run through the stand-in stream", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("serves the events after the cursor, then the replay plays them into the run's final state", () => {
    const seen: number[] = [];
    const source = recordedEventSource(SAMPLE)("/api/runs/sample-brand-health/stream?after=100");
    source.onmessage = (message) => seen.push(JSON.parse(String(message.data)).seq);
    vi.runAllTimers();
    expect(seen).toEqual(SAMPLE.filter((e) => e.seq > 100).map((e) => e.seq));

    const runId = SAMPLE[0]?.runId ?? "missing";
    const session = new RunSession(runId, true, {
      replay: { speed: 16 },
      client: { createEventSource: recordedEventSource(SAMPLE), probeRun: async () => ({ status: 200, ended: true, lastSeq: SAMPLE.length }) },
    });
    const detach = session.attach(true);
    vi.runAllTimers();
    const played = session.player?.getSnapshot();
    expect(played?.done).toBe(true);
    expect(played?.state).toEqual(reduceRunEvents(runId, SAMPLE));
    detach();
  });
});
