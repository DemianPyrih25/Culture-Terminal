// R8 (D51): Qloo entity ids stay on the server. The run's qloo and evidence events carry names where the
// requests carried ids; the ledger the server keeps still holds the ids, so receipts can open each request
// by its request id. The mock issues "mock-ent-…" ids (never UUID-shaped, D29), which the scrub replaces
// in entity parameters whatever their shape.
import type { EventInput } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { RunEvents } from "../../src/run/meter";
import { parseAll, planCall, reportWithoutFollowup, respond, run } from "./support";

const MOCK_ID = /mock-ent-[0-9a-f]{12}/;

describe("runAgent: entity ids never leave in events", () => {
  it("scrubs qloo and evidence events at emission, keeps request ids, and leaves the server's ledger whole", async () => {
    const { result, events } = await run({ stream: [respond([planCall()]), ...reportWithoutFollowup()] });
    expect(result.status).toBe("completed");
    parseAll(events);
    const qloo = events.filter((e) => e.type === "qloo");
    const evidence = events.filter((e) => e.type === "evidence");
    expect(qloo.length).toBeGreaterThan(0);
    expect(evidence.length).toBeGreaterThan(0);
    expect(JSON.stringify([...qloo, ...evidence])).not.toMatch(MOCK_ID);
    // Names stand in for the ids the requests sent.
    expect(JSON.stringify(qloo)).toContain("«Brand Alpha»");
    // Request ids still identify every call.
    expect(qloo.every((e) => e.type === "qloo" && (e.requestId === null || e.requestId.length > 0))).toBe(true);
    for (const e of evidence) if (e.type === "evidence") expect(e.evidence.requestIds.length).toBe(e.evidence.qlooCallIds.length);
    // The server keeps the ids (qloo_calls, evidence provenance): the ledger the run returns is untouched.
    expect(JSON.stringify(result.ledger.evidence)).toMatch(MOCK_ID);
  });
});

describe("RunEvents.scrubWith", () => {
  it("scrubs only the qloo and evidence events, and only once a name source is set", () => {
    const out: EventInput[] = [];
    const events = new RunEvents((e) => out.push(e));
    const qloo: EventInput = {
      type: "qloo",
      qlooCallId: "qc-1",
      toolCallId: null,
      endpoint: "/v2/insights",
      filterType: "urn:entity:brand",
      paramsRedacted: { "signal.interests.entities": "mock-ent-1aaaaaaaaaaa" },
      cache: "miss",
      ms: 1,
      requestId: "req-1",
      status: 200,
      rows: 3,
      cacheAgeMs: null,
      originRunId: null,
      error: null,
    };
    events.emit(qloo);
    events.scrubWith((id) => (id === "mock-ent-1aaaaaaaaaaa" ? "Brand Alpha" : null));
    events.emit(qloo);
    events.emit({ type: "note", text: "mock-ent-1aaaaaaaaaaa stays in a note: no Qloo parameters live there" });
    expect(out[0]).toEqual(qloo);
    expect(out[1]).toMatchObject({ paramsRedacted: { "signal.interests.entities": "«Brand Alpha»" }, requestId: "req-1" });
    expect(out[2]).toMatchObject({ type: "note" });
  });
});
