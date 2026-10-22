import type { Anthropic } from "./deps";
import { HAIKU, SONNET, type BenchModel } from "./pricing";

/** The only beta P0 uses (D22): no fallbacks, no task_budget, no per-message effort. */
export const THINKING_UPDATES_BETA = "thinking-display-updates-2026-08-18";
export const ANALYST_MAX_TOKENS = 32_000;

export type BenchConfigId = "sonnet-medium" | "sonnet-low" | "haiku-medium";

export interface BenchConfig {
  id: BenchConfigId;
  model: BenchModel;
  effort: "low" | "medium";
  thinkingDisplay: "updates" | "summarized";
  betas: Anthropic.Beta.AnthropicBeta[];
}

export const BENCH_CONFIGS: readonly BenchConfig[] = [
  { id: "sonnet-medium", model: SONNET, effort: "medium", thinkingDisplay: "updates", betas: [THINKING_UPDATES_BETA] },
  { id: "sonnet-low", model: SONNET, effort: "low", thinkingDisplay: "updates", betas: [THINKING_UPDATES_BETA] },
  // The skill's platform table lists display "updates" for Sonnet 5.5 but not for Haiku 5.5, so the
  // economy ANALYST asks for summaries; without the beta, "updates" is rejected as unknown.
  { id: "haiku-medium", model: HAIKU, effort: "medium", thinkingDisplay: "summarized", betas: [] },
];

export type AnalystRequest = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

/** The cached prefix: tools (sorted, constant per build) and a frozen system prompt. */
export interface AnalystPrefix {
  system: Anthropic.Beta.BetaTextBlockParam[];
  tools: Anthropic.Beta.BetaToolUnion[];
}

/** The system prompt as one block with its own breakpoint, so tools + system stay a read point. */
export function cachedSystem(text: string): Anthropic.Beta.BetaTextBlockParam[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}

/**
 * One ANALYST request (PLAN §4.2): adaptive thinking with the config's display, effort in
 * output_config, tool_choice auto (forced choice returns a 400 on Sonnet 5.5), and top-level
 * automatic caching for the growing conversation. The messages array is copied so later pushes
 * to the history cannot change a request already sent.
 */
export function buildAnalystRequest(
  config: BenchConfig,
  prefix: AnalystPrefix,
  messages: readonly Anthropic.Beta.BetaMessageParam[],
  maxTokens: number = ANALYST_MAX_TOKENS,
): AnalystRequest {
  return {
    model: config.model,
    max_tokens: maxTokens,
    system: prefix.system,
    tools: prefix.tools,
    tool_choice: { type: "auto" },
    thinking: { type: "adaptive", display: config.thinkingDisplay },
    output_config: { effort: config.effort },
    cache_control: { type: "ephemeral" },
    messages: [...messages],
    ...(config.betas.length > 0 ? { betas: [...config.betas] } : {}),
  };
}

export interface BenchArgs {
  runs: number;
  configs: BenchConfig[];
  dryRun: boolean;
  help: boolean;
}

export const BENCH_USAGE = [
  "usage: pnpm llm:bench [--runs N] [--configs sonnet-medium,sonnet-low,haiku-medium] [--dry-run]",
  "  --runs N      runs per config (default 2, at most 5)",
  "  --configs     comma-separated subset, in this order of preference",
  "  --dry-run     print prompt sizes and worst-case costs; no API calls",
  "  LLM_BENCH_USD_CAP (env) hard cap on total spend, default 1.50",
].join("\n");

export function parseBenchArgs(argv: readonly string[]): BenchArgs {
  const args: BenchArgs = { runs: 2, configs: [...BENCH_CONFIGS], dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    const [flag, inline] = arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const value = (): string => {
      const v = inline ?? argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value\n${BENCH_USAGE}`);
      return v;
    };
    switch (flag) {
      case "--runs": {
        const n = Number(value());
        if (!Number.isInteger(n) || n < 1 || n > 5) throw new Error(`--runs must be an integer from 1 to 5\n${BENCH_USAGE}`);
        args.runs = n;
        break;
      }
      case "--configs": {
        const ids = value().split(",").map((s) => s.trim()).filter(Boolean);
        const unknown = ids.filter((id) => !BENCH_CONFIGS.some((c) => c.id === id));
        if (ids.length === 0 || unknown.length > 0) {
          throw new Error(`unknown config ${unknown.join(", ") || "(none given)"}\n${BENCH_USAGE}`);
        }
        args.configs = BENCH_CONFIGS.filter((c) => ids.includes(c.id));
        break;
      }
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      default:
        throw new Error(`unknown argument ${arg}\n${BENCH_USAGE}`);
    }
  }
  return args;
}
