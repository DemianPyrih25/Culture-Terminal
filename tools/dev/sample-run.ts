// pnpm exec tsx tools/dev/sample-run.ts [--check]
//
// Writes the synthetic sample runs under apps/web/server/samples/ for local demos, UI tests and the
// replay player: the real runAgent with a scripted fake Anthropic and the mock Qloo transport
// (QLOO_MOCK semantics, a memory store), on a virtual clock. No model or Qloo call leaves the
// process, and every run is the same on every machine: fixed clock, fixed ids, invented entities
// (D29). --check writes nothing and exits 1 when a committed sample is out of date.
//
// sample-run.test.ts fails while a committed sample differs from what this script builds now.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import {
  runAgent,
  type AgentRunResult,
  type AnalystRequest,
  type AnalystStream,
  type AnthropicLike,
  type ClerkRequest,
  type LlmRequestOptions,
} from "@ct/agent";
import {
  DEFAULT_RUN_LIMITS,
  EMPTY_CANDIDATES,
  RunEvent,
  stampEvent,
  type DigestRow,
  type EventInput,
  type InsightsFilterType,
  type Intent,
  type ModelDigest,
  type QlooParams,
  type ReportDraftShape,
  type SubmitPlanInputShape,
} from "@ct/contracts";
import { sampleAiContext, sampleWebContext } from "../../apps/web/server/samples/context";
import {
  canonicalize,
  createMemoryQlooStore,
  createMockTransport,
  createQlooClient,
  type CanonicalRequest,
  type QlooClient,
  type QlooStore,
  type QlooTool,
  type Transport,
} from "@ct/qloo";
import { createMemoryPublicStore, createMockPublicTransport, createPublicDataClient, type PublicDataClient } from "@ct/publicdata";
import { discoveryParams, normaliseName, searchParams } from "@ct/quant";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const SAMPLES_DIR = path.join(ROOT, "apps", "web", "server", "samples");

/** The samples this script writes, by name: `<name>.events.json` in SAMPLES_DIR. */
export const SAMPLE_NAMES = ["brand-health", "brand-health-incomplete", "needs-input"] as const;
export type SampleName = (typeof SAMPLE_NAMES)[number];

export interface Sample {
  name: SampleName;
  /** Stamped events from run.created to run.end, each valid against the RunEvent schema. */
  events: RunEvent[];
}

/** The brief's question, with an invented brand. */
export const SAMPLE_QUESTION = "Is the Juniper Cola audience a moat or a niche?";
const SAMPLE_BRAND = "Juniper Cola";
/** The brief's verdict tag: what the library row and the running head print. */
const SAMPLE_TAG = "Taste island";
/**
 * The sample's Juniper Cola: an id the mock did not issue, which it describes from the id's hash
 * like any fixture id. Pair scores with such an id carry no same-genre bonus, so the brand tends to
 * rank low in its peers' rows and its closest match can sit outside its category. This id (a
 * beverages brand) was picked because it gives both, a taste island with an outside-category
 * neighbour: the story of the brand-health brief, which the mock's own universe brands do not show.
 */
const SAMPLE_ENTITY_ID = "sample-brand-juniper-cola-285";
const SAMPLE_CATEGORY_TAG = "urn:tag:genre:brand:mock_beverages";
/**
 * The two soft drinks the ANALYST expects Juniper Cola to compete with: mock universe brands outside
 * the scan's map whose pairs with Juniper Cola both carry a score, so the first prior is tested on both.
 */
const EXPECTED_RIVALS = ["Foxglove Cola", "Harbor Seltzer"] as const;

/** 2026-10-20 14:30:00 UTC: when the brand-health sample starts; the other samples follow it. */
const RUN_START = Date.UTC(2026, 9, 20, 14, 30, 0);
const DAY_MS = 86_400_000;

// What the cache holds, and what Qloo does, while a Juniper Cola sample runs. Between them, the run's
// Qloo calls take every cache status a brief shows: miss, hit, reused, stale and coalesced.

/** An earlier run fetched Juniper Cola's peer discovery this long before (served as REUSED). */
const EARLIER_RUN_ID = "b7e2a91f04c6-earlier";
const EARLIER_RUN_AGO_MS = (3 * 60 + 12) * 60_000;
/**
 * The Ask page previewed an earlier wording of the question this long before the run, leaving its
 * /search for the brand in the cache (served as a hit). A preview hands its reading only to the
 * question it read, so CLERK reads the reworded question afresh.
 */
const PREVIEW_AGO_MS = 41_000;
/**
 * A run this long before resolved the second rival. Its /search copy has expired (catalogue TTL 30 d)
 * but may still answer a failed call (up to four TTLs); during the samples Qloo fails that search
 * with 503s, so the client serves the old copy (STALE).
 */
const OLD_RUN_ID = "4d19c07a3e85-older";
const OLD_RUN_AGO_MS = 33 * DAY_MS;
const OUTAGE_SEARCH = EXPECTED_RIVALS[1];
/**
 * Another run on the same server maps the outside-category neighbour while the pivot does: it asks
 * for each of the neighbour's discovery calls a moment first, and the pivot's calls join its flights
 * (COALESCED).
 */
const CONCURRENT_RUN_ID = "e05f6b2d9a17-concurrent";

// Virtual time ------------------------------------------------------------------------------------------

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const activeClock = new AsyncLocalStorage<VirtualClock>();
let installs = 0;

class VirtualTimer {
  constructor(
    readonly clock: VirtualClock,
    readonly seq: number,
    readonly due: number,
    readonly fire: () => void,
  ) {}
  // The Timeout surface code may call (the Qloo quota tracker unrefs its timer).
  unref(): this {
    return this;
  }
  ref(): this {
    return this;
  }
  hasRef(): boolean {
    return true;
  }
  [Symbol.toPrimitive](): number {
    return this.seq;
  }
}

/** Routes setTimeout to the virtual clock of the run it is called from; every other caller keeps real timers. */
function installVirtualTimers(): void {
  if (installs++ > 0) return;
  const virtualSetTimeout = (fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    const clock = activeClock.getStore();
    return clock ? clock.schedule(() => fn(...args), ms ?? 0) : realSetTimeout(fn, ms, ...args);
  };
  const virtualClearTimeout = (handle: unknown) => {
    if (handle instanceof VirtualTimer) handle.clock.cancel(handle);
    else realClearTimeout(handle as Parameters<typeof clearTimeout>[0]);
  };
  globalThis.setTimeout = virtualSetTimeout as unknown as typeof setTimeout;
  globalThis.clearTimeout = virtualClearTimeout as unknown as typeof clearTimeout;
}

function uninstallVirtualTimers(): void {
  if (--installs > 0) return;
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}

/** How long real work may keep a run waiting with no virtual timer set before the run counts as stuck. */
const REAL_WAIT_MS = 5_000;

/** Lets every pending promise chain settle: real immediates run only once the microtask queue is empty. */
async function idle(): Promise<void> {
  for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

/**
 * A discrete-event clock. Work started by run() sees virtual time: setTimeout, sleep() and now()
 * all read this clock, and time jumps to the next timer only once every promise has settled, so
 * timers fire in due order (ties in the order they were set) and the output never depends on how
 * fast the machine is.
 */
export class VirtualClock {
  #now: number;
  #seq = 0;
  readonly #timers = new Set<VirtualTimer>();

  constructor(start: number) {
    this.#now = start;
  }

  readonly now = (): number => this.#now;

  schedule(fire: () => void, ms: number): VirtualTimer {
    const timer = new VirtualTimer(this, ++this.#seq, this.#now + Math.max(0, ms), fire);
    this.#timers.add(timer);
    return timer;
  }

  cancel(timer: VirtualTimer): void {
    this.#timers.delete(timer);
  }

  /** Resolves `ms` of virtual time from now, or rejects with the signal's reason when it aborts first. */
  readonly sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      const onAbort = () => {
        this.cancel(timer);
        reject(signal?.reason);
      };
      const timer = this.schedule(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });

  /** Moves an idle clock forward, e.g. to the next scene of a sample. */
  advanceTo(at: number): void {
    if (this.#timers.size > 0) throw new Error("the virtual clock cannot jump while timers are pending");
    this.#now = Math.max(this.#now, at);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    installVirtualTimers();
    try {
      let settled = false;
      const result = activeClock.run(this, work).finally(() => {
        settled = true;
      });
      result.catch(() => {});
      for (;;) {
        await idle();
        if (settled) break;
        const next = this.#next();
        if (next === undefined) {
          // Real work is still on its way, such as a module loaded on first use: wait for it.
          await this.#realProgress(() => settled);
          continue;
        }
        this.#timers.delete(next);
        this.#now = Math.max(this.#now, next.due);
        activeClock.run(this, next.fire);
      }
      // Timers left behind (a quota write, a disposed deadline) belong to no later scene.
      this.#timers.clear();
      return await result;
    } finally {
      uninstallVirtualTimers();
    }
  }

  async #realProgress(settled: () => boolean): Promise<void> {
    const deadline = Date.now() + REAL_WAIT_MS;
    while (!settled() && this.#timers.size === 0) {
      if (Date.now() > deadline) throw new Error("the virtual clock has no timer left, but the work is still waiting");
      await new Promise<void>((resolve) => realSetTimeout(resolve, 5));
    }
  }

  #next(): VirtualTimer | undefined {
    let best: VirtualTimer | undefined;
    for (const t of this.#timers) if (best === undefined || t.due < best.due || (t.due === best.due && t.seq < best.seq)) best = t;
    return best;
  }
}

// Qloo: the mock transport with latency, and Juniper Cola as a fixture entity ----------------------------

/** A network round trip of 240–620 ms, fixed by the request. */
const latencyOf = (request: CanonicalRequest): number => 240 + (Number.parseInt(request.key.slice(0, 6), 16) % 381);

const decoder = new TextDecoder();
const encoder = new TextEncoder();

interface SearchRow {
  entity_id: string;
  name: string;
  [key: string]: unknown;
}

const isSearchFor = (request: CanonicalRequest, name: string): boolean =>
  request.path === "/search" && normaliseName(request.query.query ?? "") === normaliseName(name);

/**
 * The mock transport, plus two changes. /search for the sample brand answers with the fixture entity
 * as its exact match, described by the mock's own /entities (so its tags and popularity agree with
 * every later score) under the searched name; the near variants stay the mock's. And from
 * `outageFrom` on, /search for OUTAGE_SEARCH fails with a 503 on every attempt.
 */
function sampleTransport(clock: VirtualClock, outageFrom: number): Transport {
  const mock = createMockTransport();
  return async (request, signal) => {
    await clock.sleep(latencyOf(request), signal);
    const reply = await mock(request, signal);
    if (isSearchFor(request, OUTAGE_SEARCH) && clock.now() >= outageFrom) {
      return { ...reply, status: 503, body: encoder.encode(JSON.stringify({ error: "Service Unavailable" })) };
    }
    if (!isSearchFor(request, SAMPLE_BRAND)) return reply;
    const described = await mock(canonicalize("/entities", { entity_ids: [SAMPLE_ENTITY_ID] }, "mock-v1"), signal);
    const fixture = (JSON.parse(decoder.decode(described.body)) as { results: SearchRow[] }).results[0];
    if (fixture === undefined) throw new Error("the mock did not describe the sample entity");
    const body = JSON.parse(decoder.decode(reply.body)) as { results: SearchRow[] };
    body.results[0] = { ...fixture, name: SAMPLE_BRAND };
    return { ...reply, body: encoder.encode(JSON.stringify(body)) };
  };
}

/**
 * A memory store that keeps no response entries, so the client serves every cached answer, fresh or
 * expired, from its in-process L1. An L2 read gunzips the body on the thread pool in real time: the
 * virtual clock cannot see that work, and could move time on before the lookup lands.
 */
function l1OnlyStore(): QlooStore {
  return { ...createMemoryQlooStore(), getEntry: async () => null, putEntry: async () => {}, pinEntry: async () => false };
}

function sampleQloo(clock: VirtualClock, outageFrom: number): QlooClient {
  return createQlooClient({
    transport: sampleTransport(clock, outageFrom),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "sample-run",
    tagCap: null,
    rps: 3,
    store: l1OnlyStore(),
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
  });
}

/**
 * The SEC and Census client on the mock transport (QLOO_MOCK semantics: invented, deterministic). The
 * sample brand is invented and not a listed company, so its scan plans no company_financials step;
 * the client is passed so the run is built the way the app builds one.
 */
function samplePublicData(clock: VirtualClock): PublicDataClient {
  return createPublicDataClient({
    env: "mock",
    transport: createMockPublicTransport({ now: clock.now }),
    store: createMemoryPublicStore(),
    tag: "sample-run",
    secUserAgent: null,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
  });
}

const otherRun = (qloo: QlooClient, runId: string) =>
  qloo.forRun({ runId, lane: "public", pillar: "investment", limits: DEFAULT_RUN_LIMITS, phase: () => "scan" });

function brandSearch(text: string): QlooParams {
  const params = searchParams({ text, type: "brand", metro: null });
  if (params === null) throw new Error(`no /search parameters for ${text}`);
  return params;
}

/**
 * What earlier work left in the cache: an old run's /search for the second rival (expired by the
 * sample, served STALE), a recent run's peer discovery (REUSED) and the Ask preview's /search (a hit).
 */
async function warmCache(clock: VirtualClock, qloo: QlooClient, runStart: number): Promise<void> {
  clock.advanceTo(runStart - OLD_RUN_AGO_MS);
  await clock.run(async () => {
    await otherRun(qloo, OLD_RUN_ID).forTool("toolu_old_resolve").search(brandSearch(OUTAGE_SEARCH));
  });
  clock.advanceTo(runStart - EARLIER_RUN_AGO_MS);
  await clock.run(async () => {
    const tool = otherRun(qloo, EARLIER_RUN_ID).forTool("scan-1");
    await tool.insights("urn:entity:brand", discoveryParams(SAMPLE_ENTITY_ID, SAMPLE_CATEGORY_TAG));
    await tool.insights("urn:entity:brand", discoveryParams(SAMPLE_ENTITY_ID, null));
  });
  clock.advanceTo(runStart - PREVIEW_AGO_MS);
  await clock.run(async () => {
    await qloo.standalone().forTool(null).search(brandSearch(SAMPLE_BRAND));
  });
}

/** A peer discovery call for a target other than Juniper Cola: the pivot's, on the neighbour. */
function isNeighbourDiscovery(params: QlooParams): boolean {
  const signal = params["signal.interests.entities"];
  return (
    params["filter.exclude.entities"] !== undefined &&
    Array.isArray(signal) &&
    signal.length === 1 &&
    signal[0] !== SAMPLE_ENTITY_ID
  );
}

/**
 * The client as the sample run sees it while CONCURRENT_RUN_ID maps the outside-category neighbour:
 * that run asks for each of the neighbour's discovery calls just before the sample run does, so the
 * sample's call joins its flight. Everything else goes straight to `qloo`.
 */
function alongsideConcurrentRun(qloo: QlooClient): QlooClient {
  let concurrent: QlooTool | null = null;
  const withConcurrent = (tool: QlooTool): QlooTool => ({
    ...tool,
    insights: <F extends InsightsFilterType>(filterType: F, params: QlooParams) => {
      if (isNeighbourDiscovery(params)) {
        concurrent ??= otherRun(qloo, CONCURRENT_RUN_ID).forTool("scan-1");
        // Both calls register their flights before their first await: the concurrent run's leads.
        concurrent.insights(filterType, params).catch(() => {});
      }
      return tool.insights(filterType, params);
    },
  });
  return {
    env: qloo.env,
    baseUrl: qloo.baseUrl,
    monthFloor: qloo.monthFloor,
    forRun: (scope) => {
      const run = qloo.forRun(scope);
      return { ...run, forTool: (toolCallId) => withConcurrent(run.forTool(toolCallId)) };
    },
    standalone: (options) => qloo.standalone(options),
    quota: () => qloo.quota(),
    pin: (path, params) => qloo.pin(path, params),
    flush: () => qloo.flush(),
  };
}

// The scripted model ---------------------------------------------------------------------------------------

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaContentBlock = Anthropic.Beta.BetaContentBlock;

interface Tokens {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

function betaUsage(t: Tokens): Anthropic.Beta.BetaUsage {
  return {
    cache_creation: null,
    cache_creation_input_tokens: t.cacheWrite ?? 0,
    cache_read_input_tokens: t.cacheRead ?? 0,
    fallback_credit: null,
    inference_geo: null,
    input_tokens: t.input,
    iterations: null,
    output_tokens: t.output,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: "standard",
    speed: null,
  };
}

/** One scripted ANALYST response. */
interface ModelTurn {
  /** Virtual time the whole response takes. */
  ms: number;
  /** Thinking updates, streamed one at a time across the response; read from the request when they name what came back. */
  thinking: readonly string[] | ((request: AnalystRequest) => string[]);
  tokens: Tokens;
  /** The response blocks, read from the request the model was sent (digests, ids). */
  content(request: AnalystRequest): BetaContentBlock[];
}

interface ClerkTurn {
  ms: number;
  intent: Intent;
  tokens: Tokens;
}

const abortError = () => new Anthropic.APIUserAbortError();

const toolUse = (id: string, name: string, input: unknown): Anthropic.Beta.BetaToolUseBlock => ({ type: "tool_use", id, name, input });

/**
 * The SDK surface runAgent calls, answering from a script on the virtual clock: CLERK after
 * `ms`, and each ANALYST response with its thinking spread evenly over `ms`, so the run's note
 * events arrive as they would from a live stream (coalesced by the agent's 300 ms timer).
 */
class ScriptedAnthropic implements AnthropicLike {
  readonly beta: AnthropicLike["beta"];
  readonly messages: AnthropicLike["messages"];
  #turn = 0;

  constructor(clock: VirtualClock, clerk: ClerkTurn, turns: readonly ModelTurn[]) {
    this.messages = {
      create: async (_body: ClerkRequest, options?: LlmRequestOptions): Promise<Anthropic.Message> => {
        await clock.sleep(clerk.ms, options?.signal).catch(() => Promise.reject(abortError()));
        return {
          id: "msg_sample_clerk",
          container: null,
          content: [{ type: "text", text: JSON.stringify(clerk.intent), citations: null }],
          diagnostics: null,
          model: "claude-haiku-5-5",
          role: "assistant",
          stop_details: null,
          stop_reason: "end_turn",
          stop_sequence: null,
          type: "message",
          usage: {
            cache_creation: null,
            cache_creation_input_tokens: clerk.tokens.cacheWrite ?? 0,
            cache_read_input_tokens: clerk.tokens.cacheRead ?? 0,
            inference_geo: null,
            input_tokens: clerk.tokens.input,
            output_tokens: clerk.tokens.output,
            output_tokens_details: null,
            server_tool_use: null,
            service_tier: "standard",
          },
        };
      },
    };
    this.beta = {
      messages: {
        stream: (body: AnalystRequest, options?: LlmRequestOptions): AnalystStream => {
          const index = this.#turn++;
          const turn = turns[index];
          if (turn === undefined) throw new Error(`the sample script has no ANALYST response #${index + 1}`);
          return new ScriptedStream(clock, turn, body, index, options?.signal);
        },
      },
    };
  }
}

class ScriptedStream implements AnalystStream {
  readonly #listeners: Array<(delta: string, snapshot: string) => void> = [];
  readonly #final: Promise<BetaMessage>;

  constructor(clock: VirtualClock, turn: ModelTurn, body: AnalystRequest, index: number, signal: AbortSignal | undefined) {
    this.#final = this.#play(clock, turn, body, index, signal);
    this.#final.catch(() => {});
  }

  async #play(clock: VirtualClock, turn: ModelTurn, body: AnalystRequest, index: number, signal: AbortSignal | undefined): Promise<BetaMessage> {
    await null; // listeners attach synchronously after stream() returns
    const updates = typeof turn.thinking === "function" ? turn.thinking(body) : turn.thinking;
    const content = turn.content(body);
    const step = turn.ms / (updates.length + 1);
    try {
      for (const update of updates) {
        await clock.sleep(step, signal);
        // Each update is a thinking block of its own: delta and snapshot are the same text.
        for (const listener of this.#listeners) listener(update, update);
      }
      await clock.sleep(step, signal);
    } catch {
      throw abortError();
    }
    const thinking = updates.map((t): Anthropic.Beta.BetaThinkingBlock => ({ type: "thinking", thinking: t, signature: "sig_sample" }));
    return {
      id: `msg_sample_${index + 1}`,
      container: null,
      content: [...thinking, ...content],
      context_management: null,
      diagnostics: null,
      model: "claude-sonnet-5-5",
      role: "assistant",
      stop_details: null,
      stop_reason: "tool_use",
      stop_sequence: null,
      type: "message",
      usage: betaUsage(turn.tokens),
    };
  }

  on(event: "thinking", listener: (delta: string, snapshot: string) => void): this {
    if (event === "thinking") this.#listeners.push(listener);
    return this;
  }

  finalMessage(): Promise<BetaMessage> {
    return this.#final;
  }
}

// Reading what the model was sent ---------------------------------------------------------------------------

type Block = Anthropic.Beta.BetaContentBlockParam;

/** Every text the model was sent in user messages: tool results and text blocks, in order. */
function userTexts(request: AnalystRequest): string[] {
  const out: string[] = [];
  for (const m of request.messages) {
    if (m.role !== "user") continue;
    const blocks: Block[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : (m.content as Block[]);
    for (const b of blocks) {
      if (b.type === "text") out.push(b.text);
      if (b.type === "tool_result") out.push(typeof b.content === "string" ? b.content : JSON.stringify(b.content));
    }
  }
  return out;
}

interface SeenDigest {
  tool: string;
  step: string | null;
  digest: ModelDigest;
}

/** The digests inside every <qloo_data> wrapper the model has seen so far, in order. */
function digestsIn(request: AnalystRequest): SeenDigest[] {
  const out: SeenDigest[] = [];
  for (const t of userTexts(request)) {
    for (const m of t.matchAll(/<qloo_data tool="([A-Z]+)"(?: step="(S\d+)")?>(.*?)<\/qloo_data>/gs)) {
      out.push({ tool: m[1] ?? "", step: m[2] ?? null, digest: JSON.parse(m[3] ?? "{}") as ModelDigest });
    }
  }
  return out;
}

function must<T>(value: T | undefined | null, what: string): T {
  if (value === undefined || value === null) throw new Error(`sample script: ${what} is missing from the digests`);
  return value;
}

/** A fact the scripted prose states; the digests must still bear it out. */
function claim(holds: boolean, fact: string): void {
  if (!holds) throw new Error(`sample script: the digests no longer show that ${fact}; update the script's prose`);
}

/** The metric whose label matches, in one digest. */
function metricId(digest: ModelDigest, label: RegExp, what: string): string {
  return must(digest.metrics.find((m) => label.test(m.label) && m.badge !== "UNAVAILABLE"), what).id;
}

function findingOf(digests: readonly SeenDigest[], kind: string): { id: string; text: string } {
  return must(digests.flatMap((d) => d.digest.findings).find((f) => f.kind === kind), `a ${kind} finding`);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The brand-health script ----------------------------------------------------------------------------------

const INTENT: Intent = {
  pillar: "investment",
  job: "brand_health",
  mentions: [{ text: SAMPLE_BRAND, entity_type: "brand", role: "primary", public_figure: false }],
  geo: { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: [] },
  constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [], concept_description: null },
  safety: {
    allowed: true,
    category: "financial_advice",
    reframe: "How distinct and how central Juniper Cola's audience taste is among the brands it shares taste with",
  },
  read_as: { nearest: false, not_covered: [] },
  candidates: EMPTY_CANDIDATES,
  assumptions: ["US taste data", "Moat read as a distinct audience taste, not as market share"],
  mnemonic: "JUNIPER COLA <BRAND> HLTH",
};

const CLERK: ClerkTurn = { ms: 1_380, intent: INTENT, tokens: { input: 2_412, output: 236 } };

const [RIVAL_A, RIVAL_B] = EXPECTED_RIVALS;

const PLAN: SubmitPlanInputShape = {
  restated_question:
    "Is Juniper Cola's audience a moat (a taste its peers cannot easily share) or a niche at the edge of the soft-drink category?",
  hypotheses: [
    {
      id: "H1",
      statement: `Juniper Cola competes most closely with ${RIVAL_A} and ${RIVAL_B}.`,
      expectation: `Both rank above every other peer in the Juniper Cola row.`,
      test_tool: "peer_landscape",
      metric_hint: `similarity of Juniper Cola to ${RIVAL_A} and ${RIVAL_B} against its nearest peer`,
    },
    {
      id: "H2",
      statement: "Juniper Cola sits near the centre of its category: most peers count it among their closest matches.",
      expectation: "A hub score above the middle of the map, and not last in most peer rows.",
      test_tool: "peer_landscape",
      metric_hint: "hub score and taste-island test for Juniper Cola",
    },
    {
      id: "H3",
      statement: "Juniper Cola's audience taste is distinctive within soft drinks.",
      expectation: "A distinctiveness rank in the top two of the map.",
      test_tool: "peer_landscape",
      metric_hint: "distinctiveness rank of Juniper Cola",
    },
    {
      id: "H4",
      statement: "Juniper Cola's audience has a second home outside beverages.",
      expectation: "Its closest match outside the category ranks Juniper Cola near the top of its own map.",
      test_tool: "peer_landscape",
      metric_hint: "rank of Juniper Cola in its outside neighbour's own map",
    },
  ],
  steps: [
    { id: "S1", tool: "peer_landscape", purpose: "Map Juniper Cola against its nearest peers; the opening scan runs this." },
    { id: "S2", tool: "resolve_entities", purpose: `Resolve ${RIVAL_A} and ${RIVAL_B}, the rivals the first prior names.` },
    { id: "S3", tool: "peer_landscape", purpose: "Score Juniper Cola against the two rivals on one scale, with its nearest peer from the scan as the yardstick." },
  ],
  assumptions: ["US taste data", "Peers chosen by discovery, plus the two named rivals"],
};

/** A brand the neighbour's own map ranks above Juniper Cola, with the metric holding its similarity to the neighbour. */
interface AheadBrand {
  name: string;
  similarity: string;
}

/** What the brief cites, read from the digests the model saw: refs, names, metric and evidence ids. */
interface Readings {
  neighbour: { ref: string; name: string; category: string };
  scan: { discovery: string; scoring: string; datasets: string[]; peers: number };
  island: string;
  hub: string;
  nearest: string;
  distinctiveness: string;
  /** The S3 map: Juniper Cola, both rivals and the neighbour, scored in one set of calls. */
  rivals: { scoring: string; datasets: string[]; a: string; b: string };
  /**
   * The neighbour's own map, where Juniper Cola is one of the peers: Juniper Cola's similarity to the
   * neighbour, its hub score there, and the brands the neighbour ranks above it.
   */
  pivot: { scoring: string; datasets: string[]; similarity: string; hub: string; ahead: AheadBrand[] };
}

const NUMBER_WORDS = ["no", "one", "two", "three", "four", "five", "six"];

const withArticle = (word: string): string => `${/^[aeiou]/i.test(word) ? "an" : "a"} ${word}`;

/** "Granite Outfitters'" and "Juniper Cola's". */
const possessive = (name: string): string => (name.endsWith("s") ? `${name}'` : `${name}'s`);

/** "A", "A and B", "A, B and C". */
const listOf = (items: readonly string[]): string =>
  items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;

/** The brands ahead, by name: "Kettle Denim and Pinecone Outfitters". */
const aheadNames = (ahead: readonly AheadBrand[]): string => listOf(ahead.map((b) => b.name));

/** The brands ahead with their similarity tokens: "Kettle Denim ({{M27}}) and Pinecone Outfitters ({{M31}})". */
const aheadWithScores = (ahead: readonly AheadBrand[]): string => listOf(ahead.map((b) => `${b.name} ({{${b.similarity}}})`));

/** The opening scan's Substitution Map of Juniper Cola. */
function scanDigest(digests: readonly SeenDigest[]): ModelDigest {
  return must(
    digests.find((d) => d.tool === "SUBS" && d.step === null && d.digest.top_rows[0]?.name === SAMPLE_BRAND),
    "the opening scan's Substitution Map",
  ).digest;
}

function neighbourOf(digests: readonly SeenDigest[]): Readings["neighbour"] {
  const row = must(
    scanDigest(digests).top_rows.find((r) => r.values.role === "outside_category"),
    "the outside-category neighbour's row",
  );
  const finding = findingOf(digests, "OUTSIDE_CATEGORY_NEIGHBOUR");
  const category = must(/\(([^)]+)\) sits outside/.exec(finding.text)?.[1], "the outside-category neighbour's category");
  return { ref: must(row.ref, "the neighbour's ref"), name: row.name, category: category.toLowerCase() };
}

function evidencePair(digest: ModelDigest, what: string): { discovery: string; scoring: string } {
  const ids = digest.evidence_ids;
  return { discovery: must(ids.length > 1 ? ids[0] : undefined, `the discovery evidence of ${what}`), scoring: must(ids.at(-1), `the scoring evidence of ${what}`) };
}

/** "0.17 · rank 3 of 4" → [3, 4]. */
function rankOf(display: string): [number, number] | null {
  const m = /rank (\d+) of (\d+)$/.exec(display);
  return m ? [Number(m[1]), Number(m[2])] : null;
}

const rowRank = (row: DigestRow): number | null => (typeof row.values.rank_to_target === "number" ? row.values.rank_to_target : null);

function readings(request: AnalystRequest): Readings {
  const digests = digestsIn(request);
  const scan = scanDigest(digests);
  const neighbour = neighbourOf(digests);
  const rivals = must(digests.find((d) => d.tool === "SUBS" && d.step === "S3"), "the S3 rival map").digest;
  const pivot = must(
    digests.find((d) => d.tool === "SUBS" && d.step === null && d.digest.top_rows[0]?.name === neighbour.name),
    "the neighbour's own map",
  ).digest;
  const brand = escapeRe(SAMPLE_BRAND);
  const similarityTo = (name: string) =>
    must(
      rivals.metrics.find((m) => new RegExp(`^(?:similarity|near-substitutes) ${brand}–${escapeRe(name)}\\b`).test(m.label) && m.badge !== "UNAVAILABLE")?.id,
      `a score for Juniper Cola and ${name} in the S3 map`,
    );
  const read = {
    island: metricId(scan, new RegExp(`^taste-island test for ${brand}`), "the taste-island test"),
    hub: metricId(scan, new RegExp(`^hub score of ${brand} \\(`), "the hub score"),
    nearest: metricId(scan, /\(nearest peer\)$/, "the nearest-peer similarity"),
    distinctiveness: metricId(scan, new RegExp(`^distinctiveness rank of ${brand}`), "the distinctiveness rank"),
    rivalA: similarityTo(RIVAL_A),
    rivalB: similarityTo(RIVAL_B),
  };

  // The neighbour's own map: Juniper Cola's rank in the neighbour's row, and the brands above it.
  const own = must(pivot.top_rows.find((r) => r.name === SAMPLE_BRAND), "Juniper Cola's row in the neighbour's map");
  const rank = must(rowRank(own), "Juniper Cola's rank in the neighbour's row");
  const aheadRows = pivot.top_rows.filter((r) => r.name !== SAMPLE_BRAND && (rowRank(r) ?? Infinity) < rank);
  const ahead = aheadRows.map((r) => ({
    name: r.name,
    similarity: String(must(r.values.similarity_metric, `the similarity of ${r.name} in the neighbour's map`)),
  }));
  const pivotHub = String(must(own.values.hub_metric, "Juniper Cola's hub score in the neighbour's map"));
  const scanPeers = scan.top_rows.filter((r) => r.name !== SAMPLE_BRAND && r.values.in_map !== "no");

  // The brief's wording states these outright; a change in the mock or the skill must fail here, not mislead.
  const display = (digest: ModelDigest, id: string) => digest.metrics.find((m) => m.id === id)?.display ?? "";
  claim(display(scan, read.island).includes("taste island"), "Juniper Cola is a taste island");
  claim(/rank (\d+) of \1$/.test(display(scan, read.hub)), "Juniper Cola has the lowest hub score in its map");
  claim(display(scan, read.distinctiveness).startsWith("1 of "), "Juniper Cola is the most distinct brand in its map");
  const nearest = Number.parseFloat(display(scan, read.nearest));
  for (const id of [read.rivalA, read.rivalB]) {
    claim(Number.parseFloat(display(rivals, id)) < nearest, "both rivals sit below the nearest match");
  }
  claim(NUMBER_WORDS[scanPeers.length] !== undefined, "the scan's map has at most six peers");
  const outside = scanPeers.filter((r) => r.values.in_category === "no");
  claim(outside.length === 1 && outside[0]?.name === neighbour.name, `${neighbour.name} is the one peer outside beverages in the scan's map`);
  claim(rank > 1 && ahead.length === rank - 1, `${neighbour.name} ranks other brands above Juniper Cola in its own row`);
  claim(aheadRows.every((r) => r.values.in_category === "yes"), `the brands ${neighbour.name} ranks above Juniper Cola are ${neighbour.category} brands`);
  const hubRank = rankOf(display(pivot, pivotHub));
  claim(hubRank !== null && hubRank[0] > hubRank[1] / 2, "Juniper Cola's hub score sits in the lower half of the neighbour's map");

  return {
    neighbour,
    scan: { ...evidencePair(scan, "the scan"), datasets: scan.dataset_ids, peers: scanPeers.length },
    island: read.island,
    hub: read.hub,
    nearest: read.nearest,
    distinctiveness: read.distinctiveness,
    rivals: { scoring: must(rivals.evidence_ids.at(-1), "the S3 evidence"), datasets: rivals.dataset_ids, a: read.rivalA, b: read.rivalB },
    pivot: {
      scoring: evidencePair(pivot, "the neighbour's map").scoring,
      datasets: pivot.dataset_ids,
      similarity: String(must(own.values.similarity_metric, "Juniper Cola's similarity in the neighbour's map")),
      hub: pivotHub,
      ahead,
    },
  };
}

/**
 * The brief. Each {{M#}} token renders as its metric's display text with a footnote, so a token sits
 * where that text reads as part of the sentence: after "at", or in parentheses after the claim it backs.
 */
function draftFrom(r: Readings): ReportDraftShape {
  const n = r.neighbour.name;
  const apparel = r.neighbour.category;
  const ahead = r.pivot.ahead;
  const aheadMetrics = ahead.map((b) => b.similarity);
  return {
    headline: `Juniper Cola is a taste island: its closest audience is ${withArticle(apparel)} brand`,
    signal: "mixed",
    verdict_tag: SAMPLE_TAG,
    thesis:
      `Juniper Cola sits apart from the soft drinks around it ({{${r.island}}}) and has the lowest hub score in its map ` +
      `({{${r.hub}}}) [${r.scan.scoring}]: its peers share their audiences with each other first. Its closest match is ${n}, ` +
      `${withArticle(apparel)} brand, at {{${r.nearest}}}, and its taste is the most distinct in the map ({{${r.distinctiveness}}}). ` +
      `A niche with a distinct taste, not yet a moat: ${possessive(n)} own map scores Juniper Cola at {{${r.pivot.similarity}}}, ` +
      `behind ${aheadNames(ahead)} [${r.pivot.scoring}].`,
    hypothesis_verdicts: [
      {
        hypothesis_id: "H1",
        verdict: "refuted",
        metric_ids: [r.nearest, r.rivals.a, r.rivals.b],
        note: `${RIVAL_A} scores {{${r.rivals.a}}} with Juniper Cola and ${RIVAL_B} {{${r.rivals.b}}}, both below ${n} at {{${r.nearest}}}.`,
      },
      {
        hypothesis_id: "H2",
        verdict: "refuted",
        metric_ids: [r.island, r.hub],
        note: `Juniper Cola sits at the edge of its category ({{${r.island}}}) and has the lowest hub score in the map ({{${r.hub}}}): its peers look to each other first.`,
      },
      {
        hypothesis_id: "H3",
        verdict: "confirmed",
        metric_ids: [r.distinctiveness],
        note: `Juniper Cola has the most distinct taste in the map ({{${r.distinctiveness}}}).`,
      },
      {
        hypothesis_id: "H4",
        verdict: "inconclusive",
        metric_ids: [r.nearest, r.pivot.similarity, ...aheadMetrics],
        note:
          `Juniper Cola's closest match is ${n} at {{${r.nearest}}}, but not the other way round: ${possessive(n)} own map scores ` +
          `Juniper Cola at {{${r.pivot.similarity}}}, behind ${aheadWithScores(ahead)}.`,
      },
    ],
    arguments: [
      {
        id: "A1",
        section: "competition",
        qloo_fact: `Juniper Cola sits apart from its peers ({{${r.island}}}) [${r.scan.scoring}], and its hub score is the lowest in the map ({{${r.hub}}}).`,
        our_read: "The colas and seltzers around it share their audiences with each other first; Juniper Cola is not part of that exchange.",
        metric_ids: [r.island, r.hub],
        evidence_ids: [r.scan.scoring],
      },
      {
        id: "A2",
        section: "audience",
        qloo_fact:
          `Juniper Cola's closest match is ${n} at {{${r.nearest}}} [${r.scan.scoring}], found by cross-category discovery [${r.scan.discovery}]. ` +
          `Scored in one set of calls, ${RIVAL_A} reaches {{${r.rivals.a}}} and ${RIVAL_B} {{${r.rivals.b}}} [${r.rivals.scoring}].`,
        our_read: `The audience's cultural home sits outside beverages, nearer ${withArticle(apparel)} brand than the colas it shelves next to.`,
        metric_ids: [r.nearest, r.rivals.a, r.rivals.b],
        evidence_ids: [r.scan.scoring, r.scan.discovery, r.rivals.scoring],
      },
      {
        id: "A3",
        section: "opportunity",
        qloo_fact:
          `${possessive(n)} own map scores Juniper Cola at {{${r.pivot.similarity}}}, behind ${aheadWithScores(ahead)} [${r.pivot.scoring}]; ` +
          `its hub score there sits in the lower half ({{${r.pivot.hub}}}).`,
        our_read: `The pull runs from Juniper Cola toward ${n}, not back. A partnership would borrow that brand's audience rather than share one.`,
        metric_ids: [r.pivot.similarity, ...aheadMetrics, r.pivot.hub],
        evidence_ids: [r.pivot.scoring],
      },
      {
        id: "A4",
        section: "risk",
        qloo_fact: `Juniper Cola has the most distinct taste in the map ({{${r.distinctiveness}}}) [${r.scan.scoring}].`,
        our_read: "A distinct taste is the raw material of a moat. Without peers that share it, it is also what a niche looks like.",
        metric_ids: [r.distinctiveness],
        evidence_ids: [r.scan.scoring],
      },
    ],
    exhibits: [
      ...r.scan.datasets.map((d) => ({
        dataset_id: d,
        title: "Last in most peer rows",
        caption: `Pairwise audience similarity of Juniper Cola and ${NUMBER_WORDS[r.scan.peers] ?? ""} peers; ${n} is the one outside beverages.`,
      })),
      ...r.rivals.datasets.map((d) => ({
        dataset_id: d,
        title: "The rivals we expected sit below the nearest match",
        caption: `Juniper Cola, ${RIVAL_A}, ${RIVAL_B} and ${n}, scored in one set of calls.`,
      })),
      ...r.pivot.datasets.map((d) => ({
        dataset_id: d,
        title: `${n} looks to ${apparel} first`,
        caption: `The same measure with ${n} as the target: ${aheadNames(ahead)} rank ahead of Juniper Cola.`,
      })),
    ],
    bear_case: [
      { text: `A wider peer set puts a soft drink above ${n} as the closest match.`, metric_ids: [r.nearest] },
      { text: "Juniper Cola stops ranking last in most of its peers' rows.", metric_ids: [r.island] },
      { text: `${possessive(n)} own map moves Juniper Cola ahead of ${aheadNames(ahead)}.`, metric_ids: [r.pivot.similarity] },
    ],
    recommendations: [
      { action: `Test a co-branded drop with ${n} before any soft-drink line extension.`, priority: "next", argument_ids: ["A2", "A3"] },
      { action: "Re-run the map with a wider soft-drink peer set before calling the audience a moat.", priority: "later", argument_ids: ["A1", "A4"] },
    ],
    next_moves: [
      { label: "Audience", question: "Who is the Juniper Cola audience beyond beverages?" },
      { label: "Head to head", question: `Juniper Cola vs ${n}: same customer?` },
      { label: "Sponsor fit", question: "Which artists fit the Juniper Cola audience?" },
    ],
    open_questions: ["Does the island hold in each metro, or only nationally?"],
  };
}

function brandHealthTurns(): ModelTurn[] {
  return [
    {
      ms: 11_200,
      thinking: () => [
        "Moat or niche comes down to where Juniper Cola's audience sits among the brands it shares taste with, and whether that position is its own.",
        "The opening scan is already mapping Juniper Cola against five peers, so I will not repeat it. Writing the priors first, before any data comes back.",
        `My expectation: it competes with ${RIVAL_A} and ${RIVAL_B}, it sits near the centre of soft drinks, and its taste is fairly distinctive. A second home outside beverages would surprise me.`,
        `Resolving ${RIVAL_A} and ${RIVAL_B} now, so step S3 can score them against Juniper Cola once the scan is back.`,
      ],
      tokens: { input: 3_106, cacheWrite: 9_480, output: 1_412 },
      content: () => [
        toolUse("toolu_sample_plan", "submit_plan", PLAN),
        toolUse("toolu_sample_rivals", "resolve_entities", {
          mentions: EXPECTED_RIVALS.map((text) => ({ text, type: "brand", metro: null })),
          trigger_finding_id: null,
          step_id: "S2",
        }),
      ],
    },
    {
      ms: 8_600,
      thinking: (request) => {
        const neighbour = neighbourOf(digestsIn(request));
        return [
          `The scan cuts against two priors at once: Juniper Cola ranks last in most peer rows, and its closest audience is ${neighbour.name}, ${withArticle(neighbour.category)} brand.`,
          `${neighbour.name} is the lead to follow. Mapping its own peers shows whether Juniper Cola belongs to that brand's world too, or whether the overlap only runs one way.`,
          `Both rivals resolved; S3 scores them against Juniper Cola, with ${neighbour.name} as the yardstick, in one set of calls.`,
        ];
      },
      tokens: { input: 4_218, cacheRead: 9_480, output: 764 },
      content: (request) => {
        const digests = digestsIn(request);
        const neighbour = neighbourOf(digests);
        const finding = findingOf(digests, "OUTSIDE_CATEGORY_NEIGHBOUR");
        const registered = digests.filter((d) => d.tool === "RES").flatMap((d) => d.digest.registered);
        const rivalRefs = EXPECTED_RIVALS.map((name) => must(registered.find((r) => r.name === name), `the ref of ${name}`).ref);
        return [
          toolUse("toolu_sample_pivot", "peer_landscape", {
            target: neighbour.ref,
            peers: ["R1"],
            discover: true,
            k: 4,
            trigger_finding_id: finding.id,
            step_id: null,
          }),
          toolUse("toolu_sample_rival_map", "peer_landscape", {
            target: "R1",
            peers: [...rivalRefs, neighbour.ref],
            discover: false,
            k: 4,
            trigger_finding_id: null,
            step_id: "S3",
          }),
        ];
      },
    },
    {
      ms: 19_400,
      thinking: (request) => {
        const r = readings(request);
        const n = r.neighbour.name;
        return [
          `${possessive(n)} own map puts ${aheadNames(r.pivot.ahead)} ahead of Juniper Cola: the pull runs from Juniper Cola outward, not back.`,
          `Neither rival comes close to ${n}, so the first prior falls. Distinctiveness holds, which is the moat argument; the island and the hub score are the niche argument.`,
          "Signal: mixed. Drafting the note with a token for every number, and keeping the bear case in.",
        ];
      },
      tokens: { input: 3_640, cacheRead: 13_698, output: 2_588 },
      content: (request) => [toolUse("toolu_sample_report", "submit_report", draftFrom(readings(request)))],
    },
  ];
}

// Recording a run ------------------------------------------------------------------------------------------

interface Scene {
  runId: string;
  question: string;
  clerk: ClerkTurn;
  turns: readonly ModelTurn[];
}

/** Runs one scene through runAgent on the clock and stamps its events, run.end included. */
async function record(clock: VirtualClock, qloo: QlooClient, scene: Scene): Promise<{ events: RunEvent[]; result: AgentRunResult }> {
  const stamped: { input: EventInput; at: number }[] = [];
  const anthropic = new ScriptedAnthropic(clock, scene.clerk, scene.turns);
  const result = await clock.run(() =>
    runAgent({
      runId: scene.runId,
      question: scene.question,
      lane: "public",
      mode: "live",
      emit: (input) => stamped.push({ input, at: clock.now() }),
      qloo,
      publicdata: samplePublicData(clock),
      anthropic,
      limits: DEFAULT_RUN_LIMITS,
      signal: new AbortController().signal,
      now: clock.now,
      // No side context call: the scripted model answers only CLERK and the ANALYST. The sample carries
      // invented blocks instead (withSampleContext).
      ...({ sideConfig: SIDE_CALLS_OFF } as object),
    }),
  );
  // The run manager writes run.end once the run's rows are stored.
  stamped.push({ input: { type: "run.end", status: result.status, elapsedMs: result.elapsedMs, reason: result.reason }, at: clock.now() + 38 });
  const withContext = withSampleContext(stamped);
  stamped.splice(0, stamped.length, ...withContext);
  const inputs = stableCallIds(scene.runId, labelSynthetic(stamped.map((s) => s.input)));
  const events = inputs.map((input, i) =>
    RunEvent.parse(stampEvent(input, { seq: i + 1, ts: new Date(stamped[i]?.at ?? clock.now()).toISOString(), runId: scene.runId })),
  );
  return { events, result };
}

/** The side context calls turned off for a scripted run (the sample's blocks are invented instead). */
const SIDE_CALLS_OFF = { aiEnabled: false, webEnabled: false, webMaxUses: 1, aiTimeoutMs: 1, webTimeoutMs: 1 };

/**
 * The run's events with the invented "What AI knows" and "From the web" blocks (R4, R5;
 * apps/web/server/samples/context.ts) right after the plan, as a live run's side calls settle while the
 * ANALYST works, any side event the agent emitted replaced, and the finished report carrying both blocks
 * at no cost. A run that ends before its plan (the picker) gets none, as a live one would not show them.
 */
export function withSampleContext(stamped: readonly { input: EventInput; at: number }[]): { input: EventInput; at: number }[] {
  const kept = stamped.filter((s) => s.input.type !== "context.ai" && s.input.type !== "context.web");
  const plan = kept.findIndex((s) => s.input.type === "plan");
  if (plan < 0) return kept;
  // At the plan's own time: the next event may share it, and replay times never run backwards.
  const at = kept[plan]?.at ?? 0;
  const iso = new Date(at).toISOString();
  const ai = sampleAiContext(iso);
  const web = sampleWebContext(iso);
  const out = kept.map((s) => {
    if (s.input.type !== "report.final") return s;
    const { report } = s.input;
    return {
      ...s,
      input: {
        ...s.input,
        report: {
          ...report,
          aiContext: ai,
          webContext: web,
          receipt: {
            ...report.receipt,
            models: { ...report.receipt.models, context: null, web: null },
            context: { aiUsd: 0, webUsd: 0, webSearches: 0 },
          },
        },
      },
    };
  });
  out.splice(
    plan + 1,
    0,
    { input: { type: "context.ai", block: ai, usd: 0, ms: 0 }, at },
    { input: { type: "context.web", block: web, usd: 0, ms: 0 }, at },
  );
  return out;
}

/** The data line every sample report closes its disclaimers with, in place of the agent's. */
const SAMPLE_DATA_LINE =
  "Data: synthetic sample from the mock Qloo transport and a scripted model; no Qloo or model calls were made, and the model spend shown is scripted.";

/**
 * The agent names its source as Qloo's dataset: in a report's last disclaimer ("Data: Qloo hackathon
 * dataset, …") and in what it says about names ("… in Qloo's hackathon dataset"). A sample's data came
 * from the mock and a script, so it says that instead.
 */
function labelSynthetic(inputs: readonly EventInput[]): EventInput[] {
  const relabelled = JSON.parse(JSON.stringify(inputs).replaceAll("Qloo's hackathon dataset", "the mock Qloo data")) as EventInput[];
  return relabelled.map((input) => {
    if (input.type !== "report.final") return input;
    const { disclaimers } = input.report;
    if (disclaimers.filter((line) => line.startsWith("Data: ")).length !== 1) throw new Error("the report has no single Data: disclaimer to replace");
    return { ...input, report: { ...input.report, disclaimers: disclaimers.map((line) => (line.startsWith("Data: ") ? SAMPLE_DATA_LINE : line)) } };
  });
}

/**
 * The Qloo client names each call with random bytes (qc_…); the sample renames them in order of
 * appearance, from a hash of the run id and the position, so they still look like call ids.
 */
function stableCallIds(runId: string, inputs: readonly EventInput[]): EventInput[] {
  const names = new Map<string, string>();
  const text = JSON.stringify(inputs).replace(/qc_[0-9a-f]{16}/g, (id) => {
    let name = names.get(id);
    if (name === undefined) {
      name = `qc_${createHash("sha256").update(`${runId}:${names.size + 1}`).digest("hex").slice(0, 16)}`;
      names.set(id, name);
    }
    return name;
  });
  return JSON.parse(text) as EventInput[];
}

function expectSample(ok: boolean, message: string): void {
  if (!ok) throw new Error(`sample check failed: ${message}`);
}

/**
 * A clock and a Qloo client for a Juniper Cola run starting at `start`: the cache the earlier work
 * left, Qloo failing the second rival's search from `start` on, and the concurrent run alongside.
 */
async function juniperColaStage(start: number): Promise<{ clock: VirtualClock; qloo: QlooClient }> {
  const clock = new VirtualClock(start - OLD_RUN_AGO_MS);
  const qloo = sampleQloo(clock, start);
  await warmCache(clock, qloo, start);
  clock.advanceTo(start);
  return { clock, qloo: alongsideConcurrentRun(qloo) };
}

const CACHE_STATUSES = ["miss", "hit", "reused", "stale", "coalesced"] as const;

/** The finished brief: CLERK, the gate, the scan with wave 1, one ANALYST PIVOT, the report and a clean CHECKER. */
async function brandHealth(): Promise<Sample> {
  const { clock, qloo } = await juniperColaStage(RUN_START);
  const { events, result } = await record(clock, qloo, {
    runId: "sample-brand-health",
    question: SAMPLE_QUESTION,
    clerk: CLERK,
    turns: brandHealthTurns(),
  });

  expectSample(result.status === "completed", `the run ended ${result.status}: ${result.reason ?? ""}`);
  expectSample(!events.some((e) => e.type === "error"), "the run emitted an error event");
  const validation = events.filter((e) => e.type === "validation").at(-1);
  expectSample(validation?.type === "validation" && validation.ok, "the CHECKER did not pass the draft");
  if (validation?.type === "validation") {
    const { traced, total } = validation.numbersTraced;
    expectSample(total > 0 && traced === total, `the CHECKER traced ${traced}/${total} numbers`);
    expectSample(!validation.issues.some((i) => i.rule === "V10"), "the CHECKER raised V10");
  }
  const final = events.find((e) => e.type === "report.final");
  expectSample(final?.type === "report.final" && final.report.verdict.tag === SAMPLE_TAG, "the report does not carry the verdict tag");
  const outside = events.find((e) => e.type === "finding" && e.finding.kind === "OUTSIDE_CATEGORY_NEIGHBOUR");
  expectSample(
    events.some((e) => e.type === "pivot" && e.tool === "peer_landscape" && outside?.type === "finding" && e.triggerFindingId === outside.finding.id),
    "no ANALYST PIVOT follows the OUTSIDE_CATEGORY_NEIGHBOUR finding",
  );
  const caches = new Set(events.flatMap((e) => (e.type === "qloo" ? [e.cache] : [])));
  for (const cache of CACHE_STATUSES) expectSample(caches.has(cache), `no Qloo call was served as ${cache}`);
  return { name: "brand-health", events };
}

/**
 * The same question, but the report turn runs past the hard wall clock: the run stops at 180 s and
 * code assembles the INCOMPLETE evidence digest from what the ledger holds.
 */
async function incomplete(): Promise<Sample> {
  const start = RUN_START + 2 * 3_600_000;
  const { clock, qloo } = await juniperColaStage(start);
  const [turn1, turn2, report] = brandHealthTurns();
  if (turn1 === undefined || turn2 === undefined || report === undefined) throw new Error("the brand-health script lost a turn");
  const stalled: ModelTurn = {
    ...report,
    // Longer than the time left before the hard stop: the stream is cut off mid-thought.
    ms: DEFAULT_RUN_LIMITS.hardMs,
    thinking: [
      "The neighbour's own map is back. Checking each prior against the numbers once more before writing.",
      "Weighing the island against distinctiveness: the same map supports both a niche and a moat reading, so the wording matters.",
      "Rewriting the opportunity argument so the partnership idea rests on the neighbour's map, not on the scan alone.",
      "Still reconciling the bear case with the hub score before the draft goes out.",
    ],
  };
  const { events, result } = await record(clock, qloo, {
    runId: "sample-brand-health-incomplete",
    question: SAMPLE_QUESTION,
    clerk: CLERK,
    turns: [turn1, turn2, stalled],
  });

  expectSample(result.status === "incomplete", `the run ended ${result.status}, not incomplete`);
  const final = events.find((e) => e.type === "report.final");
  expectSample(final?.type === "report.final" && final.report.incomplete, "no INCOMPLETE evidence digest was published");
  return { name: "brand-health-incomplete", events };
}

/** A brand whose name matches two entities: the resolution gate stops the run with a picker. */
async function needsInput(): Promise<Sample> {
  const start = RUN_START + 3 * 3_600_000;
  const clock = new VirtualClock(start);
  const qloo = sampleQloo(clock, start);
  const brand = "Twinleaf Cola";
  const intent: Intent = {
    ...INTENT,
    mentions: [{ text: brand, entity_type: "brand", role: "primary", public_figure: false }],
    safety: { ...INTENT.safety, reframe: `How distinct and how central ${brand}'s audience taste is among the brands it shares taste with` },
  };
  const { events, result } = await record(clock, qloo, {
    runId: "sample-needs-input",
    question: `Is the ${brand} audience a moat or a niche?`,
    clerk: { ...CLERK, intent },
    turns: [],
  });

  expectSample(result.status === "needs_input", `the run ended ${result.status}, not needs_input`);
  const picker = events.find((e) => e.type === "needs_input");
  expectSample(picker?.type === "needs_input" && picker.candidates.length > 1, "no picker with candidates");
  return { name: "needs-input", events };
}

// Output -----------------------------------------------------------------------------------------------------

export function sampleFile(name: SampleName): string {
  return path.join(SAMPLES_DIR, `${name}.events.json`);
}

/** One event per line, so a regenerated sample diffs event by event. */
export function renderSample(events: readonly RunEvent[]): string {
  return `[\n${events.map((e) => JSON.stringify(e)).join(",\n")}\n]\n`;
}

/** Builds every sample, in SAMPLE_NAMES order. */
export async function buildSamples(): Promise<Sample[]> {
  const scenes = [brandHealth, incomplete, needsInput];
  // A rehearsal first: modules the agent loads on first use arrive in real time, never mid-recording.
  for (const scene of scenes) await scene();
  const samples: Sample[] = [];
  for (const scene of scenes) samples.push(await scene());
  return samples;
}

async function main(): Promise<void> {
  const check = process.argv.includes("--check");
  const samples = await buildSamples();
  let stale = 0;
  for (const sample of samples) {
    const file = sampleFile(sample.name);
    const text = renderSample(sample.events);
    const rel = path.relative(ROOT, file);
    if (check) {
      let current: unknown = null;
      try {
        current = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        current = null;
      }
      const same = JSON.stringify(current) === JSON.stringify(JSON.parse(text));
      if (!same) stale += 1;
      console.log(`${same ? "up to date" : "OUT OF DATE"}  ${rel}`);
      continue;
    }
    writeFileSync(file, text, "utf8");
    const end = sample.events.at(-1);
    console.log(`wrote ${rel}: ${sample.events.length} events, ${end?.type === "run.end" ? `${end.status} after ${(end.elapsedMs / 1000).toFixed(1)} s` : "no run.end"}`);
  }
  if (stale > 0) process.exitCode = 1;
}

if (path.basename(process.argv[1] ?? "") === "sample-run.ts") {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exitCode = 1;
  });
}
