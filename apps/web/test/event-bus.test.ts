import { describe, expect, it, vi } from "vitest";
import { stampEvent } from "@ct/contracts";
import { EventBus } from "../server/event-bus";

vi.mock("server-only", () => ({}));

const note = (runId: string, seq: number) =>
  stampEvent({ type: "note", text: "n" }, { seq, ts: new Date(Date.UTC(2026, 0, 1)).toISOString(), runId });

describe("EventBus", () => {
  it("delivers events to the run's subscribers only", () => {
    const bus = new EventBus();
    const a: number[] = [];
    const b: number[] = [];
    bus.subscribe("run-a", { onEvent: (e) => a.push(e.seq) });
    bus.subscribe("run-b", { onEvent: (e) => b.push(e.seq) });
    bus.publish(note("run-a", 1));
    bus.publish(note("run-b", 7));
    expect(a).toEqual([1]);
    expect(b).toEqual([7]);
  });

  it("unsubscribes, survives a failing subscriber and signals close", () => {
    const bus = new EventBus();
    const seen: number[] = [];
    let closed = 0;
    bus.subscribe("run-a", {
      onEvent: () => {
        throw new Error("boom");
      },
    });
    const off = bus.subscribe("run-a", { onEvent: (e) => seen.push(e.seq), onClose: () => closed++ });
    bus.publish(note("run-a", 1));
    bus.close("run-a");
    off();
    bus.publish(note("run-a", 2));
    expect(seen).toEqual([1]);
    expect(closed).toBe(1);
    expect(bus.subscriberCount("run-a")).toBe(1);
  });
});
