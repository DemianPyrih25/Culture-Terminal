import type Anthropic from "@anthropic-ai/sdk";
import { GhostAnswer, GhostPickCategory, Job, QUESTION_MAX_CHARS, structuredOutputSchema, type GeoApi, type JsonSchema, type TokenUsage } from "@ct/contracts";
import { normaliseName } from "@ct/quant";
import { ANALYST_CONFIGS, type AnthropicLike, type ClerkRequest, type LlmModel, type LlmRequestOptions } from "../anthropic";
import { describeLlmError } from "../llm/errors";
import { sanitizeQuestion } from "../llm/question";
import { toRefusal, type LlmRefusal } from "../llm/stop";
import { estimateRequestUsd, isPricedModel, tokenUsageOf, usdFor } from "../pricing";
import { GHOST_PROMPT } from "../prompts.generated";
import { gazetteer } from "../run/gazetteer";
import { GHOST_EARLIER_MAX, GHOST_JOB_CATEGORIES, ghostUserMessage, type GhostContext } from "./categories";
import { GHOST_MARKETS } from "./places";

/**
 * GHOST (SPEC §6.6 item 2, D23): the run's ANALYST model answers the same question with no tools and
 * no data, in one structured-output request. Like the CLERK it uses messages.create rather than
 * messages.parse, so stop_reason is read before any content and a refusal or a max_tokens cut never
 * surfaces as a parse error; the text block is then parsed with the contracts' GhostAnswer schema.
 */

/**
 * The answer is a few hundred tokens: a headline, at most 25 names and the numbers it states. The
 * rest is room for adaptive thinking at the ANALYST's effort, which for one question with no tool
 * turns stays well under it (the bench's whole three-turn Sonnet run wrote 3,594 output tokens at
 * p50, docs/LLM_BENCH.md). 8,000 output tokens cost at most 8¢ on Sonnet 5.5 and 0.4¢ on Haiku 5.5
 * (pricing.ts), plus under half a cent of prompt.
 */
export const GHOST_MAX_TOKENS = 8000;

/**
 * A non-streaming request must finish generating inside its timeout, so the client's 120 s
 * (ANTHROPIC_CLIENT_OPTIONS, sized for the ANALYST's streams) would cut off a full-length reply
 * slower than about 67 tokens a second. GHOST_MAX_TOKENS at a pessimistic 30 tokens a second is
 * 267 s; five minutes leaves room for the prompt and the queue.
 */
export const GHOST_TIMEOUT_MS = 300_000;

/**
 * No client retries: a retry after a timeout pays for a second generation that the response never
 * reports, so one GHOST answer is one billed request and ghostWorstCaseUsd bounds it. A failed
 * answer is a GhostError the caller may run again (the eval's --resume, the attach CLI).
 */
export const GHOST_MAX_RETRIES = 0;

/** ghost.md: at most five names per list, best first. Code keeps the first five distinct ones. */
export const GHOST_PICKS_PER_CATEGORY = 5;

/** One GHOST request body: a plain messages.create, like the CLERK's. */
export type GhostRequest = ClerkRequest;

/** GhostContext: the places and earlier questions the message lists (ghostUserMessage). */
export interface GhostOptions extends GhostContext {
  /** The raw question; it is sanitized, capped and wrapped as for the ANALYST. */
  question: string;
  job: Job;
  /** The run's ANALYST model (Report.receipt.models.analyst): Sonnet 5.5 live, Haiku 5.5 in economy (D23). */
  model: LlmModel;
  anthropic: AnthropicLike;
  signal?: AbortSignal;
  /** Defaults to GHOST_PROMPT (packages/agent/prompts/ghost.md). */
  systemPrompt?: string;
  /** For `ms`; Date.now by default. */
  now?: () => number;
}

export interface GhostResult {
  /** After tidyGhostAnswer. */
  answer: GhostAnswer;
  usage: TokenUsage;
  usd: number;
  /** From the request to the parsed answer. */
  ms: number;
  model: LlmModel;
}

export type GhostErrorCode =
  | "empty_question"
  | "cancelled"
  | "api_error"
  /** The API's own refusal (stop_reason "refusal"); a refusal ghost.md asks for is an answer. */
  | "refusal"
  | "max_tokens"
  | "no_output"
  | "invalid_json"
  | "invalid_answer";

/** Why GHOST has no answer, with what the attempt cost. The client never retries it (GHOST_MAX_RETRIES). */
export class GhostError extends Error {
  override readonly name = "GhostError";
  readonly code: GhostErrorCode;
  readonly retryable: boolean;
  /** Null when no response arrived. */
  readonly usage: TokenUsage | null;
  /** 0 when no response arrived. */
  readonly usd: number;
  readonly model: LlmModel;
  /** Set for code "refusal". */
  readonly refusal: LlmRefusal | null;

  constructor(
    code: GhostErrorCode,
    message: string,
    info: { retryable: boolean; usage?: TokenUsage | null; usd?: number; model: LlmModel; refusal?: LlmRefusal | null },
  ) {
    super(message);
    this.code = code;
    this.retryable = info.retryable;
    this.usage = info.usage ?? null;
    this.usd = info.usd ?? 0;
    this.model = info.model;
    this.refusal = info.refusal ?? null;
  }
}

let answerSchema: JsonSchema | undefined;

/**
 * The contract describes numeric_claims by GHOST's name; the model is never told it is GHOST
 * (ghost.md), so the schema it reads describes the field without the name.
 */
export const NUMERIC_CLAIMS_DESCRIPTION = "Every number the headline states, verbatim.";

/** structuredOutputSchema keeps the schema strict; zodOutputFormat would move constraints into descriptions. */
export function answerFormat(): JsonSchema {
  if (answerSchema === undefined) {
    const schema = structuredOutputSchema(GhostAnswer);
    const properties = schema.properties as Record<string, JsonSchema>;
    answerSchema = {
      ...schema,
      properties: { ...properties, numeric_claims: { ...properties.numeric_claims, description: NUMERIC_CLAIMS_DESCRIPTION } },
    };
  }
  return answerSchema;
}

/** The ANALYST's effort for this model: ANALYST_CONFIGS live (Sonnet) or economy (Haiku). */
function analystEffort(model: LlmModel): "low" | "medium" {
  const config = Object.values(ANALYST_CONFIGS).find((c) => c.model === model);
  if (config === undefined) throw new Error(`runGhost: ${model} is not an ANALYST model`);
  return config.effort;
}

/**
 * Same model and effort as the ANALYST, adaptive thinking (Sonnet 5.5 cannot turn it off), no tools
 * and no tool_choice. The ANALYST's display "updates" needs a beta header messages.create does not
 * send, and GHOST's thinking is never read, so it is omitted from the response.
 */
export function ghostRequest(model: LlmModel, question: string, job: Job, context: GhostContext = {}, systemPrompt: string = GHOST_PROMPT): GhostRequest {
  return {
    model,
    max_tokens: GHOST_MAX_TOKENS,
    thinking: { type: "adaptive", display: "omitted" },
    output_config: { effort: analystEffort(model), format: { type: "json_schema", schema: answerFormat() } },
    system: systemPrompt,
    messages: [{ role: "user", content: ghostUserMessage(question, job, context) }],
  };
}

/**
 * The worst case of one GHOST answer on `model`, booked before it is sent: pricing.ts's pre-request
 * estimate of the longest request it can send (a question of QUESTION_MAX_CHARS under any job, with
 * every catalogue market, the longest metro's areas and GHOST_EARLIER_MAX earlier questions as long)
 * with all of GHOST_MAX_TOKENS billed as output. One request: the client never retries (GHOST_MAX_RETRIES).
 */
export function ghostWorstCaseUsd(model: LlmModel, geo: Pick<GeoApi, "metros" | "neighbourhoods"> = gazetteer()): number {
  const longest = "x".repeat(QUESTION_MAX_CHARS);
  const earlier = Array.from({ length: GHOST_EARLIER_MAX }, () => longest);
  const metros = [null, ...geo.metros()];
  const chars = Math.max(
    ...Job.options.flatMap((job) =>
      metros.map((metro) => JSON.stringify(ghostRequest(model, longest, job, { markets: GHOST_MARKETS, metro, geo, earlier })).length),
    ),
  );
  return estimateRequestUsd(model, chars, GHOST_MAX_TOKENS) * (GHOST_MAX_RETRIES + 1);
}

/** Controls, zero-width and bidi marks and line separators: nothing the reader should get from model text. */
const HIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;
const tidy = (s: string): string => s.replace(HIDDEN, " ").replace(/\s+/g, " ").trim();

/** Non-empty values in order, the first of each key kept. */
function distinct(values: readonly string[], key: (v: string) => string): string[] {
  const seen = new Set<string>();
  return values.filter((v) => {
    const k = key(v);
    if (v === "" || k === "" || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * The answer as stored: hidden characters removed and whitespace collapsed; per list the job fills
 * (GHOST_JOB_CATEGORIES) the first GHOST_PICKS_PER_CATEGORY names that differ under normaliseName
 * (the exact-match rule's key), so a name GHOST repeats is one pick; every other list empty, so its
 * names are never looked up, diffed or counted; each numeric claim once.
 */
export function tidyGhostAnswer(answer: GhostAnswer, job: Job): GhostAnswer {
  const lists: readonly GhostPickCategory[] = GHOST_JOB_CATEGORIES[job];
  const picks = {} as GhostAnswer["picks"];
  for (const category of GhostPickCategory.options) {
    picks[category] = lists.includes(category) ? distinct(answer.picks[category].map(tidy), normaliseName).slice(0, GHOST_PICKS_PER_CATEGORY) : [];
  }
  return {
    headline: tidy(answer.headline),
    picks,
    numeric_claims: distinct(answer.numeric_claims.map(tidy), (c) => c),
  };
}

/**
 * What runGhost passes to messages.create: the signal, and the SDK's per-request timeout and
 * maxRetries, which the real client (createAnthropic) reads in place of its own settings.
 */
export type GhostRequestOptions = LlmRequestOptions & { timeout: number; maxRetries: number };

/**
 * One GHOST answer: one request, with GHOST_TIMEOUT_MS and no client retries. Throws GhostError for
 * API failures, refusals and unusable output, carrying what the attempt cost.
 */
export async function runGhost(options: GhostOptions): Promise<GhostResult> {
  const { model, signal } = options;
  if (!isPricedModel(model)) throw new Error(`runGhost: ${String(model)} is not an allowed model (D23)`);
  const systemPrompt = options.systemPrompt ?? GHOST_PROMPT;
  if (systemPrompt.trim() === "") throw new Error("runGhost: the GHOST system prompt is empty");
  if (sanitizeQuestion(options.question) === "") throw new GhostError("empty_question", "the question is empty", { retryable: false, model });

  const now = options.now ?? Date.now;
  const started = now();
  let message: Anthropic.Message;
  try {
    const request: GhostRequestOptions = { ...(signal ? { signal } : {}), timeout: GHOST_TIMEOUT_MS, maxRetries: GHOST_MAX_RETRIES };
    message = await options.anthropic.messages.create(ghostRequest(model, options.question, options.job, options, systemPrompt), request);
  } catch (err) {
    if (signal?.aborted) throw new GhostError("cancelled", "the GHOST request was cancelled", { retryable: false, model });
    const info = describeLlmError(err);
    throw new GhostError("api_error", `${info.kind}${info.status === null ? "" : ` (${info.status})`}: ${info.message}`, {
      retryable: info.retryable,
      model,
    });
  }

  const cost = { usage: tokenUsageOf(message.usage), usd: usdFor(model, message.usage), model };
  // stop_reason first, before any content is read.
  const refusal = toRefusal(message);
  if (refusal) {
    throw new GhostError("refusal", `the model refused${refusal.category === null ? "" : ` (${refusal.category})`}`, { retryable: false, refusal, ...cost });
  }
  if (message.stop_reason === "max_tokens") {
    throw new GhostError("max_tokens", `the answer was cut off at ${GHOST_MAX_TOKENS} tokens`, { retryable: true, ...cost });
  }

  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (text === undefined) throw new GhostError("no_output", `no text block (stop_reason ${message.stop_reason})`, { retryable: true, ...cost });
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new GhostError("invalid_json", `the output is not JSON: ${err instanceof Error ? err.message : String(err)}`, { retryable: true, ...cost });
  }
  const parsed = GhostAnswer.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
    throw new GhostError("invalid_answer", `not a valid GhostAnswer: ${issues.join("; ")}`, { retryable: true, ...cost });
  }
  return { answer: tidyGhostAnswer(parsed.data, options.job), usage: cost.usage, usd: cost.usd, ms: Math.max(0, now() - started), model };
}
