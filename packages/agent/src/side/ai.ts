import Anthropic from "@anthropic-ai/sdk";
import {
  AI_CONTEXT_LIMITS,
  AiContextBlock,
  AiContextItem,
  AiContextKind,
  MarketId,
  structuredOutputSchema,
  type Intent,
  type JsonSchema,
} from "@ct/contracts";
import { z } from "zod";
import { HAIKU_MODEL, SONNET_MODEL, type LlmModel } from "../anthropic";
import { toRefusal } from "../llm/stop";
import { tokenUsageOf, usdFor } from "../pricing";
import { MARKET_CATALOGUE } from "../run/markets";
import { contextCacheKey, readContext, writeContext } from "./cache";
import type { SideContextOptions } from "./index";
import { numberProblems } from "./numbers";
import { aiBlock, freeOutcome, SIDE_NOTES, type CallOutcome } from "./outcome";
import { AI_CONTEXT_SYSTEM, aiContextUser } from "./prompts";
import { cleanText } from "./text";

/**
 * "What AI knows (not verified)" (R4, DESIGN §2.2): one structured-output call for background a buyer
 * would expect (deals, footprint, local operators, brand-safety risks). It never states a number: code
 * drops any item that does. Only the validated presence market ids ever reach the ANALYST; the item
 * texts reach no model.
 */

export const AI_CONTEXT_MAX_TOKENS = 1200;
export const AI_CONTEXT_MODELS = { live: SONNET_MODEL, economy: HAIKU_MODEL } as const;

/** What the model writes; code validates every field again before it becomes a block. */
export const AiContextAnswer = z.strictObject({
  items: z.array(
    z.strictObject({
      topic: z.string().describe("A few words, no numbers."),
      text: z.string().describe("One sentence, no numbers of any kind."),
      kind: AiContextKind,
    }),
  ),
  presence_markets: z
    .array(z.string())
    .describe("Market ids from the MARKETS list where the subject is widely reported to already operate. Empty when unsure."),
});
export type AiContextAnswer = z.infer<typeof AiContextAnswer>;

let answerSchema: JsonSchema | undefined;
function answerFormat(): JsonSchema {
  answerSchema ??= structuredOutputSchema(AiContextAnswer);
  return answerSchema;
}

/**
 * Sonnet 5.5 turns thinking off with `between_tools`. If the API rejects it together with a format, the
 * call falls back once to adaptive thinking at low effort; after that fallback succeeds the process keeps
 * using adaptive (logged once).
 */
let useAdaptive = false;

/** Tests only: forget the between_tools fallback. */
export function resetAiLatch(): void {
  useAdaptive = false;
}

type Thinking = Anthropic.ThinkingConfigParam;

export function aiRequest(model: LlmModel, thinking: Thinking, user: string): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model,
    max_tokens: AI_CONTEXT_MAX_TOKENS,
    thinking,
    output_config: { effort: "low", format: { type: "json_schema", schema: answerFormat() } },
    system: AI_CONTEXT_SYSTEM,
    messages: [{ role: "user", content: user }],
  };
}

const KNOWN_MARKETS: ReadonlySet<string> = new Set(MARKET_CATALOGUE.map((m) => m.id));

/** Market ids that parse, exist in config/metros.json, deduped, at most AI_CONTEXT_LIMITS.presence. */
export function validPresence(ids: readonly unknown[]): MarketId[] {
  const out: MarketId[] = [];
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim().toLowerCase() : raw;
    const parsed = MarketId.safeParse(id);
    if (!parsed.success || !KNOWN_MARKETS.has(parsed.data) || out.includes(parsed.data)) continue;
    out.push(parsed.data);
    if (out.length >= AI_CONTEXT_LIMITS.presence) break;
  }
  return out;
}

const length = (s: string): number => Array.from(s).length;

/**
 * The block's items from the model's answer: cleaned, an item with a number dropped and counted, an
 * over-long or empty one dropped (never cut), duplicates dropped, at most AI_CONTEXT_LIMITS.items.
 */
export function aiItems(answer: AiContextAnswer): { items: AiContextItem[]; droppedForNumbers: number } {
  const items: AiContextItem[] = [];
  const seen = new Set<string>();
  let droppedForNumbers = 0;
  for (const raw of answer.items) {
    const topic = cleanText(raw.topic);
    const text = cleanText(raw.text);
    if (numberProblems(topic).length > 0 || numberProblems(text).length > 0) {
      droppedForNumbers += 1;
      continue;
    }
    if (topic === "" || text === "" || length(topic) > AI_CONTEXT_LIMITS.topic || length(text) > AI_CONTEXT_LIMITS.text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    const item = AiContextItem.safeParse({ topic, text, kind: raw.kind });
    if (!item.success) continue;
    seen.add(key);
    items.push(item.data);
    if (items.length >= AI_CONTEXT_LIMITS.items) break;
  }
  return { items, droppedForNumbers };
}

export type AiCallInput = Pick<
  SideContextOptions,
  "question" | "intent" | "mode" | "subjectName" | "placeLabel" | "client" | "cache" | "config"
> & { signal: AbortSignal; now: () => number };

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * Presence ("already operates in") means stores or venues: only a brand the question names as its subject has
 * one. An artist's or comedian's home city is not a market they operate in, and a launch has no footprint yet.
 */
export function presenceApplies(intent: Pick<Intent, "mentions">): boolean {
  return intent.mentions.some((m) => m.role === "primary" && m.entity_type === "brand");
}

/** Never rejects: every path settles to a block (the handle owns timeouts and the run's abort). */
export async function runAiContext(o: AiCallInput): Promise<CallOutcome<AiContextBlock>> {
  if (!o.config.aiEnabled) return freeOutcome(aiBlock("off", SIDE_NOTES.aiOff));
  const model = AI_CONTEXT_MODELS[o.mode];
  const key = contextCacheKey({ kind: "ai", model, question: o.question, intent: o.intent, subjectName: o.subjectName });

  const hit = await readContext(o.cache, key);
  if (hit !== null) {
    const parsed = AiContextBlock.safeParse(hit.body);
    if (parsed.success && (parsed.data.status === "ok" || parsed.data.status === "empty")) {
      const block = { ...parsed.data, presenceMarkets: presenceApplies(o.intent) ? validPresence(parsed.data.presenceMarkets) : [], cached: true };
      return freeOutcome(block, parsed.data.model);
    }
  }

  const user = aiContextUser(o);
  const live = model === SONNET_MODEL;
  const thinking: Thinking = !live ? { type: "disabled" } : useAdaptive ? { type: "adaptive" } : { type: "between_tools" };
  const send = (t: Thinking) => o.client.create(aiRequest(model, t, user), { signal: o.signal, timeout: o.config.aiTimeoutMs });

  let message: Anthropic.Message;
  try {
    message = await send(thinking);
  } catch (err) {
    if (o.signal.aborted || !(live && thinking.type === "between_tools" && err instanceof Anthropic.BadRequestError)) {
      return freeOutcome(aiBlock("failed", SIDE_NOTES.aiFailed));
    }
    try {
      message = await send({ type: "adaptive" });
    } catch {
      return freeOutcome(aiBlock("failed", SIDE_NOTES.aiFailed));
    }
    if (!useAdaptive) {
      useAdaptive = true;
      console.warn("[side] the API rejected thinking between_tools with a format; AI context now uses adaptive thinking at low effort");
    }
  }

  const answered = iso(o.now());
  const cost = { usd: usdFor(model, message.usage), usage: tokenUsageOf(message.usage), searches: 0, model };
  const fail = (note: string): CallOutcome<AiContextBlock> => ({ ...cost, block: aiBlock("failed", note, { model }) });
  // stop_reason first, before any content is read.
  if (toRefusal(message)) return fail(SIDE_NOTES.aiRefused);
  const text = message.content.find((b): b is Anthropic.TextBlock => b.type === "text")?.text;
  if (text === undefined || message.stop_reason === "max_tokens") return fail(SIDE_NOTES.aiFailed);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(SIDE_NOTES.aiFailed);
  }
  const answer = AiContextAnswer.safeParse(json);
  if (!answer.success) return fail(SIDE_NOTES.aiFailed);

  const { items, droppedForNumbers } = aiItems(answer.data);
  const presenceMarkets = o.subjectName === null || !presenceApplies(o.intent) ? [] : validPresence(answer.data.presence_markets);
  const status = items.length > 0 ? "ok" : "empty";
  const block = AiContextBlock.parse(
    aiBlock(status, status === "empty" ? SIDE_NOTES.aiEmpty : null, { items, presenceMarkets, model, generatedAt: answered, droppedForNumbers }),
  );
  await writeContext(o.cache, { key, kind: "ai", model, body: block, usd: cost.usd });
  return { ...cost, block };
}
