// The global run queue (D24) on its own: first in, first out per lane, places told on entry and on every
// change, the wait timing out, leaving, a full queue, a slot handed to the next run, and a start handed
// back. Pure: no database, fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Lane } from "@ct/contracts";

vi.mock("server-only", () => ({}));

const { RunQueue } = await import("../server/queue");
type Place = { position: number; ahead: number; waitSMax: number };

const WAIT_MS = 120_000;

function setup(max = 12) {
  const places: { id: string; place: Place }[] = [];
  const timedOut: string[] = [];
  const queue = new RunQueue<string>({
    max,
    waitMs: WAIT_MS,
    onPlace: (id, place) => places.push({ id, place }),
    onTimeout: (id) => timedOut.push(id),
  });
  const join = (id: string, lane: Lane = "public") => {
    expect(queue.reserve(id, lane, id)).toBe(true);
    return queue.enter(id);
  };
  return { queue, places, timedOut, join };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 9, 29, 12, 0, 0));
});
afterEach(() => {
  vi.useRealTimers();
});

describe("RunQueue", () => {
  it("tells each run its place as it enters, and hands slots out first in, first out", () => {
    const { queue, places, join } = setup();
    expect(join("a")).toEqual({ position: 1, ahead: 0, waitSMax: 120 });
    expect(join("b")).toEqual({ position: 2, ahead: 1, waitSMax: 120 });
    join("c");
    expect(places.map((p) => [p.id, p.place.position])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    expect(queue.take(() => true)?.id).toBe("a");
    expect(queue.take(() => true)?.id).toBe("b");
    expect(queue.take(() => true)?.id).toBe("c");
    expect(queue.take(() => true)).toBeNull();
  });

  it("tells the runs behind a departure their new places, and only them", () => {
    const { queue, places, join } = setup();
    join("a");
    join("b");
    join("c");
    places.length = 0;
    vi.advanceTimersByTime(30_000);
    queue.take(() => true);
    expect(places).toEqual([
      { id: "b", place: { position: 1, ahead: 0, waitSMax: 90 } },
      { id: "c", place: { position: 2, ahead: 1, waitSMax: 90 } },
    ]);
    places.length = 0;
    expect(queue.leave("c")).toBe("c");
    expect(places).toEqual([]);
    expect(queue.leave("c")).toBeNull();
    expect(queue.place("b")).toEqual({ position: 1, ahead: 0, waitSMax: 90 });
  });

  it("orders each lane apart: a busy lane's runs never hold back the other's", () => {
    const { queue, join } = setup();
    join("p1", "public");
    join("j1", "judge");
    join("p2", "public");
    expect(queue.place("j1")).toMatchObject({ position: 1, ahead: 0 });
    expect(queue.place("p2")).toMatchObject({ position: 2, ahead: 1 });
    // Only the judge lane has a free slot.
    expect(queue.take((lane) => lane === "judge")?.id).toBe("j1");
    expect(queue.take((lane) => lane === "judge")).toBeNull();
    expect(queue.waiting("public")).toBe(2);
    expect(queue.waiting("judge")).toBe(0);
  });

  it("times a run out after its wait, and moves the runs behind it up", () => {
    const { queue, places, timedOut, join } = setup();
    join("a");
    vi.advanceTimersByTime(10_000);
    join("b");
    places.length = 0;
    vi.advanceTimersByTime(WAIT_MS - 10_001);
    expect(timedOut).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(timedOut).toEqual(["a"]);
    expect(queue.has("a")).toBe(false);
    expect(places).toEqual([{ id: "b", place: { position: 1, ahead: 0, waitSMax: 10 } }]);
    vi.advanceTimersByTime(10_000);
    expect(timedOut).toEqual(["a", "b"]);
    expect(queue.size).toBe(0);
  });

  it("never times out a run that left or started", () => {
    const { queue, timedOut, join } = setup();
    join("a");
    join("b");
    queue.leave("a");
    queue.take(() => true);
    vi.advanceTimersByTime(WAIT_MS * 2);
    expect(timedOut).toEqual([]);
  });

  it("refuses a run once the queue is full, counting places reserved for runs still being admitted", () => {
    const { queue, join } = setup(2);
    join("a");
    expect(queue.reserve("b", "public", "b")).toBe(true);
    expect(queue.reserve("c", "public", "c")).toBe(false);
    // A reserved run holds a place but has none yet, and cannot start before it enters.
    expect(queue.place("b")).toBeNull();
    expect(queue.waiting()).toBe(1);
    expect(queue.take(() => true)?.id).toBe("a");
    expect(queue.take(() => true)).toBeNull();
    expect(queue.reserve("c", "public", "c")).toBe(true);
    expect(queue.enter("b")).toMatchObject({ position: 1 });
  });

  it("is off with a max of 0", () => {
    const { queue } = setup(0);
    expect(queue.reserve("a", "public", "a")).toBe(false);
  });

  it("puts a start that could not go ahead back at its old place, with what was left of its wait", () => {
    const { queue, places, timedOut, join } = setup();
    join("a");
    join("b");
    vi.advanceTimersByTime(20_000);
    const taken = queue.take(() => true)!;
    join("c");
    places.length = 0;
    expect(queue.restore(taken)).toBe(true);
    expect(queue.place("a")).toEqual({ position: 1, ahead: 0, waitSMax: 100 });
    expect(places.map((p) => [p.id, p.place.position])).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
    vi.advanceTimersByTime(100_000);
    expect([...timedOut].sort()).toEqual(["a", "b"]);
  });

  it("empties on shutdown, reserved places included, and fires no timer after", () => {
    const { queue, timedOut, join } = setup();
    join("a");
    queue.reserve("b", "public", "b");
    expect(queue.clear().map((e) => e.id)).toEqual(["a", "b"]);
    expect(queue.size).toBe(0);
    vi.advanceTimersByTime(WAIT_MS);
    expect(timedOut).toEqual([]);
  });
});
