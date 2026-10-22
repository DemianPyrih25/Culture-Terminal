import type Anthropic from "@anthropic-ai/sdk";
import { toAnthropicTools } from "@ct/contracts";
import { ANALYST_MAX_TOKENS, type AnalystModelConfig, type AnalystRequest } from "../anthropic";

/** The cached prefix: tools (sorted, constant per build) and a frozen system prompt. */
export interface AnalystPrefix {
  system: Anthropic.Beta.BetaTextBlockParam[];
  tools: Anthropic.Beta.BetaToolUnion[];
}

/**
 * The system prompt as one block with its own breakpoint, so tools + system stay a cache read
 * point. Dynamic context never goes here (PLAN §4.5): it lives in the first user message.
 */
export function analystPrefix(systemPrompt: string): AnalystPrefix {
  return {
    system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
    tools: toAnthropicTools(),
  };
}

/**
 * One ANALYST request (PLAN §4.2): adaptive thinking with the mode's display, effort in
 * output_config, tool_choice auto (forced choice returns a 400 on Sonnet 5.5), and top-level
 * automatic caching for the growing conversation. Nothing else varies between requests of a run
 * except the messages and, under the cost guard, max_tokens, so the prefix always caches.
 */
export function buildAnalystRequest(
  config: AnalystModelConfig,
  prefix: AnalystPrefix,
  messages: Anthropic.Beta.BetaMessageParam[],
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
    messages,
    ...(config.betas.length > 0 ? { betas: [...config.betas] } : {}),
  };
}

/** Characters of the parts that make up the prompt, for the conservative cost estimate. */
export function promptChars(request: AnalystRequest): number {
  return JSON.stringify({ system: request.system, tools: request.tools, messages: request.messages }).length;
}
