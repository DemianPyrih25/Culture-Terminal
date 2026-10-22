import { describe, expect, it } from "vitest";
import { BudgetGuard } from "./budget";
import { promptChars } from "./client";
import type { AnalystRequest } from "./config";
import { Anthropic } from "./deps";
import { fakeClock, fakeGaMessage, scriptedStreamer, thinking } from "./fakes";
import { estimatePromptTokens, HAIKU, usageToUsd } from "./pricing";
import { BENCH_INTENT } from "./scenario";
import { analystChecks, clerkCheck, type Check, type ClerkCreate } from "./smoke-checks";
import { SMOKE_DEFAULT_CAP_USD, SMOKE_MAX_TOKENS, SMOKE_TURN1, smokePrefix, smokeWorstCaseUsd } from "./smoke-plan";
import { peerCall, planCall, reportCall, respond, shareCall } from "./test-utils";

const apiError = (status: number) =>
  Anthropic.APIError.generate(status, { type: "error", error: { type: "api_error", message: "synthetic" } }, "synthetic", new Headers());

async function smoke(steps: Parameters<typeof scriptedStreamer>[0], cap = SMOKE_DEFAULT_CAP_USD) {
  const scripted = scriptedStreamer(steps);
  const guard = new BudgetGuard(cap);
  const out = await analystChecks(scripted.streamer, guard, fakeClock(5));
  const [a, b1, b2, c] = out.checks as [Check, Check, Check, Check];
  return { ...out, a, b1, b2, c, requests: scripted.requests, guard };
}

describe("the smoke's budget", () => {
  it("defaults to a cap that covers every request at its worst case", () => {
    const worst = smokeWorstCaseUsd();
    expect(worst.second).toBeGreaterThan(worst.first);
    expect(worst.clerk).toBeGreaterThan(0);
    expect(SMOKE_DEFAULT_CAP_USD).toBeGreaterThanOrEqual(worst.total);
  });

  it("still sends the second request after a turn 1 that maxed out", async () => {
    // Request 1 costs its full estimate: the whole assumed prompt written and every output token used.
    const turn1 = (request: AnalystRequest): Anthropic.Beta.BetaMessage => {
      const written = estimatePromptTokens(promptChars({ system: request.system, tools: request.tools, messages: request.messages }));
      const signed: Anthropic.Beta.BetaThinkingBlock = { type: "thinking", thinking: "", signature: "s".repeat(12_000) };
      return respond([signed, planCall(), peerCall(), shareCall()], "tool_use", {
        input_tokens: 0,
        cache_creation_input_tokens: written,
        output_tokens: SMOKE_MAX_TOKENS,
      });
    };
    const { requests, b1, b2, c, guard } = await smoke([turn1, respond([reportCall()], "tool_use", { cache_read_input_tokens: 4000 })]);
    expect(requests).toHaveLength(2);
    expect(b1.pass).toBe(true);
    expect(b2.pass).toBe(true);
    expect(c.pass).toBe(true);
    expect(guard.spentUsd).toBeLessThanOrEqual(SMOKE_DEFAULT_CAP_USD);
  });
});

describe("check (a): thinking display updates", () => {
  it("asks for a progress update in the user turn, leaving the cached prefix alone", async () => {
    const { requests } = await smoke([respond([planCall(), peerCall()]), respond([reportCall()])]);
    const first = requests[0]!;
    expect(first.messages[0]?.content).toEqual(expect.stringContaining(SMOKE_TURN1));
    expect(SMOKE_TURN1).toMatch(/Before your tool calls, explain in two or three sentences/);
    expect(JSON.stringify([first.system, first.tools])).toBe(JSON.stringify([smokePrefix().system, smokePrefix().tools]));
    expect(first.thinking).toEqual({ type: "adaptive", display: "updates" });
  });

  it("passes with a count when the model writes progress updates", async () => {
    const { a } = await smoke([respond([thinking("Checking peers first."), planCall(), peerCall()]), respond([reportCall()])]);
    expect(a.pass).toBe(true);
    expect(a.detail).toMatch(/accepted \(1 thinking block\(s\) in 2 response\(s\)\); non-empty updates: 1/);
  });

  it("does not fail when every thinking block is empty: zero updates is allowed", async () => {
    const { a } = await smoke([respond([thinking(""), planCall(), peerCall()]), respond([thinking(""), reportCall()])]);
    expect(a.pass).toBe(true);
    expect(a.detail).toMatch(/accepted \(2 thinking block\(s\) in 2 response\(s\)\); no progress updates emitted \(allowed\)/);
  });

  it("fails when the request with display updates was rejected", async () => {
    const { a, b1, c } = await smoke([apiError(400)]);
    expect(a.pass).toBe(false);
    expect(a.detail).toMatch(/^no response: bad_request \(400\): .*synthetic/);
    expect(b1.detail).toMatch(/^bad_request \(400\): .*synthetic/);
    expect(c.pass).toBe(false);
  });
});

describe("check (d): the CLERK checks stop_reason before parsing", () => {
  function fakeCreate(response: Anthropic.Message | Error) {
    const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
    const create: ClerkCreate = async (params) => {
      requests.push(params);
      if (response instanceof Error) throw response;
      return response;
    };
    return { create, requests };
  }
  const textOf = (value: string): Anthropic.TextBlock => ({ type: "text", text: value, citations: null });

  it("sends structured outputs through messages.create and parses a valid Intent", async () => {
    const message = fakeGaMessage({ content: [textOf(JSON.stringify(BENCH_INTENT))] });
    const { create, requests } = fakeCreate(message);
    const guard = new BudgetGuard(1);
    const { check, usd } = await clerkCheck(create, guard, "structuredOutputSchema");
    expect(check.pass).toBe(true);
    expect(check.detail).toMatch(/^job brand_health, pillar investment/);
    expect(usd).toBeCloseTo(usageToUsd(HAIKU, message.usage), 12);
    expect(guard.spentUsd).toBeCloseTo(usd, 12);
    const sent = requests[0]!;
    expect(sent).toMatchObject({ model: HAIKU, thinking: { type: "disabled" }, output_config: { effort: "low", format: { type: "json_schema" } } });
    expect(Object.keys(sent.output_config?.format ?? {}).sort()).toEqual(["schema", "type"]);
  });

  it("reports a max_tokens cut as truncation, not as a parse error, and charges real usage", async () => {
    const message = fakeGaMessage({ stop_reason: "max_tokens", content: [textOf('{"pillar":"investment","job":"bra')] });
    const guard = new BudgetGuard(1);
    const { check, usd } = await clerkCheck(fakeCreate(message).create, guard, "zodOutputFormat");
    expect(check).toMatchObject({ pass: false, detail: "truncated at max_tokens" });
    expect(usd).toBeCloseTo(usageToUsd(HAIKU, message.usage), 12);
  });

  it("reports a refusal with partial text as a refusal", async () => {
    const message = fakeGaMessage({
      stop_reason: "refusal",
      stop_details: { type: "refusal", category: "cyber", explanation: "Synthetic refusal." },
      content: [textOf('{"pillar":')],
    });
    const { check } = await clerkCheck(fakeCreate(message).create, new BudgetGuard(1), "zodOutputFormat");
    expect(check).toMatchObject({ pass: false, detail: "refused (cyber)" });
  });

  it("fails on text that is not JSON or not an Intent", async () => {
    const notJson = await clerkCheck(fakeCreate(fakeGaMessage({ content: [textOf("not json")] })).create, new BudgetGuard(1), "zodOutputFormat");
    expect(notJson.check.pass).toBe(false);
    expect(notJson.check.detail).toMatch(/^the text block is not JSON/);
    const wrong = await clerkCheck(fakeCreate(fakeGaMessage({ content: [textOf('{"job":"astrology"}')] })).create, new BudgetGuard(1), "zodOutputFormat");
    expect(wrong.check.detail).toMatch(/^not a valid Intent: /);
  });

  it("charges nothing for a rejected request", async () => {
    const guard = new BudgetGuard(1);
    const { check, usd } = await clerkCheck(fakeCreate(apiError(400)).create, guard, "zodOutputFormat");
    expect(check.detail).toMatch(/^bad_request \(400\): .*synthetic/);
    expect(usd).toBe(0);
    expect(guard.spentUsd).toBe(0);
  });
});
