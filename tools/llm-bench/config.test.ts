import { describe, expect, it } from "vitest";
import { ANALYST_MAX_TOKENS, BENCH_CONFIGS, buildAnalystRequest, cachedSystem, parseBenchArgs, THINKING_UPDATES_BETA } from "./config";
import type { Anthropic } from "./deps";
import { HAIKU, SONNET } from "./pricing";

describe("BENCH_CONFIGS", () => {
  it("are sonnet-medium, sonnet-low and haiku-medium on Sonnet 5.5 and Haiku 5.5 only (D23)", () => {
    expect(BENCH_CONFIGS.map((c) => [c.id, c.model, c.effort])).toEqual([
      ["sonnet-medium", SONNET, "medium"],
      ["sonnet-low", SONNET, "low"],
      ["haiku-medium", HAIKU, "medium"],
    ]);
  });

  it("use only the thinking-display-updates beta (D22)", () => {
    const betas = new Set(BENCH_CONFIGS.flatMap((c) => c.betas));
    expect([...betas]).toEqual([THINKING_UPDATES_BETA]);
    for (const c of BENCH_CONFIGS) expect(c.betas.length > 0).toBe(c.thinkingDisplay === "updates");
  });
});

describe("buildAnalystRequest", () => {
  const prefix = { system: cachedSystem("frozen"), tools: [] };

  it("sets the PLAN §4.2 ANALYST parameters", () => {
    const req = buildAnalystRequest(BENCH_CONFIGS[0]!, prefix, [{ role: "user", content: "q" }]);
    expect(req).toMatchObject({
      model: SONNET,
      max_tokens: ANALYST_MAX_TOKENS,
      tool_choice: { type: "auto" },
      thinking: { type: "adaptive", display: "updates" },
      output_config: { effort: "medium" },
      cache_control: { type: "ephemeral" },
      betas: [THINKING_UPDATES_BETA],
    });
    expect(req.system).toEqual([{ type: "text", text: "frozen", cache_control: { type: "ephemeral" } }]);
    // No server-side fallbacks, task budgets, sampling parameters or forced tool choice.
    for (const key of ["fallbacks", "temperature", "top_p", "top_k"]) expect(req).not.toHaveProperty(key);
    expect(req.output_config).not.toHaveProperty("task_budget");
  });

  it("sends no beta header and summarized thinking for the economy ANALYST", () => {
    const req = buildAnalystRequest(BENCH_CONFIGS[2]!, prefix, []);
    expect(req).not.toHaveProperty("betas");
    expect(req.thinking).toEqual({ type: "adaptive", display: "summarized" });
  });

  it("copies the messages so later pushes to the history cannot change a sent request", () => {
    const history: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: "q" }];
    const req = buildAnalystRequest(BENCH_CONFIGS[1]!, prefix, history);
    history.push({ role: "assistant", content: "a" });
    expect(req.messages).toHaveLength(1);
  });
});

describe("parseBenchArgs", () => {
  it("defaults to two runs of every config", () => {
    const args = parseBenchArgs([]);
    expect(args.runs).toBe(2);
    expect(args.configs.map((c) => c.id)).toEqual(["sonnet-medium", "sonnet-low", "haiku-medium"]);
    expect(args.dryRun).toBe(false);
  });

  it("reads --runs in both spellings, --configs in canonical order, and --dry-run", () => {
    expect(parseBenchArgs(["--runs", "3"]).runs).toBe(3);
    expect(parseBenchArgs(["--runs=1"]).runs).toBe(1);
    expect(parseBenchArgs(["--configs", "haiku-medium,sonnet-medium"]).configs.map((c) => c.id)).toEqual(["sonnet-medium", "haiku-medium"]);
    expect(parseBenchArgs(["--dry-run"]).dryRun).toBe(true);
    expect(parseBenchArgs(["--help"]).help).toBe(true);
  });

  it("rejects bad values and unknown flags", () => {
    expect(() => parseBenchArgs(["--runs", "0"])).toThrow(/1 to 5/);
    expect(() => parseBenchArgs(["--runs", "two"])).toThrow(/1 to 5/);
    expect(() => parseBenchArgs(["--runs"])).toThrow(/needs a value/);
    expect(() => parseBenchArgs(["--configs", "opus-high"])).toThrow(/unknown config opus-high/);
    expect(() => parseBenchArgs(["--fast"])).toThrow(/unknown argument/);
  });
});
