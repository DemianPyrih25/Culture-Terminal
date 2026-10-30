// Offline fixtures for the side context calls: a scripted SideClient, an in-memory ContextCache, an
// invented intent, and web-search response blocks with example.com links. No test touches the network.
import Anthropic from "@anthropic-ai/sdk";
import { EMPTY_CANDIDATES, type Intent } from "@ct/contracts";
import type { ContextCache, SideClient, SideConfig } from "../../src/side";
import { fakeGaMessage } from "../support/fake-anthropic";

export const CONFIG: SideConfig = { aiEnabled: true, webEnabled: true, webMaxUses: 3, aiTimeoutMs: 25_000, webTimeoutMs: 45_000 };

export function intentFixture(partial: Partial<Intent> = {}): Intent {
  return {
    pillar: "investment",
    job: "brand_health",
    mentions: [{ text: "Brightwave Soda", entity_type: "brand", role: "primary", public_figure: false }],
    geo: { metro: "austin", area: null, unsupported_place: null, market: null, target_metro: null, cities: [] },
    constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [], concept_description: null },
    safety: { allowed: true, category: null, reframe: null },
    read_as: { nearest: false, not_covered: [] },
    candidates: EMPTY_CANDIDATES,
    assumptions: [],
    mnemonic: "BRIGHTWAVE SODA <BRAND> HLTH",
    ...partial,
  };
}

type Step = Anthropic.Message | Error | ((req: Anthropic.MessageCreateParamsNonStreaming, signal?: AbortSignal) => Promise<Anthropic.Message>);

/** Plays `steps` in order, one per create(); records each request and its options. */
export function scriptedClient(steps: Step[]): SideClient & {
  requests: Anthropic.MessageCreateParamsNonStreaming[];
  options: ({ signal?: AbortSignal; timeout?: number } | undefined)[];
} {
  const queue = [...steps];
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const options: ({ signal?: AbortSignal; timeout?: number } | undefined)[] = [];
  return {
    requests,
    options,
    async create(req, opts) {
      requests.push(structuredClone(req));
      options.push(opts);
      const step = queue.shift();
      if (step === undefined) throw new Error("scriptedClient: no step left");
      if (step instanceof Error) throw step;
      if (typeof step === "function") return step(req, opts?.signal);
      return step;
    },
  };
}

/** A request that never answers until its signal aborts (then rejects as the SDK does). */
export const hangs = (_req: Anthropic.MessageCreateParamsNonStreaming, signal?: AbortSignal): Promise<Anthropic.Message> =>
  new Promise((_, reject) => {
    signal?.addEventListener("abort", () => reject(new Anthropic.APIUserAbortError()), { once: true });
  });

/** Answers `message` after `ms`. */
export const after =
  (ms: number, message: Anthropic.Message) =>
  (): Promise<Anthropic.Message> =>
    new Promise((resolve) => setTimeout(() => resolve(message), ms));

export function memoryCache(): ContextCache & { rows: Map<string, { body: unknown; kind: string; model: string; usd: number; ttlMs: number }> } {
  const rows = new Map<string, { body: unknown; kind: string; model: string; usd: number; ttlMs: number }>();
  return {
    rows,
    async get(key) {
      const row = rows.get(key);
      return row ? { body: structuredClone(row.body), createdAt: "2026-10-01T00:00:00.000Z" } : null;
    },
    async put(row) {
      rows.set(row.key, { body: structuredClone(row.body), kind: row.kind, model: row.model, usd: row.usd, ttlMs: row.ttlMs });
    },
  };
}

export function badRequest(message: string, type = "invalid_request_error"): Error {
  return new Anthropic.BadRequestError(400, { type: "error", error: { type, message } }, message, new Headers());
}

/** The AI call's structured answer as the API returns it. */
export function aiMessage(answer: unknown, partial: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return fakeGaMessage({
    model: "claude-sonnet-5-5",
    content: [{ type: "text", text: JSON.stringify(answer), citations: null }],
    ...partial,
  });
}

export const NOW = Date.parse("2026-10-30T12:00:00.000Z");

// Web search blocks -----------------------------------------------------------------------------------

export const searchUse = (id: string, query: string): Anthropic.ContentBlock =>
  ({ type: "server_tool_use", id, name: "web_search", input: { query }, caller: { type: "direct" } }) as Anthropic.ContentBlock;

export interface ResultFixture {
  url: string;
  title: string;
  page_age?: string | null;
}

export const searchResults = (toolUseId: string, results: ResultFixture[]): Anthropic.ContentBlock =>
  ({
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    caller: { type: "direct" },
    content: results.map((r) => ({ type: "web_search_result", url: r.url, title: r.title, page_age: r.page_age ?? null, encrypted_content: "enc" })),
  }) as Anthropic.ContentBlock;

export const searchError = (toolUseId: string, code: string): Anthropic.ContentBlock =>
  ({
    type: "web_search_tool_result",
    tool_use_id: toolUseId,
    caller: { type: "direct" },
    content: { type: "web_search_tool_result_error", error_code: code },
  }) as Anthropic.ContentBlock;

export const plain = (text: string): Anthropic.ContentBlock => ({ type: "text", text, citations: null });

export const cited = (text: string, url: string, citedText: string, title: string | null = null): Anthropic.ContentBlock => ({
  type: "text",
  text,
  citations: [{ type: "web_search_result_location", url, title, cited_text: citedText, encrypted_index: "idx" }],
});

export function webMessage(content: Anthropic.ContentBlock[], searches: number, partial: Partial<Anthropic.Message> = {}): Anthropic.Message {
  const base = fakeGaMessage();
  return fakeGaMessage({
    model: "claude-haiku-5-5",
    content,
    usage: { ...base.usage, input_tokens: 8000, output_tokens: 300, server_tool_use: { web_search_requests: searches, web_fetch_requests: 0 } },
    ...partial,
  });
}
