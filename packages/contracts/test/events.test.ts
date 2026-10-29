import { describe, expect, it } from "vitest";
import {
  encodeSseEvent,
  parseRunEvent,
  RUN_EVENT_TYPES,
  RunEvent,
  RunEventInput,
  safeParseRunEvent,
  stampEvent,
  unstampEvent,
} from "../src/index";
import { RUN_ID, fullRunInputs, needsInputInput, stampAll, ts } from "./fixtures";

const allInputs = [...fullRunInputs, needsInputInput];

describe("RunEvent", () => {
  it("covers exactly the protocol's event types", () => {
    const unionTypes = RunEvent.options.map((o) => o.shape.type.value).sort();
    expect(unionTypes).toEqual([...RUN_EVENT_TYPES].sort());
    expect(new Set(RUN_EVENT_TYPES).size).toBe(23);
  });

  it("has a fixture for every event type", () => {
    expect(new Set(allInputs.map((e) => e.type))).toEqual(new Set(RUN_EVENT_TYPES));
  });

  it.each(RUN_EVENT_TYPES)("parses a %s event, as an object and as SSE JSON text", (type) => {
    const input = allInputs.find((e) => e.type === type)!;
    const event = stampEvent(input, { seq: 7, ts: ts(7), runId: RUN_ID });
    expect(parseRunEvent(event)).toEqual(event);
    expect(parseRunEvent(JSON.stringify(event))).toEqual(event);
    expect(RunEventInput.parse(input)).toEqual(input);
  });

  it("parses a whole stamped run", () => {
    for (const e of stampAll(fullRunInputs)) expect(RunEvent.safeParse(e).success).toBe(true);
  });

  it("rejects bad envelopes and unknown types", () => {
    const good = stampEvent({ type: "note", text: "x" }, { seq: 1, ts: ts(1), runId: RUN_ID });
    expect(safeParseRunEvent({ ...good, seq: 0 }).success).toBe(false);
    expect(safeParseRunEvent({ ...good, seq: 1.5 }).success).toBe(false);
    expect(safeParseRunEvent({ ...good, ts: "yesterday" }).success).toBe(false);
    expect(safeParseRunEvent({ ...good, runId: "" }).success).toBe(false);
    expect(safeParseRunEvent({ ...good, type: "tool.progress" }).success).toBe(false);
    expect(safeParseRunEvent("{not json").success).toBe(false);
  });

  it("rejects a resolve entry that applies a non-exact match", () => {
    const resolve = fullRunInputs.find((e) => e.type === "resolve")!;
    if (resolve.type !== "resolve") throw new Error("fixture");
    const bad = { ...resolve, entities: [{ ...resolve.entities[1]!, ref: "R9" }] };
    expect(RunEventInput.safeParse(bad).success).toBe(false);
  });

  it("round-trips the envelope", () => {
    const event = stampEvent(fullRunInputs[0]!, { seq: 3, ts: ts(3), runId: RUN_ID });
    const { envelope, input } = unstampEvent(event);
    expect(envelope).toEqual({ seq: 3, ts: ts(3), runId: RUN_ID });
    expect(input).toEqual(fullRunInputs[0]);
  });

  it("encodes one SSE frame with the seq as id and no named event", () => {
    const event = stampEvent({ type: "note", text: "line one\nline two" }, { seq: 12, ts: ts(12), runId: RUN_ID });
    const frame = encodeSseEvent(event);
    expect(frame.startsWith("id: 12\ndata: ")).toBe(true);
    expect(frame.endsWith("\n\n")).toBe(true);
    expect(frame.split("\n")).toHaveLength(4); // the payload's newline is escaped inside one data line
    expect(frame).not.toMatch(/^event:/m);
    expect(parseRunEvent(frame.slice("id: 12\ndata: ".length).trim())).toEqual(event);
  });
});
