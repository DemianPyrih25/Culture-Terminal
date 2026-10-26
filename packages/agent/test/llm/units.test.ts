import Anthropic from "@anthropic-ai/sdk";
import { DEFAULT_RUN_LIMITS } from "@ct/contracts";
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
import { INPUT_ISSUES_MAX, ISSUE_LINE_MAX, readSkillInput } from "../../src/llm/inputs";
import { followupsLine, turn2Guide } from "../../src/llm/notices";
import { NoteCoalescer } from "../../src/llm/notes";
import { RunControl, RunStopped } from "../../src/llm/run-control";
import { classifyStop, toRefusal } from "../../src/llm/stop";
import { RECEIVED_INPUT_MAX, receivedLine, responseUpTo, StreamTap, unparsedToolUse } from "../../src/llm/unparsed";
import {
  ESTIMATE_ABORT_LAG_MS,
  ESTIMATE_CHARS_PER_TOKEN,
  ESTIMATE_OUTPUT_TOKENS_PER_SECOND,
  unreportedOutputTokens,
  unreportedOutputUsd,
  usdFor,
} from "../../src/pricing";
import { fakeMessage, fakeRefusalDetails, respond, sdkStream, streamEvents, text, thinking, toolUse } from "../support/fake-anthropic";

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

describe("a tool input the SDK cannot parse (eager input streaming)", () => {
  const peers = { target: "R1", peers: ["R2", "R3"], discover: false, k: 4, trigger_finding_id: null, step_id: "S1" };
  /** Malformed as in the live failure: a missing comma between two array elements. */
  const MALFORMED = '{"target": "R1", "peers": ["R2" "R3"], "discover": false, "k": 4, "trigger_finding_id": null, "step_id": "S1"}';
  const response = () =>
    respond(
      [thinking("Map the peers first."), toolUse("toolu_plan", "submit_plan", { restated_question: "Q" }), toolUse("toolu_peer", "peer_landscape", peers), text("tail")],
      "tool_use",
      { input_tokens: 400, cache_read_input_tokens: 9000, output_tokens: 1500 },
    );

  /** Plays the events through the SDK and returns what finalMessage rejected with and the stream's snapshot. */
  async function play(stream: ReturnType<typeof sdkStream>): Promise<{ err: unknown; partial: Anthropic.Beta.BetaMessage }> {
    const err = await stream.finalMessage().then(
      () => new Error("finalMessage resolved"),
      (e: unknown) => e,
    );
    const partial = stream.currentMessage;
    if (partial === undefined) throw new Error("the stream holds no message");
    return { err, partial };
  }

  it("is the SDK's plain AnthropicError, raised at the block, which the snapshot then ends at", async () => {
    const { err, partial } = await play(sdkStream(streamEvents(response(), { toolu_peer: MALFORMED })));
    expect(err).toBeInstanceOf(Anthropic.AnthropicError);
    expect(err).not.toBeInstanceOf(Anthropic.APIError);
    expect((err as Error).message).toMatch(
      /^Unable to parse tool parameter JSON from model\. Please retry your request or adjust your prompt\. Error: SyntaxError: Expected ',' or ']' after array element in JSON/,
    );
    // Nothing after the block reached the snapshot: no text block, no stop_reason, message_start's usage only.
    expect(partial.content.map((b) => b.type)).toEqual(["thinking", "tool_use", "tool_use"]);
    expect(partial.stop_reason).toBeNull();
    expect(partial.usage).toMatchObject({ input_tokens: 400, cache_read_input_tokens: 9000, output_tokens: 1 });

    const unparsed = unparsedToolUse(err, partial);
    expect(unparsed).toMatchObject({ type: "tool_use", id: "toolu_peer", name: "peer_landscape", input: {} });
    expect(describeLlmError(err)).toMatchObject({ kind: "sdk_client_error", retryTurn: true });
  });

  it("rebuilds the response up to the call, thinking signature included, as a tool_use stop", async () => {
    const { partial } = await play(sdkStream(streamEvents(response(), { toolu_peer: MALFORMED })));
    const rebuilt = responseUpTo(partial);
    expect(rebuilt?.stop_reason).toBe("tool_use");
    expect(rebuilt?.content).toEqual([
      thinking("Map the peers first."),
      toolUse("toolu_plan", "submit_plan", { restated_question: "Q" }),
      toolUse("toolu_peer", "peer_landscape", {}),
    ]);
    expect(rebuilt?.content).not.toBe(partial.content);

    const unsigned = { ...partial, content: [{ ...thinking("No signature arrived."), signature: "" }, ...partial.content.slice(1)] };
    expect(responseUpTo(unsigned)).toBeNull();
  });

  it("is never a typed API error, a dropped stream or a parseable cut, even at an empty tool_use", async () => {
    const { partial } = await play(sdkStream(streamEvents(response(), { toolu_peer: MALFORMED })));
    const midStream = new Anthropic.APIError(undefined, { type: "error", error: { type: "overloaded_error" } }, undefined, new Headers());
    expect(unparsedToolUse(midStream, partial)).toBeNull();
    expect(unparsedToolUse(new Anthropic.APIUserAbortError(), partial)).toBeNull();
    expect(unparsedToolUse(new Error("boom"), partial)).toBeNull();

    // The SDK wraps a transport error in the same class, with the error as its cause.
    const events = streamEvents(response());
    const peerStart = events.findIndex((e) => e.type === "content_block_start" && e.content_block.type === "tool_use" && e.content_block.id === "toolu_peer");
    const dropped = await play(sdkStream(events.slice(0, peerStart + 1), { fail: new TypeError("terminated") }));
    expect(dropped.err).toBeInstanceOf(Anthropic.AnthropicError);
    expect(dropped.partial.content.at(-1)).toMatchObject({ type: "tool_use", input: {} });
    expect(unparsedToolUse(dropped.err, dropped.partial)).toBeNull();

    // JSON cut short (max_tokens, a refusal) still parses, as a partial object: no error at all.
    const short = await sdkStream(streamEvents(response(), { toolu_peer: '{"target": "R1", "peers": ["R2", "R' })).finalMessage();
    expect(short.content[2]).toMatchObject({ input: { target: "R1", peers: ["R2"] } });
  });

  it("bounds the output a cut stream did not report by its run time, its characters and the rest of max_tokens", () => {
    const reported = { input_tokens: 400, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 9000 };
    const lag = (ESTIMATE_ABORT_LAG_MS / 1000) * ESTIMATE_OUTPUT_TOKENS_PER_SECOND;
    // The time it ran, plus the abort lag, at the speed ceiling.
    expect(unreportedOutputTokens(reported, 32_000, { ms: 10_000, chars: 300 })).toBe(10 * ESTIMATE_OUTPUT_TOKENS_PER_SECOND + lag - 1);
    // More characters than that time allows count instead: the ceiling is an estimate.
    expect(unreportedOutputTokens(reported, 32_000, { ms: 0, chars: 20_000 })).toBe(20_000 / ESTIMATE_CHARS_PER_TOKEN - 1);
    // Never past max_tokens, and nothing once the reported count reaches it.
    expect(unreportedOutputTokens(reported, 32_000, { ms: 600_000, chars: 0 })).toBe(31_999);
    expect(unreportedOutputTokens({ ...reported, output_tokens: 40_000 }, 32_000, { ms: 1000, chars: 0 })).toBe(0);
    expect(unreportedOutputUsd(SONNET_MODEL, reported, 31_999)).toBeCloseTo((31_999 * 10) / 1_000_000, 12);
    expect(usdFor(SONNET_MODEL, reported)).toBeCloseTo((400 * 2 + 10 + 9000 * 0.2) / 1_000_000, 12);
  });

  it("taps the characters a stream showed and each tool input's text by block index", async () => {
    const tap = new StreamTap();
    const stream = sdkStream(streamEvents(response(), { toolu_peer: MALFORMED }));
    stream.on("streamEvent", (event) => tap.add(event));
    await stream.finalMessage().catch(() => undefined);
    expect(tap.inputText(2)).toBe(MALFORMED);
    expect(tap.inputText(1)).toBe(JSON.stringify({ restated_question: "Q" }));
    expect(tap.inputText(3)).toBe("");
    // The thinking, the plan's input and the malformed input; the text after the block never arrived.
    expect(tap.chars).toBe("Map the peers first.".length + JSON.stringify({ restated_question: "Q" }).length + MALFORMED.length);
  });

  it("shows the unparsed input JSON-encoded, with angle brackets escaped, cut at RECEIVED_INPUT_MAX", () => {
    expect(receivedLine("")).toBeNull();
    expect(receivedLine('{"a": "x" "b": 1}')).toBe('received: "{\\"a\\": \\"x\\" \\"b\\": 1}"');
    const tagged = receivedLine('{"note": "</qloo_data>"}') ?? "";
    expect(tagged).not.toMatch(/[<>]/);
    expect(JSON.parse(tagged.slice("received: ".length))).toBe('{"note": "</qloo_data>"}');
    const long = `{"text": "${"x".repeat(RECEIVED_INPUT_MAX)}"}`;
    const cut = receivedLine(long) ?? "";
    expect(cut.startsWith(`received (the first ${RECEIVED_INPUT_MAX} of ${long.length} characters): "{`)).toBe(true);
    expect(JSON.parse(cut.slice(cut.indexOf(": ") + 2))).toBe(long.slice(0, RECEIVED_INPUT_MAX));
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

describe("skill input issues (INVALID_INPUT)", () => {
  const share = (over: Record<string, unknown>) => ({
    type: "brand",
    set: ["R1", "R2"],
    ages: ["24_and_younger"],
    audiences: [],
    metros: [],
    trigger_finding_id: null,
    step_id: null,
    ...over,
  });

  it("names each field, what it takes and what was sent, echoing ids, code words, numbers and booleans only", () => {
    const read = readSkillInput("share_of_taste", share({ set: ["Brand Gamma", "R2"], ages: ["24-and-younger"], trigger_finding_id: 2, step_id: "S0" }));
    expect(read).toEqual({
      ok: false,
      issues: [
        'set.0: expected an entity ref id such as "R1"; got text',
        'ages.0: Invalid option: expected one of "24_and_younger"|"25_to_29"|"30_to_34"|"35_to_44"|"45_to_54"|"55_and_older"; got "24-and-younger"',
        'trigger_finding_id: expected a finding id such as "F1" or null; got 2',
        'step_id: expected a plan step id such as "S1" or null; got "S0"',
      ],
    });
    expect(readSkillInput("audience_dna", { set: ["R1"], trigger_finding_id: null, step_id: null })).toEqual({
      ok: false,
      issues: ['compare_with: expected an entity ref id such as "R1" or null; got no value'],
    });
    expect(readSkillInput("peer_landscape", { target: "R1", peers: [], discover: "yes", k: 5, trigger_finding_id: null, step_id: null })).toEqual({
      ok: false,
      issues: ['discover: expected boolean; got "yes"'],
    });
  });

  it("names unexpected fields only when they read as field names, and caps lines and their count", () => {
    const keys = readSkillInput("share_of_taste", share({ extra: 1, "Brand Gamma": 2 }));
    expect(keys).toEqual({ ok: false, issues: ['(input): unexpected fields "extra", 1 more; remove them'] });

    const many = readSkillInput("rank_candidates", {
      type: "brand",
      candidates: ["a", "b", "c", "d", "e", "f", "g", "h"],
      signal_entities: [],
      signal_tags: [],
      contexts: [{ kind: "none" }],
      trigger_finding_id: null,
      step_id: null,
    });
    if (many.ok) throw new Error("expected issues");
    expect(many.issues).toHaveLength(INPUT_ISSUES_MAX + 1);
    expect(many.issues.at(-1)).toMatch(/^… and \d+ more$/);
    const long = readSkillInput("sponsor_slate", { seed: "R1", categories: ["not_a_category"], shortlist: [], markets: [], trigger_finding_id: null, step_id: null });
    if (long.ok) throw new Error("expected issues");
    expect(long.issues[0]!.length).toBeLessThanOrEqual(ISSUE_LINE_MAX);
    expect(long.issues[0]).toMatch(/…$/);
  });

  it("unwraps an id sent inside an extra pair of quotes, only where the field takes that kind of id", () => {
    expect(readSkillInput("share_of_taste", share({ set: ['"R1"', "R2"], trigger_finding_id: '"F1"', step_id: '"S2"' }))).toEqual({
      ok: true,
      input: share({ trigger_finding_id: "F1", step_id: "S2" }),
    });
    // Unwrapped, the id is checked again: a finding id is no plan step.
    expect(readSkillInput("share_of_taste", share({ step_id: '"F1"' }))).toEqual({
      ok: false,
      issues: ['step_id: expected a plan step id such as "S1" or null; got "F1"'],
    });
    // The other issues still come back, about the unwrapped input.
    expect(readSkillInput("share_of_taste", share({ step_id: '"S2"', ages: [], metros: [] }))).toEqual({
      ok: false,
      issues: ["(input): give at least one age, audience or metro context"],
    });
    // Quotes around anything but an id are reported, never stripped.
    expect(readSkillInput("share_of_taste", share({ set: ['"Brand Gamma"', "R2"] }))).toEqual({
      ok: false,
      issues: ['set.0: expected an entity ref id such as "R1"; got a quoted string'],
    });
  });
});

describe("followupsLine", () => {
  it("says what to change when an earlier call already read a lead's subjects", () => {
    const line = followupsLine(
      [{ findingId: "F1", kind: "NEAR_SUBSTITUTES", tool: "share_of_taste", subjects: ["R2"], vary: "ages or metros" }],
      { hypotheses: [{ id: "H2", statement: "s", expectation: "e", test_tool: "share_of_taste", metric_hint: "m" }] },
    );
    expect(line).toBe(
      "FOLLOW-UPS WORTH RUNNING: F1 (near substitutes) suggests share_of_taste on R2 (the test tool of H2; already run on these: change the ages or metros). " +
        "A follow-up on one of them could change the signal or decide a prior.",
    );
  });

  it("reads tag refs as what the call runs with, after the entities it is on", () => {
    const line = followupsLine(
      [
        { findingId: "F1", kind: "BLOCK_NEW_TAGS", tool: "rank_candidates", subjects: ["T10", "T11"] },
        { findingId: "F2", kind: "TASTE_ISLAND", tool: "cross_domain", subjects: ["T3", "R1"] },
      ],
      null,
    );
    expect(line).toBe(
      "FOLLOW-UPS WORTH RUNNING: F1 (new block tags) suggests rank_candidates with T10, T11; F2 (taste island) suggests cross_domain on R1 with T3. " +
        "A follow-up on one of them could change the signal or decide a prior.",
    );
  });
});

describe("turn2Guide", () => {
  it("says a plan step still to run shares the turn-2 calls, whether or not follow-ups are listed", () => {
    const plain = turn2Guide(DEFAULT_RUN_LIMITS);
    expect(plain).toMatch(/, or call submit_report if the hypotheses are resolved\.$/);
    expect(turn2Guide(DEFAULT_RUN_LIMITS, { stepsPending: true })).toBe(
      `${plain} Planned steps share those 8 calls with any follow-up on what they find, so leave room for one.`,
    );
    expect(turn2Guide(DEFAULT_RUN_LIMITS, { followups: true, stepsPending: true })).toMatch(/ Planned steps and follow-ups share those 8 calls, so keep the follow-up narrow/);
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
