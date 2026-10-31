import "server-only";
import { randomBytes } from "node:crypto";
import {
  createEntityRegistry,
  createRunBudget,
  createRunLedger,
  findPickerChoice,
  runResolutionGate,
  type GateOutcome,
  type RunLedger,
  type RunRegistry,
} from "@ct/agent";
import {
  DEFAULT_RUN_LIMITS,
  EMPTY_CANDIDATES,
  NO_RUN_CANDIDATES,
  type GeoApi,
  type Intent,
  type Lane,
  type Metric,
  type Mode,
  type QlooCallMeta,
  type RegisteredEntity,
  type RunLimits,
  type Skill,
  type SkillCtx,
  type SkillId,
} from "@ct/contracts";
import { BudgetError, scrubEntityIds, type QlooCallRecord, type QlooClient, type QlooTool, type RunQloo } from "@ct/qloo";
import { addSkillMetric, normaliseName, searchParams, SKILLS } from "@ct/quant";
import { desHref, desMnemonic, type DesQuery, type DesType } from "../../components/des/des-href";
import type { DesCandidate, DesOutcome, DesSectionId, Tearsheet } from "../../components/des/model";
import type { Breaker } from "../breakers";
import { log } from "../log";
import { isCurated } from "./curated";
import { DEFAULT_DES_LIMITS, DesLimiter, nextUtcMidnight, type DesLimits, type DesWait } from "./limits";
import { buildTearsheet, SECTION_SKILL, type SectionRun } from "./tearsheet";
import type { VettedPerson } from "./vetted";

/**
 * The DES tearsheet (P1 #1, SPEC D11): code only, $0 LLM. For one name and
 * type it runs the agent's own resolution gate (exact normalised name and type, D20: a tie is a
 * picker, a miss offers candidates and applies none), then Audience DNA, the cultural neighbourhood
 * and travel taste through the QUANT skills' public exports, exactly as an opening scan would, and
 * shapes the ledger into a one-page tearsheet (./tearsheet.ts).
 *
 * Guarded like the rest of the server: a person is looked up only once vetted as a public figure
 * (CLERK's rule at $0: curated, or marked so by CLERK in a brief, ./vetted.ts), decided before any
 * Qloo request, so a private person's name is never sent; the mode machine (every breaker but the LLM
 * spend, which a tearsheet never touches) and QLOO_DISABLED turn it off with a clear reason; its Qloo
 * calls run in a lane scope, so the client's daily lane caps, run cap and month floor apply; and
 * ./limits.ts adds the per-visitor, hourly and daily tearsheet limits. A tearsheet once computed is
 * kept for DES_ANSWER_TTL_MS and served again at no cost, in any mode; the Qloo cache makes a
 * recomputation free of network calls too.
 */

/**
 * Qloo network calls one tearsheet may make. It needs nine at most: the search, a pin's describe, DNA's
 * demographics and describe, four domains and travel taste.
 */
export const DES_RUN_QLOO_CAP = 12;
/** Wall clock for one lookup, gate and skills together. */
export const DES_TIMEOUT_MS = 25_000;
/** How long a computed tearsheet answers the same name, type and pick again (an answer cache, D26). */
export const DES_ANSWER_TTL_MS = 60 * 60_000;
/** Tearsheets the answer cache holds; the oldest goes first. */
export const DES_ANSWER_MAX = 200;
/** cross_domain domains: music, podcasts, TV and brands, as the audience brief reads them (A08). */
export const DES_DOMAINS = ["artist", "podcast", "tv_show", "brand"] as const;

const DES_LIMITS: RunLimits = { ...DEFAULT_RUN_LIMITS, qlooCalls: DES_RUN_QLOO_CAP, qlooWarnAt: DES_RUN_QLOO_CAP };
const NO_STEP = { trigger_finding_id: null, step_id: null } as const;

const PAUSED_REASON = "it was paused by the operator";
const QLOO_OFF_MESSAGE = "Profiles are off: this server makes no Qloo requests (QLOO_DISABLED). Answers you already have still open.";
const UNCONFIGURED_MESSAGE = "Profiles are unavailable: the Qloo client is not configured on this server.";
const BUDGET_MESSAGE = "Today's Qloo requests for profiles are used up. Profiles resume at 00:00 UTC; answers you already have still open.";
const FLOOR_MESSAGE =
  "Live profiles are paused: this month's Qloo quota is at its floor. Profiles read earlier and answers you already have still open.";
const FAILED_MESSAGE = "The name could not be looked up in Qloo just now. Try again shortly.";
const NOT_VETTED_MESSAGE =
  "This name is not among the vetted public figures, so no Qloo request was made for it. To read a public figure's audience, ask a question about them: a brief checks first whether they are one. Culture Terminal reads an audience's taste, never an individual's.";
const PICK_MESSAGE = "Pick the one you mean: each opens its own tearsheet.";

/** What the mode machine says about a lane, for a lookup that spends no LLM. */
export interface DesMode {
  mode: Mode;
  /** The breaker that stepped it down (breakers.ts Breaker); null while live. */
  breaker: Breaker | null;
  /** Why it stepped down ("today's Qloo requests are used up"); null while live. */
  reason: string | null;
  /** When the step-down lifts by itself (ISO); null when it does not. */
  until: string | null;
}

export interface DesDeps {
  /** The process-wide Qloo client; throws when it cannot be configured. */
  qloo: () => QlooClient;
  /** False with QLOO_DISABLED=1: no lookup at all. */
  qlooEnabled: boolean;
  /** The lane's mode from every breaker but the LLM spend. */
  mode: (lane: Lane) => Promise<DesMode>;
  /** The gazetteer the skill context carries (these skills read no area). */
  geo: () => GeoApi;
  /**
   * Whether a person who is not curated was vetted as a public figure, with no Qloo request
   * (./vetted.ts). Absent: only curated persons are looked up.
   */
  vettedPerson?: VettedPerson;
  /**
   * Records one finished lookup's measured cost (feature_uses, /method's measured costs). Never fails a
   * lookup: an error is logged and dropped.
   */
  recordUse?: (use: FeatureUseRecord) => Promise<void>;
  now?: () => number;
}

export interface DesServiceOptions {
  limits?: DesLimits;
  answerTtlMs?: number;
  answerMax?: number;
  timeoutMs?: number;
}

export interface DesRequest {
  query: DesQuery;
  lane: Lane;
  /** The visitor's key (client-ip.ts); null without an address: no per-visitor limit applies. */
  visitor: string | null;
}

interface Answer {
  sheet: Tearsheet;
  at: number;
}

/** One feature use as /method measures it: Qloo calls (network and cached) and wall time. */
export interface FeatureUseRecord {
  feature: "des_profile" | "screener";
  qlooNetwork: number;
  qlooCached: number;
  ms: number;
}

/**
 * R8 (D51): a tearsheet as the browser gets it: every Qloo entity id in its evidence and request
 * parameters replaced by the entity's readable name (the server keeps the ids in its caches).
 */
export function publicSheet<T>(sheet: T, registry: Pick<RunRegistry, "entities">): T {
  const names = new Map(registry.entities().map((e) => [e.entityId.toLowerCase(), e.name]));
  return scrubEntityIds(sheet, (id) => names.get(id.toLowerCase()) ?? null) as T;
}

/** The answer-cache key: names compared as the gate compares them, and the pick. */
export const desKey = (query: DesQuery): string => `${query.type}|${normaliseName(query.name)}|${query.pick ?? ""}`;

/** The intent the gate reads: one primary mention, as CLERK would write it for "<NAME> DES". */
export function desIntent(query: { name: string; type: DesType }, publicFigure: boolean): Intent {
  return {
    pillar: "audience",
    job: "audience_discovery",
    mentions: [{ text: query.name, entity_type: query.type, role: "primary", public_figure: query.type === "person" && publicFigure }],
    geo: { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: [] },
    constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [], concept_description: null },
    safety: { allowed: true, category: null, reframe: null },
    read_as: { nearest: false, not_covered: [] },
    assumptions: ["US geography"],
    mnemonic: desMnemonic(query),
    candidates: EMPTY_CANDIDATES,
  };
}

/** "in 40 s", "in 6 minutes". */
function waitText(wait: DesWait): string {
  if (wait.retryAfterS < 60) return `in ${wait.retryAfterS} s`;
  const minutes = Math.ceil(wait.retryAfterS / 60);
  return `in ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** A limit reached: the day's allowance pauses tearsheets until 00:00 UTC; the others ask for a short wait. */
function waitOutcome(wait: DesWait, now: number): DesOutcome {
  switch (wait.scope) {
    case "daily":
      return { kind: "unavailable", cause: "budget", message: BUDGET_MESSAGE, until: new Date(nextUtcMidnight(now)).toISOString() };
    case "visitor":
      return {
        kind: "limited",
        message: `You have opened several new tearsheets in a short time. Try again ${waitText(wait)}; profiles already read still open.`,
        retryAfterS: wait.retryAfterS,
      };
    case "global":
      return {
        kind: "limited",
        message: `Profiles are busy right now. Try again ${waitText(wait)}; profiles already read still open.`,
        retryAfterS: wait.retryAfterS,
      };
  }
}

/** The step-down as a tearsheet reader reads it. */
function pausedMessage(mode: DesMode): string {
  const resumes = mode.until !== null ? " They resume at 00:00 UTC." : "";
  return `Live profiles are paused: ${mode.reason ?? PAUSED_REASON}.${resumes} Profiles read earlier and answers you already have still open.`;
}

class Unavailable extends Error {
  constructor(readonly outcome: Extract<DesOutcome, { kind: "unavailable" | "failed" }>) {
    super(outcome.message);
    this.name = "DesUnavailable";
  }
}

/** One lookup's Qloo scope, registry and ledger, as an opening scan has them. */
interface Lookup {
  runId: string;
  scope: RunQloo;
  qloo: QlooTool;
  registry: RunRegistry;
  ledger: RunLedger;
  calls: QlooCallRecord[];
  signal: AbortSignal;
}

export class DesService {
  private readonly deps: DesDeps;
  private readonly limiter: DesLimiter;
  private readonly answerTtlMs: number;
  private readonly answerMax: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  /** Computed tearsheets by desKey, least recently stored first. */
  private readonly answers = new Map<string, Answer>();
  /** Lookups in flight by desKey: a second request for the same tearsheet waits for the first. */
  private readonly inFlight = new Map<string, Promise<DesOutcome>>();

  constructor(deps: DesDeps, options: DesServiceOptions = {}) {
    this.deps = deps;
    this.limiter = new DesLimiter(options.limits ?? DEFAULT_DES_LIMITS);
    this.answerTtlMs = options.answerTtlMs ?? DES_ANSWER_TTL_MS;
    this.answerMax = options.answerMax ?? DES_ANSWER_MAX;
    this.timeoutMs = options.timeoutMs ?? DES_TIMEOUT_MS;
    this.now = deps.now ?? Date.now;
  }

  /** Fresh Qloo calls tearsheets made today (UTC), for /status and tests. */
  networkToday(): number {
    return this.limiter.networkToday(this.now());
  }

  /**
   * The tearsheet for a name and type, or why there is none. Never throws: a database or Qloo
   * failure is an outcome the page words.
   */
  async describe(request: DesRequest): Promise<DesOutcome> {
    const key = desKey(request.query);
    const asked = { name: request.query.name, type: request.query.type };
    const cached = this.cached(key);
    if (cached !== null) return { kind: "ready", sheet: rebound(cached.sheet, asked), cachedAt: new Date(cached.at).toISOString() };
    try {
      // Before anything that reaches Qloo, and whether or not it is on: a refused name is never sent.
      if (!(await this.vetted(request.query))) return { kind: "refused", query: asked, message: NOT_VETTED_MESSAGE };
      const client = await this.admit(request);
      const pending = this.inFlight.get(key);
      if (pending) return reboundOutcome(await pending, asked);
      const started = this.now();
      const wait = this.limiter.take(request.visitor, started, DES_RUN_QLOO_CAP);
      if (wait !== null) return waitOutcome(wait, started);
      const lookup = this.lookup(client, request, key, started).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, lookup);
      return await lookup;
    } catch (err) {
      if (err instanceof Unavailable) return err.outcome;
      log.error({ err }, "des: the lookup failed");
      return { kind: "failed", message: FAILED_MESSAGE };
    }
  }

  /** The tearsheet in the answer cache, while it is fresh. */
  private cached(key: string): Answer | null {
    const hit = this.answers.get(key);
    if (!hit) return null;
    if (hit.at + this.answerTtlMs <= this.now()) {
      this.answers.delete(key);
      return null;
    }
    return hit;
  }

  private remember(key: string, sheet: Tearsheet, at: number): void {
    this.answers.delete(key);
    this.answers.set(key, { sheet, at });
    for (const oldest of this.answers.keys()) {
      if (this.answers.size <= this.answerMax) break;
      this.answers.delete(oldest);
    }
  }

  /**
   * CLERK's public-figure rule at $0 (SPEC §4.6): any other type passes; a person passes when curated
   * or vetted (./vetted.ts). A check that fails refuses: the name then goes nowhere.
   */
  private async vetted(query: DesQuery): Promise<boolean> {
    if (query.type !== "person" || isCurated(query.name, "person")) return true;
    try {
      return (await this.deps.vettedPerson?.(query.name)) ?? false;
    } catch (err) {
      log.warn({ err }, "des: a person could not be vetted");
      return false;
    }
  }

  /** The Qloo client when a new lookup may run at all: Qloo on, the lane not paused, the client configured. */
  private async admit(request: DesRequest): Promise<QlooClient> {
    if (!this.deps.qlooEnabled) throw new Unavailable({ kind: "unavailable", cause: "qloo_off", message: QLOO_OFF_MESSAGE, until: null });
    const mode = await this.deps.mode(request.lane);
    if (mode.mode === "replay_only") {
      // Only today's calls lift at 00:00 UTC; the month floor and every other step-down are a pause.
      const cause = mode.breaker === "qloo_daily" ? "budget" : "paused";
      throw new Unavailable({ kind: "unavailable", cause, message: pausedMessage(mode), until: mode.until });
    }
    try {
      return this.deps.qloo();
    } catch (err) {
      log.error({ err }, "des: the Qloo client could not be created");
      throw new Unavailable({ kind: "unavailable", cause: "unconfigured", message: UNCONFIGURED_MESSAGE, until: null });
    }
  }

  private open(client: QlooClient, lane: Lane): Lookup {
    const runId = `des_${randomBytes(8).toString("hex")}`;
    const calls: QlooCallRecord[] = [];
    const signal = AbortSignal.timeout(this.timeoutMs);
    // A lane scope, not a standalone one: the client then holds the lookup to the lane's share of
    // the day's fresh calls as well as the day's total, and to DES_RUN_QLOO_CAP.
    const scope = client.forRun({
      runId,
      lane,
      pillar: "audience",
      limits: DES_LIMITS,
      phase: () => "scan",
      onCall: (record) => calls.push(record),
      signal,
    });
    const ledger = createRunLedger({ emit: () => undefined, provenanceOf: (id) => scope.provenance(id) });
    return { runId, scope, qloo: scope.forTool(null), registry: createEntityRegistry(), ledger, calls, signal };
  }

  /** One lookup, from its start (when take() reserved its calls) to its settled count. */
  private async lookup(client: QlooClient, request: DesRequest, key: string, started: number): Promise<DesOutcome> {
    const { query } = request;
    const run = this.open(client, request.lane);
    try {
      return await this.resolveAndRun(run, query, key, started);
    } catch (err) {
      if (err instanceof Unavailable) return err.outcome;
      if (err instanceof BudgetError) return budgetOutcome(err, this.now());
      log.warn({ err, type: query.type }, "des: the lookup failed");
      return { kind: "failed", message: FAILED_MESSAGE };
    } finally {
      this.limiter.settle(DES_RUN_QLOO_CAP, run.scope.networkUsed(), started, this.now());
      this.recordUse(run, started);
    }
  }

  /** feature_uses: one row per lookup that reached Qloo (network or cache). */
  private recordUse(run: Lookup, started: number): void {
    if (this.deps.recordUse === undefined || run.calls.length === 0) return;
    const network = run.calls.filter((c) => c.cache === "miss").length;
    this.deps
      .recordUse({ feature: "des_profile", qlooNetwork: network, qlooCached: run.calls.length - network, ms: Math.max(0, Math.round(this.now() - started)) })
      .catch((err: unknown) => log.warn({ err }, "des: the feature use could not be recorded"));
  }

  private async resolveAndRun(run: Lookup, query: DesQuery, key: string, started: number): Promise<DesOutcome> {
    // A person reaches this only once vetted (vetted()), so the intent marks the mention a public figure.
    const intent = desIntent({ name: query.name, type: query.type }, true);

    // A picker choice becomes a pin, as a run's picker answer does: the key is matched against the
    // search the gate then repeats from the cache, so the browser never holds an entity id.
    const params = query.pick === null ? null : searchParams({ text: query.name, type: query.type, metro: null });
    const choice = params === null || query.pick === null ? null : findPickerChoice((await run.qloo.search(params)).data.results, query.pick);
    const pins: Record<string, string> = choice ? { [normaliseName(query.name)]: choice.entity_id } : {};
    const gate = await runResolutionGate({ intent, qloo: run.qloo, registry: run.registry, pins });
    return this.fromGate(run, query, key, gate, { started, picked: choice !== null });
  }

  private async fromGate(
    run: Lookup,
    query: DesQuery,
    key: string,
    gate: GateOutcome,
    { started, picked }: { started: number; picked: boolean },
  ): Promise<DesOutcome> {
    const asked = { name: query.name, type: query.type };
    switch (gate.kind) {
      case "refused":
        return { kind: "refused", query: asked, message: gate.reason };
      case "failed":
        if (gate.error instanceof BudgetError) return budgetOutcome(gate.error, this.now());
        throw gate.error;
      case "needs_input": {
        const candidates: DesCandidate[] = gate.picker.candidates.map((c) => ({
          key: c.key,
          name: c.name,
          disambiguation: c.disambiguation,
          popularity: c.popularity,
          href: desHref({ ...asked, pick: c.key }),
        }));
        // The page words these itself: the gate's sentences speak of a question to rephrase.
        return gate.picker.reason === "ambiguous"
          ? { kind: "pick", query: asked, message: PICK_MESSAGE, candidates }
          : { kind: "not_found", query: asked, message: notFoundMessage(candidates.length), candidates };
      }
      case "resolved":
        break;
    }
    const primary = gate.primary;
    if (primary === null) return { kind: "failed", message: FAILED_MESSAGE };
    const popularity = this.recordPopularity(run, primary, gate.primaryCalls);
    const sections = await this.runSections(run, primary);
    const built = buildTearsheet({
      query: asked,
      picked,
      entity: { name: primary.name, type: query.type, disambiguation: primary.disambiguation },
      computedAt: new Date(started).toISOString(),
      snapshot: run.ledger.snapshot(),
      calls: run.calls,
      sections,
      popularity,
    });
    const sheet = publicSheet(built, run.registry);
    if (complete(sections)) this.remember(key, sheet, started);
    return { kind: "ready", sheet, cachedAt: null };
  }

  /** The entity's popularity from the resolving /search, as resolve_entities records it (MEASURED). */
  private recordPopularity(run: Lookup, primary: RegisteredEntity, calls: readonly QlooCallMeta[]): Metric | null {
    if (calls.length === 0) return null;
    const name = primary.name;
    const evidence = run.ledger.addEvidence({
      skill: "resolve_entities",
      purpose: `Resolution: /search for '${name}' as ${primary.type}`,
      calls,
      status: "ok",
      summary: `'${name}' (${primary.type}): exact match.`,
      flags: [],
    });
    return addSkillMetric(run.ledger, {
      key: "popularity",
      label: `popularity ${name}`,
      subjectRefs: [primary.ref],
      value: primary.popularity,
      reason: "not_measured",
      display: primary.popularity === null ? "" : primary.popularity.toFixed(2),
      unit: "popularity",
      badge: "MEASURED",
      formulaId: "popularity",
      evidenceIds: [evidence.id],
      n: null,
      comparator: null,
    });
  }

  /** Audience DNA, the cultural neighbourhood and travel taste, in parallel, with the scan's default inputs. */
  private async runSections(run: Lookup, primary: RegisteredEntity): Promise<Record<DesSectionId, SectionRun>> {
    const ref = primary.ref;
    const budget = createRunBudget({
      limits: DES_LIMITS,
      qlooNetworkUsed: () => run.scope.networkUsed(),
      followupNetworkUsed: () => 0,
      phase: () => "scan",
      llmUsd: () => 0,
      startedAt: this.now(),
      now: this.now,
    });
    const geo = this.deps.geo();
    const ctx = (toolCallId: string): SkillCtx => ({
      qloo: run.scope.forTool(toolCallId),
      ledger: run.ledger.forToolCall(toolCallId),
      geo,
      localities: null,
      // A tearsheet reads taste data only: no SEC or Census lookups.
      publicdata: null,
      registry: run.registry,
      emit: () => undefined,
      budget,
      signal: run.signal,
      runId: run.runId,
      pillar: "audience",
      phase: "scan",
      toolCallId,
      concepts: [],
      candidates: NO_RUN_CANDIDATES,
    });
    const section = async (skill: SkillId, toolCallId: string, input: () => unknown): Promise<SectionRun> => {
      try {
        const runner = SKILLS[skill] as unknown as Skill<unknown>;
        return { kind: "ran", skill, result: await runner.run(runner.input.parse(input()), ctx(toolCallId)) };
      } catch (err) {
        if (err instanceof BudgetError) throw err;
        log.warn({ err, skill }, "des: a section's skill failed");
        return { kind: "failed", skill, message: err instanceof Error ? err.message : String(err) };
      }
    };
    const [dna, neighbours, travel] = await Promise.all([
      section(SECTION_SKILL.dna, "des-dna", () => ({ set: [ref], compare_with: null, ...NO_STEP })),
      section(SECTION_SKILL.neighbours, "des-neighbours", () => ({
        seeds: [ref],
        seed_tags: [],
        domains: [...DES_DOMAINS],
        popularity_max: 1,
        ...NO_STEP,
      })),
      section(SECTION_SKILL.travel, "des-travel", () => ({ seeds: [ref], ...NO_STEP })),
    ]);
    return { dna, neighbours, travel };
  }
}

/** A tearsheet worth keeping: no section failed or was cut short by a budget. */
function complete(sections: Record<DesSectionId, SectionRun>): boolean {
  return Object.values(sections).every((r) => r.kind === "ran" && r.result.status !== "error" && !r.result.flags.includes("BUDGET_TRUNCATED"));
}

/**
 * A budget gate's refusal: today's lane cap pauses tearsheets until 00:00 UTC, the month floor until
 * the quota is topped up; the lookup's own cap is a failure.
 */
function budgetOutcome(err: BudgetError, now: number): DesOutcome {
  switch (err.gate) {
    case "daily_lane_cap":
      return { kind: "unavailable", cause: "budget", message: BUDGET_MESSAGE, until: new Date(nextUtcMidnight(now)).toISOString() };
    case "month_floor":
      return { kind: "unavailable", cause: "paused", message: FLOOR_MESSAGE, until: null };
    default:
      return { kind: "failed", message: FAILED_MESSAGE };
  }
}

function notFoundMessage(candidates: number): string {
  return candidates > 0 ? "Check the spelling or the type, or open one of the closest names below." : "Check the spelling or the type.";
}

/**
 * A tearsheet computed for one spelling, as another reader asked for it: the answer cache and the
 * joins key names as the gate compares them, so the page's own name and command follow the asker.
 */
function rebound(sheet: Tearsheet, asked: { name: string; type: DesType }): Tearsheet {
  return sheet.query.name === asked.name ? sheet : { ...sheet, query: asked, mnemonic: desMnemonic(asked) };
}

/** An outcome another request computed, told to this asker: its name, command and picker links. */
function reboundOutcome(outcome: DesOutcome, asked: { name: string; type: DesType }): DesOutcome {
  switch (outcome.kind) {
    case "ready":
      return { ...outcome, sheet: rebound(outcome.sheet, asked) };
    case "pick":
    case "not_found":
      return { ...outcome, query: asked, candidates: outcome.candidates.map((c) => ({ ...c, href: desHref({ ...asked, pick: c.key }) })) };
    case "refused":
      return { ...outcome, query: asked };
    default:
      return outcome;
  }
}
