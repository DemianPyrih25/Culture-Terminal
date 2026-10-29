import Anthropic from "@anthropic-ai/sdk";
import { ANALYST_TOOL_NAMES, DEFAULT_RUN_LIMITS } from "@ct/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYST_MIN_MAX_TOKENS } from "../../src/analyst";
import { ANALYST_MAX_TOKENS, HAIKU_MODEL, SONNET_MODEL, THINKING_UPDATES_BETA } from "../../src/anthropic";
import { NOTICE_COST, NOTICE_INVALID_JSON, NOTICE_TIME, NUDGE_PLAN, NUDGE_REPORT, TURN3_NOTICE, turn2Guide } from "../../src/llm/notices";
import { promptChars } from "../../src/llm/request";
import { DIRECTOR_PROMPT } from "../../src/prompts";
import {
  ESTIMATE_ABORT_LAG_MS,
  ESTIMATE_OUTPUT_TOKENS_PER_SECOND,
  estimateRequestUsd,
  unreportedOutputUsd,
  usdFor,
} from "../../src/pricing";
import { ManualClock, respond, streamEvents, text, thinking } from "../support/fake-anthropic";
import {
  followUp,
  lastMessage,
  peerCall,
  planCall,
  reportCall,
  resultText,
  runScripted,
  shareCall,
  stepCall,
  SYSTEM_PROMPT,
  textsOf,
  toolResults,
} from "./builders";

/** The worst case the cost guard reserved for request `i`: what an aborted stream is charged. */
const reserved = (h: Awaited<ReturnType<typeof runScripted>>, i: number): number => {
  const req = h.fake.streamRequests[i]!;
  return estimateRequestUsd(req.model, promptChars(req), req.max_tokens);
};

afterEach(() => {
  vi.useRealTimers();
});

describe("the request shape and the cached prefix", () => {
  const steps = () => [respond([planCall(), peerCall()]), respond([followUp()]), respond([reportCall()])];

  it("sends the live ANALYST settings on every request (D22, D23)", async () => {
    const h = await runScripted(steps());
    for (const req of h.fake.streamRequests) {
      expect(req).toMatchObject({
        model: SONNET_MODEL,
        max_tokens: ANALYST_MAX_TOKENS,
        tool_choice: { type: "auto" },
        thinking: { type: "adaptive", display: "updates" },
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        betas: [THINKING_UPDATES_BETA],
      });
      expect(req.system).toEqual([{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }]);
      expect(req).not.toHaveProperty("fallbacks");
      expect(req.output_config).not.toHaveProperty("task_budget");
    }
  });

  it("keeps system and tools byte-identical across requests, sorted, eager-streamed, strict only for submit tools", async () => {
    const h = await runScripted(steps());
    const first = h.fake.streamRequests[0]!;
    const tools = (first.tools ?? []) as Array<{ name: string; strict?: boolean; eager_input_streaming?: boolean }>;
    expect(tools.map((t) => t.name)).toEqual(ANALYST_TOOL_NAMES);
    expect(tools.every((t) => t.eager_input_streaming === true)).toBe(true);
    expect(tools.filter((t) => t.strict).map((t) => t.name)).toEqual(["submit_report"]);
    for (const req of h.fake.streamRequests) {
      expect(JSON.stringify([req.system, req.tools])).toBe(JSON.stringify([first.system, first.tools]));
    }
  });

  it("keeps the history append-only and sends each response back unchanged", async () => {
    const script = steps();
    const h = await runScripted(script);
    const reqs = h.fake.streamRequests;
    for (let i = 1; i < reqs.length; i++) {
      const prev = reqs[i - 1]!.messages;
      const next = reqs[i]!.messages;
      expect(next.length).toBeGreaterThan(prev.length);
      prev.forEach((m, j) => expect(next[j]).toBe(m));
    }
    // Nothing already sent was edited afterwards.
    reqs.forEach((r, i) => expect(JSON.stringify(r)).toBe(h.fake.streamSnapshots[i]));
    // The assistant turn is the response's own content array, thinking signatures included.
    expect(reqs[1]!.messages[1]).toEqual({ role: "assistant", content: script[0]!.content });
    expect(reqs[1]!.messages[1]!.content).toBe(script[0]!.content);
  });

  it("runs the economy ANALYST on Haiku 5.5 without the beta and with summarized thinking", async () => {
    const h = await runScripted(steps(), { model: "economy" });
    const req = h.fake.streamRequests[0]!;
    expect(req.model).toBe(HAIKU_MODEL);
    expect(req).not.toHaveProperty("betas");
    expect(req.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(req.output_config).toEqual({ effort: "medium" });
    expect(h.outcome).toMatchObject({ status: "completed", model: HAIKU_MODEL });
  });

  it("passes the run's abort signal to every stream", async () => {
    const h = await runScripted(steps());
    expect(h.fake.streamSignals.every((s) => s instanceof AbortSignal && !s.aborted)).toBe(true);
  });
});

describe("the response cap (D4)", () => {
  it("never sends more than limits.modelResponses requests", async () => {
    const h = await runScripted([
      respond([peerCall()]),
      respond([planCall("toolu_p1", { bad: true })]),
      respond([planCall(), peerCall()]),
      respond([followUp()]),
      respond([followUp("toolu_late")]),
      respond([reportCall()]),
    ]);
    expect(h.fake.streamRequests).toHaveLength(5);
    expect(h.outcome).toMatchObject({ status: "incomplete", code: "response_limit", responses: 5 });
  });

  it("skips turn 2 when only one response is left", async () => {
    const h = await runScripted([respond([planCall(), peerCall()]), respond([reportCall()])], { limits: { modelResponses: 2 } });
    expect(textsOf(lastMessage(h.fake.streamRequests[1])).at(-1)).toBe(TURN3_NOTICE);
    expect(h.outcome.status).toBe("completed");
  });

  it("counts pause_turn continuations against the cap", async () => {
    const pause = () => respond([thinking("…")], "pause_turn");
    const h = await runScripted([pause(), pause(), pause(), pause(), pause()]);
    expect(h.outcome).toMatchObject({ status: "incomplete", code: "response_limit", responses: 5 });
  });
});

describe("wall clock", () => {
  it("carries the soft nudge on the next message after softMs and holds the rest to turn-3 rules", async () => {
    const clock = new ManualClock();
    const h = await runScripted([respond([planCall(), peerCall()]), respond([reportCall()])], {
      now: clock.now,
      executeTools: async (calls) => {
        clock.advance(125_000);
        return calls.map((c) => ({ tool_use_id: c.id, content: "digest" }));
      },
    });
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))).toEqual([NOTICE_TIME, TURN3_NOTICE]);
    expect(h.outcome).toMatchObject({ status: "completed", nudges: { time: true } });
  });

  it("stops before the next request once hardMs has passed, keeping the plan", async () => {
    const clock = new ManualClock();
    const h = await runScripted([respond([planCall(), peerCall()]), respond([reportCall()])], {
      now: clock.now,
      executeTools: async (calls) => {
        clock.advance(181_000);
        return calls.map((c) => ({ tool_use_id: c.id, content: "digest" }));
      },
    });
    expect(h.fake.streamRequests).toHaveLength(1);
    expect(h.outcome).toMatchObject({ status: "incomplete", code: "wall_clock", reason: "stopped at the hard wall-clock limit of 180 s" });
    expect(h.outcome.plan).not.toBeNull();
  });

  it("aborts a stream still running at 180 s", async () => {
    vi.useFakeTimers();
    const running = runScripted([respond([planCall(), peerCall()]), { hang: true }]);
    await vi.advanceTimersByTimeAsync(179_999);
    let settled = false;
    void running.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(0);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const h = await running;
    expect(h.outcome).toMatchObject({ status: "incomplete", code: "wall_clock", responses: 2, elapsedMs: 180_000 });
    expect(h.fake.streamSignals[1]?.aborted).toBe(true);
    expect(h.outcome.plan).not.toBeNull();
    // The aborted stream may have been billed: its reserved worst case counts as unmetered spend.
    expect(h.outcome.unmeteredUsd).toBeGreaterThan(0);
    expect(h.outcome.unmeteredUsd).toBeCloseTo(reserved(h, 1), 12);
  });

  it("stops waiting on tool execution at the hard limit and aborts the executor's signal", async () => {
    vi.useFakeTimers();
    let toolSignal: AbortSignal | undefined;
    const running = runScripted([respond([planCall(), peerCall()])], {
      executeTools: (_calls, _turn, signal) => {
        toolSignal = signal;
        return new Promise(() => {});
      },
    });
    await vi.advanceTimersByTimeAsync(180_000);
    const h = await running;
    expect(h.outcome).toMatchObject({ status: "incomplete", code: "wall_clock" });
    expect(toolSignal?.aborted).toBe(true);
    // No stream was in flight, and the finished one was metered from its usage.
    expect(h.outcome.unmeteredUsd).toBe(0);
  });

  it("counts from startedAt, so time spent before the ANALYST counts too", async () => {
    const clock = new ManualClock();
    clock.advance(200_000);
    const h = await runScripted([respond([planCall()])], { now: clock.now, startedAt: 0 });
    expect(h.fake.streamRequests).toHaveLength(0);
    expect(h.outcome.code).toBe("wall_clock");
  });
});

describe("cancellation", () => {
  it("cancels a running stream promptly", async () => {
    const controller = new AbortController();
    const running = runScripted([{ hang: true }], { signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    const h = await running;
    expect(h.outcome).toMatchObject({ status: "cancelled", code: "cancelled", responses: 1, usd: 0 });
    expect(h.fake.streamSignals[0]?.aborted).toBe(true);
    expect(h.outcome.unmeteredUsd).toBeGreaterThan(0);
    expect(h.outcome.unmeteredUsd).toBeCloseTo(reserved(h, 0), 12);
  });

  it("sends nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const h = await runScripted([respond([planCall()])], { signal: controller.signal });
    expect(h.fake.streamRequests).toHaveLength(0);
    expect(h.outcome).toMatchObject({ status: "cancelled", unmeteredUsd: 0 });
  });
});

describe("per-run cost", () => {
  // 30000 output tokens on Sonnet 5.5 cost $0.30.
  const expensive = { output_tokens: 30_000 };

  it("sends the wrap-up nudge once spend reaches usdNudge", async () => {
    const h = await runScripted([respond([planCall(), peerCall()], "tool_use", expensive), respond([reportCall()])], { limits: { usdNudge: 0.25 } });
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))).toEqual([NOTICE_COST, TURN3_NOTICE]);
    expect(h.outcome).toMatchObject({ status: "completed", nudges: { cost: true } });
  });

  it("lowers max_tokens so the worst case of the next request stays under usdHard", async () => {
    const h = await runScripted([respond([planCall(), peerCall()], "tool_use", expensive), respond([reportCall()])]);
    const second = h.fake.streamRequests[1]!;
    expect(second.max_tokens).toBeLessThan(ANALYST_MAX_TOKENS);
    expect(second.max_tokens).toBeGreaterThanOrEqual(ANALYST_MIN_MAX_TOKENS);
    expect(h.usages[0]!.usd + estimateRequestUsd(SONNET_MODEL, promptChars(second), second.max_tokens)).toBeLessThanOrEqual(0.6);
    expect(h.outcome.status).toBe("completed");
  });

  it("stops before a request that cannot fit even the minimum max_tokens", async () => {
    const h = await runScripted([respond([planCall(), peerCall()], "tool_use", { output_tokens: 50_000 }), respond([reportCall()])]);
    expect(h.fake.streamRequests).toHaveLength(1);
    expect(h.outcome).toMatchObject({ status: "incomplete", code: "usd_limit", responses: 1 });
  });

  it("sends nothing when usdHard cannot cover the first request", async () => {
    const h = await runScripted([respond([planCall()])], { limits: { usdNudge: 0.01, usdHard: 0.02 } });
    expect(h.fake.streamRequests).toHaveLength(0);
    expect(h.outcome.code).toBe("usd_limit");
  });
});

describe("API and hook failures", () => {
  it("re-issues the turn once after an SDK client error (unparseable eager tool JSON)", async () => {
    const h = await runScripted([{ error: new Anthropic.AnthropicError("Unable to parse tool parameter JSON") }, respond([planCall()]), respond([reportCall()])]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 3 });
    expect(h.outcome.unmeteredUsd).toBeGreaterThan(0);
    const [first, retry] = h.fake.streamRequests;
    expect(JSON.stringify(retry?.messages)).toBe(JSON.stringify(first?.messages));
  });

  it("fails after a second SDK client error", async () => {
    const err = () => ({ error: new Anthropic.AnthropicError("stream ended") });
    const h = await runScripted([err(), err()]);
    expect(h.outcome).toMatchObject({ status: "failed", code: "api_error", responses: 2 });
    expect(h.outcome.error?.kind).toBe("sdk_client_error");
  });

  it("fails on a typed API error after the SDK's own retries", async () => {
    const rateLimited = new Anthropic.RateLimitError(429, { type: "error" }, "rate limited", new Headers());
    const h = await runScripted([{ error: rateLimited }]);
    expect(h.outcome).toMatchObject({ status: "failed", code: "api_error", error: { kind: "rate_limited", status: 429, retryable: true } });
    expect(h.outcome.unmeteredUsd).toBe(0);
  });

  it("charges nothing for a 529 answered before any stream opened, but the worst case for a mid-stream error", async () => {
    const overloaded = new Anthropic.InternalServerError(529, { type: "error" }, "overloaded", new Headers());
    const h = await runScripted([{ error: overloaded }]);
    expect(h.outcome).toMatchObject({ status: "failed", code: "api_error", usd: 0, error: { kind: "server_error", status: 529 } });
    expect(h.outcome.unmeteredUsd).toBe(0);

    const midStream = new Anthropic.APIError(undefined, { type: "error", error: { type: "overloaded_error" } }, undefined, new Headers());
    const cut = await runScripted([{ error: midStream }]);
    expect(cut.outcome).toMatchObject({ status: "failed", code: "api_error", error: { kind: "api_error", status: null } });
    expect(cut.outcome.unmeteredUsd).toBeCloseTo(reserved(cut, 0), 12);
  });

  it("fails with hook_error when executeTools rejects", async () => {
    const h = await runScripted([respond([planCall(), peerCall()])], {
      executeTools: async () => {
        throw new Error("skill registry offline");
      },
    });
    expect(h.outcome).toMatchObject({ status: "failed", code: "hook_error", reason: "executeTools failed: skill registry offline" });
  });

  it("keeps going when an observer throws", async () => {
    const h = await runScripted([respond([thinking("Note."), planCall(), peerCall()]), respond([reportCall()])], {
      onThinking: () => {
        throw new Error("ui down");
      },
      onPlan: () => {
        throw new Error("db down");
      },
    });
    expect(h.outcome.status).toBe("completed");
  });

  it("charges a stream that failed after reporting usage that usage, and only the output it could have generated as an estimate", async () => {
    // An error event mid-stream, after message_start: unlike the case above, its usage is known.
    const clock = new ManualClock();
    const midStream = new Anthropic.APIError(undefined, { type: "error", error: { type: "overloaded_error" } }, undefined, new Headers());
    const partial = respond([thinking("Mapping.")], "tool_use", { input_tokens: 500, cache_read_input_tokens: 12_000, output_tokens: 1 });
    partial.stop_reason = null;
    const h = await runScripted([{ error: midStream, partial, onSend: () => clock.advance(30_000) }], { now: clock.now });
    expect(h.outcome).toMatchObject({ status: "failed", code: "api_error", error: { kind: "api_error" } });
    expect(h.usages).toEqual([{ usd: usdFor(SONNET_MODEL, partial.usage), model: SONNET_MODEL }]);
    expect(h.outcome.usd).toBeCloseTo(usdFor(SONNET_MODEL, partial.usage), 12);
    // 30 s plus the abort lag at the speed ceiling, less the one output token message_start reported.
    const unreported = ((30_000 + ESTIMATE_ABORT_LAG_MS) / 1000) * ESTIMATE_OUTPUT_TOKENS_PER_SECOND - 1;
    expect(h.outcome.unmeteredUsd).toBeCloseTo(unreportedOutputUsd(SONNET_MODEL, partial.usage, unreported), 12);
    expect(h.outcome.usd + h.outcome.unmeteredUsd).toBeLessThan(reserved(h, 0));
    // A failed stream is never read again: its request is aborted.
    expect(h.fake.streamSignals[0]?.aborted).toBe(true);
  });

  it("charges no estimate once message_delta delivered the final usage", async () => {
    const midStream = new Anthropic.APIError(undefined, { type: "error", error: { type: "overloaded_error" } }, undefined, new Headers());
    const partial = respond([thinking("Mapping.")], "end_turn", { input_tokens: 500, output_tokens: 900 });
    const h = await runScripted([{ error: midStream, partial }]);
    expect(h.outcome.usd).toBeCloseTo(usdFor(SONNET_MODEL, partial.usage), 12);
    expect(h.outcome.unmeteredUsd).toBe(0);
  });

  it("ends a turn-2 text reply with the report nudge", async () => {
    const h = await runScripted([respond([planCall(), peerCall()]), respond([text("Thinking aloud.")], "end_turn"), respond([reportCall()])]);
    expect(toolResults(lastMessage(h.fake.streamRequests[2]))).toEqual([]);
    expect(textsOf(lastMessage(h.fake.streamRequests[2]))).toEqual([NUDGE_REPORT]);
  });
});

describe("a tool input that was not valid JSON (eager input streaming, the SDK's own stream)", () => {
  /** share_of_taste's input with the comma between two set refs missing, as in the live failure. */
  const MALFORMED_SHARE =
    '{"type": "brand", "set": ["R1" "R2"], "ages": ["24_and_younger"], "audiences": [], "metros": [], "trigger_finding_id": null, "step_id": "S2"}';
  const MALFORMED_DNA = '{"set": ["R1", "R2"} "compare_with": null, "trigger_finding_id": "F1", "step_id": null}';
  const turnOneUsage = { input_tokens: 300, cache_creation_input_tokens: 9000, output_tokens: 1800 };
  /** Turn 1 as the model wrote it, its last call malformed; the SDK never reads the text after it. */
  const brokenTurnOne = () =>
    streamEvents(
      respond([thinking("Plan, then peers and ages."), planCall(), peerCall(), shareCall(), text("Waiting for the digests.")], "tool_use", turnOneUsage),
      { toolu_share: MALFORMED_SHARE },
    );
  /** message_start's usage: the prompt side, and one output token. */
  const startUsage = () => respond([], "tool_use", { ...turnOneUsage, output_tokens: 1 }).usage;
  const RESEND = "INVALID_JSON: the tool input was not valid JSON; send the call again.";
  const CLOSED = "INVALID_JSON: the tool input was not valid JSON, so it did not run; only submit_report is left.";
  /** The answer to an unparsed call: the code line, then the text it sent, JSON-encoded. */
  const invalidJson = (head: string, raw: string) => `${head}\nreceived: ${JSON.stringify(raw)}`;

  it("answers the call INVALID_JSON with the text it sent, runs the calls before it and keeps the turn going", async () => {
    const h = await runScripted([{ events: brokenTurnOne() }, respond([stepCall("toolu_share_again", "S2")]), respond([reportCall()])]);
    expect(h.outcome).toMatchObject({ status: "completed", code: "report_accepted", responses: 3, error: null });
    expect(h.outcome.repairs).toEqual({ plan: false, report: false, truncated: false, invalidJson: true, input: false, lookup: false });

    // The response goes back as it streamed, up to the unparsed call, whose input is {}.
    const second = h.fake.streamRequests[1]!;
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: [thinking("Plan, then peers and ages."), planCall(), peerCall(), { ...shareCall(), input: {} }],
    });
    const results = toolResults(lastMessage(second));
    expect(results.map((r) => [r.tool_use_id, r.is_error ?? false])).toEqual([
      ["toolu_plan", false],
      ["toolu_peer", false],
      ["toolu_share", true],
    ]);
    expect(resultText(results[2])).toBe(invalidJson(RESEND, MALFORMED_SHARE));
    // S2 never ran in wave 1, so the guide says it shares the turn-2 calls.
    expect(textsOf(lastMessage(second))).toEqual([NOTICE_INVALID_JSON, turn2Guide(DEFAULT_RUN_LIMITS, { stepsPending: true })]);

    // Wave 1 ran without the unparsed call; it ran in turn 2 as the planned step it was.
    expect(h.executed.map((e) => [e.turn, e.calls.map((c) => c.id)])).toEqual([
      [1, ["toolu_peer"]],
      [2, ["toolu_share_again"]],
    ]);
    expect(h.plans).toHaveLength(1);
    expect(h.outcome.rejections).toEqual([{ toolCallId: "toolu_share", tool: "share_of_taste", code: "INVALID_JSON", turn: 1 }]);
    expect(h.toolEnds.find((e) => e.use.id === "toolu_share")).toMatchObject({ ok: false, code: "INVALID_JSON", executed: false });
  });

  it("charges the usage the stream reported and the output it could have generated, and stops the stream", async () => {
    const clock = new ManualClock();
    const h = await runScripted(
      [{ events: brokenTurnOne(), onSend: () => clock.advance(20_000) }, respond([stepCall("toolu_share_again", "S2")]), respond([reportCall()])],
      { now: clock.now },
    );
    expect(h.usages[0]).toEqual({ usd: usdFor(SONNET_MODEL, startUsage()), model: SONNET_MODEL });
    expect(h.outcome.usage.input).toBe(300 + 1000 + 1000);
    // 20 s plus the abort lag at the speed ceiling outweighs the characters the stream showed.
    const unreported = ((20_000 + ESTIMATE_ABORT_LAG_MS) / 1000) * ESTIMATE_OUTPUT_TOKENS_PER_SECOND - 1;
    expect(h.outcome.unmeteredUsd).toBeCloseTo(unreportedOutputUsd(SONNET_MODEL, startUsage(), unreported), 12);
    expect(h.outcome.unmeteredUsd).toBeLessThan(unreportedOutputUsd(SONNET_MODEL, startUsage(), h.fake.streamRequests[0]!.max_tokens) / 2);
    expect(h.fake.streamSignals[0]?.aborted).toBe(true);
    expect(h.fake.streamSignals.slice(1).every((s) => s?.aborted === false)).toBe(true);
  });

  it("repairs a turn-1 call at a live prompt's size and still completes with its pivot, below the cost nudge", async () => {
    // The director prompt, a first message and digests of live size, and usage like a live run's.
    const clock = new ManualClock();
    const h = await runScripted(
      [
        { events: brokenTurnOne(), onSend: () => clock.advance(25_000) },
        respond([stepCall("toolu_share_again", "S2"), followUp()], "tool_use", { input_tokens: 9000, cache_read_input_tokens: 15_000, output_tokens: 3000 }),
        respond([reportCall()], "tool_use", { input_tokens: 4000, cache_read_input_tokens: 24_000, output_tokens: 5000 }),
      ],
      {
        now: clock.now,
        systemPrompt: DIRECTOR_PROMPT,
        firstUserMessage: `RUN CONTEXT (synthetic)\n${"Brand Alpha context. ".repeat(1500)}`,
        executeTools: async (calls) => calls.map((c) => ({ tool_use_id: c.id, content: `<qloo_data>${"digest ".repeat(600)}</qloo_data>` })),
      },
    );
    expect(h.outcome).toMatchObject({ status: "completed", responses: 3, repairs: { invalidJson: true }, nudges: { cost: false } });
    expect(h.pivots).toEqual(["F1"]);
    expect(h.outcome.usd + h.outcome.unmeteredUsd).toBeLessThan(DEFAULT_RUN_LIMITS.usdNudge);
  });

  it("holds wave 1 back when submit_plan itself was not valid JSON, without spending the plan nudge", async () => {
    const plan = streamEvents(respond([peerCall("toolu_early"), planCall("toolu_bad_plan")]), { toolu_bad_plan: '{"restated_question": "Q" "hypotheses": []}' });
    const h = await runScripted([{ events: plan }, respond([planCall(), peerCall()]), respond([reportCall()])]);
    const answers = toolResults(lastMessage(h.fake.streamRequests[1]));
    expect(answers.map((r) => [r.tool_use_id, resultText(r).split(":")[0]])).toEqual([
      ["toolu_early", "PLAN_REQUIRED"],
      ["toolu_bad_plan", "INVALID_JSON"],
    ]);
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))).toEqual([NOTICE_INVALID_JSON]);
    expect(textsOf(lastMessage(h.fake.streamRequests[1]))).not.toContain(NUDGE_PLAN);
    expect(h.executed).toEqual([{ turn: 1, calls: [expect.objectContaining({ id: "toolu_peer" })] }]);
    expect(h.outcome).toMatchObject({ status: "completed", nudges: { plan: false }, repairs: { plan: false, invalidJson: true } });
  });

  it("asks a turn again, not with the report nudge, when its only call was not valid JSON", async () => {
    const dna = streamEvents(respond([followUp()]), { toolu_dna: MALFORMED_DNA });
    const h = await runScripted([respond([planCall(), peerCall()]), { events: dna }, respond([followUp("toolu_dna_again")]), respond([reportCall()])]);
    expect(resultText(toolResults(lastMessage(h.fake.streamRequests[2]))[0])).toBe(invalidJson(RESEND, MALFORMED_DNA));
    expect(textsOf(lastMessage(h.fake.streamRequests[2]))).toEqual([NOTICE_INVALID_JSON]);
    expect(h.pivots).toEqual(["F1"]);
    expect(h.executed.map((e) => [e.turn, e.calls.map((c) => c.id)])).toEqual([
      [1, ["toolu_peer"]],
      [2, ["toolu_dna_again"]],
    ]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 4, nudges: { report: false } });
  });

  it("closes turn 2 at a lone unparsed call when only the report's response is left, or after a wrap-up notice", async () => {
    const dna = () => streamEvents(respond([followUp()]), { toolu_dna: MALFORMED_DNA });
    const lastResponse = await runScripted([respond([planCall(), peerCall()]), { events: dna() }, respond([reportCall()])], {
      limits: { modelResponses: 3 },
    });
    const clock = new ManualClock();
    const pastSoft = { events: dna(), onSend: () => clock.advance(DEFAULT_RUN_LIMITS.softMs) };
    const timedOut = await runScripted([respond([planCall(), peerCall()]), pastSoft, respond([reportCall()])], { now: clock.now });

    for (const [h, notices] of [
      [lastResponse, [NOTICE_INVALID_JSON, TURN3_NOTICE]],
      [timedOut, [NOTICE_INVALID_JSON, NOTICE_TIME, TURN3_NOTICE]],
    ] as const) {
      const reply = lastMessage(h.fake.streamRequests[2]);
      expect(resultText(toolResults(reply)[0])).toBe(invalidJson(CLOSED, MALFORMED_DNA));
      expect(textsOf(reply)).toEqual(notices);
      expect(h.outcome).toMatchObject({ status: "completed", responses: 3, turn: 3, nudges: { report: false } });
    }
  });

  it("keeps turn 2 open for the call after running the follow-ups before it", async () => {
    const dna = streamEvents(respond([followUp("toolu_first", "F2"), followUp()]), { toolu_dna: MALFORMED_DNA });
    const h = await runScripted([respond([planCall(), peerCall()]), { events: dna }, respond([followUp("toolu_dna_again")]), respond([reportCall()])]);
    const reply = lastMessage(h.fake.streamRequests[2]);
    expect(toolResults(reply).map((r) => [r.tool_use_id, r.is_error ?? false])).toEqual([
      ["toolu_first", false],
      ["toolu_dna", true],
    ]);
    expect(textsOf(reply)).toEqual([NOTICE_INVALID_JSON]);
    expect(textsOf(lastMessage(h.fake.streamRequests[3]))).toEqual([TURN3_NOTICE]);
    expect(h.executed.map((e) => [e.turn, e.calls.map((c) => c.id)])).toEqual([
      [1, ["toolu_peer"]],
      [2, ["toolu_first"]],
      [2, ["toolu_dna_again"]],
    ]);
    expect(h.pivots).toEqual(["F2", "F1"]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 4 });
  });

  it("closes turn 2 at an unparsed call after the follow-up nudge, so a rejected report still gets its repair turn", async () => {
    const listed = [{ findingId: "F1" as const, kind: "NEAR_SUBSTITUTES" as const, tool: "audience_dna" as const, subjects: ["R2"] }];
    const broken = () => ({ events: streamEvents(respond([followUp()]), { toolu_dna: MALFORMED_DNA }) });
    // The nudge on a report, or after a planned step, each leaves three responses; the unparsed call then spends one.
    const afterReport = [respond([planCall(), peerCall(), shareCall()]), respond([reportCall("toolu_r1")])];
    const afterStep = [respond([planCall(), peerCall()]), respond([stepCall("toolu_s2", "S2")])];
    for (const opening of [afterReport, afterStep]) {
      const reviews: Array<{ attempt: 1 | 2; final: boolean }> = [];
      const h = await runScripted([...opening, broken(), respond([reportCall("toolu_r2")]), respond([reportCall("toolu_r3")])], {
        followupLeads: () => listed,
        reviewReport: (_draft, context) => (reviews.push(context), context.final ? { ok: true } : { ok: false, feedback: "V3 thesis: numbers typed outside tokens." }),
      });
      const reply = lastMessage(h.fake.streamRequests[3]);
      expect(resultText(toolResults(reply)[0])).toBe(invalidJson(CLOSED, MALFORMED_DNA));
      expect(textsOf(reply)).toEqual([NOTICE_INVALID_JSON, TURN3_NOTICE]);
      expect(reviews).toEqual([
        { attempt: 1, final: false },
        { attempt: 2, final: true },
      ]);
      expect(h.pivots).toEqual([]);
      expect(h.outcome).toMatchObject({ status: "completed", responses: 5, nudges: { followup: true }, repairs: { invalidJson: true, report: true } });
    }
  });

  it("sends no follow-up nudge to a report in a turn 2 kept open after a follow-up ran", async () => {
    const dna = streamEvents(respond([followUp("toolu_first", "F2"), followUp()]), { toolu_dna: MALFORMED_DNA });
    const listed = [{ findingId: "F1" as const, kind: "NEAR_SUBSTITUTES" as const, tool: "audience_dna" as const, subjects: ["R2"] }];
    const h = await runScripted([respond([planCall(), peerCall()]), { events: dna }, respond([reportCall()])], { followupLeads: () => listed });
    expect(h.pivots).toEqual(["F2"]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 3, turn: 2, nudges: { followup: false } });
  });

  it("asks turn 3 again, without spending the report nudge, when submit_report was not valid JSON", async () => {
    const MALFORMED_REPORT = '{"headline": "Brand Alpha" "signal": "mixed"}';
    const report = streamEvents(respond([followUp("toolu_more", "F2"), reportCall("toolu_r1")]), { toolu_r1: MALFORMED_REPORT });
    const h = await runScripted([respond([planCall(), peerCall()]), respond([followUp()]), { events: report }, respond([reportCall("toolu_r2")])]);
    const reply = lastMessage(h.fake.streamRequests[3]);
    expect(toolResults(reply).map((r) => resultText(r).split(":")[0])).toEqual(["INVESTIGATION_BUDGET_EXHAUSTED", "INVALID_JSON"]);
    expect(resultText(toolResults(reply)[1])).toBe(invalidJson(RESEND, MALFORMED_REPORT));
    expect(textsOf(reply)).toEqual([NOTICE_INVALID_JSON]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 4, nudges: { report: false }, repairs: { invalidJson: true } });
  });

  it("tells turn 3 that only submit_report is left when the unparsed call was another tool", async () => {
    const late = streamEvents(respond([followUp()]), { toolu_dna: MALFORMED_DNA });
    const h = await runScripted([respond([planCall(), peerCall()]), respond([followUp("toolu_first", "F2")]), { events: late }, respond([reportCall()])]);
    const reply = lastMessage(h.fake.streamRequests[3]);
    expect(resultText(toolResults(reply)[0])).toBe(invalidJson(CLOSED, MALFORMED_DNA));
    expect(textsOf(reply)).toEqual([NOTICE_INVALID_JSON]);
    expect(h.outcome).toMatchObject({ status: "completed", responses: 4, nudges: { report: false } });
  });

  it("re-issues the request once when the response before the call cannot go back (an unsigned thinking block)", async () => {
    const unsigned = streamEvents(respond([{ ...thinking("Planning."), signature: "" }, planCall(), shareCall()]), { toolu_share: MALFORMED_SHARE });
    const h = await runScripted([{ events: unsigned }, respond([planCall(), peerCall()]), respond([reportCall()])]);
    const [first, retry] = h.fake.streamRequests;
    expect(JSON.stringify(retry?.messages)).toBe(JSON.stringify(first?.messages));
    expect(h.outcome).toMatchObject({ status: "completed", responses: 3, repairs: { invalidJson: true } });
    expect(h.usages[0]?.usd).toBeCloseTo(usdFor(SONNET_MODEL, respond([], "tool_use", { output_tokens: 1 }).usage), 12);
  });

  it("ends the run incomplete, not failed, at a second tool input that was not valid JSON", async () => {
    const dna = streamEvents(respond([followUp()]), { toolu_dna: MALFORMED_DNA });
    const h = await runScripted([{ events: brokenTurnOne() }, { events: dna }, respond([reportCall()])]);
    expect(h.fake.streamRequests).toHaveLength(2);
    expect(h.outcome).toMatchObject({ status: "incomplete", code: "invalid_tool_json", error: null, draft: null });
    expect(h.outcome.reason).toBe("a second tool input that was not valid JSON (audience_dna); that response was not run");
    expect(h.executed).toHaveLength(1);
    expect(h.outcome.plan).not.toBeNull();
  });
});
