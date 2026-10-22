import { describe, expect, it } from "vitest";
import { BudgetGuard, BudgetStop } from "./budget";
import { callModel, CallFailed, CLIENT_OPTIONS, describeError, promptChars } from "./client";
import { BENCH_CONFIGS, buildAnalystRequest, cachedSystem } from "./config";
import { Anthropic } from "./deps";
import { fakeClock, fakeUsage, scriptedStreamer, thinking, toolUse } from "./fakes";
import { estimatePromptTokens, usageToUsd } from "./pricing";
import { respond } from "./test-utils";

const apiError = (status: number) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: "api_error", message: "synthetic" } }, "synthetic", new Headers());

describe("describeError", () => {
  it("maps typed SDK errors to a scope and a billing assumption", () => {
    expect(describeError(apiError(400))).toMatchObject({ kind: "bad_request", status: 400, scope: "config", maybeBilled: false });
    expect(describeError(apiError(401))).toMatchObject({ kind: "authentication", scope: "bench", maybeBilled: false });
    expect(describeError(apiError(403))).toMatchObject({ kind: "permission_denied", scope: "bench" });
    expect(describeError(apiError(404))).toMatchObject({ kind: "not_found", scope: "config" });
    expect(describeError(apiError(429))).toMatchObject({ kind: "rate_limited", scope: "run", maybeBilled: false });
    expect(describeError(apiError(500))).toMatchObject({ kind: "server_error", scope: "run", maybeBilled: false });
    expect(describeError(apiError(529))).toMatchObject({ kind: "server_error", scope: "run", maybeBilled: false });
  });

  it("maps the 4xx statuses the SDK has no class for: never billed, a 402 stops the bench", () => {
    expect(describeError(apiError(402))).toMatchObject({ kind: "billing", status: 402, scope: "bench", maybeBilled: false });
    expect(describeError(apiError(413))).toMatchObject({ kind: "request_too_large", scope: "config", maybeBilled: false });
    expect(describeError(apiError(409))).toMatchObject({ kind: "conflict", scope: "run", maybeBilled: false });
    expect(describeError(apiError(408))).toMatchObject({ kind: "request_timeout", scope: "run", maybeBilled: false });
    expect(describeError(apiError(418))).toMatchObject({ kind: "client_error", scope: "run", maybeBilled: false, retryTurn: false });
  });

  it("handles connection errors and mid-stream API errors without a status", () => {
    expect(describeError(new Anthropic.APIConnectionTimeoutError())).toMatchObject({ kind: "timeout", status: null, maybeBilled: true });
    expect(describeError(new Anthropic.APIConnectionError({ message: "reset" }))).toMatchObject({ kind: "connection" });
    expect(describeError(new Anthropic.APIUserAbortError())).toMatchObject({ kind: "aborted" });
    expect(describeError(new Anthropic.APIError(undefined, undefined, "overloaded mid-stream", undefined))).toMatchObject({
      kind: "api_error",
      status: null,
    });
  });

  it("flags plain SDK client errors (unparseable tool JSON) as a turn to re-issue", () => {
    const info = describeError(new Anthropic.AnthropicError("Unable to parse tool parameter JSON from model."));
    expect(info).toMatchObject({ kind: "sdk_client_error", retryTurn: true, maybeBilled: true });
    expect(describeError(apiError(400)).retryTurn).toBe(false);
  });

  it("keeps unknown errors at run scope", () => {
    expect(describeError(new TypeError("boom"))).toMatchObject({ kind: "unexpected", scope: "run", message: "boom" });
    expect(describeError("text")).toMatchObject({ kind: "unexpected", message: "text" });
  });
});

describe("callModel", () => {
  const config = BENCH_CONFIGS[0]!;
  const request = buildAnalystRequest(config, { system: cachedSystem("short system"), tools: [] }, [{ role: "user", content: "hi" }]);

  it("charges the real cost from usage and reports latency, first delta and thinking chars", async () => {
    const guard = new BudgetGuard(5);
    const usage = { input_tokens: 500, output_tokens: 900, cache_creation_input_tokens: 4000 };
    const { streamer } = scriptedStreamer([respond([thinking("Checking the peer set."), toolUse("t1", "submit_plan", {})], "tool_use", usage)]);
    const out = await callModel(streamer, request, guard, fakeClock(10));
    expect(out.usd).toBeCloseTo(usageToUsd(config.model, fakeUsage(usage)), 12);
    expect(guard.spentUsd).toBeCloseTo(out.usd, 12);
    expect(out.latencyMs).toBe(20);
    expect(out.firstDeltaMs).toBe(10);
    expect(out.thinkingDeltaChars).toBe("Checking the peer set.".length);
    expect(out.estimateUsd).toBeGreaterThan(out.usd);
  });

  it("records how far a real prompt exceeded the estimate's assumption", async () => {
    const assumed = estimatePromptTokens(promptChars({ system: request.system, tools: request.tools, messages: request.messages }));
    const { streamer } = scriptedStreamer([
      respond([], "end_turn", { input_tokens: 0, cache_read_input_tokens: assumed }),
      respond([], "end_turn", { input_tokens: 100, cache_read_input_tokens: assumed }),
    ]);
    const guard = new BudgetGuard(5);
    expect((await callModel(streamer, request, guard, fakeClock(1))).estimateShortfallTokens).toBe(0);
    expect((await callModel(streamer, request, guard, fakeClock(1))).estimateShortfallTokens).toBe(100);
  });

  it("refuses to send when the worst case could pass the cap", async () => {
    const guard = new BudgetGuard(0.05);
    const scripted = scriptedStreamer([respond([])]);
    await expect(callModel(scripted.streamer, request, guard, fakeClock(1))).rejects.toBeInstanceOf(BudgetStop);
    expect(scripted.requests).toHaveLength(0);
    expect(guard.spentUsd).toBe(0);
  });

  it("charges the estimate for a failure that may have been billed, nothing for a 400", async () => {
    const guard = new BudgetGuard(5);
    // A dropped connection may have been billed; a 5xx was not (the server produced no tokens).
    const midStream = scriptedStreamer([new Anthropic.APIConnectionError({ message: "reset" })]);
    const err = await callModel(midStream.streamer, request, guard, fakeClock(1)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CallFailed);
    expect((err as CallFailed).chargedUsd).toBeGreaterThan(0);
    expect(guard.spentUsd).toBeCloseTo((err as CallFailed).chargedUsd, 12);

    const before = guard.spentUsd;
    const rejected = scriptedStreamer([apiError(400)]);
    const err400 = await callModel(rejected.streamer, request, guard, fakeClock(1)).catch((e: unknown) => e);
    expect((err400 as CallFailed).info.scope).toBe("config");
    expect(guard.spentUsd).toBe(before);
  });
});

describe("CLIENT_OPTIONS", () => {
  it("matches SPEC §4.2: three retries and a 120 s timeout", () => {
    expect(CLIENT_OPTIONS).toEqual({ maxRetries: 3, timeout: 120_000 });
  });
});
