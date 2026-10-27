import "server-only";
import { randomBytes } from "node:crypto";
import {
  DEFAULT_RUN_LIMITS,
  METRO_LABEL,
  MetroId,
  type CacheProbe,
  type EntityType,
  type Intent,
  type Job,
  type Lane,
  type MatchClass,
  type MentionRole,
  type Pillar,
  type ResolvedMention,
  type SafetyCategory,
  type Skill,
  type SkillId,
} from "@ct/contracts";
import {
  createEntityRegistry,
  planScan,
  privatePersonRefusal,
  refusalOf,
  runClerk,
  runResolutionGate,
  sanitizeQuestion,
  type AnalystMode,
  type AnthropicLike,
  type GateOutcome,
  type RunRegistry,
} from "@ct/agent";
import type { Queryable } from "@ct/db";
import type { QlooClient } from "@ct/qloo";
import { SKILLS } from "@ct/quant";
import {
  llmDailyUsdCapFromEnv,
  previewHourlyCapFromEnv,
  qlooDailyFreshCapFromEnv,
  qlooDisabledFromEnv,
} from "./config";
import { DESK_LABEL, JOB_LABEL } from "../lib/brief/format";
import { findAlreadyHave, type AlreadyHave } from "./answer-cache";
import { laneModeOf, type LaneMode } from "./breakers";
import { getAnthropic, getDatabase, getQlooClient, laneMode } from "./container";
import { SpendMeter, todayLlmUsd } from "./llm-spend";
import { log } from "./log";
import type { RunManagerErrorCode } from "./run-manager";

export { findAlreadyHave, type AlreadyHave };

/**
 * POST /api/preview: the A02 "Understood as" panel. CLERK reads the question (Haiku, as a run
 * would), the resolution gate matches its mentions (cache-first /search through the shared Qloo
 * client: the very calls the run makes, so the run finds them cached), the opening scan is costed
 * against the cache, and the answer cache says whether a recent brief already answers it. The
 * reading is kept for ten minutes under an opaque token: POST /api/runs with that token and the
 * same question skips CLERK (AgentRunOptions.intent).
 *
 * A preview of a question previewed within the last ten minutes reuses that reading and renews it
 * for ten more: no CLERK call and no charge against the hourly cap or the budget. Concurrent
 * previews of one question share one CLERK call; a new reading takes its hourly slot and its
 * budget reserve in the same tick as the checks, so a burst of different questions cannot pass
 * them all at once. Readings live in this process only, in a bounded map.
 */

/** How long a reading and its token live after the question was last previewed. */
export const PREVIEW_TTL_MS = 10 * 60_000;
/** Readings held at once; the oldest goes first. */
export const PREVIEW_MAX_ENTRIES = 500;
/**
 * A preview runs CLERK only while today's spend plus this, for each reading in flight, stays within
 * the daily cap (one CLERK call costs well under it).
 */
export const PREVIEW_RESERVE_USD = 0.01;
/** "pv_" and 32 hex digits of random bytes. */
export const PREVIEW_TOKEN = /^pv_[0-9a-f]{32}$/;

const HOUR_MS = 3_600_000;
const CLERK_TIMEOUT_MS = 20_000;
const GATE_TIMEOUT_MS = 10_000;
/** LLM bench p50 for the ANALYST's three turns (docs/LLM_BENCH.md: 29.4 s). */
const ANALYST_SECONDS = 30;
/** Conservative: a run sends up to four requests at once, but the rate limit and retries add waits. */
const SECONDS_PER_NETWORK_CALL = 1;
/** A run that stops at the picker only repeats the gate's cached lookups. */
const PICKER_SECONDS = 5;
/** D24: finding-triggered follow-ups share this many network calls; the estimate assumes a run uses them. */
const FOLLOWUP_ALLOWANCE = DEFAULT_RUN_LIMITS.followupCalls;
const PAUSED_REASON = "Live analysis is paused. Answers you already have still open.";
const NO_KEY_REASON = "Live analysis is unavailable: this server has no Anthropic API key.";
const NO_QLOO_REASON = "Live analysis is unavailable: the Qloo client is not configured.";
const CAPPED_REASON = "Question previews are paused for a while. You can still run the brief.";
const BUDGET_REASON = "Today's budget for live analysis is used up. Live runs resume at 00:00 UTC.";
const CLERK_FAILED_REASON = "The question could not be read right now. Try again shortly.";

// The answer --------------------------------------------------------------------------------------

export interface PreviewMention {
  /** As written in the question. */
  text: string;
  type: EntityType;
  role: MentionRole;
  /** The gate's match class; null when the mention was not looked up (Qloo off, a private person, a place with no metro). */
  match: MatchClass | null;
  /** Qloo's name for an exact match; null otherwise. */
  name: string | null;
}

export interface PreviewUnderstood {
  pillar: Pillar;
  job: Job;
  /** "Compare two brands". */
  jobLabel: string;
  /** The compiled command, e.g. "JUNIPER COLA <BRAND> HLTH". */
  mnemonic: string;
  mentions: PreviewMention[];
  /** The gazetteer metros the question names ("Austin"); empty for a US-wide question. */
  metros: string[];
  /** The scope as A02 shows it, e.g. "US metros & ages". */
  scope: string;
  /** "Investment lens · both names matched exactly · vs US baseline". */
  lens: string;
}

export interface PreviewRefusal {
  /** CLERK's safety category; null when the model itself declined to read the question. */
  category: SafetyCategory | null;
  /** Why a brief on this question would be declined. */
  reason: string;
  /** A group-level question that can be answered instead, when one applies. */
  reframe: string | null;
}

export interface PreviewEstimate {
  /** Qloo requests expected on the network: the opening scan as the cache stands now, plus the follow-up allowance. */
  networkCalls: number;
  /** Requests expected from the cache: the gate lookups this preview just made and the scan's cached part. */
  cachedCalls: number;
  /** A rough wall-clock guide, rounded up to 5 s. */
  seconds: number;
  /** networkCalls as a share (0 to 1) of the day's fresh-call quota. */
  quotaShare: number;
}

export interface PreviewResponse {
  /** Pass as previewToken to POST /api/runs with the same question; null when there is no reading to reuse. */
  token: string | null;
  /** When the token, and the reading behind it, expire; previewing the question again renews them. */
  expiresAt: string;
  /** Null only when the model declined to read the question at all (`refusal` then says so). */
  understood: PreviewUnderstood | null;
  /** Present when a brief on this question would be declined. */
  refusal?: PreviewRefusal;
  alreadyHave: AlreadyHave | null;
  estimate: PreviewEstimate;
  /** The ANALYST a brief started now would get: economy once today's live budget is nearly used. */
  mode: AnalystMode;
  /** Why a brief would run in economy (the breaker's message); null in live mode. */
  modeNote: string | null;
}

export type PreviewOutcome =
  | { kind: "ok"; body: PreviewResponse }
  /** Refused with the run manager's codes (and HTTP mapping); a recent brief may still answer it. */
  | { kind: "refused"; code: RunManagerErrorCode; message: string; retryAfterS: number | null; alreadyHave: AlreadyHave | null }
  /** CLERK could not answer; `retry` says whether trying again may help. */
  | { kind: "failed"; message: string; retry: boolean };

// Dependencies ------------------------------------------------------------------------------------

export interface PreviewDeps {
  /** The process-wide Qloo client; throws when it cannot be configured. */
  qloo: () => QlooClient;
  /** Null without ANTHROPIC_API_KEY. */
  anthropic: () => AnthropicLike | null;
  /** The lane's mode as the breakers decide it, or a bare mode. */
  mode: (lane: Lane) => Promise<LaneMode>;
  /** Today's LLM spend across lanes, in USD. */
  todayUsd: () => Promise<number>;
  /** Adds a CLERK call's spend to today's accounting under the lane (the run manager's usage_daily metric). */
  recordUsd: (usd: number, lane: Lane) => Promise<void>;
  /** The newest completed brief that answers this (sanitized) question, or null. */
  findAnswer: (question: string) => Promise<AlreadyHave | null>;
}

export interface PreviewServiceOptions {
  /** CLERK calls this process makes for previews per rolling hour (default 120, PREVIEW_HOURLY_CAP). */
  hourlyCap?: number;
  /** The daily LLM breaker in USD (default 1.40). */
  llmDailyUsdCap?: number;
  /** False (QLOO_DISABLED=1): no lookups, and no data requests in the estimate. Default true. */
  qlooEnabled?: boolean;
  /** Fresh Qloo calls per day, for quotaShare (default 1,900). */
  dailyFreshCap?: number;
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** The database half of PreviewDeps: the answer cache and the run manager's daily LLM accounting. */
export function databasePreviewDeps(db: () => Queryable): Pick<PreviewDeps, "todayUsd" | "recordUsd" | "findAnswer"> {
  return {
    todayUsd: () => todayLlmUsd(db()),
    recordUsd: (usd, lane) => new SpendMeter(db(), lane).upTo(usd),
    findAnswer: (question) => findAlreadyHave(db(), question),
  };
}

// Reading the intent ------------------------------------------------------------------------------

/** What CLERK made of a question: an intent, or the model's own refusal to read it. */
type Reading = { kind: "intent"; intent: Intent } | { kind: "declined"; reason: string };

/** Who previews: the lane, and its mode when the caller already decided it (the route does, for the human check). */
export interface PreviewRequest {
  lane?: Lane;
  mode?: LaneMode;
}

interface Entry {
  token: string;
  /** The question as sanitized, the one CLERK read. */
  question: string;
  /** questionKey of the question. */
  key: string;
  reading: Reading;
  /** The gate's latest matching of the intent's mentions. */
  resolutions: ResolvedMention[];
  expiresAt: number;
}

/** Questions that differ only in case, width or spacing read the same, as the answer cache keys them. */
export const questionKey = (question: string): string => sanitizeQuestion(question).normalize("NFKC").toLowerCase();

const newToken = (): string => `pv_${randomBytes(16).toString("hex")}`;

class Refused extends Error {
  constructor(
    readonly code: RunManagerErrorCode,
    message: string,
    readonly retryAfterS: number | null = null,
  ) {
    super(message);
    this.name = "PreviewRefused";
  }
}

class ClerkFailed extends Error {
  constructor(readonly retry: boolean) {
    super(CLERK_FAILED_REASON);
    this.name = "PreviewClerkFailed";
  }
}

// Describing the reading --------------------------------------------------------------------------

/** What each job compares against, for the lens line. */
const JOB_BASELINE: Readonly<Record<Job, string>> = {
  brand_health: "vs its nearest peers",
  head_to_head: "vs US baseline",
  site_selection: "vs the city",
  area_profile: "vs the city",
  tenant_mix: "vs the city",
  sponsorship: "within the slate",
  market_selection: "vs US baseline",
  audience_discovery: "vs US baseline",
};

function scopeOf(intent: Intent): string {
  const { metro, area, unsupported_place: elsewhere } = intent.geo;
  const city = metro !== null ? METRO_LABEL[metro] : elsewhere;
  switch (intent.job) {
    case "brand_health":
      return "US · peers & audience";
    case "head_to_head":
      return "US metros & ages";
    case "site_selection":
      return city ? `${city} neighbourhoods` : `Neighbourhoods in ${MetroId.options.length} US cities`;
    case "area_profile":
    case "tenant_mix":
      return [area, city].filter((s): s is string => Boolean(s)).join(", ") || `A neighbourhood in one of ${MetroId.options.length} US cities`;
    case "sponsorship":
      return "US · sponsor categories";
    case "market_selection":
      return "US markets";
    case "audience_discovery":
      return "US · across domains";
  }
}

/** How the gate went, for the lens line. */
type Matching = { kind: "matched"; gate: GateOutcome } | { kind: "off" } | { kind: "failed" } | { kind: "none" };

function matchLine(matching: Matching, mentions: readonly PreviewMention[]): string | null {
  switch (matching.kind) {
    case "none":
      return null;
    case "off":
      return "names not looked up (Qloo is off)";
    case "failed":
      return "names could not be looked up just now";
    case "matched":
      break;
  }
  if (matching.gate.kind === "needs_input") return `pick the ${matching.gate.picker.mention} you mean`;
  if (matching.gate.kind === "failed") return "names could not be looked up just now";
  const searched = mentions.filter((m) => m.match !== null);
  if (searched.length === 0) return null;
  const exact = searched.filter((m) => m.match === "exact").length;
  if (exact < searched.length) return `${exact} of ${searched.length} names matched exactly`;
  if (exact === 1) return "the name matched exactly";
  return exact === 2 ? "both names matched exactly" : `all ${exact} names matched exactly`;
}

function mentionsOf(intent: Intent, resolutions: readonly ResolvedMention[]): PreviewMention[] {
  return intent.mentions.map((m) => {
    const found = resolutions.find((r) => r.mention === m.text && r.entityType === m.entity_type);
    return { text: m.text, type: m.entity_type, role: m.role, match: found?.match ?? null, name: found?.name ?? null };
  });
}

function understoodOf(intent: Intent, resolutions: readonly ResolvedMention[], matching: Matching): PreviewUnderstood {
  const mentions = mentionsOf(intent, resolutions);
  const advice = intent.safety.category === "financial_advice" ? "taste signal, not advice" : null;
  const lens = [`${DESK_LABEL[intent.pillar]} lens`, matchLine(matching, mentions), JOB_BASELINE[intent.job], advice]
    .filter((s): s is string => s !== null)
    .join(" · ");
  return {
    pillar: intent.pillar,
    job: intent.job,
    jobLabel: JOB_LABEL[intent.job],
    mnemonic: intent.mnemonic,
    mentions,
    metros: intent.geo.metro !== null ? [METRO_LABEL[intent.geo.metro]] : [],
    scope: scopeOf(intent),
    lens,
  };
}

/** Why a run on this intent would be declined, as runAgent decides it; null when it would go ahead. */
function refusalFor(intent: Intent): PreviewRefusal | null {
  const reframe = intent.safety.reframe?.trim() || null;
  if (refusalOf(intent) !== null) {
    const category = intent.safety.category;
    const reason =
      category === null
        ? "Culture Terminal does not answer this question."
        : `Culture Terminal does not answer this kind of question (${category.replace(/_/g, " ")}).`;
    return { category, reason, reframe };
  }
  const privatePerson = privatePersonRefusal(intent);
  return privatePerson === null ? null : { category: "private_individual", reason: privatePerson, reframe };
}

// Estimating the run ------------------------------------------------------------------------------

/** A probe that finds nothing cached: what a skill costs cold. */
const NOTHING_CACHED: CacheProbe = { has: async () => false };

async function skillCalls(tool: SkillId, input: unknown, probe: CacheProbe, registry: RunRegistry): Promise<number> {
  try {
    const n = await (SKILLS[tool] as unknown as Skill<unknown>).estimateCalls(input, probe, registry);
    return Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

const roundUpTo5 = (s: number): number => Math.ceil(s / 5) * 5;

// The service -------------------------------------------------------------------------------------

export class PreviewService {
  private readonly deps: PreviewDeps;
  private readonly hourlyCap: number;
  private readonly llmDailyUsdCap: number;
  private readonly qlooEnabled: boolean;
  private readonly dailyFreshCap: number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;
  /** Readings by token, least recently previewed first. */
  private readonly entries = new Map<string, Entry>();
  /** questionKey → token of its live reading. */
  private readonly byQuestion = new Map<string, string>();
  /** CLERK calls in flight, by questionKey. */
  private readonly reading = new Map<string, Promise<Entry>>();
  /** When each CLERK call of the last hour was made (or its slot taken), oldest first. */
  private readonly clerkCalls: number[] = [];
  /** New readings between their budget check and their recorded spend; each holds PREVIEW_RESERVE_USD. */
  private readingsInFlight = 0;

  constructor(deps: PreviewDeps, options: PreviewServiceOptions = {}) {
    this.deps = deps;
    this.hourlyCap = options.hourlyCap ?? 120;
    this.llmDailyUsdCap = options.llmDailyUsdCap ?? 1.4;
    this.qlooEnabled = options.qlooEnabled ?? true;
    this.dailyFreshCap = options.dailyFreshCap ?? 1_900;
    this.ttlMs = options.ttlMs ?? PREVIEW_TTL_MS;
    this.maxEntries = options.maxEntries ?? PREVIEW_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Readings held now, expired ones included until the next write prunes them. */
  get size(): number {
    return this.entries.size;
  }

  /**
   * Previews a question. Never throws for refusals or CLERK failures (see PreviewOutcome); a
   * database failure (the answer cache, the spend) is thrown for the route to answer 503.
   */
  async preview(raw: string, request: PreviewRequest = {}): Promise<PreviewOutcome> {
    const question = sanitizeQuestion(raw);
    if (question === "") {
      return { kind: "refused", code: "invalid", message: "The question is empty.", retryAfterS: null, alreadyHave: null };
    }
    const lane = request.lane ?? "public";
    const alreadyHave = await this.deps.findAnswer(question);
    try {
      const { mode, message } = laneModeOf(request.mode ?? (await this.deps.mode(lane)));
      if (mode === "replay_only") throw new Refused("unavailable", message ?? PAUSED_REASON);
      const anthropic = this.deps.anthropic();
      if (!anthropic) throw new Refused("unavailable", NO_KEY_REASON);
      const qloo = this.qlooEnabled ? this.qlooClient() : null;
      const entry = await this.entryFor(question, anthropic, lane);
      const body = await this.describe(entry, qloo, alreadyHave);
      return { kind: "ok", body: { ...body, mode, modeNote: mode === "economy" ? message : null } };
    } catch (err) {
      if (err instanceof Refused) {
        return { kind: "refused", code: err.code, message: err.message, retryAfterS: err.retryAfterS, alreadyHave };
      }
      if (err instanceof ClerkFailed) return { kind: "failed", message: err.message, retry: err.retry };
      throw err;
    }
  }

  /**
   * The intent behind a token, for POST /api/runs: only while the token lives, and only for the
   * question it was made for (compared as the answer cache compares questions). Null otherwise,
   * and the run then reads the question with CLERK as usual.
   */
  intentFor(token: string, question: string): Intent | null {
    const entry = this.entries.get(token);
    if (!entry || entry.expiresAt <= this.now()) return null;
    if (entry.key !== questionKey(question) || entry.reading.kind !== "intent") return null;
    return entry.reading.intent;
  }

  /** The resolutions the gate last made for a token's reading (empty for an unknown or expired token). */
  resolutionsFor(token: string): readonly ResolvedMention[] {
    const entry = this.entries.get(token);
    return entry && entry.expiresAt > this.now() ? entry.resolutions : [];
  }

  private qlooClient(): QlooClient {
    try {
      return this.deps.qloo();
    } catch (err) {
      log.error({ err }, "the Qloo client could not be created; refusing previews");
      throw new Refused("unavailable", NO_QLOO_REASON);
    }
  }

  /** The live reading of this question, the one CLERK is producing for it, or a new one. */
  private entryFor(question: string, anthropic: AnthropicLike, lane: Lane): Promise<Entry> {
    const key = questionKey(question);
    const held = this.live(key);
    if (held) return Promise.resolve(held);
    const pending = this.reading.get(key);
    if (pending) return pending;
    const read = this.read(question, key, anthropic, lane).finally(() => this.reading.delete(key));
    this.reading.set(key, read);
    return read;
  }

  /**
   * The live reading of a question, renewed for a full TTL and moved to the newest place (so the
   * token a preview hands out never expires sooner, and eviction stays least-recent-first). An
   * expired reading is dropped.
   */
  private live(key: string): Entry | null {
    const token = this.byQuestion.get(key);
    const entry = token === undefined ? undefined : this.entries.get(token);
    if (!entry) return null;
    const now = this.now();
    if (entry.expiresAt <= now) {
      this.drop(entry);
      return null;
    }
    entry.expiresAt = now + this.ttlMs;
    this.entries.delete(entry.token);
    this.entries.set(entry.token, entry);
    return entry;
  }

  private async read(question: string, key: string, anthropic: AnthropicLike, lane: Lane): Promise<Entry> {
    // The slot and the budget reserve are taken in the tick of their checks: concurrent readings of
    // different questions each see the others' share.
    const slot = this.takeHourlySlot();
    this.readingsInFlight += 1;
    try {
      try {
        await this.checkBudget();
      } catch (err) {
        // No CLERK call was made, so the slot goes back. A failed CLERK call keeps its slot.
        this.freeHourlySlot(slot);
        throw err;
      }
      const clerk = await runClerk({ client: anthropic, question, signal: AbortSignal.timeout(CLERK_TIMEOUT_MS) });
      if (clerk.usd > 0) {
        // The spend is real whatever CLERK answered; a failed write is logged, never shown.
        await this.deps
          .recordUsd(clerk.usd, lane)
          .catch((err: unknown) => log.error({ err, usd: clerk.usd }, "could not record a preview's CLERK spend"));
      }
      let reading: Reading;
      if (clerk.kind === "error") {
        log.warn({ code: clerk.code, message: clerk.message }, "CLERK could not read a preview question");
        throw new ClerkFailed(clerk.retryable || clerk.code === "cancelled");
      } else if (clerk.kind === "refusal") {
        reading = { kind: "declined", reason: clerk.explanation ?? "The model declined to read this question." };
      } else {
        reading = { kind: "intent", intent: clerk.intent };
      }
      return this.store(question, key, reading);
    } finally {
      // CLERK's spend has been recorded (or CLERK was never called), so the reserve is released.
      this.readingsInFlight -= 1;
    }
  }

  /** Takes a slot of the rolling hour for a CLERK call, or refuses when they are all taken. */
  private takeHourlySlot(): number {
    const now = this.now();
    while (this.clerkCalls.length > 0 && (this.clerkCalls[0] ?? now) <= now - HOUR_MS) this.clerkCalls.shift();
    const oldest = this.clerkCalls[0];
    if (oldest !== undefined && this.clerkCalls.length >= this.hourlyCap) {
      throw new Refused("limited", CAPPED_REASON, Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000)));
    }
    this.clerkCalls.push(now);
    return now;
  }

  /** Gives back a slot taken for a CLERK call that was never made. */
  private freeHourlySlot(slot: number): void {
    const at = this.clerkCalls.lastIndexOf(slot);
    if (at >= 0) this.clerkCalls.splice(at, 1);
  }

  /** Refuses while today's spend plus the reserve of every reading in flight, this one included, would pass the daily cap. */
  private async checkBudget(): Promise<void> {
    const today = await this.deps.todayUsd();
    if (today + this.readingsInFlight * PREVIEW_RESERVE_USD > this.llmDailyUsdCap) throw new Refused("budget", BUDGET_REASON);
  }

  private store(question: string, key: string, reading: Reading): Entry {
    const now = this.now();
    for (const entry of [...this.entries.values()]) if (entry.expiresAt <= now) this.drop(entry);
    for (const oldest of this.entries.values()) {
      if (this.entries.size < this.maxEntries) break;
      this.drop(oldest);
    }
    const entry: Entry = { token: newToken(), question, key, reading, resolutions: [], expiresAt: now + this.ttlMs };
    this.entries.set(entry.token, entry);
    this.byQuestion.set(key, entry.token);
    return entry;
  }

  private drop(entry: Entry): void {
    this.entries.delete(entry.token);
    if (this.byQuestion.get(entry.key) === entry.token) this.byQuestion.delete(entry.key);
  }

  /**
   * The answer for a reading: matching and estimate are made afresh, from the cache where they can be.
   * The analyst is added by the caller.
   */
  private async describe(
    entry: Entry,
    qloo: QlooClient | null,
    alreadyHave: AlreadyHave | null,
  ): Promise<Omit<PreviewResponse, "mode" | "modeNote">> {
    const expiresAt = new Date(entry.expiresAt).toISOString();
    const nothing: PreviewEstimate = { networkCalls: 0, cachedCalls: 0, seconds: 0, quotaShare: 0 };
    if (entry.reading.kind === "declined") {
      const refusal: PreviewRefusal = { category: null, reason: entry.reading.reason, reframe: null };
      return { token: null, expiresAt, understood: null, refusal, alreadyHave, estimate: nothing };
    }
    const intent = entry.reading.intent;
    const refusal = refusalFor(intent);
    if (refusal !== null) {
      const understood = understoodOf(intent, [], { kind: "none" });
      return { token: entry.token, expiresAt, understood, refusal, alreadyHave, estimate: nothing };
    }
    if (qloo === null) {
      const understood = understoodOf(intent, [], intent.mentions.length > 0 ? { kind: "off" } : { kind: "none" });
      return { token: entry.token, expiresAt, understood, alreadyHave, estimate: this.estimateOf(0, 0) };
    }

    const registry = createEntityRegistry();
    let gate: GateOutcome;
    try {
      const scope = qloo.standalone({ pillar: intent.pillar, signal: AbortSignal.timeout(GATE_TIMEOUT_MS) }).forTool(null);
      gate = await runResolutionGate({ intent, qloo: scope, registry, pins: {} });
    } catch (err) {
      log.warn({ err }, "the preview's resolution gate failed");
      gate = { kind: "failed", error: err };
    }
    if (gate.kind === "refused") {
      // refusalFor already declines a private primary person; this is the gate's own backstop.
      const understood = understoodOf(intent, [], { kind: "none" });
      const declined: PreviewRefusal = { category: "private_individual", reason: gate.reason, reframe: null };
      return { token: entry.token, expiresAt, understood, refusal: declined, alreadyHave, estimate: nothing };
    }
    const resolutions = gate.kind === "failed" ? [] : gate.entities;
    entry.resolutions = resolutions;
    const understood = understoodOf(intent, resolutions, gate.kind === "failed" ? { kind: "failed" } : { kind: "matched", gate });
    return { token: entry.token, expiresAt, understood, alreadyHave, estimate: await this.estimate(intent, gate, qloo, registry) };
  }

  /**
   * The run's Qloo requests: the gate's lookups again (cached now), the opening scan as the cache
   * stands, and the follow-up allowance on the network. A run that stops at the picker costs only
   * the cached lookups; a gate that failed leaves the scan unknown, so only the allowance counts.
   */
  private async estimate(
    intent: Intent,
    gate: Exclude<GateOutcome, { kind: "refused" }>,
    qloo: QlooClient,
    registry: RunRegistry,
  ): Promise<PreviewEstimate> {
    if (gate.kind === "failed") return this.estimateOf(FOLLOWUP_ALLOWANCE, 0);
    const lookups = gate.entities.length;
    if (gate.kind === "needs_input") return { ...this.estimateOf(0, lookups), seconds: PICKER_SECONDS };
    const scan = planScan(intent.job, { intent, primary: gate.primary, peers: gate.peers });
    const probe = qloo.standalone({ pillar: intent.pillar }).forTool(null);
    let network = 0;
    let cold = 0;
    for (const step of scan.steps) {
      network += await skillCalls(step.tool, step.input, probe, registry);
      cold += await skillCalls(step.tool, step.input, NOTHING_CACHED, registry);
    }
    // A chained scan step (site_selection's geo_lift) has no input until find_tags returns: its typical cost stands in.
    for (const step of scan.chained) {
      network += step.estimate;
      cold += step.estimate;
    }
    return this.estimateOf(network + FOLLOWUP_ALLOWANCE, Math.max(0, cold - network) + lookups);
  }

  private estimateOf(network: number, cached: number): PreviewEstimate {
    const networkCalls = Math.min(network, DEFAULT_RUN_LIMITS.qlooCalls);
    const seconds = Math.min(roundUpTo5(ANALYST_SECONDS + networkCalls * SECONDS_PER_NETWORK_CALL), DEFAULT_RUN_LIMITS.hardMs / 1000);
    const quotaShare = Math.round((networkCalls / this.dailyFreshCap) * 10_000) / 10_000;
    return { networkCalls, cachedCalls: cached, seconds, quotaShare };
  }
}

const KEY = "__ctPreview";
type GlobalWithPreview = typeof globalThis & { [KEY]?: PreviewService };

/**
 * The process-wide preview service, on globalThis like the container's singletons: the preview
 * route stores readings and the runs route reads them, and Next.js may bundle this module per route.
 */
export function getPreviewService(): PreviewService {
  const g = globalThis as GlobalWithPreview;
  return (g[KEY] ??= new PreviewService(
    { qloo: getQlooClient, anthropic: getAnthropic, mode: laneMode, ...databasePreviewDeps(getDatabase) },
    {
      hourlyCap: previewHourlyCapFromEnv(),
      llmDailyUsdCap: llmDailyUsdCapFromEnv(),
      qlooEnabled: !qlooDisabledFromEnv(),
      dailyFreshCap: qlooDailyFreshCapFromEnv(),
    },
  ));
}
