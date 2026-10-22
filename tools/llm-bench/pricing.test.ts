import { describe, expect, it } from "vitest";
import {
  ESTIMATE_CHARS_PER_TOKEN,
  ESTIMATE_HIDDEN_PROMPT_TOKENS,
  estimatePromptTokens,
  estimateRequestUsd,
  formatUsd,
  HAIKU,
  promptTokens,
  rateCardFor,
  SONNET,
  usageToUsd,
} from "./pricing";

const usage = (input: number, output: number, write = 0, read = 0, write1h = 0) => ({
  input_tokens: input,
  output_tokens: output,
  cache_creation_input_tokens: write,
  cache_read_input_tokens: read,
  cache_creation: write1h > 0 ? { ephemeral_1h_input_tokens: write1h, ephemeral_5m_input_tokens: write - write1h } : null,
});

describe("usageToUsd", () => {
  it("prices Sonnet 5.5 input, output, 5-minute writes and reads", () => {
    // 1000×2 + 2000×10 + 10000×2.5 + 20000×0.2 per million
    expect(usageToUsd(SONNET, usage(1000, 2000, 10_000, 20_000))).toBeCloseTo(0.051, 10);
  });

  it("bills 1-hour cache writes at their own rate when the breakdown is present", () => {
    // 6000×2.5 + 4000×4 per million
    expect(usageToUsd(SONNET, usage(0, 0, 10_000, 0, 4000))).toBeCloseTo(0.031, 10);
  });

  it("treats null cache fields as zero", () => {
    expect(usageToUsd(SONNET, { input_tokens: 1_000_000, output_tokens: 0, cache_creation_input_tokens: null, cache_read_input_tokens: null })).toBeCloseTo(2, 10);
  });

  it("prices Haiku 5.5 on the base card up to a 100K-token prompt", () => {
    const u = usage(50_000, 1000, 10_000, 40_000);
    expect(promptTokens(u)).toBe(100_000);
    // 50000×0.1 + 1000×0.5 + 10000×0.125 + 40000×0.01 per million
    expect(usageToUsd(HAIKU, u)).toBeCloseTo(0.00715, 10);
  });

  it("switches the whole Haiku 5.5 request to the long-prompt card above 100K tokens", () => {
    const u = usage(60_001, 1000, 0, 40_000);
    expect(rateCardFor(HAIKU, promptTokens(u)).input).toBe(0.5);
    // 60001×0.5 + 1000×2.5 + 40000×0.05 per million
    expect(usageToUsd(HAIKU, u)).toBeCloseTo(0.0345005, 10);
  });

  it("has no long-prompt card for Sonnet 5.5", () => {
    expect(rateCardFor(SONNET, 900_000)).toEqual(rateCardFor(SONNET, 10));
  });

  it("refuses to price any other model (D23: no Opus)", () => {
    expect(() => usageToUsd("claude-opus-5-5", usage(1, 1))).toThrow(/only claude-sonnet-5-5 and claude-haiku-5-5/);
  });
});

describe("estimateRequestUsd", () => {
  it("bills every prompt token as a cache write and the full max_tokens as output", () => {
    // 25000 chars / 2 + 1000 hidden = 13500 tokens: 13500×2.5 + 32000×10 per million
    expect(estimateRequestUsd(SONNET, 25_000, 32_000)).toBeCloseTo(0.35375, 10);
  });

  it("assumes two characters per token plus 1,000 hidden prompt tokens", () => {
    expect(ESTIMATE_CHARS_PER_TOKEN).toBe(2);
    expect(ESTIMATE_HIDDEN_PROMPT_TOKENS).toBe(1000);
    expect(estimatePromptTokens(0)).toBe(1000);
    expect(estimatePromptTokens(25_001)).toBe(13_501);
  });

  // The guarantee itself: any response whose prompt is within estimatePromptTokens(chars) and whose
  // output is within max_tokens costs no more than the estimate, however the prompt splits between
  // input, 5-minute writes and reads (the bench never asks for the 1-hour TTL).
  it.each([
    [SONNET, 0, 8000],
    [SONNET, 15_229, 8000],
    [SONNET, 52_700, 32_000],
    [SONNET, 2_000_000, 64_000],
    [HAIKU, 4000, 1500],
    [HAIKU, 197_998, 32_000],
    [HAIKU, 198_000, 32_000],
    [HAIKU, 400_000, 32_000],
  ])("covers every bounded response for %s at %i chars, max_tokens %i", (model, chars, maxTokens) => {
    const prompt = estimatePromptTokens(chars);
    expect(prompt).toBe(Math.ceil(chars / 2) + 1000);
    const estimate = estimateRequestUsd(model, chars, maxTokens);
    const half = Math.floor(prompt / 2);
    for (const u of [usage(prompt, maxTokens), usage(0, maxTokens, prompt), usage(0, maxTokens, 0, prompt), usage(half, maxTokens, prompt - half), usage(prompt - 1, maxTokens - 1)]) {
      expect(estimate).toBeGreaterThanOrEqual(usageToUsd(model, u));
    }
  });

  it("uses Haiku's long-prompt card when the estimated prompt passes 100K tokens", () => {
    // 300000 / 2 + 1000 = 151000 tokens: 151000×0.625 + 32000×2.5 per million
    expect(estimateRequestUsd(HAIKU, 300_000, 32_000)).toBeCloseTo(0.174375, 10);
  });
});

describe("formatUsd", () => {
  it("shows four decimals under a dollar and two above", () => {
    expect(formatUsd(0.0123)).toBe("$0.0123");
    expect(formatUsd(1.5)).toBe("$1.50");
  });
});
