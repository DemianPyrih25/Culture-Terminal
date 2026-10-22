import { describe, expect, it } from "vitest";
import { fakeMessage, fakeRefusalDetails, text, thinking, toolUse } from "./fakes";
import { classifyStop, thinkingSummary, toolUses, toRefusal } from "./stop";

describe("toRefusal (smoke check e)", () => {
  it("turns stop_reason refusal with stop_details into a refusal result", () => {
    const message = fakeMessage({
      stop_reason: "refusal",
      stop_details: fakeRefusalDetails({ category: "general_harms", explanation: "Synthetic explanation." }),
      content: [],
    });
    expect(toRefusal(message)).toEqual({
      kind: "refusal",
      category: "general_harms",
      explanation: "Synthetic explanation.",
      partialOutput: false,
    });
  });

  it("branches on stop_reason, not stop_details, which may be null on a refusal", () => {
    expect(toRefusal(fakeMessage({ stop_reason: "refusal", stop_details: null }))).toEqual({
      kind: "refusal",
      category: null,
      explanation: null,
      partialOutput: false,
    });
  });

  it("marks a mid-stream refusal as partial output, to be discarded", () => {
    const message = fakeMessage({ stop_reason: "refusal", stop_details: fakeRefusalDetails(), content: [text("Partial answer")] });
    expect(toRefusal(message)?.partialOutput).toBe(true);
  });

  it("is null for every other stop reason, even when stop_details is present", () => {
    for (const stop_reason of ["end_turn", "tool_use", "max_tokens", "pause_turn"] as const) {
      expect(toRefusal(fakeMessage({ stop_reason, stop_details: fakeRefusalDetails() }))).toBeNull();
    }
  });

  it("accepts a GA (non-beta) message shape, as the CLERK's messages.parse returns", () => {
    const gaMessage = { stop_reason: "refusal", stop_details: { category: "bio" as const, explanation: null }, content: [] };
    expect(toRefusal(gaMessage)?.category).toBe("bio");
  });
});

describe("classifyStop", () => {
  it("puts refusal first, even when the content holds a tool_use cut off mid-input", () => {
    const message = fakeMessage({ stop_reason: "refusal", content: [toolUse("t1", "peer_landscape", {})] });
    expect(classifyStop(message).kind).toBe("refusal");
  });

  it("reports pause_turn so the loop continues", () => {
    expect(classifyStop(fakeMessage({ stop_reason: "pause_turn" }))).toEqual({ kind: "pause_turn" });
  });

  it("separates max_tokens with a pending tool_use from plain truncated text", () => {
    const pending = fakeMessage({ stop_reason: "max_tokens", content: [thinking("…"), toolUse("t1", "submit_report", {})] });
    expect(classifyStop(pending)).toEqual({ kind: "max_tokens_pending_tool", pendingTools: ["submit_report"] });
    expect(classifyStop(fakeMessage({ stop_reason: "max_tokens", content: [text("cut")] }))).toEqual({ kind: "max_tokens" });
  });

  it("passes tool_use, end_turn and unknown reasons through", () => {
    expect(classifyStop(fakeMessage({ stop_reason: "tool_use" })).kind).toBe("tool_use");
    expect(classifyStop(fakeMessage({ stop_reason: "end_turn" })).kind).toBe("end_turn");
    expect(classifyStop(fakeMessage({ stop_reason: "model_context_window_exceeded" }))).toEqual({
      kind: "other",
      stopReason: "model_context_window_exceeded",
    });
  });
});

describe("content helpers", () => {
  it("counts thinking blocks and keeps only non-empty ones as updates", () => {
    const message = fakeMessage({ content: [thinking(""), thinking("Mapping peers next."), text("ok"), thinking("  ")] });
    expect(thinkingSummary(message)).toEqual({ blocks: 3, nonEmpty: 1, texts: ["Mapping peers next."] });
  });

  it("lists tool_use blocks in order", () => {
    const message = fakeMessage({ content: [text("a"), toolUse("t1", "submit_plan", {}), toolUse("t2", "peer_landscape", {})] });
    expect(toolUses(message).map((u) => u.id)).toEqual(["t1", "t2"]);
  });
});
