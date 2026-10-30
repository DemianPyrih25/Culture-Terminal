import "server-only";
import { randomBytes } from "node:crypto";
import { findPickerChoice, pickerKey } from "@ct/agent";
import {
  DEFAULT_RUN_LIMITS,
  isPublicProvenanceRequest,
  ScreenerResult,
  TasteMapPayload,
  TASTE_MAP_MIN_K,
  type Lane,
  type LocalityApi,
  type MarketId,
  type PickerCandidate,
  type QlooEntity,
  type QlooParams,
  type QlooProvenanceRequest,
  type QlooSearchEntity,
  type RunLimits,
  type ScreenerAnswer,
  type ScreenerRequest,
  type ScreenerRequestEntry,
  type ScreenerRequestId,
  type ScreenerRequestPurpose,
} from "@ct/contracts";
import { BudgetError, scrubEntityIds, type QlooCallRecord, type QlooClient, type RunQloo } from "@ct/qloo";
import {
  categoryPath,
  classifyCategoryTags,
  classifyMatches,
  computeScreener,
  marketLabel,
  qualityGate,
  screenerAgeSpecs,
  screenerBrandDiscovery,
  screenerMapMembers,
  screenerMapPlan,
  screenerScoringParams,
  screenerTagDiscoveryParams,
  screenerTagSearchParams,
  searchParams,
  SCREENER_AGES,
  SCREENER_COLUMNS,
  screenerFit,
  screenerMarketSpec,
  type ScreenerCandidate,
  type ScreenerContextCall,
  type ScreenerMapInput,
  type ScreenerResponse,
  type TasteMapBuild,
} from "@ct/quant";
import { log } from "../log";
import { DesLimiter, nextUtcMidnight, type DesLimits, type DesWait } from "../des/limits";
import type { DesMode, FeatureUseRecord } from "../des/service";
import { ScreenerAnswers, screenerKey } from "./cache";
import { DEFAULT_SCREENER_LIMITS } from "./limits";
import { screenerMarket } from "./markets";

/**
 * The brand screener (PLAN §5.5, §8.1 `/screener`): code only, $0 LLM. A category name (resolved with
 * find_tags' own tag search, exact names only, D20) or a seed brand (the resolver's exact-match rule,
 * a tie is a picker) → discovery (1 call, the category's tag or the seed brand as its signal, so it
 * is also the one-scale scoring: by candidate-set invariance, G1, a separate scoring call over the same
 * brands would return the same scores) → three age contexts → up to four markets,
 * and with `map` the taste map's triangular calls (≤ 13), which fill distinctiveness. Every call goes
 * through @ct/qloo in a lane scope (cache, budgets, call log, request ids), so the client's daily lane
 * caps, month floor and this screen's own cap apply; ./limits.ts adds per-visitor, hourly and daily
 * limits. A finished screen is kept in the answer cache (./cache.ts) and served again at no cost.
 */

/** Calls a screen makes at most without the map: the lookup, discovery, 3 ages and 4 markets. */
export const SCREENER_BASE_QLOO_CAP = 9;
/** The taste map's triangular calls at most (k − 1, k ≤ 14). */
export const SCREENER_MAP_QLOO_CAP = 13;
export const SCREENER_TIMEOUT_MS = 30_000;

const BRAND = "urn:entity:brand";
const PICK_MAX = 5;

const QLOO_OFF_MESSAGE = "The screener is off: this server makes no Qloo requests (QLOO_DISABLED). Screens you already ran still open.";
const UNCONFIGURED_MESSAGE = "The screener is unavailable: the Qloo client is not configured on this server.";
const BUDGET_MESSAGE = "Today's Qloo requests are used up. The screener resumes at 00:00 UTC; screens already run still open.";
const FLOOR_MESSAGE = "Live screens are paused: this month's Qloo quota is at its floor. Screens already run still open.";
const FAILED_MESSAGE = "The screen could not be finished just now. Try again shortly.";

export interface ScreenerDeps {
  /** The process-wide Qloo client; throws when it cannot be configured. */
  qloo: () => QlooClient;
  /** False with QLOO_DISABLED=1. */
  qlooEnabled: boolean;
  /** The lane's mode from every breaker but the LLM spend (a screen makes no LLM call). */
  mode: (lane: Lane) => Promise<DesMode>;
  /** The pinned market localities (server/localities.ts); null leaves every market unread. */
  localities: () => LocalityApi | null;
  /**
   * The Category Taste Map's builder (quant `tasteMapFromScreen`: classical MDS over the screen's
   * triangular similarities). A map it cannot draw comes back with the reason, which the screen lists.
   * Absent: distinctiveness is still measured, and the screen says the map is not drawn.
   */
  tasteMap?: (input: ScreenerMapInput) => TasteMapBuild | null;
  /** Counts one live screen in today's kv counter (screener.count.<day>, /status). Never fails a screen. */
  countScreen?: (nowMs: number) => Promise<void>;
  /** Records one live screen's measured cost (feature_uses, /method). Never fails a screen. */
  recordUse?: (use: FeatureUseRecord) => Promise<void>;
  now?: () => number;
}

export interface ScreenerServiceOptions {
  limits?: DesLimits;
  answerTtlMs?: number;
  answerMax?: number;
  timeoutMs?: number;
}

export interface ScreenerServiceRequest {
  body: ScreenerRequest;
  lane: Lane;
  /** The visitor's key (client-ip.ts); null without an address: no per-visitor limit applies. */
  visitor: string | null;
}

class Stop extends Error {
  constructor(readonly answer: ScreenerAnswer) {
    super(answer.kind);
    this.name = "ScreenerStop";
  }
}

const unavailable = (message: string, retryAfterS: number | null): ScreenerAnswer => ({ kind: "unavailable", message, retryAfterS });

function waitText(s: number): string {
  if (s < 60) return `in ${s} s`;
  const m = Math.ceil(s / 60);
  return `in ${m} ${m === 1 ? "minute" : "minutes"}`;
}

function waitAnswer(wait: DesWait): ScreenerAnswer {
  switch (wait.scope) {
    case "daily":
      return unavailable(BUDGET_MESSAGE, wait.retryAfterS);
    case "visitor":
      return unavailable(`You have run several new screens in a short time. Try again ${waitText(wait.retryAfterS)}; screens already run still open.`, wait.retryAfterS);
    case "global":
      return unavailable(`The screener is busy right now. Try again ${waitText(wait.retryAfterS)}.`, wait.retryAfterS);
  }
}

function budgetAnswer(err: BudgetError, now: number): ScreenerAnswer | null {
  if (err.gate === "daily_lane_cap") return unavailable(BUDGET_MESSAGE, Math.max(1, Math.ceil((nextUtcMidnight(now) - now) / 1000)));
  if (err.gate === "month_floor" || err.gate === "tag_cap") return unavailable(FLOOR_MESSAGE, null);
  return null;
}

/** One screen's Qloo scope and the requests it made, numbered Q1, Q2, … in the order they were asked. */
class Screen {
  readonly entries: ScreenerRequestEntry[] = [];
  private next = 1;

  constructor(
    readonly scope: RunQloo,
    /** The scope's call records, as its onCall pushes them. */
    private readonly records: readonly QlooCallRecord[],
    private readonly now: () => number,
  ) {}

  /**
   * One request: its own tool id (the Q#), so its call record is found whether it answered or failed.
   * A budget refusal before sending has no record and no Q#; a refusal that pauses the screener stops it.
   */
  async call<T>(purpose: ScreenerRequestPurpose, context: string | null, run: (api: ReturnType<RunQloo["forTool"]>) => Promise<T>): Promise<{ id: ScreenerRequestId | null; value: T | null; error: unknown }> {
    const id = `Q${this.next++}` as ScreenerRequestId;
    try {
      const value = await run(this.scope.forTool(id));
      this.record(id, purpose, context);
      return { id, value, error: null };
    } catch (err) {
      if (err instanceof BudgetError) {
        const stop = budgetAnswer(err, this.now());
        if (stop !== null) throw new Stop(stop);
      }
      return { id: this.record(id, purpose, context) ? id : null, value: null, error: err };
    }
  }

  private record(id: ScreenerRequestId, purpose: ScreenerRequestPurpose, context: string | null): boolean {
    const rec = [...this.records].reverse().find((r) => r.toolCallId === id);
    if (!rec) return false;
    const prov = this.scope.provenance(rec.qlooCallId);
    const request: QlooProvenanceRequest =
      prov !== null && !isPublicProvenanceRequest(prov) ? prov : { method: "GET", path: rec.path, query: rec.query };
    this.entries.push({
      id,
      purpose,
      context,
      request,
      requestId: rec.requestId ?? `none-${rec.qlooCallId}`,
      cache: rec.cache,
      fetchedAt: rec.fetchedAt ?? new Date(this.now()).toISOString(),
      rows: rec.rows,
      error: rec.error,
    });
    return true;
  }
}

/** An insights answer as the compute reads it, or the gap that stands in for a failed or refused call. */
function responseOf(r: { id: ScreenerRequestId | null; value: { data: { results: { entities: QlooEntity[] } }; meta: ScreenerResponseMeta } | null; error: unknown }): ScreenerResponse {
  if (r.value !== null && r.id !== null) return { kind: "ok", id: r.id, entities: r.value.data.results.entities, meta: r.value.meta };
  return { kind: "gap", id: r.id, reason: r.error instanceof BudgetError ? "budget_truncated" : "error" };
}
type ScreenerResponseMeta = Extract<ScreenerResponse, { kind: "ok" }>["meta"];

/** The seed once resolved: a category tag or a brand. */
type Seed =
  | { by: "tag"; label: string; tagId: string }
  | { by: "brand"; label: string; entity: QlooSearchEntity; searchId: ScreenerRequestId };

export class ScreenerService {
  private readonly deps: ScreenerDeps;
  private readonly limiter: DesLimiter;
  private readonly answers: ScreenerAnswers;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  /** Screens in flight by key: a second request for the same screen waits for the first. */
  private readonly inFlight = new Map<string, Promise<ScreenerAnswer>>();

  constructor(deps: ScreenerDeps, options: ScreenerServiceOptions = {}) {
    this.deps = deps;
    this.limiter = new DesLimiter(options.limits ?? DEFAULT_SCREENER_LIMITS);
    this.answers = new ScreenerAnswers(options.answerTtlMs, options.answerMax);
    this.timeoutMs = options.timeoutMs ?? SCREENER_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Fresh Qloo calls screens made today (UTC), for /status and tests. */
  networkToday(): number {
    return this.limiter.networkToday(this.now());
  }

  /** The answer cache's screen for this request, as a repeat reads it (no network call); null on a miss. */
  cached(body: ScreenerRequest): ScreenerAnswer | null {
    const screen = this.answers.get(screenerKey(body), this.now());
    return screen === null ? null : { kind: "ok", screen: { ...screen, qloo: { network: 0, cached: screen.requests.length } } };
  }

  /** The screen for a request, or why there is none. Never throws. */
  async screen(request: ScreenerServiceRequest): Promise<ScreenerAnswer> {
    const hit = this.cached(request.body);
    if (hit !== null) return hit;
    const key = screenerKey(request.body);
    try {
      const { client, mode } = await this.admit(request.lane);
      const pending = this.inFlight.get(key);
      if (pending) return await pending;
      const cap = SCREENER_BASE_QLOO_CAP + (request.body.map ? SCREENER_MAP_QLOO_CAP : 0);
      const started = this.now();
      const wait = this.limiter.take(request.visitor, started, cap);
      if (wait !== null) return waitAnswer(wait);
      const run = this.run(client, mode, request, key, cap, started).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, run);
      return await run;
    } catch (err) {
      if (err instanceof Stop) return err.answer;
      log.error({ err }, "screener: the screen failed");
      return unavailable(FAILED_MESSAGE, null);
    }
  }

  private async admit(lane: Lane): Promise<{ client: QlooClient; mode: DesMode }> {
    if (!this.deps.qlooEnabled) throw new Stop(unavailable(QLOO_OFF_MESSAGE, null));
    const mode = await this.deps.mode(lane);
    if (mode.mode === "replay_only") {
      const resumes = mode.until !== null ? " It resumes at 00:00 UTC." : "";
      throw new Stop(unavailable(`Live screens are paused: ${mode.reason ?? "it was paused by the operator"}.${resumes} Screens already run still open.`, null));
    }
    try {
      return { client: this.deps.qloo(), mode };
    } catch (err) {
      log.error({ err }, "screener: the Qloo client could not be created");
      throw new Stop(unavailable(UNCONFIGURED_MESSAGE, null));
    }
  }

  private async run(client: QlooClient, mode: DesMode, request: ScreenerServiceRequest, key: string, cap: number, started: number): Promise<ScreenerAnswer> {
    const limits: RunLimits = { ...DEFAULT_RUN_LIMITS, qlooCalls: cap, qlooWarnAt: cap };
    const records: QlooCallRecord[] = [];
    const scope = client.forRun({
      runId: `scr_${randomBytes(8).toString("hex")}`,
      lane: request.lane,
      pillar: "investment",
      limits,
      phase: () => "scan",
      onCall: (record) => records.push(record),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const screen = new Screen(scope, records, this.now);
    try {
      const answer = await this.compute(screen, request.body, mode, started);
      if (answer.kind === "ok" && complete(answer.screen)) this.answers.set(key, answer.screen, started);
      return answer;
    } catch (err) {
      if (err instanceof Stop) return err.answer;
      log.warn({ err }, "screener: the screen failed");
      return unavailable(FAILED_MESSAGE, null);
    } finally {
      this.limiter.settle(cap, scope.networkUsed(), started, this.now());
      this.recordUse(records, started);
    }
  }

  /** One live screen: today's counter and its feature_uses row. Failures are logged, never shown. */
  private recordUse(records: readonly QlooCallRecord[], started: number): void {
    const ms = Math.max(0, Math.round(this.now() - started));
    this.deps.countScreen?.(started).catch((err: unknown) => log.warn({ err }, "screener: today's count could not be stored"));
    if (records.length === 0 || this.deps.recordUse === undefined) return;
    const network = records.filter((r) => r.cache === "miss").length;
    this.deps
      .recordUse({ feature: "screener", qlooNetwork: network, qlooCached: records.length - network, ms })
      .catch((err: unknown) => log.warn({ err }, "screener: the feature use could not be recorded"));
  }

  private async compute(screen: Screen, body: ScreenerRequest, mode: DesMode, started: number): Promise<ScreenerAnswer> {
    const call: Screen["call"] = (purpose, context, fn) => screen.call(purpose, context, fn);
    const seed = await this.resolve(call, body);
    if (seed.kind !== "seed") return seed.answer;
    const s = seed.seed;
    const limitations: string[] = [];

    // Discovery: the screened set (FORMULAS screen.universe).
    const take = s.by === "brand" ? body.rows - 1 : body.rows;
    let discoveryParams: QlooParams;
    if (s.by === "tag") {
      discoveryParams = screenerTagDiscoveryParams(s.tagId, take);
      limitations.push(`Brands Qloo files under the category "${s.label}", ranked by how strongly that category's taste points to each (FIT, within this set).`);
    } else {
      const d = screenerBrandDiscovery(s.entity, take);
      discoveryParams = d.params;
      limitations.push(
        d.categoryName !== null
          ? `Brands whose audience taste is nearest ${s.label}'s, inside its Qloo category (${d.categoryName}). FIT is that nearness, within this set.`
          : `${s.label} carries no Qloo brand category, so these are its nearest brands across categories. FIT is that nearness, within this set.`,
      );
    }
    const context = `${s.by === "tag" ? `category ${s.label}` : `near ${s.label}`}; also the FIT scale`;
    const discovery = await call("discovery", context, (api) => api.insights(BRAND, discoveryParams));
    const discoveryResponse = responseOf(discovery);
    if (discoveryResponse.kind !== "ok") return unavailable(FAILED_MESSAGE, null);
    const gate = qualityGate(discoveryResponse.entities, (e) => e.popularity ?? null);
    if (gate.dropped.length > 0) {
      limitations.push(`${gate.dropped.length} result${gate.dropped.length === 1 ? "" : "s"} below Qloo popularity 0.01 left out as likely artifacts (quality gate).`);
    }
    const candidates: ScreenerCandidate[] = [];
    if (s.by === "brand") {
      candidates.push({ key: "b1", label: s.entity.name, disambiguation: s.entity.disambiguation ?? null, entityId: s.entity.entity_id, popularity: s.entity.popularity ?? null, popularityFrom: s.searchId, seed: true });
    }
    for (const e of gate.kept.slice(0, take)) {
      if (candidates.some((c) => c.entityId === e.entity_id)) continue;
      candidates.push({ key: `b${candidates.length + 1}`, label: e.name, disambiguation: e.disambiguation ?? null, entityId: e.entity_id, popularity: e.popularity ?? null, popularityFrom: discoveryResponse.id, seed: false });
    }
    const ids = candidates.map((c) => c.entityId);

    // One-scale scoring: the discovery call scored every brand against the same signal.
    const fit: ScreenerResponse = discoveryResponse;

    // Ages and markets: one rank call each over the same list, in parallel.
    const ageSpecs = screenerAgeSpecs();
    const breadth = breadthMarkets(body.markets);
    if (breadth.length > body.markets.length) {
      limitations.push(
        `Metro breadth across ${breadth.length} markets: ${breadth.map((id) => screenerMarket(id)?.label ?? marketLabel(id)).join(", ")} ` +
          "(the market you chose plus the largest pinned markets, because one market alone says nothing about breadth).",
      );
    } else if (breadth.length > 0) limitations.push(`Metro breadth across ${breadth.length} ${breadth.length === 1 ? "market" : "markets"}.`);
    const marketSpecs = await this.marketSpecs(breadth);
    for (const spec of marketSpecs) if (spec.gap) limitations.push(spec.gap.notice);
    const contextCall = async (purpose: "age" | "market", spec: (typeof ageSpecs)[number]): Promise<ScreenerContextCall> => {
      if (spec.signal === null || ids.length < 2) return { spec, response: { kind: "gap", id: null, reason: spec.gap?.reason ?? "insufficient_n" } };
      const signal = spec.signal;
      return { spec, response: responseOf(await call(purpose, spec.label, (api) => api.insights(BRAND, screenerScoringParams(signal, ids)))) };
    };
    const [ages, markets] = await Promise.all([
      Promise.all(ageSpecs.map((spec) => contextCall("age", spec))),
      Promise.all(marketSpecs.map((spec) => contextCall("market", spec))),
    ]);

    // The taste map: triangular similarity calls over the top rows.
    let mapCalls = null as { members: number[]; responses: ScreenerResponse[] } | null;
    if (body.map) {
      const members = screenerMapMembers(candidates, screenerFit({ candidates, fit }).pct);
      if (members.length >= TASTE_MAP_MIN_K) {
        const plan = screenerMapPlan(members.map((j) => candidates[j]!.entityId));
        const responses = await Promise.all(
          plan.map((p, i) => call("taste_map", `similarity row ${i + 1} of ${plan.length}`, (api) => api.insights(BRAND, p.params)).then(responseOf)),
        );
        mapCalls = { members, responses };
      } else {
        limitations.push(`The taste map needs at least ${TASTE_MAP_MIN_K} brands; this screen has ${members.length}.`);
      }
    }

    const computed = computeScreener({ candidates, fit, ages, markets, map: mapCalls });
    let map: TasteMapPayload | null = null;
    if (computed.map !== null) {
      if (this.deps.tasteMap) {
        const built = this.deps.tasteMap(computed.map);
        if (built !== null && !built.ok) limitations.push(built.message);
        const parsed = built?.ok ? TasteMapPayload.safeParse(built.payload) : null;
        if (parsed?.success) map = parsed.data;
        else if (parsed) {
          log.warn({ issues: parsed.error.issues }, "screener: the taste map did not validate");
          limitations.push("The taste map could not be drawn for this screen; the table is unaffected.");
        }
      } else {
        limitations.push("The taste map view is not drawn on this server yet; distinctiveness is measured from its calls.");
      }
    }

    limitations.push(...computed.notes, ...standingLimitations(body, screen.entries));
    const result = ScreenerResult.safeParse({
      seed: { by: s.by, label: s.label },
      markets: breadth.map((id) => ({ id, label: screenerMarket(id)?.label ?? marketLabel(id) })),
      columns: SCREENER_COLUMNS,
      rows: computed.rows,
      requests: screen.entries,
      map,
      limitations,
      mode: mode.mode,
      qloo: { network: screen.entries.filter((e) => e.cache === "miss").length, cached: screen.entries.filter((e) => e.cache !== "miss").length },
      createdAt: new Date(started).toISOString(),
    });
    if (!result.success) {
      log.error({ issues: result.error.issues }, "screener: the screen did not validate");
      return unavailable(FAILED_MESSAGE, null);
    }
    // R8 (D51): the browser gets readable names in place of Qloo entity ids; the server keeps the ids.
    const names = new Map(candidates.map((c) => [c.entityId.toLowerCase(), c.label]));
    return { kind: "ok", screen: scrubEntityIds(result.data, (id) => names.get(id.toLowerCase()) ?? null) as typeof result.data };
  }

  /** The seed, or the answer that stands in for it (a picker, the closest names, a failed lookup). */
  private async resolve(call: Screen["call"], body: ScreenerRequest): Promise<{ kind: "seed"; seed: Seed } | { kind: "answer"; answer: ScreenerAnswer }> {
    const answer = (a: ScreenerAnswer) => ({ kind: "answer" as const, answer: a });
    if (body.seed.by === "tag") {
      const query = body.seed.query;
      const r = await call("resolve", `category "${query}"`, (api) => api.tags(screenerTagSearchParams(query)));
      if (r.value === null) return answer(unavailable(FAILED_MESSAGE, null));
      const items = r.value.data.results.tags;
      const { exact, others } = classifyCategoryTags(query, items);
      const asCandidate = (t: (typeof items)[number]): PickerCandidate => ({
        key: pickerKey(t.id),
        name: t.name,
        disambiguation: categoryPath(t.id),
        popularity: t.popularity ?? null,
      });
      const picked = body.pick ? [...exact, ...others].find((t) => pickerKey(t.id) === body.pick) : undefined;
      const tag = picked ?? (exact.length === 1 ? exact[0] : undefined);
      if (tag) return { kind: "seed", seed: { by: "tag", label: tag.name, tagId: tag.id } };
      if (exact.length > 1) {
        return answer({ kind: "pick", message: `More than one Qloo category is called "${query}". Pick the one you mean.`, candidates: exact.slice(0, PICK_MAX).map(asCandidate) });
      }
      return answer({
        kind: "not_found",
        message:
          others.length > 0
            ? `No Qloo brand category is called "${query}". The closest are below; nothing was swapped in for you.`
            : `No Qloo brand category matches "${query}". Try a broader word, or screen a seed brand instead.`,
        candidates: others.slice(0, PICK_MAX).map(asCandidate),
      });
    }

    const name = body.seed.name;
    const params = searchParams({ text: name, type: "brand", metro: null });
    if (params === null) return answer(unavailable(FAILED_MESSAGE, null));
    const r = await call("resolve", `brand "${name}"`, (api) => api.search(params));
    if (r.value === null || r.id === null) return answer(unavailable(FAILED_MESSAGE, null));
    const results = r.value.data.results;
    const choice = body.pick ? findPickerChoice(results, body.pick) : null;
    const m = classifyMatches({ text: name, type: "brand" }, results);
    const entity = choice ?? (m.matchClass === "exact" ? m.exact[0] : undefined);
    if (entity) return { kind: "seed", seed: { by: "brand", label: entity.name, entity, searchId: r.id } };
    const candidates = m.alternatives.map((a) => ({ key: pickerKey(a.result.entity_id), name: a.name, disambiguation: a.disambiguation, popularity: a.popularity }));
    if (m.matchClass === "ambiguous") return answer({ kind: "pick", message: `More than one brand in Qloo is called "${name}". Pick the one you mean.`, candidates });
    return answer({
      kind: "not_found",
      message: candidates.length > 0 ? `"${name}" is not a brand in Qloo's data. The closest names are below; nothing was swapped in for you.` : `"${name}" is not a brand in Qloo's data. Check the spelling or use the full name.`,
      candidates,
    });
  }

  /** The market contexts, each market's pinned locality looked up once (a failed lookup reads as unpinned). */
  private async marketSpecs(markets: readonly MarketId[]) {
    const localities = this.deps.localities();
    const unique = [...new Set(markets)];
    const pins = await Promise.allSettled(unique.map((m) => Promise.resolve().then(() => localities?.market(m) ?? null)));
    return unique.map((m, i) => {
      const pin = pins[i];
      return screenerMarketSpec(m, pin?.status === "fulfilled" ? pin.value : "failed", localities !== null);
    });
  }
}

/** A screen worth keeping: no request failed and none was refused by a budget. */
function complete(screen: ScreenerResult): boolean {
  return screen.requests.every((r) => r.error === null) && !screen.rows.some((row) => Object.values(row.cells).some((c) => c.reason === "budget_truncated" || c.reason === "error"));
}

/**
 * The largest pinned markets a single-market screen adds for metro breadth (Part 10 open issue: breadth
 * over one market is not breadth), in this order, skipping the chosen one.
 */
export const BREADTH_FILL_MARKETS: readonly MarketId[] = ["nyc", "los_angeles", "chicago"];
/** Markets metro breadth reads at most. */
export const BREADTH_MAX_MARKETS = 4;

/** The markets a screen reads breadth over: the chosen ones, plus the largest markets when only one was chosen. */
export function breadthMarkets(chosen: readonly MarketId[]): MarketId[] {
  const unique = [...new Set(chosen)];
  if (unique.length !== 1) return unique.slice(0, BREADTH_MAX_MARKETS);
  return [...unique, ...BREADTH_FILL_MARKETS.filter((m) => !unique.includes(m))].slice(0, BREADTH_MAX_MARKETS);
}

/** The limits every screen states: group-level taste, compressed scores, the snapshot dates. */
function standingLimitations(body: ScreenerRequest, entries: readonly ScreenerRequestEntry[]): string[] {
  const dates = entries.map((e) => e.fetchedAt.slice(0, 10)).sort();
  const first = dates[0];
  const last = dates[dates.length - 1];
  const snapshot = first === undefined ? null : first === last ? first : `${first} to ${last}`;
  return [
    "Group-level taste data: what the audiences of these brands like, never any individual. Taste fit within this set, not sales, share or revenue.",
    "Qloo's scores are compressed: read ranks and clear gaps, not small differences. Percentiles compare these brands only.",
    `Next-gen tilt compares ${SCREENER_AGES.length === 3 ? "24 and younger and 25–29 against 55 and older" : "young against old age contexts"}.`,
    ...(body.markets.length === 0 ? ["Metro breadth needs markets: pick up to 4 to read it."] : []),
    ...(body.map ? [] : ["Distinctiveness needs the taste map's similarity calls (up to 13 more Qloo requests): turn on the taste map to measure it."]),
    ...(snapshot === null ? [] : [`Snapshot: Qloo data as fetched on ${snapshot} (UTC); saved copies keep their original date.`]),
  ];
}
