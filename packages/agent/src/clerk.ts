import type Anthropic from "@anthropic-ai/sdk";
import { Intent, normalizeIntent, structuredOutputSchema, type JsonSchema, type TokenUsage } from "@ct/contracts";
import { CLERK_MAX_TOKENS, CLERK_MODEL, type AnthropicLike, type ClerkRequest } from "./anthropic";
import { describeLlmError } from "./llm/errors";
import { sanitizeQuestion, wrapQuestion } from "./llm/question";
import { toRefusal } from "./llm/stop";
import { tokenUsageOf, usdFor } from "./pricing";
import { CLERK_PROMPT } from "./prompts";

export { sanitizeQuestion, wrapQuestion } from "./llm/question";

/**
 * CLERK (PLAN §4.1 step A): Haiku 5.5 reads the question into an Intent through structured output.
 * It uses messages.create rather than messages.parse: parse() runs the parser before the caller sees
 * stop_reason, so a refusal or a max_tokens cut would surface as a parse error. Here stop_reason
 * comes first, then the text block is parsed with the contracts' Intent schema (tools/llm-bench).
 */

export interface ClerkOptions {
  client: AnthropicLike;
  /** The raw question; it is sanitized, capped and wrapped here. */
  question: string;
  /** Defaults to CLERK_PROMPT (packages/agent/prompts/clerk.md). */
  systemPrompt?: string;
  signal?: AbortSignal;
}

interface ClerkCost {
  usage: TokenUsage;
  usd: number;
  model: typeof CLERK_MODEL;
}

export type ClerkErrorCode =
  | "empty_question"
  | "cancelled"
  | "api_error"
  | "max_tokens"
  | "no_output"
  | "invalid_json"
  | "invalid_intent";

export type ClerkResult =
  /** The intent after normalizeIntent (pillar from the job, mnemonic recompiled). safety.allowed may be false. */
  | ({ kind: "intent"; intent: Intent } & ClerkCost)
  /** The API's own refusal (stop_reason "refusal"); partial output is discarded. */
  | ({ kind: "refusal"; category: string | null; explanation: string | null } & ClerkCost)
  /** usage is null when no response arrived. */
  | {
      kind: "error";
      code: ClerkErrorCode;
      message: string;
      retryable: boolean;
      usage: TokenUsage | null;
      usd: number;
      model: typeof CLERK_MODEL;
    };

let intentSchema: JsonSchema | undefined;

/** structuredOutputSchema keeps the enums constrained; zodOutputFormat would move them into descriptions. */
function intentFormat(): JsonSchema {
  intentSchema ??= structuredOutputSchema(Intent);
  return intentSchema;
}

function clerkRequest(systemPrompt: string, question: string): ClerkRequest {
  return {
    model: CLERK_MODEL,
    max_tokens: CLERK_MAX_TOKENS,
    thinking: { type: "disabled" },
    output_config: { effort: "low", format: { type: "json_schema", schema: intentFormat() } },
    system: systemPrompt,
    messages: [{ role: "user", content: wrapQuestion(question) }],
  };
}

/** Never throws for API failures, refusals or bad output: every path returns a ClerkResult. */
export async function runClerk(options: ClerkOptions): Promise<ClerkResult> {
  const systemPrompt = options.systemPrompt ?? CLERK_PROMPT;
  if (systemPrompt.trim() === "") throw new Error("runClerk: the CLERK system prompt is empty");
  const fail = (code: ClerkErrorCode, message: string, retryable: boolean, cost?: ClerkCost): ClerkResult => ({
    kind: "error",
    code,
    message,
    retryable,
    usage: cost?.usage ?? null,
    usd: cost?.usd ?? 0,
    model: CLERK_MODEL,
  });
  if (sanitizeQuestion(options.question) === "") return fail("empty_question", "the question is empty", false);

  let message: Anthropic.Message;
  try {
    message = await options.client.messages.create(clerkRequest(systemPrompt, options.question), options.signal ? { signal: options.signal } : undefined);
  } catch (err) {
    if (options.signal?.aborted) return fail("cancelled", "the CLERK request was cancelled", false);
    const info = describeLlmError(err);
    return fail("api_error", `${info.kind}${info.status === null ? "" : ` (${info.status})`}: ${info.message}`, info.retryable);
  }

  const cost: ClerkCost = { usage: tokenUsageOf(message.usage), usd: usdFor(CLERK_MODEL, message.usage), model: CLERK_MODEL };
  // stop_reason first, before any content is read.
  const refusal = toRefusal(message);
  if (refusal) return { kind: "refusal", category: refusal.category, explanation: refusal.explanation, ...cost };
  if (message.stop_reason === "max_tokens") return fail("max_tokens", `the intent was cut off at ${CLERK_MAX_TOKENS} tokens`, true, cost);

  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (text === undefined) return fail("no_output", `no text block (stop_reason ${message.stop_reason})`, true, cost);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    return fail("invalid_json", `the output is not JSON: ${err instanceof Error ? err.message : String(err)}`, true, cost);
  }
  const parsed = Intent.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    return fail("invalid_intent", `not a valid Intent: ${issues.join("; ")}`, true, cost);
  }
  return { kind: "intent", intent: normalizeIntent(parsed.data), ...cost };
}
