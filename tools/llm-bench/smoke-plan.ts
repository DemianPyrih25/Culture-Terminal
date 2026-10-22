// The smoke test's fixed requests and their worst-case cost, apart from smoke.ts (which runs on
// import) so tests can check that the default cap lets every request through.
import { promptChars } from "./client";
import { buildAnalystRequest, cachedSystem, THINKING_UPDATES_BETA, type AnalystPrefix, type BenchConfig } from "./config";
import { Intent, MODEL_DIGEST_MAX_TOKENS, structuredOutputSchema, toAnthropicTools, zodOutputFormat, type Anthropic } from "./deps";
import { textBlock } from "./history";
import { estimateRequestUsd, HAIKU, SONNET } from "./pricing";
import { CLERK_SYSTEM_PROMPT, SMOKE_SYSTEM_PROMPT } from "./prompts";
import { buildScenario, QUESTION, type Scenario } from "./scenario";

/** LLM_SMOKE_USD_CAP default: at least smokeWorstCaseUsd().total, so no request is refused for budget. */
export const SMOKE_DEFAULT_CAP_USD = 0.3;
/** The production ANALYST settings (D23), with a smaller max_tokens to bound the smoke's worst case. */
export const SMOKE_CONFIG: BenchConfig = { id: "sonnet-medium", model: SONNET, effort: "medium", thinkingDisplay: "updates", betas: [THINKING_UPDATES_BETA] };
/** Not lower: with medium-effort thinking, a smaller limit risks max_tokens with a pending tool_use on turn 1. */
export const SMOKE_MAX_TOKENS = 8000;
/** Both strict tools plus three skills: the real definitions, fewer of them, to keep the smoke cheap. */
export const SMOKE_TOOLS: ReadonlySet<string> = new Set(["submit_plan", "submit_report", "peer_landscape", "share_of_taste", "audience_dna"]);
/** User text, so the cached system and tools prefix stays the same; the second sentence asks for a progress update. */
export const SMOKE_TURN1 =
  "Call submit_plan with two hypotheses and two steps, together with one or two wave-1 tools. " +
  "Before your tool calls, explain in two or three sentences what you will check first and why.";
export const SMOKE_FINAL =
  "Final turn: call submit_report now. Keep it brief: three arguments, one bear-case item, two next moves, every text field one short sentence.";
export const CLERK_MAX_TOKENS = 1500;

export function smokePrefix(): AnalystPrefix {
  return { system: cachedSystem(SMOKE_SYSTEM_PROMPT), tools: toAnthropicTools().filter((t) => SMOKE_TOOLS.has(t.name)) };
}

export function smokeOpening(scenario: Scenario): Anthropic.Beta.BetaMessageParam {
  return { role: "user", content: `${scenario.runContext}\n${SMOKE_TURN1}` };
}

/** zodOutputFormat as PLAN §4.2 states it, or the contracts' schema (zodOutputFormat moves enums into description text). */
export type ClerkVariant = "zodOutputFormat" | "structuredOutputSchema";

export function clerkSchema(variant: ClerkVariant): Record<string, unknown> {
  return variant === "zodOutputFormat" ? zodOutputFormat(Intent).schema : structuredOutputSchema(Intent);
}

export function clerkMessages(): Anthropic.MessageParam[] {
  return [{ role: "user", content: `<user_question>${QUESTION}</user_question>` }];
}

export function clerkEstimateUsd(variant: ClerkVariant): number {
  return estimateRequestUsd(HAIKU, promptChars({ system: CLERK_SYSTEM_PROMPT, messages: clerkMessages(), schema: clerkSchema(variant) }), CLERK_MAX_TOKENS);
}

/** A wrapped digest at the per-result cap (approxTokens counts 3.5 characters per token). */
const DIGEST_CAP_CHARS = MODEL_DIGEST_MAX_TOKENS * 3.5;
/**
 * Turn 1's content as request 2 replays it. Its output is at most SMOKE_MAX_TOKENS tokens; six
 * characters per token covers base64 signatures, update text and tool inputs.
 */
const TURN1_REPLAY_CHARS = SMOKE_MAX_TOKENS * 6;

function estimate(messages: Anthropic.Beta.BetaMessageParam[]): number {
  const request = buildAnalystRequest(SMOKE_CONFIG, smokePrefix(), messages, SMOKE_MAX_TOKENS);
  return estimateRequestUsd(request.model, promptChars({ system: request.system, tools: request.tools, messages: request.messages }), request.max_tokens);
}

/**
 * What the guard can reserve across the smoke when every request maxes out: request 1, then
 * request 2 after a maximal turn 1 that called every offered skill (each digest at the cap), then
 * both CLERK variants. The real spend of request 1 is at most its estimate, so a cap of at least
 * the total lets every request through. pause_turn continuations need server tools, which the
 * smoke does not offer; the guard would still stop one that did not fit.
 */
export function smokeWorstCaseUsd(): { first: number; second: number; clerk: number; total: number } {
  const opening = smokeOpening(buildScenario());
  const skills = [...SMOKE_TOOLS].filter((name) => !name.startsWith("submit_"));
  const uses: Anthropic.Beta.BetaToolUseBlockParam[] = ["submit_plan", ...skills].map((name, i) => ({ type: "tool_use", id: `toolu_${i}`, name, input: {} }));
  const turn1: Anthropic.Beta.BetaMessageParam = {
    role: "assistant",
    content: [{ type: "thinking", thinking: "", signature: "s".repeat(TURN1_REPLAY_CHARS) }, ...uses],
  };
  const results: Anthropic.Beta.BetaContentBlockParam[] = uses.map((use, i) => ({
    type: "tool_result",
    tool_use_id: use.id,
    content: i === 0 ? "PLAN_ACCEPTED: hypotheses H1, H2; steps S1, S2. Opening-scan and wave-1 digests follow." : "d".repeat(DIGEST_CAP_CHARS),
  }));
  const first = estimate([opening]);
  const second = estimate([opening, turn1, { role: "user", content: [...results, textBlock(SMOKE_FINAL)] }]);
  const clerk = clerkEstimateUsd("zodOutputFormat") + clerkEstimateUsd("structuredOutputSchema");
  return { first, second, clerk, total: first + second + clerk };
}
