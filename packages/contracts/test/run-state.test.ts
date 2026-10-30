import { describe, expect, it } from "vitest";
import { applyEvent, applyEvents, initialRunState, queueTimeoutReason, reduceRunEvents, stampEvent, type RunEvent } from "../src/index";
import { RUN_ID, deepFreeze, fullRunInputs, needsInputInput, queuedInput, stampAll, ts } from "./fixtures";

const events = stampAll(fullRunInputs);

describe("applyEvent", () => {
  it("counts a stale call as network: it spent a request before the expired entry was served", () => {
    const base = events.find((e) => e.type === "qloo");
    if (base?.type !== "qloo") throw new Error("the fixture run has no qloo event");
    const s = applyEvents(initialRunState(RUN_ID), [events[0]!, { ...base, cache: "stale" }]);
    expect(s.qloo).toMatchObject({ network: 1, cached: 0, reused: 0 });
    expect(s.qloo.byCache.stale).toBe(1);
  });

  it("starts empty and queued", () => {
    const s = initialRunState(RUN_ID);
    expect(s.lastSeq).toBe(0);
    expect(s.status).toBe("queued");
    expect(s.timeline).toEqual([]);
  });

  it("builds the full run from a complete event sequence", () => {
    const s = reduceRunEvents(RUN_ID, events);

    expect(s.lastSeq).toBe(events.length);
    expect(s.status).toBe("completed");
    expect(s.ended).toEqual({ status: "completed", elapsedMs: 53_000, reason: null });
    expect(s.question).toBe("Is the Juniper Cola audience a moat or a niche?");
    expect(s.mode).toBe("live");
    expect(s.limits?.qlooCalls).toBe(40);
    expect(s.intent?.job).toBe("brand_health");
    expect(s.resolves.map((r) => r.match)).toEqual(["exact", "inexact"]);
    expect(s.plan?.plan.hypotheses).toHaveLength(2);
    expect(s.notes.map((n) => n.text)).toEqual(["Checking the substitution map first."]);

    expect(s.qloo.network).toBe(1);
    expect(s.qloo.cached).toBe(2); // hit + coalesced
    expect(s.qloo.reused).toBe(1);
    expect(s.qloo.byCache).toEqual({ hit: 1, miss: 1, stale: 0, coalesced: 1, reused: 1 });
    expect(s.qloo.chips.map((c) => c.qlooCallId)).toEqual(["q1", "q2", "q3", "q4"]);

    expect(s.toolCalls.map((t) => t.toolCallId)).toEqual(["toolu_fixture_1", "toolu_fixture_2"]);
    const [first, second] = s.toolCalls;
    expect(first).toMatchObject({ status: "ok", ok: true, pivot: false, qlooCallIds: ["q1", "q2", "q3"], stepId: "S1" });
    expect(second).toMatchObject({ status: "partial", pivot: true, triggerFindingId: "F1", qlooCallIds: ["q4"], publicCallIds: ["p1"] });
    expect(first?.publicCallIds).toEqual([]);
    // Public calls cost no Qloo calls: they are counted apart.
    expect(s.publicCalls).toMatchObject({ network: 0, cached: 1, reused: 0 });
    expect(s.publicCalls.chips.map((c) => [c.publicCallId, c.source, c.reference])).toEqual([["p1", "sec", "CIK0000000001"]]);
    expect(s.timeline.find((e) => e.type === "public")?.key).toBe("p1");

    expect(Object.keys(s.metrics).sort()).toEqual(["M1", "M2", "M3"]);
    expect(s.metrics.M3?.value).toBeNull();
    expect(s.evidence.E1?.requestIds).toEqual(["req-fixture-1", "req-fixture-2"]);
    expect(s.datasets.D1?.data?.kind).toBe("Matrix");
    expect(s.findings.map((f) => f.id)).toEqual(["F1"]);
    expect(s.fallbacks).toHaveLength(1);
    expect(s.pivots[0]?.triggerFindingId).toBe("F1");
    expect(s.draft?.arguments).toHaveLength(3);
    expect(s.validation?.numbersTraced).toEqual({ traced: 3, total: 3 });
    expect(s.report?.receipt.qlooNetwork).toBe(1);
    expect(s.ghost?.diff.items).toHaveLength(1);
    expect(s.usage?.llmUsd).toBe(0.18);
    expect(s.errors.map((e) => e.code)).toEqual(["qloo_rate_limited"]);
    expect(s.timeline.map((e) => e.seq)).toEqual(events.map((e) => e.seq));
    expect(s.timeline.find((e) => e.type === "qloo")?.key).toBe("q1");
  });

  it("returns the same reference for a duplicate event", () => {
    const once = applyEvent(initialRunState(RUN_ID), events[0] as RunEvent);
    expect(applyEvent(once, events[0] as RunEvent)).toBe(once);
  });

  it("is idempotent over a replayed sequence", () => {
    const s = reduceRunEvents(RUN_ID, events);
    expect(applyEvents(s, events)).toBe(s);
    for (const e of events) expect(applyEvent(s, e)).toBe(s);
  });

  it("ignores out-of-order events", () => {
    const [e1, e2, e3] = events as [RunEvent, RunEvent, RunEvent];
    const s13 = applyEvents(initialRunState(RUN_ID), [e1, e3]);
    expect(s13.lastSeq).toBe(3);
    expect(applyEvent(s13, e2)).toBe(s13);
    expect(s13.intent).toBeNull(); // e2 (clerk) never applied
  });

  it("ignores events for another run", () => {
    const s = initialRunState(RUN_ID);
    const other = stampEvent(fullRunInputs[0]!, { seq: 1, ts: ts(1), runId: "run-other" });
    expect(applyEvent(s, other)).toBe(s);
  });

  it("does not double-count when the same events arrive twice interleaved", () => {
    const doubled = events.flatMap((e) => [e, e]);
    expect(reduceRunEvents(RUN_ID, doubled)).toEqual(reduceRunEvents(RUN_ID, events));
  });

  it("never mutates its input state or events", () => {
    const frozenEvents = deepFreeze(stampAll(fullRunInputs));
    let s = deepFreeze(initialRunState(RUN_ID));
    for (const e of frozenEvents) s = deepFreeze(applyEvent(s, e));
    expect(s.lastSeq).toBe(frozenEvents.length);
  });

  it("produces plain JSON state", () => {
    const s = reduceRunEvents(RUN_ID, events);
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it("stays queued with its place while it waits, and drops the place when it starts", () => {
    const seq = stampAll([
      fullRunInputs[0]!,
      queuedInput,
      { type: "run.queued", position: 1, ahead: 0, waitSMax: 90 },
      fullRunInputs[1]!,
      { type: "run.queued", position: 1, ahead: 0, waitSMax: 80 },
    ]);
    const states = seq.reduce<ReturnType<typeof initialRunState>[]>(
      (acc, e) => [...acc, applyEvent(acc[acc.length - 1] ?? initialRunState(RUN_ID), e)],
      [],
    );
    expect(states.map((s) => s.status)).toEqual(["queued", "queued", "queued", "running", "running"]);
    expect(states[1]?.queue).toEqual({ position: 2, ahead: 1, waitSMax: 120, at: ts(2) });
    expect(states[2]?.queue).toMatchObject({ position: 1, waitSMax: 90 });
    expect(states[3]?.queue).toBeNull();
    expect(states[4]?.queue).toBeNull();
  });

  it("ends a run that timed out in the queue without ever running", () => {
    const s = reduceRunEvents(
      RUN_ID,
      stampAll([
        fullRunInputs[0]!,
        queuedInput,
        { type: "error", code: "queue_timeout", message: "No slot came free.", retryable: true },
        { type: "run.end", status: "failed", elapsedMs: 120_000, reason: queueTimeoutReason(120) },
      ]),
    );
    expect(s.status).toBe("failed");
    expect(s.queue).toBeNull();
    expect(s.ended?.reason).toContain("120 s");
  });

  it("moves queued → running → needs_input and ends with run.end", () => {
    const seq = stampAll([
      fullRunInputs[0]!,
      fullRunInputs[1]!,
      needsInputInput,
      { type: "run.end", status: "needs_input", elapsedMs: 1500, reason: "primary mention is ambiguous" },
    ]);
    const states = seq.reduce<ReturnType<typeof initialRunState>[]>(
      (acc, e) => [...acc, applyEvent(acc[acc.length - 1] ?? initialRunState(RUN_ID), e)],
      [],
    );
    expect(states.map((s) => s.status)).toEqual(["queued", "running", "needs_input", "needs_input"]);
    const last = states[states.length - 1];
    expect(last?.needsInput?.candidates.map((c) => c.key)).toEqual(["c1", "c2"]);
    expect(last?.ended?.status).toBe("needs_input");
  });

  it("creates a tool call when a replay starts after its tool.start", () => {
    const end = fullRunInputs.find((e) => e.type === "tool.end")!;
    const s = applyEvent(initialRunState(RUN_ID), stampEvent(end, { seq: 9, ts: ts(9), runId: RUN_ID }));
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0]).toMatchObject({ toolCallId: "toolu_fixture_1", status: "ok", startedSeq: null, endedSeq: 9 });
  });

  it("keeps the terminal status once the run has ended", () => {
    const s = reduceRunEvents(RUN_ID, events);
    const late = stampEvent({ type: "note", text: "late" }, { seq: events.length + 1, ts: ts(99), runId: RUN_ID });
    const after = applyEvent(s, late);
    expect(after).not.toBe(s);
    expect(after.status).toBe("completed");
  });

  it("keeps the first run.end when a second one arrives", () => {
    const s = reduceRunEvents(RUN_ID, events);
    const orphan = stampEvent(
      { type: "run.end", status: "incomplete", elapsedMs: 120_000, reason: "server stopped" },
      { seq: events.length + 1, ts: ts(99), runId: RUN_ID },
    );
    const after = applyEvent(s, orphan);
    expect(after).not.toBe(s);
    expect(after.lastSeq).toBe(events.length + 1);
    expect(after.status).toBe("completed");
    expect(after.ended).toEqual(s.ended);
  });
});
