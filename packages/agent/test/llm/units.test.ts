import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANALYST_CONFIGS,
  ANALYST_MODELS,
  CLERK_MODEL,
  createAnthropic,
  HAIKU_MODEL,
  SONNET_MODEL,
  type AnthropicLike,
} from "../../src/anthropic";
import { describeLlmError } from "../../src/llm/errors";
import { NoteCoalescer } from "../../src/llm/notes";
import { RunControl, RunStopped } from "../../src/llm/run-control";
import { classifyStop, toRefusal } from "../../src/llm/stop";
import { fakeMessage, fakeRefusalDetails, text, thinking, toolUse } from "../support/fake-anthropic";

afterEach(() => {
  vi.useRealTimers();
});

describe("models and client (D22, D23)", () => {
  it("uses Haiku 5.5 for the CLERK and Sonnet 5.5 or Haiku 5.5 for the ANALYST, never Opus", () => {
    expect(CLERK_MODEL).toBe(HAIKU_MODEL);
    expect(ANALYST_MODELS).toEqual({ live: SONNET_MODEL, economy: HAIKU_MODEL });
    const models: string[] = [CLERK_MODEL, ...Object.values(ANALYST_CONFIGS).map((c) => c.model)];
    expect(models.some((m) => m.includes("opus"))).toBe(false);
  });

  it("creates an SDK client that satisfies AnthropicLike, with three retries and a 120 s timeout", () => {
    const client = createAnthropic("sk-test-not-a-real-key");
    const like: AnthropicLike = client;
    expect(like).toBe(client);
    expect(client.maxRetries).toBe(3);
    expect(client.timeout).toBe(120_000);
  });

  it("refuses an empty key", () => {
    expect(() => createAnthropic("  ")).toThrow(/empty/);
  });
});

describe("stop classification", () => {
  it("puts refusal first, even with a tool_use cut off mid-input, and keeps null stop_details", () => {
    const message = fakeMessage({ stop_reason: "refusal", content: [toolUse("t1", "peer_landscape", {})] });
    expect(classifyStop(message)).toEqual({ kind: "refusal", refusal: { category: null, explanation: null, partialOutput: true } });
  });

  it("is not a refusal for any other stop reason, even with stop_details present", () => {
    for (const stop_reason of ["end_turn", "tool_use", "max_tokens", "pause_turn"] as const) {
      expect(toRefusal(fakeMessage({ stop_reason, stop_details: fakeRefusalDetails() }))).toBeNull();
    }
  });

  it("separates max_tokens with a pending tool_use from plain truncated text", () => {
    const pending = fakeMessage({ stop_reason: "max_tokens", content: [thinking("…"), toolUse("t1", "submit_report", {})] });
    expect(classifyStop(pending)).toEqual({ kind: "max_tokens_pending_tool", pendingTools: ["submit_report"] });
    expect(classifyStop(fakeMessage({ stop_reason: "max_tokens", content: [text("cut")] }))).toEqual({ kind: "proceed", stopReason: "max_tokens" });
    expect(classifyStop(fakeMessage({ stop_reason: "pause_turn" }))).toEqual({ kind: "pause_turn" });
  });
});

describe("error classification", () => {
  it("keeps typed SDK errors apart, most specific first", () => {
    expect(describeLlmError(new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers()))).toMatchObject({ kind: "authentication", retryable: false });
    expect(describeLlmError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ kind: "timeout", retryable: true, maybeBilled: true });
    expect(describeLlmError(new Anthropic.APIUserAbortError())).toMatchObject({ kind: "aborted", retryTurn: false });
    expect(describeLlmError(new Anthropic.AnthropicError("bad JSON"))).toMatchObject({ kind: "sdk_client_error", retryTurn: true });
    expect(describeLlmError(new Error("boom"))).toMatchObject({ kind: "unexpected", retryTurn: false });
  });

  it("bills an HTTP 5xx answered before any stream as nothing, and a status-less mid-stream error as maybe", () => {
    for (const status of [500, 529]) {
      const err = new Anthropic.InternalServerError(status, { type: "error" }, "overloaded", new Headers());
      expect(describeLlmError(err)).toMatchObject({ kind: "server_error", status, retryable: true, maybeBilled: false });
    }
    const midStream = new Anthropic.APIError(undefined, { type: "error", error: { type: "overloaded_error" } }, undefined, new Headers());
    expect(describeLlmError(midStream)).toMatchObject({ kind: "api_error", status: null, maybeBilled: true });
  });
});

describe("NoteCoalescer", () => {
  it("emits buffered deltas once per 300 ms and separates thinking blocks", () => {
    vi.useFakeTimers();
    const notes: string[] = [];
    const c = new NoteCoalescer((t) => notes.push(t));
    c.push("Mapping ", "Mapping ");
    c.push("peers.", "Mapping peers.");
    vi.advanceTimersByTime(299);
    expect(notes).toEqual([]);
    c.push("Then ages.", "Then ages.");
    vi.advanceTimersByTime(1);
    expect(notes).toEqual(["Mapping peers.\n\nThen ages."]);
    c.push("Last.", "Last.");
    c.flush();
    expect(notes).toEqual(["Mapping peers.\n\nThen ages.", "Last."]);
  });

  it("never emits whitespace-only notes", () => {
    const notes: string[] = [];
    const c = new NoteCoalescer((t) => notes.push(t));
    c.push("  ", "  ");
    c.flush();
    expect(notes).toEqual([]);
  });
});

describe("RunControl", () => {
  it("stops on the deadline and rejects pending work with RunStopped", async () => {
    vi.useFakeTimers();
    const control = new RunControl(undefined, 1000);
    const pending = control.race(new Promise(() => {}));
    vi.advanceTimersByTime(1000);
    await expect(pending).rejects.toBeInstanceOf(RunStopped);
    expect(control.cause).toBe("wall_clock");
    control.dispose();
  });

  it("keeps the first cause and lets settled work through", async () => {
    const controller = new AbortController();
    const control = new RunControl(controller.signal, 60_000);
    await expect(control.race(Promise.resolve(7))).resolves.toBe(7);
    controller.abort();
    control.stop("wall_clock");
    expect(control.cause).toBe("cancelled");
    expect(control.signal.aborted).toBe(true);
    control.dispose();
  });
});
