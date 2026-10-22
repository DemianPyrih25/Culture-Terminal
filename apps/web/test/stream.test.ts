// The replay-to-live handoff of runEventStream, with an in-memory store whose reads the tests
// interleave with bus publications. Each case fails if its branch of the handoff is broken.
import { describe, expect, it, vi } from "vitest";
import { stampEvent, type EventInput, type RunEvent } from "@ct/contracts";
import type { Queryable } from "@ct/db";
import { EventBus } from "../server/event-bus";
import { runEventStream, type RunStreamDeps } from "../server/stream";

vi.mock("server-only", () => ({}));

const RUN = "run-handoff-test";
const stamp = (seq: number, input: EventInput): RunEvent =>
  stampEvent(input, { seq, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), runId: RUN });
const note = (seq: number) => stamp(seq, { type: "note", text: `note ${seq}` });
const end = (seq: number) => stamp(seq, { type: "run.end", status: "completed", elapsedMs: 9000, reason: null });

class MemoryStore {
  readonly events: RunEvent[] = [];
  reads = 0;
  /** Runs inside a read, before its result is returned; gets the 1-based read number. */
  duringRead: ((read: number, snapshot: () => RunEvent[]) => Promise<RunEvent[]>) | null = null;

  constructor(readonly bus: EventBus) {}

  store(...events: RunEvent[]): void {
    this.events.push(...events);
  }

  /** What the run manager does: store, then publish. */
  emit(...events: RunEvent[]): void {
    for (const event of events) {
      this.store(event);
      this.bus.publish(event);
    }
  }

  readEventsAfter = async (_runId: string, after: number, limit: number): Promise<RunEvent[]> => {
    this.reads += 1;
    const snapshot = () => this.events.filter((e) => e.seq > after).sort((a, b) => a.seq - b.seq).slice(0, limit);
    return this.duringRead ? this.duringRead(this.reads, snapshot) : snapshot();
  };
}

function setup(options: { live?: boolean } = {}) {
  const bus = new EventBus();
  const store = new MemoryStore(bus);
  const deps: RunStreamDeps = {
    // Only the tail's status checks touch the database; these cases end before they run.
    db: {} as Queryable,
    bus,
    isLive: () => options.live ?? true,
    readEventsAfter: store.readEventsAfter,
  };
  const controller = new AbortController();
  const stream = runEventStream(deps, RUN, 0, controller.signal, { tailIntervalMs: 60_000, statusCheckMs: 60_000 });
  return { bus, store, stream, controller };
}

async function take(stream: AsyncGenerator<RunEvent>, n: number): Promise<number[]> {
  const seqs: number[] = [];
  for (let i = 0; i < n; i++) {
    const { value, done } = await stream.next();
    if (done) break;
    seqs.push(value.seq);
  }
  return seqs;
}

/** The next event, or "timeout" when none arrives within `ms`. */
async function nextWithin(stream: AsyncGenerator<RunEvent>, ms: number): Promise<number | "timeout" | "done"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), ms)));
  const next = stream.next().then((r) => (r.done ? ("done" as const) : r.value.seq));
  const result = await Promise.race([next, timeout]);
  clearTimeout(timer);
  return result;
}

describe("runEventStream handoff", () => {
  it("drops buffered events the replay already sent and yields the rest once, in order", async () => {
    const { bus, store, stream } = setup();
    store.store(note(1), note(2), note(3));
    store.duringRead = async (read, snapshot) => {
      if (read > 1) return snapshot();
      // While the first page is being read the run writes on: 4 and 5 land in the page and in the
      // buffer, 6 only in the buffer.
      store.emit(note(4), note(5));
      const page = snapshot();
      store.emit(note(6));
      return page;
    };
    expect(await take(stream, 6)).toEqual([1, 2, 3, 4, 5, 6]);
    store.emit(end(7));
    expect(await take(stream, 2)).toEqual([7]);
    // The live path never went back to the store.
    expect(store.reads).toBe(1);
    expect(bus.subscriberCount(RUN)).toBe(0);
  });

  it("fills a jump past the last seq from the store", async () => {
    const { store, stream } = setup();
    store.store(note(1), note(2), note(3), note(4), note(5));
    expect(await take(stream, 5)).toEqual([1, 2, 3, 4, 5]);
    // 6 and 7 are stored but their publications never reached this subscriber.
    store.store(note(6), note(7));
    store.emit(note(8));
    expect(await take(stream, 3)).toEqual([6, 7, 8]);
    store.emit(end(9));
    expect(await take(stream, 2)).toEqual([9]);
    expect(store.reads).toBe(2);
  });

  it("takes the live path: a published event arrives without waiting for the tail interval", async () => {
    const { bus, store, stream, controller } = setup();
    store.store(note(1));
    expect(await take(stream, 1)).toEqual([1]);
    // Published but not stored (only possible in a test): only the bus path can deliver it. The
    // tail would wait out its 60 s interval and then find nothing in the store.
    bus.publish(note(2));
    expect(await nextWithin(stream, 200)).toBe(2);
    controller.abort();
    await stream.return(undefined);
    expect(bus.subscriberCount(RUN)).toBe(0);
  });

  it("drains the buffer after the bus closes, then reads the rest from the store", async () => {
    const { bus, store, stream } = setup();
    store.store(note(1), note(2));
    expect(await take(stream, 2)).toEqual([1, 2]);
    store.emit(note(3), note(4));
    // run.end is stored but the producer closes the bus before this subscriber hears it.
    store.store(end(5));
    bus.close(RUN);
    expect(await take(stream, 4)).toEqual([3, 4, 5]);
    expect(store.reads).toBe(2);
  });

  it("tails the store when the run is not live here", async () => {
    const { store, stream } = setup({ live: false });
    store.store(note(1), note(2), end(3));
    expect(await take(stream, 4)).toEqual([1, 2, 3]);
  });
});
