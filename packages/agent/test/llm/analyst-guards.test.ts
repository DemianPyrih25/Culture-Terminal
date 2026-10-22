import Anthropic from "@anthropic-ai/sdk";
import { ANALYST_TOOL_NAMES } from "@ct/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANALYST_MIN_MAX_TOKENS } from "../../src/analyst";
import { ANALYST_MAX_TOKENS, HAIKU_MODEL, SONNET_MODEL, THINKING_UPDATES_BETA } from "../../src/anthropic";
import { NOTICE_COST, NOTICE_TIME, NUDGE_REPORT, TURN3_NOTICE } from "../../src/llm/notices";
import { promptChars } from "../../src/llm/request";
import { estimateRequestUsd } from "../../src/pricing";
import { ManualClock, respond, text, thinking } from "../support/fake-anthropic";
import { followUp, lastMessage, peerCall, planCall, reportCall, runScripted, SYSTEM_PROMPT, textsOf, toolResults } from "./builders";

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
    expect(tools.filter((t) => t.strict).map((t) => t.name)).toEqual(["submit_plan", "submit_report"]);
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

  it("ends a turn-2 text reply with the report nudge", async () => {
    const h = await runScripted([respond([planCall(), peerCall()]), respond([text("Thinking aloud.")], "end_turn"), respond([reportCall()])]);
    expect(toolResults(lastMessage(h.fake.streamRequests[2]))).toEqual([]);
    expect(textsOf(lastMessage(h.fake.streamRequests[2]))).toEqual([NUDGE_REPORT]);
  });
});
