import Anthropic from "@anthropic-ai/sdk";
import { WEB_CONTEXT_LIMITS, WebContextBlock, WebContextItem, type TokenUsage } from "@ct/contracts";
import { HAIKU_MODEL } from "../anthropic";
import { GHOST_MARKETS } from "../ghost/places";
import { toRefusal } from "../llm/stop";
import { addTokenUsage, emptyTokenUsage, tokenUsageOf, usdFor } from "../pricing";
import { contextCacheKey, readContext, writeContext } from "./cache";
import type { SideContextOptions } from "./index";
import { unbackedNumbers } from "./numbers";
import { freeOutcome, SIDE_NOTES, webBlock, type CallOutcome } from "./outcome";
import { webContextSystem, webContextUser } from "./prompts";
import { cleanText, cutTitle } from "./text";

/**
 * "From the web" (R5, DESIGN §2.3): Haiku 5.5 with Anthropic's server web search writes a few short
 * sentences; code keeps only sentences backed by a search citation, takes the link, title and dates from
 * the response itself, and drops any sentence whose numbers its cited passage does not state. Page text
 * is untrusted: the block is only displayed, escaped, with its link. It never reaches CLERK, the ANALYST,
 * a candidate set or a metric.
 */

export const WEB_CONTEXT_MODEL = HAIKU_MODEL;
export const WEB_CONTEXT_MAX_TOKENS = 1500;
/** Basic web search: the dynamic-filtering variant needs a Sonnet or Opus model. */
export const WEB_SEARCH_TOOL_TYPE = "web_search_20250305";
/** `pause_turn` continuations allowed inside the timeout. */
export const WEB_MAX_CONTINUATIONS = 2;
/** USD per billed search ($10 per 1,000). index.ts re-exports it as WEB_SEARCH_USD_PER_SEARCH. */
export const WEB_SEARCH_FEE_USD = 0.01;
export const WEB_CLAIM_MIN_CHARS = 20;
const MAX_URL_CHARS = 2048;

/** Sentences that address a model rather than state a fact are dropped (prompt injection in page text). */
export const INJECTION_RE = /ignore (all|previous)|system prompt|you are an? |as an ai/i;

/**
 * Sentences that advise instead of report ("a ticketing brand could fit", "we recommend") are dropped: the
 * block reports what sources say, and the measured answer is the only place that weighs a choice.
 */
export const ADVICE_RE =
  /\b(could|would|might|may) (also )?(be (a )?)?(good |strong |natural |great )?(fit|suit|match|work well)\b|\b(we|i) (would )?recommend\b|\byou (should|could|might)\b|\bconsider (partnering|adding|opening|targeting)\b/i;

/**
 * One text block as plain prose: heading lines (ending in a colon) are dropped and list markers removed, so a
 * sentence never starts with "Under-the-radar fits: -".
 */
function blockProse(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*\u2022]|\d{1,2}[.)])\s+/, "").trim())
    .filter((line) => line !== "" && !/:$/.test(line))
    .join(" ");
}

/**
 * Set when the API says web search is not enabled for this account: the process stops calling it until
 * restart (logged once), and every later block is `off` with the account note.
 */
let webSearchNotEnabled = false;

/** Tests only: forget the "not enabled" latch. */
export function resetWebLatch(): void {
  webSearchNotEnabled = false;
}

export function isWebSearchLatched(): boolean {
  return webSearchNotEnabled;
}

/**
 * A 400 invalid_request_error that says web search is not enabled. The SDK has no class for this case,
 * so the typed 400 is narrowed by the error body's type and message.
 */
export function isWebSearchNotEnabled(err: unknown): boolean {
  if (!(err instanceof Anthropic.BadRequestError)) return false;
  const body = err.error as { error?: { type?: unknown; message?: unknown } } | undefined;
  const type = body?.error?.type;
  const message = typeof body?.error?.message === "string" ? body.error.message : err.message;
  return (type === undefined || type === "invalid_request_error") && /web.?search/i.test(message) && /not (been )?enabled|disabled|not available|not allowed/i.test(message);
}

type UserLocation = Anthropic.UserLocation;

/** Approximate US location of the run's city (metro, else market), for more local results. */
export function webUserLocation(geo: { metro: string | null; market: string | null }): UserLocation {
  const id = geo.metro ?? geo.market;
  const market = id === null ? undefined : GHOST_MARKETS.find((m) => m.id === id);
  return {
    type: "approximate",
    country: "US",
    ...(market ? { city: market.label } : {}),
    ...(market?.stateName ? { region: market.stateName } : {}),
  };
}

export function webRequest(maxUses: number, user: string, location: UserLocation): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: WEB_CONTEXT_MODEL,
    max_tokens: WEB_CONTEXT_MAX_TOKENS,
    thinking: { type: "disabled" },
    output_config: { effort: "low" },
    system: webContextSystem(maxUses),
    tools: [{ type: WEB_SEARCH_TOOL_TYPE, name: "web_search", max_uses: maxUses, user_location: location }],
    messages: [{ role: "user", content: user }],
  };
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/\.$/, "");
  if (w.length < 3) return -1;
  return MONTHS.findIndex((m) => m.startsWith(w));
}

function isoDate(y: number, m: number, d: number): string | null {
  const date = new Date(Date.UTC(y, m, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

const DAY_MS = 86_400_000;
const RELATIVE_DAYS: Readonly<Record<string, number>> = { minute: 0, hour: 0, day: 1, week: 7 };

/**
 * page_age as a calendar date when it names one unambiguously: "2025-04-30", "April 30, 2025",
 * "Apr 30, 2025", "30 April 2025". A relative age ("3 days ago", "2 weeks ago", "5 hours ago",
 * "yesterday") becomes the date it points to from `retrievedAt`, when given, so a stored answer never
 * reads "3 days ago" a month later. Month and year ages are too coarse for a date, and numeric day/month
 * orders that could be read two ways give null.
 */
export function parsePageAge(pageAge: string | null, retrievedAt?: string): string | null {
  if (pageAge === null) return null;
  const s = pageAge.trim();
  if (retrievedAt !== undefined) {
    const base = Date.parse(retrievedAt);
    const rel = /^(\d{1,4}|an?) (minute|hour|day|week)s? ago$/i.exec(s);
    const days = rel
      ? (/^an?$/i.test(rel[1] ?? "") ? 1 : Number(rel[1])) * (RELATIVE_DAYS[(rel[2] ?? "").toLowerCase()] ?? 0)
      : /^today$/i.test(s) ? 0 : /^yesterday$/i.test(s) ? 1 : null;
    if (days !== null && Number.isFinite(base)) return new Date(base - days * DAY_MS).toISOString().slice(0, 10);
  }
  let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ].*)?$/.exec(s);
  if (m) return isoDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = /^([A-Za-z]+\.?) (\d{1,2}),? (\d{4})$/.exec(s);
  if (m) {
    const month = monthIndex(m[1] ?? "");
    return month < 0 ? null : isoDate(Number(m[3]), month, Number(m[2]));
  }
  m = /^(\d{1,2}) ([A-Za-z]+\.?),? (\d{4})$/.exec(s);
  if (m) {
    const month = monthIndex(m[2] ?? "");
    return month < 0 ? null : isoDate(Number(m[3]), month, Number(m[1]));
  }
  return null;
}

/** An http(s) link of at most 2048 characters without credentials, or null. */
export function safeUrl(raw: string): URL | null {
  if (raw.length > MAX_URL_CHARS) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "" || url.hostname === "") return null;
  return url;
}

export interface WebParse {
  items: WebContextItem[];
  droppedForNumbers: number;
  /** Search results seen across the response. */
  results: number;
  /** Error codes of search results that came back as an error object. */
  errors: string[];
}

const length = (s: string): number => Array.from(s).length;

/** Where a sentence ends inside model text: terminal punctuation, an optional closing quote, then space or end. */
const SENTENCE_END = /[.!?]["'\u201d\u2019)]?(?=\s|$)/g;

/**
 * The whole sentence a cited text block belongs to. The API splits the model's text at each citation, so a
 * cited block can be a fragment ("has gone after the segment"); the sentence is completed from the text
 * blocks either side, up to their sentence boundaries. Numbers in the completed sentence are still checked
 * against the cited passage, so a borrowed half-sentence can only cause a drop, never an unbacked figure.
 */
function sentenceOf(texts: readonly Anthropic.TextBlock[], index: number): string {
  const own = cleanText(blockProse(texts[index]?.text ?? ""));
  let head = "";
  if (!/^[\p{Lu}\p{N}"'\u201c\u2018]/u.test(own)) {
    for (let i = index - 1; i >= 0; i -= 1) {
      const prev = cleanText(blockProse(texts[i]?.text ?? ""));
      const ends = [...prev.matchAll(SENTENCE_END)];
      const last = ends.at(-1);
      head = (last === undefined ? prev : prev.slice((last.index ?? 0) + last[0].length)).trim() + (head === "" ? "" : ` ${head}`);
      if (last !== undefined) break;
    }
  }
  let tail = "";
  if (!/[.!?]["'\u201d\u2019)]?$/.test(own)) {
    for (let i = index + 1; i < texts.length; i += 1) {
      const next = cleanText(blockProse(texts[i]?.text ?? ""));
      const first = [...next.matchAll(SENTENCE_END)][0];
      tail += (tail === "" ? "" : " ") + (first === undefined ? next : next.slice(0, (first.index ?? 0) + first[0].length));
      if (first !== undefined) break;
    }
  }
  return cleanText([head, own, tail].filter((p) => p.trim() !== "").join(" "));
}

/**
 * Items from the response content only (DESIGN §2.3 steps 1-5). `retrievedAt` is when the response came.
 */
export function webItems(content: readonly Anthropic.ContentBlock[], retrievedAt: string): WebParse {
  const results = new Map<string, { title: string; pageAge: string | null }>();
  const errors: string[] = [];
  for (const block of content) {
    if (block.type !== "web_search_tool_result") continue;
    if (Array.isArray(block.content)) {
      for (const r of block.content) if (!results.has(r.url)) results.set(r.url, { title: r.title, pageAge: r.page_age });
    } else {
      errors.push(block.content.error_code);
    }
  }

  const items: WebContextItem[] = [];
  const seen = new Set<string>();
  let droppedForNumbers = 0;
  const texts = content.filter((b): b is Anthropic.TextBlock => b.type === "text");
  for (const [index, block] of texts.entries()) {
    const citation = (block.citations ?? []).find(
      (c): c is Anthropic.CitationsWebSearchResultLocation => c.type === "web_search_result_location",
    );
    if (!citation) continue;
    const claim = sentenceOf(texts, index);
    if (length(claim) < WEB_CLAIM_MIN_CHARS || length(claim) > WEB_CONTEXT_LIMITS.claim || INJECTION_RE.test(claim) || ADVICE_RE.test(claim)) continue;
    const url = safeUrl(citation.url);
    const result = results.get(citation.url);
    if (url === null || result === undefined) continue;
    const dedupe = claim.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
    if (seen.has(dedupe)) continue;
    const citedText = cleanText(citation.cited_text);
    if (unbackedNumbers(claim, citedText).length > 0) {
      droppedForNumbers += 1;
      continue;
    }
    const item = WebContextItem.safeParse({
      claim,
      url: citation.url,
      title: cutTitle(cleanText(citation.title ?? result.title), WEB_CONTEXT_LIMITS.title),
      publisher: url.hostname.replace(/^www\./i, ""),
      published: result.pageAge,
      publishedIso: parsePageAge(result.pageAge, retrievedAt),
      retrievedAt,
      citedText: cutTitle(citedText, WEB_CONTEXT_LIMITS.citedText),
    });
    if (!item.success) continue;
    seen.add(dedupe);
    items.push(item.data);
    if (items.length >= WEB_CONTEXT_LIMITS.items) break;
  }
  return { items, droppedForNumbers, results: results.size, errors };
}

const ERROR_NOTE: Readonly<Record<string, string>> = {
  too_many_requests: SIDE_NOTES.webBusy,
  unavailable: SIDE_NOTES.webUnavailable,
};

export type WebCallInput = Pick<
  SideContextOptions,
  "question" | "intent" | "mode" | "subjectName" | "placeLabel" | "client" | "cache" | "config"
> & { signal: AbortSignal; now: () => number };

/** WEB_SEARCH_MAX_USES clamped to 1..5. */
export const clampMaxUses = (n: number): number => (Number.isFinite(n) ? Math.min(5, Math.max(1, Math.round(n))) : 3);

const iso = (ms: number): string => new Date(ms).toISOString();

/** Never rejects: every path settles to a block (the handle owns timeouts and the run's abort). */
export async function runWebContext(o: WebCallInput): Promise<CallOutcome<WebContextBlock>> {
  if (!o.config.webEnabled) return freeOutcome(webBlock("off", SIDE_NOTES.webOff));
  if (o.mode !== "live") return freeOutcome(webBlock("off", SIDE_NOTES.webEconomy));
  if (webSearchNotEnabled) return freeOutcome(webBlock("off", SIDE_NOTES.webNotEnabled));
  const model = WEB_CONTEXT_MODEL;
  const key = contextCacheKey({ kind: "web", model, question: o.question, intent: o.intent, subjectName: o.subjectName });

  const hit = await readContext(o.cache, key);
  if (hit !== null) {
    const parsed = WebContextBlock.safeParse(hit.body);
    if (parsed.success && (parsed.data.status === "ok" || parsed.data.status === "empty")) {
      return freeOutcome({ ...parsed.data, cached: true }, parsed.data.model);
    }
  }

  const maxUses = clampMaxUses(o.config.webMaxUses);
  const request = webRequest(maxUses, webContextUser(o), webUserLocation(o.intent.geo));
  const content: Anthropic.ContentBlock[] = [];
  let usage: TokenUsage = emptyTokenUsage();
  let tokenUsd = 0;
  let searches = 0;
  let last: Anthropic.Message | null = null;
  const cost = (block: WebContextBlock): CallOutcome<WebContextBlock> => ({
    block,
    usd: tokenUsd + searches * WEB_SEARCH_FEE_USD,
    usage,
    searches,
    model: last === null ? null : model,
  });

  for (let turn = 0; turn <= WEB_MAX_CONTINUATIONS; turn += 1) {
    // A pause_turn continuation re-sends the assistant content unchanged; the API carries on from it.
    const body: Anthropic.MessageCreateParamsNonStreaming =
      content.length === 0 ? request : { ...request, messages: [...request.messages, { role: "assistant", content: content as Anthropic.ContentBlockParam[] }] };
    let message: Anthropic.Message;
    try {
      message = await o.client.create(body, { signal: o.signal, timeout: o.config.webTimeoutMs });
    } catch (err) {
      if (!o.signal.aborted && isWebSearchNotEnabled(err)) {
        if (!webSearchNotEnabled) console.warn("[side] web search is not enabled for this API account; web context is off until restart");
        webSearchNotEnabled = true;
        return cost(webBlock("off", SIDE_NOTES.webNotEnabled));
      }
      return cost(webBlock("failed", SIDE_NOTES.webFailed, last === null ? {} : { model, searches }));
    }
    last = message;
    usage = addTokenUsage(usage, tokenUsageOf(message.usage));
    tokenUsd += usdFor(model, message.usage);
    searches += message.usage.server_tool_use?.web_search_requests ?? 0;
    if (toRefusal(message)) return cost(webBlock("failed", SIDE_NOTES.webRefused, { model, searches }));
    content.push(...message.content);
    if (message.stop_reason !== "pause_turn") break;
  }

  const retrievedAt = iso(o.now());
  const parsed = webItems(content, retrievedAt);
  const settled = { model, searches, retrievedAt, droppedForNumbers: parsed.droppedForNumbers };
  if (parsed.items.length === 0 && parsed.results === 0 && parsed.errors.length > 0) {
    const code = parsed.errors[0] ?? "";
    return cost(webBlock("failed", ERROR_NOTE[code] ?? SIDE_NOTES.webFailed, settled));
  }
  const status = parsed.items.length > 0 ? "ok" : "empty";
  const block = WebContextBlock.parse(webBlock(status, status === "empty" ? SIDE_NOTES.webEmpty : null, { ...settled, items: parsed.items }));
  const outcome = cost(block);
  await writeContext(o.cache, { key, kind: "web", model, body: block, usd: outcome.usd });
  return outcome;
}
