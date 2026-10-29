import {
  DEFAULT_RUN_LIMITS,
  FIXED_DISCLAIMERS,
  JOB_PILLAR,
  PUBLIC_ENDPOINTS,
  PUBLIC_SOURCE_LABEL,
  RunEvent,
  stampEvent,
  VIZ_COMPAT,
  type CacheStatus,
  type DatasetEnvelope,
  type DatasetId,
  type DatasetKind,
  type DatasetPayload,
  type EventInput,
  type EventInputOf,
  type Evidence,
  type EvidenceId,
  type Finding,
  type FindingId,
  type Flag,
  type Intent,
  type Job,
  type Metric,
  type MetricId,
  type PublicEndpoint,
  type PublicSource,
  type QlooPath,
  type QuadrantName,
  type Report,
  type ResolvedMention,
  type SkillId,
  type SponsorCategory,
  type TrendWindow,
} from "@ct/contracts";
import { GAZETTEER_CATALOG } from "@ct/geo";
import { KPI_SLOTS, pickMatches } from "@/lib/brief/kpi-slots";

/**
 * Synthetic finished runs, one per job, for the /dev/brief viewer and the brief tests: every Part 5
 * exhibit kind (lift map, slope, momentum, position card, slate) on a brief, with the key figures, the
 * location method and its CODE FALLBACK, and next moves for every desk. Built here, not recorded: every
 * brand, artist, request id and number is invented (D29); only the public geography (Austin planning
 * areas, Nashville ZIP areas from @ct/geo) is real. Each run passes the RunEvent schema, from run.created
 * to run.end, and its report keeps the contracts' Report shape, so the brief reads it like any run.
 * SEC filings and Census figures (Part 9) are invented too: no company, filing, accession or estimate in
 * them is real, and the references are `mock-` ones as the mock transport writes them.
 */

type Args = EventInputOf<"tool.start">["args"];

const T0 = Date.UTC(2026, 9, 21, 9, 0, 0);
const STEP_MS = 420;
const WINDOW: TrendWindow = { start: "2025-04-01", end: "2025-09-30" };

interface HypothesisSpec {
  statement: string;
  expectation: string;
  tool: SkillId;
  verdict: "CONFIRMED" | "REFUTED" | "INCONCLUSIVE";
  metrics: () => MetricId[];
  note: string;
}

interface ReportSpec {
  /** Prose writes {{name}} for the metric a job named, {{WINDOW}} for the trending window. */
  names: Record<string, MetricId>;
  headline: string;
  tag: string;
  signal: Report["verdict"]["signal"];
  thesis: string;
  /** Exhibits in layout order: a dataset and its title and caption. */
  exhibits: { dataset: () => DatasetId; title: string; caption: string }[];
  arguments: { section: Report["arguments"][number]["section"]; fact: string; read: string; strength: Report["arguments"][number]["strength"] }[];
  bearCase: string[];
  recommendations: { action: string; priority: "now" | "next" | "later" }[];
  nextMoves: { label: string; question: string }[];
  penalties?: Report["verdict"]["confidence"]["breakdown"];
  limitations?: string[];
  /** D41: what the question asked beyond its job, as the READ_AS_NEAREST_JOB limitation says it. */
  readAs?: string;
}

/** One tool call: its Qloo calls, evidence, metrics, datasets, findings and fallbacks, in event order. */
class ToolScope {
  readonly evidenceIds: EvidenceId[] = [];
  readonly metricIds: MetricId[] = [];
  readonly datasetIds: DatasetId[] = [];
  readonly findingIds: FindingId[] = [];
  readonly flags = new Set<Flag>();

  constructor(
    private readonly run: RunBuilder,
    readonly toolCallId: string,
    readonly skill: SkillId,
  ) {}

  /** A Qloo call this tool made; its id. */
  call(endpoint: QlooPath, filterType: string | null, params: Record<string, string>, rows: number, cache: CacheStatus = "miss"): string {
    return this.run.qloo(this.toolCallId, endpoint, filterType, params, rows, cache);
  }

  /** An SEC or Census call this tool made (synthetic, no Qloo cost); its id. */
  publicCall(endpoint: PublicEndpoint, path: string, query: Record<string, string>, reference: string, cache: CacheStatus = "miss"): string {
    return this.run.public(this.toolCallId, endpoint, path, query, reference, cache);
  }

  evidence(purpose: string, summary: string, calls: string[], flags: Flag[] = []): EvidenceId {
    for (const f of flags) this.flags.add(f);
    const id = this.run.addEvidence(this.skill, purpose, summary, calls, flags);
    this.evidenceIds.push(id);
    return id;
  }

  metric(spec: MetricSpec): MetricId {
    const id = this.run.addMetric(spec);
    this.metricIds.push(id);
    return id;
  }

  dataset<K extends DatasetKind>(kind: K, title: string, payload: DatasetPayload<K>, evidenceIds: EvidenceId[], formulaIds: string[]): DatasetId {
    const id = this.run.addDataset(kind, title, payload, evidenceIds, formulaIds);
    this.datasetIds.push(id);
    return id;
  }

  finding(kind: Finding["kind"], text: string, metricIds: MetricId[], suggestion: Finding["suggestion"] = null): FindingId {
    const id = this.run.addFinding(this.toolCallId, kind, text, metricIds, suggestion);
    this.findingIds.push(id);
    return id;
  }

  fallback(from: string, to: string, reason: string, findingId: FindingId | null): void {
    this.flags.add("LOCATION_FALLBACK");
    this.run.push({ type: "fallback", from, to, reason, toolCallId: this.toolCallId, findingId });
  }
}

interface MetricSpec {
  key: string;
  label: string;
  subjectRefs: string[];
  value: number | null;
  display: string;
  unit: Metric["unit"];
  formulaId: string;
  evidenceIds: EvidenceId[];
  badge?: Metric["badge"];
  comparator?: Metric["comparator"];
  reason?: Metric["reason"];
  n?: number | null;
  stale?: boolean;
  /** An SEC or Census metric's period or vintage ({{PERIOD:M#}}). */
  period?: string | null;
}

class RunBuilder {
  private readonly inputs: EventInput[] = [];
  private counts = { q: 0, e: 0, m: 0, d: 0, f: 0 };
  readonly metrics = new Map<MetricId, Metric>();
  readonly datasets = new Map<DatasetId, DatasetEnvelope>();
  readonly evidence = new Map<EvidenceId, Evidence>();
  private readonly calls = new Map<string, { endpoint: QlooPath; filterType: string | null; params: Record<string, string>; requestId: string; cache: CacheStatus }>();
  /** SEC and Census calls by id: their endpoint template, concrete path, query and reference. */
  private readonly publicCalls = new Map<string, { source: PublicSource; endpoint: PublicEndpoint; path: string; query: Record<string, string>; reference: string; cache: CacheStatus }>();
  private hypotheses: HypothesisSpec[] = [];
  /** The question's named peers as resolved, for head_to_head's pair similarity. */
  private peers: string[] = [];

  constructor(
    readonly runId: string,
    readonly question: string,
    readonly intent: Intent,
  ) {}

  push(input: EventInput): void {
    this.inputs.push(input);
  }

  private ts(): string {
    return new Date(T0 + this.inputs.length * STEP_MS).toISOString();
  }

  start(resolves: ResolvedMention[], plan: { restated: string; hypotheses: HypothesisSpec[]; steps: { tool: SkillId; purpose: string }[] }): this {
    this.push({ type: "run.created", question: this.question, mode: "live", lane: "public", limits: DEFAULT_RUN_LIMITS, parentRunId: null, model: "claude-sonnet-5-5" });
    this.push({ type: "clerk", intent: this.intent, ms: 900 });
    this.peers = resolves.flatMap((r) => (r.role === "peer" && r.ref !== null ? [r.ref] : []));
    if (resolves.length > 0) {
      for (const r of resolves) this.qloo(null, "/search", null, { query: r.mention, take: "5", types: `urn:entity:${r.entityType}` }, 5, "hit");
      this.push({ type: "resolve", entities: resolves });
    }
    this.hypotheses = plan.hypotheses;
    this.push({
      type: "plan",
      plan: {
        restated_question: plan.restated,
        hypotheses: plan.hypotheses.map((h, i) => ({ id: `H${i + 1}`, statement: h.statement, expectation: h.expectation, test_tool: h.tool, metric_hint: h.expectation })),
        steps: plan.steps.map((s, i) => ({ id: `S${i + 1}`, tool: s.tool, purpose: s.purpose })),
        assumptions: ["US geography"],
      },
      estimates: plan.steps.map((_, i) => ({ stepId: `S${i + 1}` as `S${number}`, calls: 2 })),
    });
    return this;
  }

  tool(
    spec: { id: string; tool: SkillId; phase: "scan" | "wave1" | "followup"; args: Args; step?: number; trigger?: FindingId; estimate: number },
    body: (t: ToolScope) => void,
  ): this {
    if (spec.trigger) this.push({ type: "pivot", triggerFindingId: spec.trigger, tool: spec.tool, args: spec.args, toolCallId: spec.id });
    this.push({
      type: "tool.start",
      toolCallId: spec.id,
      tool: spec.tool,
      phase: spec.phase,
      args: spec.args,
      stepId: spec.step ? (`S${spec.step}` as `S${number}`) : null,
      triggerFindingId: spec.trigger ?? null,
      estimatedCalls: spec.estimate,
    });
    const scope = new ToolScope(this, spec.id, spec.tool);
    body(scope);
    this.push({
      type: "tool.end",
      toolCallId: spec.id,
      tool: spec.tool,
      ok: true,
      status: "ok",
      ms: 1200,
      evidenceIds: scope.evidenceIds,
      metricIds: scope.metricIds,
      datasetIds: scope.datasetIds,
      findingIds: scope.findingIds,
      flags: [...scope.flags],
      error: null,
    });
    return this;
  }

  qloo(toolCallId: string | null, endpoint: QlooPath, filterType: string | null, params: Record<string, string>, rows: number, cache: CacheStatus): string {
    const n = ++this.counts.q;
    const id = `qc_dev_${this.runId.slice(0, 6)}_${n}`;
    const requestId = `dev-${this.runId.slice(0, 4)}-${String(n).padStart(4, "0")}-req`;
    const cached = cache !== "miss";
    this.calls.set(id, { endpoint, filterType, params, requestId, cache });
    this.push({
      type: "qloo",
      qlooCallId: id,
      toolCallId,
      endpoint,
      filterType,
      paramsRedacted: params,
      cache,
      ms: cached ? 0 : 180 + ((n * 37) % 220),
      requestId,
      status: 200,
      rows,
      cacheAgeMs: cached ? 3 * 3_600_000 : null,
      originRunId: null,
      error: null,
    });
    return id;
  }

  /**
   * A synthetic SEC or Census call: the `public` event the client emits (D29: the reference is a mock
   * one, the values behind it invented). Its id goes into a public evidence bundle.
   */
  public(toolCallId: string | null, endpoint: PublicEndpoint, path: string, query: Record<string, string>, reference: string, cache: CacheStatus = "miss"): string {
    const n = ++this.counts.q;
    const id = `pc_dev_${this.runId.slice(0, 6)}_${n}`;
    const source = PUBLIC_ENDPOINTS[endpoint].source;
    this.publicCalls.set(id, { source, endpoint, path, query, reference, cache });
    const cached = cache !== "miss";
    this.push({
      type: "public",
      publicCallId: id,
      toolCallId,
      source,
      endpoint,
      paramsRedacted: query,
      cache,
      ms: cached ? 0 : 140 + ((n * 29) % 160),
      status: 200,
      reference,
      cacheAgeMs: cached ? 5 * 3_600_000 : null,
      originRunId: null,
      error: null,
    });
    return id;
  }

  addEvidence(skill: SkillId, purpose: string, summary: string, callIds: string[], flags: Flag[]): EvidenceId {
    const id = `E${++this.counts.e}` as EvidenceId;
    const publicCalls = callIds.map((c) => this.publicCalls.get(c)).filter((c) => c !== undefined);
    if (publicCalls.length > 0) {
      // One bundle, one source: qlooCallIds holds the public call ids and requestIds their references.
      const evidence: Evidence = {
        id,
        skill,
        source: publicCalls[0]!.source,
        purpose,
        status: "ok",
        qlooCallIds: callIds,
        requestIds: publicCalls.map((c) => c.reference),
        cached: publicCalls.every((c) => c.cache !== "miss"),
        fetchedAt: this.ts(),
        provenance: {
          requests: publicCalls.map((c) => ({ source: c.source, method: "GET" as const, host: PUBLIC_ENDPOINTS[c.endpoint].host, path: c.path, query: c.query, reference: c.reference })),
        },
        summary,
        flags,
        qualityGateDrops: 0,
      };
      this.evidence.set(id, evidence);
      this.push({ type: "evidence", evidence });
      return id;
    }
    const calls = callIds.map((c) => this.calls.get(c)).filter((c) => c !== undefined);
    const evidence: Evidence = {
      id,
      skill,
      source: "qloo",
      purpose,
      status: "ok",
      qlooCallIds: callIds,
      requestIds: calls.map((c) => c.requestId),
      cached: calls.every((c) => c.cache !== "miss"),
      fetchedAt: this.ts(),
      provenance: { requests: calls.map((c) => ({ method: "GET", path: c.endpoint, query: { ...(c.filterType ? { "filter.type": c.filterType } : {}), ...c.params } })) },
      summary,
      flags,
      qualityGateDrops: 0,
    };
    this.evidence.set(id, evidence);
    this.push({ type: "evidence", evidence });
    return id;
  }

  addMetric(spec: MetricSpec): MetricId {
    const id = `M${++this.counts.m}` as MetricId;
    const unavailable = spec.value === null;
    const metric: Metric = {
      id,
      key: spec.key,
      label: spec.label,
      subjectRefs: spec.subjectRefs,
      value: spec.value,
      reason: unavailable ? (spec.reason ?? "not_measured") : null,
      display: unavailable ? "" : spec.display,
      unit: spec.unit,
      badge: unavailable ? "UNAVAILABLE" : spec.stale ? "STALE" : (spec.badge ?? "DERIVED"),
      formulaId: spec.formulaId,
      evidenceIds: spec.evidenceIds,
      n: spec.n ?? null,
      conf: unavailable ? null : 0.72,
      comparator: spec.comparator ?? null,
      window: spec.stale ? WINDOW : null,
      ...(spec.period ? { period: spec.period } : {}),
    };
    this.metrics.set(id, metric);
    this.push({ type: "metric", metric });
    return id;
  }

  addDataset<K extends DatasetKind>(kind: K, title: string, payload: DatasetPayload<K>, evidenceIds: EvidenceId[], formulaIds: string[]): DatasetId {
    const id = `D${++this.counts.d}` as DatasetId;
    const dataset = { id, kind, title, evidenceIds, formulaIds, payload } as DatasetEnvelope;
    this.datasets.set(id, dataset);
    this.push({ type: "dataset.ready", datasetId: id, kind, title, bytes: JSON.stringify(dataset).length, inline: dataset });
    return id;
  }

  addFinding(toolCallId: string, kind: Finding["kind"], text: string, metricIds: MetricId[], suggestion: Finding["suggestion"]): FindingId {
    const id = `F${++this.counts.f}` as FindingId;
    this.push({ type: "finding", finding: { id, kind, severity: suggestion ? "high" : "info", text, metricIds, suggestion }, toolCallId });
    return id;
  }

  /** The KPI strip as the agent picks it: by metric key, the subject's own first, a `top` slot by value. */
  private kpis(job: Job, subject: string | null): Report["kpis"] {
    const focus = { subject, peers: this.peers };
    const valued = [...this.metrics.values()].filter((m) => m.value !== null);
    const order = (m: Metric) => (m.subjectRefs[0] === subject ? 0 : 1);
    const picked: Metric[] = [];
    for (const slot of KPI_SLOTS[job]) {
      for (const pick of slot.picks) {
        const hits = valued.filter((m) => pickMatches(m, pick, focus) && !picked.includes(m));
        if (hits.length === 0) continue;
        hits.sort(slot.top ? (a, b) => (b.value ?? 0) - (a.value ?? 0) || order(a) - order(b) : (a, b) => order(a) - order(b));
        picked.push(...hits.slice(0, slot.count));
        break;
      }
    }
    return picked.map((m) => ({ metricId: m.id, label: m.label, comparator: m.comparator }));
  }

  private sourceLine(evidenceIds: readonly EvidenceId[]): string {
    const publicCall = evidenceIds.flatMap((id) => this.evidence.get(id)?.qlooCallIds ?? []).flatMap((c) => this.publicCalls.get(c) ?? [])[0];
    if (publicCall) {
      return `Source: ${PUBLIC_SOURCE_LABEL[publicCall.source]} ${publicCall.endpoint} · ${publicCall.reference} · fetched 2026-10-21 09:00 UTC · Culture Terminal analysis`;
    }
    const calls = evidenceIds.flatMap((id) => this.evidence.get(id)?.qlooCallIds ?? []).flatMap((c) => this.calls.get(c) ?? []);
    const first = calls[0];
    if (!first) return "Source: Culture Terminal analysis";
    const filter = first.filterType ? ` (${first.filterType})` : "";
    return `Source: Qloo ${first.endpoint}${filter} · req ${first.requestId.slice(0, 8)}… · fetched 2026-10-21 09:00 UTC · Culture Terminal analysis`;
  }

  finish(given: ReportSpec): RunEvent[] {
    const job = this.intent.job;
    const named = (text: string) =>
      text
        // {{PERIOD:name}}: the period or vintage of an SEC or Census metric (CHECKER V11).
        .replace(/\{\{PERIOD:([a-z]\w*)\}\}/g, (token, name: string) => {
          const id = given.names[name];
          if (!id) throw new Error(`no metric named ${name}`);
          return `{{PERIOD:${id}}}`;
        })
        .replace(/\{\{([a-z]\w*)\}\}/gi, (token, name: string) => {
          if (name === "WINDOW" || /^M\d+$/.test(name)) return token;
          const id = given.names[name];
          if (!id) throw new Error(`no metric named ${name}`);
          return `{{${id}}}`;
        });
    const spec: ReportSpec = {
      ...given,
      headline: named(given.headline),
      thesis: named(given.thesis),
      exhibits: given.exhibits.map((e) => ({ ...e, caption: named(e.caption) })),
      arguments: given.arguments.map((a) => ({ ...a, fact: named(a.fact), read: named(a.read) })),
      bearCase: given.bearCase.map(named),
    };
    this.hypotheses = this.hypotheses.map((h) => ({ ...h, note: named(h.note) }));
    const subject = this.intent.mentions.length > 0 ? "R1" : null;
    const scorecardRows = this.hypotheses.map((h, i) => {
      const metricIds = h.metrics();
      return {
        hypothesisId: `H${i + 1}` as `H${number}`,
        statement: h.statement,
        expectation: h.expectation,
        testTool: h.tool,
        verdict: h.verdict,
        metricIds,
        evidenceIds: [...new Set(metricIds.flatMap((id) => this.metrics.get(id)?.evidenceIds ?? []))],
        note: h.note,
      };
    });
    const scorecard = this.addDataset("Scorecard", "Hypothesis Scorecard", { rows: scorecardRows }, [], []);
    const exhibits: Report["exhibits"] = [scorecard, ...spec.exhibits.map((e) => e.dataset())].map((id, i) => {
      const dataset = this.datasets.get(id) as DatasetEnvelope;
      const given = i === 0 ? null : spec.exhibits[i - 1];
      return {
        datasetId: id,
        kind: dataset.kind,
        viz: VIZ_COMPAT[dataset.kind],
        title: given?.title ?? dataset.title,
        caption: given?.caption ?? "Priors written before any data, judged against the cited metrics.",
        badges: ["DERIVED"],
        sourceLine: this.sourceLine(dataset.evidenceIds),
        evidenceIds: dataset.evidenceIds,
      };
    });
    const penalties = spec.penalties ?? [];
    const score = Math.max(0, 100 + penalties.reduce((sum, p) => sum + p.points, 0));
    const text = [spec.headline, spec.thesis, ...spec.arguments.flatMap((a) => [a.fact, a.read]), ...scorecardRows.map((r) => r.note)].join(" ");
    const traced = new Set(text.match(/\{\{M\d+\}\}/g) ?? []).size;
    const metricIdsIn = (s: string) => [...s.matchAll(/\{\{(M\d+)\}\}/g)].map((m) => m[1] as MetricId);
    const chips = this.inputs.filter((i): i is EventInputOf<"qloo"> => i.type === "qloo");
    const endpoints = new Map<string, { path: QlooPath; filterType: string | null; calls: number }>();
    for (const c of chips) {
      const key = `${c.endpoint} ${c.filterType ?? ""}`;
      const e = endpoints.get(key) ?? { path: c.endpoint, filterType: c.filterType, calls: 0 };
      e.calls += 1;
      endpoints.set(key, e);
    }
    const network = chips.filter((c) => c.cache === "miss").length;
    const publicChips = this.inputs.filter((i): i is EventInputOf<"public"> => i.type === "public");
    const publicEndpoints = new Map<PublicEndpoint, { source: PublicSource; endpoint: PublicEndpoint; calls: number }>();
    for (const c of publicChips) {
      const e = publicEndpoints.get(c.endpoint) ?? { source: c.source, endpoint: c.endpoint, calls: 0 };
      e.calls += 1;
      publicEndpoints.set(c.endpoint, e);
    }
    const flags = [...new Set([...this.evidence.values()].flatMap((e) => e.flags))];
    const report: Report = {
      runId: this.runId,
      question: this.question,
      pillar: JOB_PILLAR[job],
      job,
      mode: "live",
      createdAt: new Date(T0).toISOString(),
      incomplete: false,
      investmentBanner: JOB_PILLAR[job] === "investment",
      dataFreshness: { fetchedFrom: new Date(T0 - 3 * 3_600_000).toISOString(), fetchedTo: new Date(T0 + 40_000).toISOString(), trendWindow: spec.thesis.includes("{{WINDOW}}") || [...this.metrics.values()].some((m) => m.window) ? WINDOW : null },
      verdict: {
        headline: spec.headline,
        signal: spec.signal,
        tag: spec.tag,
        thesis: spec.thesis,
        confidence: { score, band: score >= 75 ? "HIGH" : score >= 50 ? "MED" : "LOW", breakdown: penalties },
        coverage: { evidenceOk: this.evidence.size, evidenceTotal: this.evidence.size },
      },
      scorecard: scorecardRows,
      kpis: this.kpis(job, subject),
      exhibits,
      arguments: spec.arguments.map((a, i) => ({
        id: `A${i + 1}` as `A${number}`,
        section: a.section,
        qlooFact: a.fact,
        ourRead: a.read,
        metricIds: metricIdsIn(a.fact),
        evidenceIds: [...new Set(metricIdsIn(a.fact).flatMap((id) => this.metrics.get(id)?.evidenceIds ?? []))],
        strength: a.strength,
      })),
      bearCase: spec.bearCase.map((text) => ({ text, metricIds: metricIdsIn(text) })),
      recommendations: spec.recommendations.map((r) => ({ action: r.action, priority: r.priority, argumentIds: ["A1" as `A${number}`] })),
      limitations: [
        ...flags.map((flag) => ({ source: "flag" as const, flag, text: FLAG_SENTENCE[flag] ?? `${flag.toLowerCase().replace(/_/g, " ")}.` })),
        ...(spec.readAs ? [{ source: "flag" as const, flag: "READ_AS_NEAREST_JOB" as const, text: spec.readAs }] : []),
        ...(spec.limitations ?? []).map((text) => ({ source: "desk" as const, flag: null, text })),
      ],
      disclaimers: [...FIXED_DISCLAIMERS, "Data: synthetic dev brief with invented entities and numbers; no Qloo or model calls were made."],
      ghost: null,
      nextMoves: spec.nextMoves,
      warnings: [],
      receipt: {
        qlooNetwork: network,
        qlooCached: chips.length - network,
        qlooReused: 0,
        endpoints: [...endpoints.values()],
        publicEndpoints: [...publicEndpoints.values()],
        ms: this.inputs.length * STEP_MS,
        usd: 0,
        tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
        numbersTraced: { traced, total: traced },
        models: { clerk: "claude-haiku-5-5", analyst: "claude-sonnet-5-5", ghost: null },
        economy: false,
      },
    };
    this.push({ type: "validation", ok: true, attempt: 1, issues: [], numbersTraced: { traced, total: traced }, adviceTerms: 0 });
    this.push({ type: "report.final", report });
    this.push({ type: "usage", llmUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, qloo: { network, cached: chips.length - network, reused: 0 }, elapsedMs: this.inputs.length * STEP_MS });
    this.push({ type: "run.end", status: "completed", elapsedMs: this.inputs.length * STEP_MS, reason: null });
    return RunEvent.array().parse(
      this.inputs.map((input, i) => stampEvent(input, { seq: i + 1, ts: new Date(T0 + i * STEP_MS).toISOString(), runId: this.runId })),
    );
  }
}

/** The fixed limitation sentences these runs raise (the real ones come from FLAG_TEXT in @ct/quant). */
const FLAG_SENTENCE: Partial<Record<Flag, string>> = {
  CENSUS_RESIDENTS_ONLY: "Area figures are Census survey estimates for residents, not customers, visitors or spending.",
  NOT_A_LISTED_COMPANY: "The brand is not a listed company we map, so no financial figures are shown or guessed.",
  READ_AS_NEAREST_JOB: "The question asks for more than any job covers; it was answered as the closest one, and the rest is not covered.",
  LOCATION_FALLBACK: "An area was read by a simpler location form after its boundary failed; the step costs conviction.",
  TRENDING_HISTORICAL_WINDOW: "Momentum comes from Qloo's historical trending window only; nothing after it is used.",
  DEMOGRAPHICS_ARE_INDICES: "Age and gender figures are relative affinity indices, not population shares.",
  SUPPLY_SAMPLE_ONLY: "Supply is a capped sample of venues Qloo indexes, not a full count.",
};

// Helpers ------------------------------------------------------------------------------------------------

type Ref = `R${number}`;
const rid = (n: number): Ref => `R${n}`;

const exact = (mention: string, entityType: ResolvedMention["entityType"], ref: Ref, role: ResolvedMention["role"] = "primary"): ResolvedMention => ({
  mention,
  role,
  entityType,
  match: "exact",
  ref,
  name: mention,
  popularity: 0.5,
  disambiguation: null,
  alternatives: [],
  source: "gate",
});

function intentOf(job: Job, mentions: Intent["mentions"], geo: Partial<Intent["geo"]> = {}, constraints: Partial<Intent["constraints"]> = {}, mnemonic = ""): Intent {
  return {
    pillar: JOB_PILLAR[job],
    job,
    mentions,
    geo: { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: [], ...geo },
    constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [], concept_description: null, ...constraints },
    safety: { allowed: true, category: null, reframe: null },
    read_as: { nearest: false, not_covered: [] },
    assumptions: ["US geography"],
    mnemonic,
  };
}

const brand = (text: string, role: Intent["mentions"][number]["role"] = "primary") => ({ text, entity_type: "brand" as const, role, public_figure: false });
const f2 = (n: number) => n.toFixed(2);
const signed = (n: number) => `${n >= 0 ? "+" : "−"}${Math.abs(n).toFixed(2)}`;
const axis = (key: string, label: string, ref: Ref | null = null, group: string | null = null) => ({ key, label, ref, group });
const v = (value: number) => ({ value, reason: null });

/** A quadrant at the slate's split lines: fit 0.78 and popularity 0.5. */
function quadrantOf(fit: number, popularity: number): QuadrantName {
  if (fit >= 0.78) return popularity < 0.5 ? "HIDDEN_POCKET" : "HEARTLAND";
  return popularity < 0.5 ? "COLD" : "MASS";
}

/** Base-32 geohash of a point, for the lift map's cells. */
function geohash(lat: number, lon: number, precision: number): string {
  const base32 = "0123456789bcdefghjkmnpqrstuvwxyz";
  const range = { lat: [-90, 90], lon: [-180, 180] };
  let hash = "";
  let bits = 0;
  let ch = 0;
  let even = true;
  while (hash.length < precision) {
    const [r, value] = even ? [range.lon, lon] : [range.lat, lat];
    const mid = ((r[0] as number) + (r[1] as number)) / 2;
    if (value >= mid) {
      ch = (ch << 1) | 1;
      r[0] = mid;
    } else {
      ch <<= 1;
      r[1] = mid;
    }
    even = !even;
    if (++bits === 5) {
      hash += base32[ch];
      bits = 0;
      ch = 0;
    }
  }
  return hash;
}

/** A gazetteer area's name and centroid, by id, from @ct/geo (public geography). */
function area(metro: "austin" | "nashville", id: string): { id: string; name: string; lat: number; lon: number } {
  const found = GAZETTEER_CATALOG[metro]?.areas.find((a) => a.id === id);
  if (!found) throw new Error(`no ${metro} area ${id} in the gazetteer`);
  return { id: found.id, name: found.name, lat: found.centroid.lat, lon: found.centroid.lon };
}

// Jobs ----------------------------------------------------------------------------------------------------

function brandHealth(): RunEvent[] {
  const q = "Is the Juniper Cola audience a moat or a niche?";
  const run = new RunBuilder("dev-brand-health", q, intentOf("brand_health", [brand("Juniper Cola")], {}, {}, "JUNIPER COLA <BRAND> HLTH"));
  const ids: Record<string, MetricId> = {};
  let matrix = "" as DatasetId;
  let position = "" as DatasetId;
  let momentum = "" as DatasetId;
  const peers = ["Juniper Cola", "Foxglove Cola", "Harbor Seltzer", "Saltmarsh Seltzer", "Granite Outfitters", "Kettle Ridge Tonic"];
  const sims = [
    [null, 0.41, 0.38, 0.29, 0.56, 0.33],
    [0.41, null, 0.72, 0.64, 0.22, 0.51],
    [0.38, 0.72, null, 0.69, 0.19, 0.47],
    [0.29, 0.64, 0.69, null, 0.24, 0.58],
    [0.56, 0.22, 0.19, 0.24, null, 0.31],
    [0.33, 0.51, 0.47, 0.58, 0.31, null],
  ];
  run.start([exact("Juniper Cola", "brand", "R1"), exact("Foxglove Cola", "brand", "R2", "secondary")], {
    restated: "Does Juniper Cola's audience sit apart from other soft drinks?",
    hypotheses: [
      { statement: "Juniper Cola competes most closely with other colas.", expectation: "A cola is its nearest audience.", tool: "peer_landscape", verdict: "REFUTED", metrics: () => [ids.sim as MetricId], note: "Its nearest audience is Granite Outfitters at {{sim}}, outside the category." },
      { statement: "Its momentum rose through the window.", expectation: "A rising label.", tool: "momentum", verdict: "INCONCLUSIVE", metrics: () => [ids.mom as MetricId], note: "Momentum reads {{mom}} over {{WINDOW}}." },
    ],
    steps: [
      { tool: "peer_landscape", purpose: "Map the nearest audiences." },
      { tool: "momentum", purpose: "Read the trend over the window." },
    ],
  });
  run.tool({ id: "scan-1", tool: "peer_landscape", phase: "scan", args: { target: "R1", peers: [], discover: true, k: 6 }, estimate: 5 }, (t) => {
    const calls = [0, 1, 2, 3, 4].map((i) => t.call("/v2/insights", "urn:entity:brand", { "signal.interests.entities": `R${i + 1}`, take: "20" }, 20, i < 2 ? "hit" : "miss"));
    const e = t.evidence("Pairwise similarity of Juniper Cola and five peers", "6 × 6 matrix, 15 pairs", calls);
    ids.sim = t.metric({ key: "subs.similarity", label: "similarity Juniper Cola–Granite Outfitters (nearest peer)", subjectRefs: ["R1", "R5"], value: 0.56, display: "0.56", unit: "similarity", formulaId: "subs.similarity", evidenceIds: [e], badge: "MEASURED" });
    ids.dist = t.metric({ key: "subs.distinctiveness", label: "distinctiveness rank of Juniper Cola among 6 brands (1 = most distinctive)", subjectRefs: ["R1"], value: 1, display: "1 of 6", unit: "rank", formulaId: "subs.distinctiveness", evidenceIds: [e], comparator: "PEERS" });
    ids.youth = t.metric({ key: "dna.youth_index", label: "Juniper Cola youth index (Y)", subjectRefs: ["R1"], value: 0.31, display: "+0.31", unit: "index", formulaId: "dna.youth_index", evidenceIds: [e], comparator: "BASELINE", badge: "MEASURED" });
    const rows = peers.map((p, i) => axis(`R${i + 1}`, p, rid(i + 1)));
    matrix = t.dataset(
      "Matrix",
      "Substitution Map · Juniper Cola",
      {
        mode: "similarity",
        valueLabel: "Audience taste similarity",
        unit: "similarity",
        comparator: "PEERS",
        rows,
        cols: rows.map((r) => ({ ...r })),
        cells: sims.map((row) => {
          const ranks = row.map((c) => (c === null ? null : row.filter((o) => o !== null && o > c).length + 1));
          return row.map((c, j) => (c === null ? { value: null, reason: "self" as const, rank: null } : { value: c, reason: null, rank: ranks[j] ?? null }));
        }),
        margin: null,
        targetKey: "R1",
        annotations: [{ text: "Juniper Cola: last in 4 of 5 rows", rowKey: null, colKey: "R1" }],
      },
      [e],
      ["subs.similarity", "subs.rank_in_row"],
    );
  });
  run.tool({ id: "tool-2", tool: "momentum", phase: "wave1", step: 2, args: { refs: ["R1", "R2"] }, estimate: 2 }, (t) => {
    const calls = ["R1", "R2"].map((r) => t.call("/v2/trending", "urn:entity:brand", { "signal.interests.entities": r }, 26, "hit"));
    const e = t.evidence("Weekly trending percentile of Juniper Cola and Foxglove Cola", "26 weeks each", calls, ["TRENDING_HISTORICAL_WINDOW"]);
    t.metric({ key: "mom.delta_26w", label: "26-week momentum of Juniper Cola (change in trending percentile)", subjectRefs: ["R1"], value: 0.012, display: "+0.012", unit: "delta", formulaId: "mom.delta_26w", evidenceIds: [e], comparator: "WITHIN_CALL", stale: true });
    ids.mom = t.metric({ key: "mom.label", label: "momentum label of Juniper Cola", subjectRefs: ["R1"], value: 0, display: "Flat", unit: "score", formulaId: "mom.label", evidenceIds: [e], stale: true });
    const weeks = Array.from({ length: 26 }, (_, i) => new Date(Date.UTC(2025, 3, 7) + i * 7 * 86_400_000).toISOString().slice(0, 10));
    momentum = t.dataset(
      "Momentum",
      "Momentum · Juniper Cola and Foxglove Cola",
      {
        window: WINDOW,
        badgeText: "HISTORICAL · QLOO TRENDING · Apr–Sep 2025",
        badge: "STALE",
        series: [
          { ref: "R1", label: "Juniper Cola", type: "brand", state: "ok", reason: null, trend: "flat", points: weeks.map((date, i) => ({ date, pct: 0.52 + 0.02 * Math.sin(i / 3), clipped: false })), delta26w: 0.012, tau: 0.08, p: 0.61, peerRank: { rank: 2, of: 2 }, scaleBreak: false },
          { ref: "R2", label: "Foxglove Cola", type: "brand", state: "ok", reason: null, trend: "rising", points: weeks.map((date, i) => ({ date, pct: 0.44 + 0.006 * i, clipped: i === 17 })), delta26w: 0.15, tau: 0.71, p: 0.01, peerRank: { rank: 1, of: 2 }, scaleBreak: false },
        ],
      },
      [e],
      ["mom.delta_26w", "mom.mann_kendall", "mom.label"],
    );
    position = t.dataset(
      "Position",
      "Taste Position · Juniper Cola",
      {
        subject: { ref: "R1", label: "Juniper Cola" },
        peerCount: 5,
        axes: [
          { axis: "distinctiveness", label: "Distinctiveness", display: "1 of 6", value: 1, reason: null, badge: "DERIVED", peerRank: { rank: 1, of: 6 }, note: "nearest: Granite Outfitters", metricId: ids.dist as MetricId, datasetId: matrix },
          { axis: "reach", label: "Reach", display: "4 of 6", value: 4, reason: null, badge: "MEASURED", peerRank: { rank: 4, of: 6 }, note: null, metricId: null, datasetId: null },
          { axis: "next_gen_tilt", label: "Next-gen tilt", display: "+0.31", value: 0.31, reason: null, badge: "MEASURED", peerRank: null, note: "0 = average", metricId: ids.youth as MetricId, datasetId: null },
          { axis: "metro_breadth", label: "Metro breadth", display: "not measured", value: null, reason: "not_measured", badge: "UNAVAILABLE", peerRank: null, note: "no metro contexts run", metricId: null, datasetId: null },
          { axis: "momentum", label: "Momentum", display: "Flat", value: 0, reason: null, badge: "STALE", peerRank: { rank: 2, of: 2 }, note: "Apr–Sep 2025 only", metricId: ids.mom as MetricId, datasetId: null },
        ],
      },
      [e],
      ["subs.distinctiveness", "dna.youth_index", "mom.label"],
    );
  });
  return run.finish({
    names: ids,
    headline: "Juniper Cola is a taste island: its nearest audience is an outfitter, not a cola",
    tag: "Taste island",
    signal: "mixed",
    thesis: "Its closest audience is Granite Outfitters at {{sim}}, and it is the most distinctive brand in the set ({{dist}}). Momentum held {{mom}} over {{WINDOW}}.",
    exhibits: [
      { dataset: () => position, title: "Distinctive, mid-reach, younger than average", caption: "Five axes against five peers; no composite score." },
      { dataset: () => matrix, title: "Last in most peer rows", caption: "Pairwise audience similarity of Juniper Cola and five peers." },
      { dataset: () => momentum, title: "Flat while Foxglove Cola rose", caption: "Weekly trending percentile over {{WINDOW}}." },
    ],
    arguments: [
      { section: "competition", fact: "Its nearest audience is Granite Outfitters ({{sim}}).", read: "The colas trade audiences with each other first.", strength: "MODERATE" },
      { section: "audience", fact: "Its youth index is {{youth}}.", read: "A younger core than the category.", strength: "MODERATE" },
      { section: "momentum", fact: "Momentum reads {{mom}} over {{WINDOW}}.", read: "No lift to lean on.", strength: "THIN" },
    ],
    bearCase: ["A wider peer set puts a cola above Granite Outfitters ({{sim}})."],
    recommendations: [{ action: "Test a co-branded drop with Granite Outfitters before any cola line extension.", priority: "next" }],
    nextMoves: [
      { label: "Who they are", question: "Who is the Juniper Cola audience beyond beverages?" },
      { label: "Head to head", question: "Juniper Cola vs Foxglove Cola: same customer?" },
      { label: "Launch cities", question: "Which cities should Juniper Cola launch in next?" },
    ],
    penalties: [{ rule: "stale_momentum", label: "STALE momentum cited", count: 1, points: -20 }],
  });
}

function headToHead(): RunEvent[] {
  const q = "Kestrel Tonic vs Brightwater Soda: who wins where?";
  const run = new RunBuilder("dev-head-to-head", q, intentOf("head_to_head", [brand("Kestrel Tonic"), brand("Brightwater Soda", "peer")], {}, {}, "KESTREL TONIC VS BRIGHTWATER SODA"));
  const ids: Record<string, MetricId> = {};
  let split = "" as DatasetId;
  let ages = "" as DatasetId;
  const metros = [
    ["los_angeles", "Los Angeles", 0.38],
    ["new_york", "New York", 0.42],
    ["miami", "Miami", 0.45],
    ["atlanta", "Atlanta", 0.47],
    ["chicago", "Chicago", 0.52],
    ["denver", "Denver", 0.51],
    ["austin", "Austin", 0.55],
    ["nashville", "Nashville", 0.59],
  ] as const;
  run.start([exact("Kestrel Tonic", "brand", "R1"), exact("Brightwater Soda", "brand", "R2", "peer")], {
    restated: "Where does each brand lead, by metro and by age?",
    hypotheses: [
      { statement: "Brightwater Soda wins the coasts.", expectation: "It leads in the coastal metros.", tool: "share_of_taste", verdict: "CONFIRMED", metrics: () => [ids.wonB as MetricId], note: "Brightwater Soda: {{wonB}}." },
      { statement: "Kestrel Tonic skews younger.", expectation: "A higher youth tilt.", tool: "share_of_taste", verdict: "REFUTED", metrics: () => [ids.tiltA as MetricId], note: "Kestrel Tonic's tilt is {{tiltA}}." },
    ],
    steps: [
      { tool: "peer_landscape", purpose: "How much the two audiences overlap." },
      { tool: "share_of_taste", purpose: "Who wins each metro and age band." },
    ],
  });
  run.tool({ id: "scan-1", tool: "peer_landscape", phase: "scan", args: { target: "R1", peers: ["R2"], discover: false, k: 2 }, estimate: 1 }, (t) => {
    const e = t.evidence("Similarity of Kestrel Tonic and Brightwater Soda", "1 pair", [t.call("/v2/insights", "urn:entity:brand", { "signal.interests.entities": "R1", "filter.results.entities": "R2" }, 1, "hit")]);
    ids.sim = t.metric({ key: "subs.similarity", label: "similarity Kestrel Tonic–Brightwater Soda", subjectRefs: ["R1", "R2"], value: 0.62, display: "0.62", unit: "similarity", formulaId: "subs.similarity", evidenceIds: [e], badge: "MEASURED" });
  });
  run.tool({ id: "tool-2", tool: "share_of_taste", phase: "wave1", step: 2, args: { refs: ["R1", "R2"], metros: metros.map((m) => m[0]), ages: ["24_and_younger", "25_to_29", "45_to_54", "55_and_older"] }, estimate: 12 }, (t) => {
    const calls = metros.map(([id]) => t.call("/v2/insights", "urn:entity:brand", { "signal.location": id, "filter.results.entities": "R1,R2" }, 2));
    const e = t.evidence("Share of taste by metro for Kestrel Tonic and Brightwater Soda", "8 metro contexts", calls);
    const won = metros.filter((m) => m[2] < 0.5).length;
    ids.wonA = t.metric({ key: "share.metros_won", label: "metros won by Kestrel Tonic (first in the set)", subjectRefs: ["R1", ...metros.map((m) => m[0])], value: won, display: `wins ${won} of 8 · top half in ${won} of 8`, unit: "count", formulaId: "share.metros_won", evidenceIds: [e], comparator: "PEERS" });
    ids.wonB = t.metric({ key: "share.metros_won", label: "metros won by Brightwater Soda (first in the set)", subjectRefs: ["R2", ...metros.map((m) => m[0])], value: 8 - won, display: `wins ${8 - won} of 8 · top half in ${8 - won} of 8`, unit: "count", formulaId: "share.metros_won", evidenceIds: [e], comparator: "PEERS" });
    ids.tiltA = t.metric({ key: "share.youth_tilt", label: "youth tilt of Kestrel Tonic (≤24, 25–29 minus 45–54, 55+)", subjectRefs: ["R1"], value: -0.18, display: "−0.18 · rank 2 of 2", unit: "delta", formulaId: "share.youth_tilt", evidenceIds: [e], comparator: "PEERS" });
    ids.tiltB = t.metric({ key: "share.youth_tilt", label: "youth tilt of Brightwater Soda (≤24, 25–29 minus 45–54, 55+)", subjectRefs: ["R2"], value: 0.18, display: "+0.18 · rank 1 of 2", unit: "delta", formulaId: "share.youth_tilt", evidenceIds: [e], comparator: "PEERS" });
    split = t.dataset(
      "Bars",
      "Who wins where · Kestrel Tonic vs Brightwater Soda",
      {
        mode: "butterfly",
        comparator: "WITHIN_CALL",
        valueLabel: "Share of the pair's affinity",
        unit: "pct",
        series: [axis("R2", "Brightwater Soda", "R2"), axis("R1", "Kestrel Tonic", "R1")],
        groups: [{ key: "METRO", label: "Metro", family: null, bars: metros.map(([id, label, a]) => ({ key: id, label, tagRef: null, values: [v(1 - a), v(a)], isNew: false, ranks: null })) }],
        method: null,
        domain: null,
        caption: "Each context is one call; the pair's two shares sum to 1, and a lead within ±0.02 of an even split reads as even.",
        display: "split",
        baseline: 0.5,
        evenBand: 0.02,
      },
      [e],
      ["share.pair_split"],
    );
  });
  run.tool({ id: "tool-3", tool: "audience_dna", phase: "wave1", step: 2, args: { refs: ["R1"], compare_with: "R2" }, estimate: 1 }, (t) => {
    const e = t.evidence("Age indices of Kestrel Tonic and Brightwater Soda", "6 age bands each", [t.call("/v2/insights", "urn:demographics", { "signal.interests.entities": "R1,R2" }, 2)], ["DEMOGRAPHICS_ARE_INDICES"]);
    const bands = [
      ["≤24", 0.08, 0.34],
      ["25–29", 0.12, 0.22],
      ["30–34", 0.1, 0.05],
      ["35–44", 0.06, -0.08],
      ["45–54", -0.03, -0.19],
      ["55+", -0.12, -0.3],
    ] as const;
    ages = t.dataset(
      "Bars",
      "Audience DNA · Kestrel Tonic vs Brightwater Soda",
      {
        mode: "butterfly",
        comparator: "BASELINE",
        valueLabel: "Age affinity index",
        unit: "index",
        series: [axis("R2", "Brightwater Soda", "R2"), axis("R1", "Kestrel Tonic", "R1")],
        groups: [{ key: "AGE", label: "Age", family: null, bars: bands.map(([label, a, b]) => ({ key: label, label, tagRef: null, values: [v(b), v(a)], isNew: false, ranks: null })) }],
        method: null,
        domain: null,
        caption: "Relative affinity indices from −1 to 1 around the average audience (0), not population shares.",
        display: "dumbbell",
        baseline: 0,
      },
      [e],
      ["dna.age_index"],
    );
  });
  return run.finish({
    names: ids,
    headline: "Same customer, different turf: Brightwater Soda wins the coasts and the young",
    tag: "Split by region",
    signal: "mixed",
    thesis: "The two audiences overlap at {{sim}}. Metros: Brightwater Soda {{wonB}}; Kestrel Tonic {{wonA}}. Brightwater Soda's youth tilt is {{tiltB}}.",
    exhibits: [
      { dataset: () => split, title: "Brightwater Soda takes the coasts; Kestrel Tonic holds Austin and Nashville", caption: "Share of taste by metro, within call. The shaded band (±0.02) reads as even." },
      { dataset: () => ages, title: "Brightwater Soda leads under 30; Kestrel Tonic holds from 35 up", caption: "Age affinity index, 0 = average audience." },
    ],
    arguments: [
      { section: "competition", fact: "Overlap is {{sim}}.", read: "They fight for one customer.", strength: "STRONG" },
      { section: "geography", fact: "Brightwater Soda: {{wonB}}.", read: "A coastal footprint.", strength: "MODERATE" },
      { section: "audience", fact: "Kestrel Tonic's youth tilt is {{tiltA}}.", read: "An older core.", strength: "MODERATE" },
    ],
    bearCase: ["Chicago and Denver sit inside the even band; one refresh can flip them ({{wonA}})."],
    recommendations: [{ action: "Defend Austin and Nashville with the 35+ audience before contesting the coasts.", priority: "now" }],
    nextMoves: [
      { label: "Sun Belt markets", question: "Does Brightwater Soda's lead hold across Sun Belt markets?" },
      { label: "Who they are", question: "Who is the Kestrel Tonic audience beyond soft drinks?" },
      { label: "Nashville pop-up", question: "Which East Nashville block fits a Kestrel Tonic pop-up?" },
    ],
  });
}

/** The Block DNA call of a location run: an area read down the ladder, with its bars and local brands. */
function blockDna(
  run: RunBuilder,
  spec: { id: string; phase: "wave1" | "followup"; step?: number; trigger?: FindingId; metro: "austin" | "nashville"; areaId: string; fallback: boolean; tags: [string, number, boolean][] },
  out: { bars: DatasetId; ids: Record<string, MetricId> },
): void {
  const a = area(spec.metro, spec.areaId);
  const city = spec.metro === "austin" ? "Austin" : "Nashville";
  run.tool({ id: spec.id, tool: "block_dna", phase: spec.phase, step: spec.step, trigger: spec.trigger, args: { area: { kind: "nbhd", ref: a.id, metro: spec.metro }, include_brands: false }, estimate: 2 }, (t) => {
    const method = spec.fallback ? "POINT" : "POLYGON";
    if (spec.fallback) {
      const empty = t.call("/v2/insights", "urn:tag", { "signal.location": "POLYGON((…))", take: "50" }, 0);
      t.evidence(`Location ladder for ${a.name}: rungs that returned no ranked taste tags`, "POLYGON returned no taste tags", [empty]);
      const finding = t.finding("LOCATION_FALLBACK", `${a.name} was read by POINT after POLYGON returned no taste tags.`, []);
      t.fallback("POLYGON", "POINT", "POLYGON returned no taste tags", finding);
    }
    const areaCall = t.call("/v2/insights", "urn:tag", { "signal.location": method === "POINT" ? `POINT(${a.lon.toFixed(4)} ${a.lat.toFixed(4)})` : "POLYGON((…))", take: "50" }, 50);
    const cityCall = t.call("/v2/insights", "urn:tag", { "signal.location": `${city} locality`, take: "50" }, 50, "hit");
    const e = t.evidence(`Tag fingerprint of ${a.name} by ${method}`, "50 area tags against 50 city tags", [areaCall, cityCall], spec.fallback ? ["LOCATION_FALLBACK"] : []);
    spec.tags.forEach(([label, delta, isNew], i) => {
      // Tag refs after the concept tags the run registered first.
      const ref = `T${i + 11}`;
      const key = `tag${i}`;
      out.ids[key] = t.metric({
        key: "block.rank_delta",
        label: `rank ${delta > 0 ? "gain" : "loss"} vs ${city}: ${label} (WHAT tag, ${a.name})`,
        subjectRefs: [ref, a.id, spec.metro],
        value: delta,
        display: delta > 0 ? `+${delta}${isNew ? " · NEW" : ""}` : `−${Math.abs(delta)}`,
        unit: "delta",
        formulaId: "block.rank_delta",
        evidenceIds: [e],
        comparator: "CITY",
        n: 50,
      });
    });
    const newCount = spec.tags.filter((tg) => tg[2]).length;
    out.ids.newTags = t.metric({
      key: "block.new_tag",
      label: `NEW WHAT tags in ${a.name} (area top 20, absent from the ${city} top 50)`,
      subjectRefs: [a.id, spec.metro],
      value: newCount,
      display: `${newCount} of 20 in the area top 20`,
      unit: "count",
      formulaId: "block.new_tag",
      evidenceIds: [e],
      comparator: "CITY",
      n: 20,
    });
    out.bars = t.dataset(
      "Bars",
      `Block DNA · ${a.name} vs ${city}`,
      {
        mode: "diverging",
        comparator: "CITY",
        valueLabel: "Rank vs city",
        unit: "delta",
        series: [axis(a.id, a.name)],
        groups: [
          {
            key: "WHAT",
            label: "What",
            family: "WHAT",
            bars: spec.tags.map(([label, delta, isNew], i) => ({ key: `t${i}`, label, tagRef: `T${i + 11}`, values: [v(delta)], isNew, ranks: { subject: Math.max(1, 20 - delta), comparator: 20 } })),
          },
        ],
        method,
        domain: null,
        caption: "Rank deltas against the whole city; venue-goer taste signals, not residents or census data.",
      },
      [e],
      ["block.rank_delta", "block.new_tag"],
    );
  });
}

function siteSelection(): RunEvent[] {
  const q = "Where should a natural-wine and vinyl bar open in Austin?";
  const run = new RunBuilder("dev-site-selection", q, intentOf("site_selection", [], { metro: "austin" }, { concepts: ["natural-wine bar", "vinyl listening room"] }, "NATURAL WINE BAR SITE AUSTIN"));
  const ids: Record<string, MetricId> = {};
  const lifts: [string, number | null, number][] = [
    ["east_cesar_chavez", 1.48, 14],
    ["holly", 1.36, 11],
    ["central_east_austin", 1.29, 12],
    ["govalle", 1.12, 8],
    ["bouldin_creek", 1.06, 9],
    ["barton_hills", 0.94, 7],
    ["downtown", 0.82, 13],
    ["hyde_park", null, 3],
  ];
  const areas = lifts.map(([id, lift, n]) => ({ ...area("austin", id), lift, n }));
  let map = "" as DatasetId;
  const block = { bars: "" as DatasetId, ids };
  let latent = "" as FindingId;
  run.start([], {
    restated: "Which Austin neighbourhoods over-index for a natural-wine and vinyl audience against restaurants?",
    hypotheses: [
      { statement: "Downtown is the best fit.", expectation: "Downtown has the highest lift.", tool: "geo_lift", verdict: "REFUTED", metrics: () => [ids.low as MetricId], note: "Downtown's lift is {{low}}, the lowest measured." },
      { statement: "The east side over-indexes.", expectation: "East Cesar Chavez in the top three.", tool: "geo_lift", verdict: "CONFIRMED", metrics: () => [ids.top as MetricId], note: "East Cesar Chavez leads at {{top}}." },
    ],
    steps: [
      { tool: "geo_lift", purpose: "Lift map against the restaurant baseline." },
      { tool: "block_dna", purpose: "What the top pocket already has." },
    ],
  });
  run.tool({ id: "tool-1", tool: "geo_lift", phase: "wave1", step: 1, args: { metro: "austin", concept_tags: ["T1"], concept_entities: [], supply: true }, estimate: 3 }, (t) => {
    const concept = t.call("/v2/insights", "urn:heatmap", { "filter.location": "Austin locality", "signal.interests.tags": "T1" }, 980);
    const base = t.call("/v2/insights", "urn:heatmap", { "filter.location": "Austin locality", "signal.interests.tags": "restaurant" }, 1010, "hit");
    const supply = t.call("/v2/insights", "urn:entity:place", { "filter.location": "Austin locality", take: "50" }, 50);
    const e = t.evidence("Concept and baseline heatmaps for Austin", "980 concept cells, 1,010 baseline cells at geohash 6", [concept, base]);
    const s = t.evidence("Sample of Qloo-indexed wine bars in Austin", "50 venues, capped", [supply], ["SUPPLY_SAMPLE_ONLY"]);
    ids.precision = t.metric({ key: "lift.precision", label: "map precision factor in Austin (geohash length after normalisation; 1 = full confidence)", subjectRefs: ["austin"], value: 0.8, display: "gh6 · 0.80", unit: "ratio", formulaId: "lift.confidence", evidenceIds: [e], n: 980 });
    const ranked = areas.filter((a) => a.lift !== null).sort((x, y) => (y.lift ?? 0) - (x.lift ?? 0));
    ranked.slice(0, 3).forEach((a, i) => {
      const id = t.metric({ key: "lift.area", label: `lift of ${a.name} vs the restaurant baseline`, subjectRefs: [a.id, "T1"], value: a.lift, display: `${f2(a.lift ?? 0)}×`, unit: "lift", formulaId: "lift.area", evidenceIds: [e], comparator: "BASELINE", badge: "ESTIMATED", n: a.n });
      if (i === 0) ids.top = id;
    });
    const lowest = ranked.at(-1);
    if (lowest) ids.low = t.metric({ key: "lift.area", label: `lift of ${lowest.name} vs the restaurant baseline (lowest in the metro)`, subjectRefs: [lowest.id, "T1"], value: lowest.lift, display: `${f2(lowest.lift ?? 0)}×`, unit: "lift", formulaId: "lift.area", evidenceIds: [e], comparator: "BASELINE", badge: "ESTIMATED", n: lowest.n });
    ranked.slice(0, 3).forEach((a) => t.metric({ key: "lift.confidence", label: `confidence of the ${a.name} lift (gated cells × map precision)`, subjectRefs: [a.id], value: Math.min(1, a.n / 12) * 0.8, display: f2(Math.min(1, a.n / 12) * 0.8), unit: "ratio", formulaId: "lift.confidence", evidenceIds: [e], n: a.n }));
    ids.ws = t.metric({ key: "lift.white_space", label: `white space in ${ranked[1]?.name ?? ""} (demand percentile × open supply)`, subjectRefs: [ranked[1]?.id ?? "holly", "T1"], value: 0.62, display: "0.62 · Latent & open", unit: "score", formulaId: "lift.white_space", evidenceIds: [e, s], badge: "ESTIMATED" });
    const cells = areas.flatMap((a, k) =>
      [-1, 0, 1].flatMap((dy) =>
        [-1, 0, 1].map((dx) => {
          const lift = a.lift === null ? null : a.lift * (1 + 0.04 * (dx - dy));
          return { geohash: geohash(a.lat + dy * 0.0055, a.lon + dx * 0.011, 6), raw: 0.5 + 0.05 * k, base: 0.55, lift, gated: lift !== null, conf: a.lift === null ? 0 : 0.8, neighbourhood: a.id };
        }),
      ),
    );
    map = t.dataset(
      "GeoLift",
      "Lift Map · natural-wine and vinyl bar in Austin",
      {
        metro: "austin",
        precision: 6,
        precisionFactor: 0.8,
        coarse: false,
        concept: { label: "natural-wine and vinyl bar", tagRefs: ["T1"], entityRefs: [] },
        baseline: { label: "restaurants", tag: "urn:tag:genre:place:restaurant" },
        // One cell per geohash; where two areas' cells meet, the first area keeps it.
        cells: cells.filter((c, i) => cells.findIndex((o) => o.geohash === c.geohash) === i),
        neighbourhoods: areas.map((a, i) => ({
          id: a.id,
          name: a.name,
          n: a.n,
          lift: a.lift,
          conf: a.lift === null ? null : Math.min(1, a.n / 12) * 0.8,
          demandPct: a.lift === null ? null : 1 - i / 7,
          supplyPct: a.lift === null ? null : [0.2, 0.15, 0.45, 0.3, 0.6, 0.5, 0.95][i] ?? null,
          supplyCount: a.lift === null ? null : [2, 1, 5, 3, 6, 4, 14][i] ?? null,
          whiteSpace: a.lift === null ? null : [0.8, 0.73, 0.39, 0.42, 0.18, 0.15, 0.0][i] ?? null,
          quadrant: a.lift === null ? null : (["LATENT_OPEN", "LATENT_OPEN", "PROVEN_CROWDED", "LATENT_OPEN", "SATURATED", "COLD", "SATURATED"] as const)[i] ?? null,
          reason: a.lift === null ? "insufficient_n" : null,
        })),
        supply: { source: "places_sample", capped: true, points: areas.slice(0, 5).map((a, i) => ({ lat: a.lat + 0.002 * i, lon: a.lon - 0.002, label: `Wine bar ${i + 1}`, ref: null })) },
        boundarySource: "City of Austin neighbourhood planning areas (public domain)",
        caption: "Lift = the concept's heat in a neighbourhood ÷ the restaurant baseline's; raw heat tracks popularity.",
      },
      [e, s],
      ["lift.cell", "lift.area", "lift.confidence", "lift.white_space"],
    );
    latent = t.finding("LATENT_DEMAND", "East Cesar Chavez and Holly show high demand and little supply.", [ids.ws as MetricId], { tool: "block_dna", reason: "Read what the top pocket already has." });
  });
  blockDna(run, { id: "tool-2", phase: "followup", trigger: latent, metro: "austin", areaId: "east_cesar_chavez", fallback: true, tags: [["Listening room", 42, true], ["Natural wine", 31, false], ["Record store", 27, false], ["Sports bar", -21, false], ["Chain coffee", -17, false], ["Nightclub", -12, false]] }, block);
  return run.finish({
    names: ids,
    headline: "East side, not downtown: East Cesar Chavez leads the lift map",
    tag: "East side leads",
    signal: "strong",
    thesis: "East Cesar Chavez lifts {{top}} against the restaurant baseline and Downtown only {{low}}. Listening rooms already over-index there ({{tag0}}).",
    exhibits: [
      { dataset: () => map, title: "The fit sits on the east side, centred on East Cesar Chavez", caption: "Lift vs the Austin restaurant baseline (1.00) for a natural-wine and vinyl bar audience." },
      { dataset: () => block.bars, title: "East Cesar Chavez already over-indexes on listening rooms", caption: "Rank of each place tag in the area against the whole city." },
    ],
    arguments: [
      { section: "geography", fact: "East Cesar Chavez lifts {{top}}.", read: "The audience goes out east of I-35.", strength: "STRONG" },
      { section: "opportunity", fact: "White space in Holly reads {{ws}}.", read: "Demand without many venues yet.", strength: "MODERATE" },
      { section: "risk", fact: "Downtown lifts {{low}}.", read: "Busy, but not this audience.", strength: "MODERATE" },
    ],
    bearCase: ["A second baseline (retail) moves East Cesar Chavez out of the top three ({{top}})."],
    recommendations: [{ action: "Shortlist corner sites in East Cesar Chavez and Holly; skip Downtown.", priority: "now" }],
    nextMoves: [
      { label: "Best tenants for the block", question: "Which tenants fit a corner storefront in East Cesar Chavez, Austin?" },
      { label: "Who drinks natural wine", question: "Who is the natural-wine bar audience, and what else do they love?" },
      { label: "Sponsor a listening night", question: "Which sponsors fit a vinyl listening night in Austin?" },
    ],
    penalties: [{ rule: "code_fallback", label: "CODE FALLBACK", count: 1, points: -10 }],
    limitations: ["Relative within Austin and against the named baseline.", "Boundaries © City of Austin (public domain)."],
  });
}

function tenantMix(job: "tenant_mix" | "area_profile"): RunEvent[] {
  const tenant = job === "tenant_mix";
  const q = tenant
    ? "I own a vacant corner storefront in East Nashville. What should go there, and what does the block already have too much of?"
    : "What does the Holly neighbourhood in Austin already have too much of?";
  const metro = tenant ? "nashville" : "austin";
  const run = new RunBuilder(tenant ? "dev-tenant-mix" : "dev-area-profile", q, intentOf(job, [], { metro, area: tenant ? "East Nashville" : "Holly" }, {}, tenant ? "EAST NASHVILLE, NASHVILLE TEN" : "HOLLY, AUSTIN DNA"));
  const ids: Record<string, MetricId> = {};
  const block = { bars: "" as DatasetId, ids };
  let slope = "" as DatasetId;
  run.start([], {
    restated: tenant ? "Which concepts fit the block better than the city, and what is over-supplied?" : "Which taste tags over-index in Holly against Austin?",
    hypotheses: [
      { statement: "Bars over-index on the block.", expectation: "Bars gain rank vs the city.", tool: "block_dna", verdict: "REFUTED", metrics: () => [ids.tag3 as MetricId], note: "Sports bars lose rank ({{tag3}})." },
      { statement: "Live music leads the block.", expectation: "A music tag in the top gains.", tool: "block_dna", verdict: "CONFIRMED", metrics: () => [ids.tag0 as MetricId], note: "Listening rooms gain {{tag0}}." },
    ],
    steps: [
      { tool: "block_dna", purpose: "What the area over- and under-indexes on." },
      ...(tenant ? [{ tool: "rank_candidates" as const, purpose: "Tenant fit, site vs city." }] : []),
    ],
  });
  blockDna(
    run,
    {
      id: "tool-1",
      phase: "wave1",
      step: 1,
      metro,
      areaId: tenant ? "zcta_37206" : "holly",
      fallback: tenant,
      tags: [
        ["Listening room", 38, true],
        ["Roots music", 29, false],
        ["Vintage clothing", 22, true],
        ["Sports bar", -24, false],
        ["Event venue", -15, false],
      ],
    },
    block,
  );
  if (tenant) {
    run.tool({ id: "tool-2", tool: "rank_candidates", phase: "wave1", step: 2, args: { type: "brand", candidates: ["R1", "R2", "R3", "R4", "R5"], contexts: [{ kind: "city", metro: "nashville" }, { kind: "site", area: "zcta_37206" }] }, estimate: 2 }, (t) => {
      const calls = [t.call("/v2/insights", "urn:entity:brand", { "signal.location": "Nashville locality", "filter.results.entities": "R1,R2,R3,R4,R5" }, 5), t.call("/v2/insights", "urn:entity:brand", { "signal.location": "POINT(…)", "filter.results.entities": "R1,R2,R3,R4,R5" }, 5)];
      const e = t.evidence("Tenant candidates ranked for ZIP 37206 (East Nashville) and Nashville", "5 candidates, both contexts", calls);
      const tenants: [string, number, number, number][] = [
        ["Lantern Hi-Fi Bar", 1, 4, 88],
        ["Thimble & Thread", 2, 3, 74],
        ["Copper Kettle Coffee", 3, 1, 52],
        ["Northside Taproom", 4, 2, 41],
        ["Corner Lot Burgers", 5, 5, 30],
      ];
      tenants.forEach(([name, site, city, fit], i) => {
        const shift = (city - site) / 4;
        if (i < 2) ids[`shift${i}`] = t.metric({ key: "tenant.rank_shift", label: `rank shift of ${name}, ZIP 37206 (East Nashville) vs Nashville`, subjectRefs: [`R${i + 1}`, "zcta_37206", "nashville"], value: shift, display: `${signed(shift)} · site ${site} of 5 · city ${city} of 5, among the 5 ranked at both`, unit: "delta", formulaId: "tenant.rank_shift", evidenceIds: [e], comparator: "CITY" });
        if (i < 2) t.metric({ key: "tenant.fit", label: `tenant fit of ${name} at ZIP 37206 (East Nashville)`, subjectRefs: [`R${i + 1}`, "zcta_37206", "nashville"], value: fit, display: `${fit} of 100 · site ${site} of 5 · city ${city} of 5, among the 5 ranked at both`, unit: "score", formulaId: "tenant.fit", evidenceIds: [e], comparator: "CITY" });
      });
      slope = t.dataset(
        "Slope",
        "Tenant fit · ZIP 37206 (East Nashville) vs Nashville",
        {
          axes: [
            { key: "city", label: "Nashville" },
            { key: "site", label: "ZIP 37206 (East Nashville)" },
          ],
          scale: "rank",
          comparator: "CITY",
          valueLabel: "Rank among the candidates",
          scoreLabel: "Tenant fit",
          lines: tenants.map(([name, site, city, fit], i) => ({
            key: `R${i + 1}`,
            label: name,
            ref: rid(i + 1),
            points: [
              { value: city, reason: null, rank: city },
              { value: site, reason: null, rank: site },
            ],
            // Last axis minus first, in ranks: a climber's rank falls from city to site.
            delta: site - city,
            highlight: site < city,
            score: fit,
          })),
        },
        [e],
        ["tenant.rank_shift", "tenant.fit"],
      );
    });
  }
  const place = tenant ? "East Nashville" : "Holly";
  return run.finish({
    names: ids,
    headline: tenant ? "A listening bar fits the corner; the block already has its sports bars" : "Holly over-indexes on listening rooms and vintage, not on bars",
    tag: tenant ? "Listening bar fits" : "Music over bars",
    signal: "strong",
    thesis: `Listening rooms gain {{tag0}} in ${place} against the city, and sports bars lose {{tag3}}.${tenant ? " Lantern Hi-Fi Bar climbs most from city to site ({{shift0}})." : ""}`,
    exhibits: [
      { dataset: () => block.bars, title: `${place} over-indexes on listening rooms, under-indexes on sports bars`, caption: "Rank of each place tag in the area against the whole city." },
      ...(tenant ? [{ dataset: () => slope, title: "A hi-fi bar climbs most from city to site", caption: "Rank among five candidates in Nashville and at the site; climbers highlighted." }] : []),
    ],
    arguments: [
      { section: "geography", fact: "Listening rooms gain {{tag0}}.", read: "The block's audience goes out for music.", strength: "STRONG" },
      { section: "risk", fact: "Sports bars lose {{tag3}}.", read: "A sports bar fights the block's taste.", strength: "MODERATE" },
      { section: "opportunity", fact: "NEW tags: {{newTags}}.", read: "Tastes the city list does not hold yet.", strength: "MODERATE" },
    ],
    bearCase: ["A second read of the area by its boundary moves listening rooms out of the top gains ({{tag0}})."],
    recommendations: [{ action: tenant ? "Pitch the corner to a listening-bar operator first." : "Pitch music-led concepts to Holly landlords.", priority: "now" }],
    nextMoves: [
      { label: "Where else in town", question: tenant ? "Where else in Nashville does a listening bar over-index?" : "Where in Austin should a listening bar open?" },
      { label: "Sponsors for the opening", question: "Which sponsors fit a listening-bar opening night?" },
      { label: "Who goes there", question: "Who is the listening-room audience, and what else do they love?" },
    ],
    penalties: tenant ? [{ rule: "code_fallback", label: "CODE FALLBACK", count: 1, points: -10 }] : [],
    limitations: ["Taste signals of venue-goers, not residents or census data.", "Commercial concept fit only."],
  });
}

function sponsorship(): RunEvent[] {
  const q = "Which sponsors fit Marlowe Vance?";
  const run = new RunBuilder("dev-sponsorship", q, intentOf("sponsorship", [{ text: "Marlowe Vance", entity_type: "artist", role: "primary", public_figure: true }], {}, { sponsor_categories: ["beer", "spirits", "auto", "apparel_footwear", "outdoor_sporting_retail", "energy_drinks"] }, "MARLOWE VANCE <ARTIST> SPON"));
  const ids: Record<string, MetricId> = {};
  let slate = "" as DatasetId;
  let quadrant = "" as DatasetId;
  let slope = "" as DatasetId;
  const rows: [SponsorCategory, string, string, number, number, boolean][] = [
    ["beer", "Beer", "Harrow Pale Lager", 0.94, 0.24, true],
    ["spirits", "Spirits", "Cinder Hollow Rye", 0.91, 0.58, false],
    ["auto", "Trucks", "Mesa Line Trucks", 0.88, 0.71, false],
    ["apparel_footwear", "Boots & apparel", "Lantern & Loom", 0.86, 0.44, false],
    ["outdoor_sporting_retail", "Outdoor", "Ridgeway Outdoor", 0.83, 0.62, false],
    ["energy_drinks", "Energy drink", "Voltline Energy", 0.61, 0.77, false],
  ];
  run.start([exact("Marlowe Vance", "artist", "R1")], {
    restated: "Which brand in each sponsor category best fits the Marlowe Vance audience?",
    hypotheses: [
      { statement: "An energy drink fits best.", expectation: "Energy leads the slate.", tool: "sponsor_slate", verdict: "REFUTED", metrics: () => [ids.f5 as MetricId], note: "The energy best fit reads {{f5}}, the slate's lowest." },
      { statement: "Beer leads the slate.", expectation: "Beer has the top fit.", tool: "sponsor_slate", verdict: "CONFIRMED", metrics: () => [ids.f0 as MetricId], note: "Harrow Pale Lager fits at {{f0}}." },
    ],
    steps: [{ tool: "sponsor_slate", purpose: "Best fit per category, then markets." }],
  });
  run.tool({ id: "tool-1", tool: "sponsor_slate", phase: "wave1", step: 1, args: { seed: "R1", categories: rows.map((r) => r[0]), markets: ["nashville", "austin", "denver"] }, estimate: 10 }, (t) => {
    const calls = rows.map(([cat]) => t.call("/v2/insights", "urn:entity:brand", { "signal.interests.entities": "R1", "filter.tags": cat, take: "10" }, 10));
    const scoring = t.call("/v2/insights", "urn:entity:brand", { "signal.interests.entities": "R1", "filter.results.entities": "R2,R3,R4,R5,R6,R7" }, 24);
    const markets = ["nashville", "austin", "denver"].map((m) => t.call("/v2/insights", "urn:entity:brand", { "signal.interests.entities": "R1", "signal.location": m }, 12, "hit"));
    const e = t.evidence("Category discovery and one-scale scoring for Marlowe Vance", "6 categories, 24 scored", [...calls, scoring]);
    const em = t.evidence("Market alignment for the slate", "3 markets", markets);
    rows.forEach(([, label, name, fit, , utr], i) => {
      ids[`f${i}`] = t.metric({ key: "slate.fit", label: `FIT · ${name} · ${label} best fit${utr ? ", under the radar" : ""}`, subjectRefs: [`R${i + 2}`, "R1"], value: fit, display: `${f2(fit)} · ${i + 1} of 24`, unit: "pct", formulaId: "slate.best_fit", evidenceIds: [e], comparator: "WITHIN_CALL" });
    });
    ids.utr = t.metric({ key: "slate.utr_count", label: "best fits under the radar", subjectRefs: ["R1"], value: 1, display: "1 of 6", unit: "count", formulaId: "slate.under_the_radar", evidenceIds: [e], comparator: "WITHIN_CALL" });
    t.metric({ key: "slate.market_alignment", label: "Harrow Pale Lager · strongest market", subjectRefs: ["R2", "nashville"], value: 0.14, display: "+0.14 in Nashville", unit: "delta", formulaId: "slate.market_alignment", evidenceIds: [e, em], comparator: "BASELINE" });
    slate = t.dataset(
      "Slate",
      "Sponsor slate · Marlowe Vance",
      {
        seed: { ref: "R1", label: "Marlowe Vance" },
        rows: rows.map(([cat, label, name, fit, pop, utr], i) => ({
          category: cat,
          label,
          best: { ref: rid(i + 2), label: name, fit: v(fit), popularity: pop, utr, topMarkets: i === 0 ? [{ market: "nashville", label: "Nashville", delta: 0.14 }] : [] },
          runnerUp: null,
          reason: null,
        })),
        markets: [
          { id: "nashville", label: "Nashville" },
          { id: "austin", label: "Austin" },
          { id: "denver", label: "Denver" },
        ],
        caption: "Taste fit only; no fee, availability or ROI data.",
      },
      [e],
      ["slate.best_fit", "slate.under_the_radar"],
    );
    const others = Array.from({ length: 14 }, (_, i) => ({ fit: 0.55 + ((i * 7) % 30) / 100, pop: ((i * 13) % 90) / 100 + 0.05 }));
    quadrant = t.dataset(
      "Quadrant",
      "Sponsor fit against popularity · Marlowe Vance",
      {
        xLabel: "Popularity percentile within category",
        yLabel: "Fit",
        xUnit: "popularity",
        yUnit: "pct",
        xSplit: 0.5,
        ySplit: 0.78,
        quadrantLabels: { HEARTLAND: "PRICED IN", HIDDEN_POCKET: "UNDER-THE-RADAR FIT · no pricing data", MASS: "FAMOUS · POOR FIT", COLD: "WEAK FIT · NICHE" },
        points: [
          ...rows.map(([, label, name, fit, pop, utr], i) => ({ key: `R${i + 2}`, label: name, ref: rid(i + 2), x: pop, y: fit, quadrant: quadrantOf(fit, pop), score: null, labelled: true, group: label, utr, geo: null })),
          ...others.map((o, i) => ({ key: `o${i}`, label: `Candidate ${i + 1}`, ref: null, x: o.pop, y: o.fit, quadrant: quadrantOf(o.fit, o.pop), score: null, labelled: false, group: null, utr: false, geo: null })),
        ],
        omitted: [],
        belts: [],
        inset: null,
        caption: "Taste fit only; no fee, availability or ROI data.",
      },
      [e],
      ["slate.under_the_radar"],
    );
    slope = t.dataset(
      "Slope",
      "Sponsor market alignment · Marlowe Vance",
      {
        axes: [
          { key: "national", label: "National" },
          { key: "nashville", label: "Nashville" },
          { key: "austin", label: "Austin" },
          { key: "denver", label: "Denver" },
        ],
        scale: "pct",
        comparator: "BASELINE",
        valueLabel: "Fit percentile",
        scoreLabel: null,
        lines: rows.slice(0, 4).map(([, , name, fit], i) => {
          const pts = [fit, fit + [0.04, -0.06, 0.02, -0.03][i]!, fit - [0.08, 0.02, -0.03, 0.05][i]!, fit - 0.04];
          return { key: `R${i + 2}`, label: name, ref: rid(i + 2), points: pts.map((p) => ({ value: Math.min(1, p), reason: null, rank: null })), delta: (pts[3] as number) - (pts[0] as number), highlight: i === 0, score: null };
        }),
      },
      [em],
      ["slate.market_alignment"],
    );
  });
  return run.finish({
    names: ids,
    headline: "Beer leads, and its best fit is a lager most sponsors would miss",
    tag: "Beer leads",
    signal: "strong",
    thesis: "Harrow Pale Lager fits Marlowe Vance at {{f0}} while sitting under the radar ({{utr}}). Energy drinks trail at {{f5}}.",
    exhibits: [
      { dataset: () => slate, title: "Beer leads, and its best fit is a lager most sponsors would miss", caption: "Best fit per category; fit is taste overlap with Marlowe Vance listeners, 0–1." },
      { dataset: () => quadrant, title: "Only one category winner sits in the under-the-radar corner", caption: "Fit against popularity percentile within category; grey: other candidates." },
      { dataset: () => slope, title: "Nashville pulls the lager up", caption: "Fit percentile nationally and in three markets." },
    ],
    arguments: [
      { section: "opportunity", fact: "Harrow Pale Lager fits at {{f0}}.", read: "A partner the audience already likes.", strength: "STRONG" },
      { section: "audience", fact: "Under the radar: {{utr}}.", read: "Few rivals for its attention.", strength: "MODERATE" },
      { section: "risk", fact: "Energy trails at {{f5}}.", read: "Skip the category.", strength: "MODERATE" },
    ],
    bearCase: ["A wider shortlist moves a national lager above Harrow Pale Lager ({{f0}})."],
    recommendations: [{ action: "Open talks with Harrow Pale Lager for the Nashville dates first.", priority: "now" }],
    nextMoves: [
      // Desk-first labels, as the director prompt asks for them.
      { label: "MARKETING · Tour cities", question: "Which cities should Marlowe Vance tour for the Harrow Pale Lager audience?" },
      { label: "LOCATION · After-party block", question: "Which East Nashville block fits the after-party pop-up?" },
      { label: "AUDIENCE · Who the fans are", question: "Who are Marlowe Vance's fans, and what else do they love?" },
    ],
  });
}

function marketSelection(): RunEvent[] {
  const q = "Which cities should Juniper Cola launch in next?";
  const run = new RunBuilder("dev-market-selection", q, intentOf("market_selection", [brand("Juniper Cola"), brand("Foxglove Cola", "peer")], {}, {}, "JUNIPER COLA <BRAND> MKTS"));
  const ids: Record<string, MetricId> = {};
  let grid = "" as DatasetId;
  const metros = [
    ["austin", "Austin", 0.92],
    ["nashville", "Nashville", 0.84],
    ["denver", "Denver", 0.71],
    ["atlanta", "Atlanta", 0.48],
    ["chicago", "Chicago", 0.33],
  ] as const;
  run.start([exact("Juniper Cola", "brand", "R1"), exact("Foxglove Cola", "brand", "R2", "peer")], {
    restated: "Where does Juniper Cola rank highest among its set, by metro?",
    hypotheses: [{ statement: "Austin leads.", expectation: "Austin is the top metro.", tool: "share_of_taste", verdict: "CONFIRMED", metrics: () => [ids.m0 as MetricId], note: "Austin reads {{m0}}." }],
    steps: [{ tool: "share_of_taste", purpose: "Rank the set in each candidate metro." }],
  });
  run.tool({ id: "tool-1", tool: "share_of_taste", phase: "wave1", step: 1, args: { refs: ["R1", "R2", "R3"], metros: metros.map((m) => m[0]) }, estimate: 5 }, (t) => {
    const calls = metros.map(([id]) => t.call("/v2/insights", "urn:entity:brand", { "signal.location": id, "filter.results.entities": "R1,R2,R3" }, 3));
    const e = t.evidence("Share of taste by metro for Juniper Cola and two peers", "5 metro contexts", calls);
    metros.forEach(([id, label, pct], i) => {
      const m = t.metric({ key: "share.pct", label: `Share-of-Taste percentile of Juniper Cola, metro ${label}${i === 0 ? " (best context)" : i === metros.length - 1 ? " (worst context)" : ""}`, subjectRefs: ["R1", id], value: pct, display: `${f2(pct)} · ${pct > 0.5 ? 1 : 2} of 3`, unit: "pct", formulaId: "share.pct", evidenceIds: [e], comparator: "WITHIN_CALL" });
      ids[`m${i}`] = m;
    });
    t.metric({ key: "share.metros_won", label: "metros won by Juniper Cola (first in the set)", subjectRefs: ["R1", ...metros.map((m) => m[0])], value: 3, display: "wins 3 of 5 · top half in 3 of 5", unit: "count", formulaId: "share.metros_won", evidenceIds: [e], comparator: "PEERS" });
    const names = ["Juniper Cola", "Foxglove Cola", "Harbor Seltzer"];
    grid = t.dataset(
      "Matrix",
      "Share of Taste · Juniper Cola",
      {
        mode: "share",
        valueLabel: "Within-call percentile",
        unit: "pct",
        comparator: "WITHIN_CALL",
        rows: metros.map(([id, label]) => axis(id, label, null, "METRO")),
        cols: names.map((n, i) => axis(`R${i + 1}`, n, rid(i + 1))),
        cells: metros.map(([, , pct]) => [pct, 1 - pct, 0.5].map((value, j, all) => ({ value, reason: null, rank: all.filter((o) => o > value).length + 1 + 0 * j }))),
        margin: null,
        targetKey: "R1",
        annotations: [],
      },
      [e],
      ["share.pct", "share.metros_won"],
    );
  });
  return run.finish({
    names: ids,
    headline: "Launch in Austin and Nashville; Chicago is not ready",
    tag: "Sun Belt first",
    signal: "strong",
    thesis: "Juniper Cola ranks {{m0}} in Austin and {{m1}} in Nashville, against {{m4}} in Chicago.",
    exhibits: [{ dataset: () => grid, title: "Austin and Nashville rank Juniper Cola first", caption: "Within-call percentile of three brands in five metros." }],
    arguments: [
      { section: "geography", fact: "Austin reads {{m0}}.", read: "The strongest launch market.", strength: "STRONG" },
      { section: "geography", fact: "Nashville reads {{m1}}.", read: "A close second.", strength: "MODERATE" },
      { section: "risk", fact: "Chicago reads {{m4}}.", read: "Not yet.", strength: "MODERATE" },
    ],
    bearCase: ["A metro refresh moves Denver above Nashville ({{m1}})."],
    recommendations: [{ action: "Plan the first two launches in Austin and Nashville.", priority: "now" }],
    nextMoves: [
      { label: "Austin pop-up site", question: "Where in Austin should a Juniper Cola pop-up open?" },
      { label: "Local sponsor", question: "Which Austin artists fit a Juniper Cola sponsorship?" },
    ],
  });
}

function audienceDiscovery(): RunEvent[] {
  const q = "Who is the Pantry & Pine shopper, and what else do they love?";
  const run = new RunBuilder("dev-audience", q, intentOf("audience_discovery", [brand("Pantry & Pine")], {}, { domains: ["artist", "podcast", "tv_show"] }, "PANTRY & PINE <BRAND> AUD"));
  const ids: Record<string, MetricId> = {};
  let ages = "" as DatasetId;
  let media = "" as DatasetId;
  run.start([exact("Pantry & Pine", "brand", "R1")], {
    restated: "Who is the Pantry & Pine audience, and which culture do they share?",
    hypotheses: [{ statement: "The audience skews 25–34.", expectation: "The 25–29 and 30–34 indices lead.", tool: "audience_dna", verdict: "CONFIRMED", metrics: () => [ids.y as MetricId], note: "Youth index {{y}}." }],
    steps: [
      { tool: "audience_dna", purpose: "Age and gender indices against grocery peers." },
      { tool: "cross_domain", purpose: "Music, podcasts and TV they over-index on." },
    ],
  });
  run.tool({ id: "tool-1", tool: "audience_dna", phase: "wave1", step: 1, args: { refs: ["R1"] }, estimate: 2 }, (t) => {
    const e = t.evidence("Demographics of Pantry & Pine and six grocery peers", "6 age bands, 2 genders", [t.call("/v2/insights", "urn:demographics", { "signal.interests.entities": "R1" }, 7), t.call("/entities", null, { entity_ids: "R1" }, 1, "hit")], ["DEMOGRAPHICS_ARE_INDICES"]);
    const bands = [
      ["≤24", 0.05, 0.02],
      ["25–29", 0.31, 0.06],
      ["30–34", 0.24, 0.04],
      ["35–44", 0.12, 0.03],
      ["45–54", -0.12, -0.01],
      ["55+", -0.27, -0.07],
    ] as const;
    bands.forEach(([label, value], i) => (ids[`age${i}`] = t.metric({ key: "dna.age_index", label: `Pantry & Pine age index ${label}`, subjectRefs: ["R1"], value, display: signed(value), unit: "index", formulaId: "dna.age_index", evidenceIds: [e], comparator: "BASELINE", badge: "MEASURED" })));
    ids.y = t.metric({ key: "dna.youth_index", label: "Pantry & Pine youth index (Y)", subjectRefs: ["R1"], value: 0.38, display: "+0.38 · 1 of 7", unit: "index", formulaId: "dna.youth_index", evidenceIds: [e], comparator: "BASELINE" });
    t.metric({ key: "dna.distinctive_tags", label: "distinctive facet tags of Pantry & Pine (on fewer than half of its peers of the same type)", subjectRefs: ["R1"], value: 7, display: "7 of 31 facet tags, vs 6 peers of the same type", unit: "count", formulaId: "dna.distinctive_tags", evidenceIds: [e], comparator: "PEERS" });
    ages = t.dataset(
      "Bars",
      "Audience DNA · Pantry & Pine and peers",
      {
        mode: "butterfly",
        comparator: "BASELINE",
        valueLabel: "Age affinity index",
        unit: "index",
        series: [axis("R1", "Pantry & Pine", "R1"), axis("peers", "Grocery peers, average of 6")],
        groups: [{ key: "AGE", label: "Age", family: null, bars: bands.map(([label, a, b]) => ({ key: label, label, tagRef: null, values: [v(a), v(b)], isNew: false, ranks: null })) }],
        method: null,
        domain: null,
        caption: "Relative affinity indices from −1 to 1 around the average audience (0), not population shares.",
        display: "dumbbell",
        baseline: 0,
      },
      [e],
      ["dna.age_index"],
    );
  });
  run.tool({ id: "tool-2", tool: "cross_domain", phase: "wave1", step: 2, args: { seeds: ["R1"], seed_tags: [], domains: ["artist", "podcast", "tv_show"], popularity_max: 0.8 }, estimate: 3 }, (t) => {
    const calls = ["artist", "podcast", "tv_show"].map((d) => t.call("/v2/insights", `urn:entity:${d}`, { "signal.interests.entities": "R1", take: "15" }, 15));
    const e = t.evidence("Cultural neighbourhood of Pantry & Pine", "3 domains, 45 results", calls);
    const lists: [string, string, [string, number, number][]][] = [
      ["artist", "Music · artists", [["The Larkspur Collective", 0.96, 0.31], ["Wren & Ash", 0.91, 0.44], ["Halcyon Drift", 0.88, 0.22]]],
      ["podcast", "Podcasts", [["The Slow Kitchen", 0.93, 0.28], ["Saltbox Radio Hour", 0.86, 0.35]]],
      ["tv_show", "TV · series", [["Hollow Creek Lane", 0.9, 0.52], ["The Long Table", 0.84, 0.39]]],
    ];
    let r = 2;
    const groups = lists.map(([key, label, rows]) => ({
      key,
      label,
      rows: rows.map(([name, fit, pop], i) => {
        const ref = rid(r++);
        if (i === 0) ids[`utr${key}`] = t.metric({ key: "xdom.under_the_radar", label: `${label} · under-the-radar pick`, subjectRefs: [ref], value: fit - pop, display: `${f2(fit - pop)} · fit ${f2(fit)} − popularity ${f2(pop)}`, unit: "score", formulaId: "xdom.under_the_radar", evidenceIds: [e], comparator: "WITHIN_CALL" });
        return { key: ref, rank: i + 1, label: name, sublabel: null, ref, tagRef: null, type: key as "artist", cells: [v(fit)], flags: i === 0 ? ["UTR" as const] : [], explain: [] };
      }),
    }));
    media = t.dataset("Ranked", "Cultural neighbourhood · Pantry & Pine", { columns: [{ key: "fit", label: "Fit", unit: "pct", comparator: "WITHIN_CALL" }], groups, caption: "Top results per domain; explainability is attribution inside Qloo's model, not causation." }, [e], ["pct.within_call", "xdom.under_the_radar"]);
  });
  return run.finish({
    names: ids,
    headline: "A distinct 25–34 core that cooks, listens to indie folk and watches slow TV",
    tag: "Distinct young core",
    signal: "strong",
    thesis: "The 25–29 index is {{age1}} and the youth index {{y}}. Their under-the-radar music pick scores {{utrartist}}.",
    exhibits: [
      { dataset: () => ages, title: "The audience peaks at 25–29 and thins after 45", caption: "Age index around the average audience (0); grey: grocery peers." },
      { dataset: () => media, title: "Indie folk, kitchen podcasts and slow TV", caption: "Top items per domain by fit." },
    ],
    arguments: [
      { section: "audience", fact: "25–29 indexes {{age1}}.", read: "A young-professional core.", strength: "STRONG" },
      { section: "audience", fact: "55+ indexes {{age5}}.", read: "Older shoppers are elsewhere.", strength: "MODERATE" },
      { section: "opportunity", fact: "Music pick: {{utrartist}}.", read: "Partner with small artists.", strength: "MODERATE" },
    ],
    bearCase: ["A different peer set lowers the youth index below the peers' ({{y}})."],
    recommendations: [{ action: "Test an in-store listening session with an indie folk artist.", priority: "next" }],
    nextMoves: [
      { label: "Sponsor fit", question: "Which artists fit a Pantry & Pine sponsorship?" },
      { label: "Store sites", question: "Where in Austin should Pantry & Pine open its next store?" },
      { label: "Competitors", question: "Who does Pantry & Pine really compete with?" },
    ],
  });
}

/** The synthetic run for each job (all eight), in desk order. */
// Part 9 jobs ------------------------------------------------------------------------------------------------

/** The vintage every synthetic Census figure carries (the values are invented, D29). */
const ACS = "ACS 2019–2023 5-year";

const usdK = (n: number) => `$${(n / 1000).toFixed(1)}K`;

/** Census figures for areas, as area_economics returns them: one public call per city, one bundle, a Ranked table. */
function areaEconomics(
  t: ToolScope,
  calls: { metro: "austin" | "nashville" | "denver"; query: Record<string, string> }[],
  rows: { key: string; label: string; sublabel: string | null; population: number; age: number; income: number; home: number; comparison?: boolean }[],
  title: string,
  ids: Record<string, MetricId>,
  name: (key: string) => string,
): DatasetId {
  const callIds = calls.map((c, i) => t.publicCall("/data/acs/acs5", "/data/2023/acs/acs5", c.query, `mock-acs5-2023-${c.metro}-${i + 1}`));
  const e = t.evidence("Census residents of the areas compared", `${rows.length} rows from ${calls.length} Census requests`, callIds, ["CENSUS_RESIDENTS_ONLY"]);
  for (const r of rows) {
    if (r.comparison) continue;
    ids[name(r.key)] = t.metric({
      key: "econ.median_hh_income",
      label: `Median household income, ${r.label}`,
      subjectRefs: [r.key],
      value: r.income,
      display: `${usdK(r.income)} · approximate`,
      unit: "usd",
      formulaId: "econ.median",
      evidenceIds: [e],
      badge: "ESTIMATED",
      comparator: "CITY",
      period: ACS,
    });
  }
  return t.dataset(
    "Ranked",
    title,
    {
      columns: [
        { key: "population", label: "Residents", unit: "people", comparator: null },
        { key: "median_age", label: "Median age", unit: "years", comparator: null },
        { key: "median_income", label: "Median household income", unit: "usd", comparator: "CITY" },
        { key: "work_from_home", label: "Work from home", unit: "pct", comparator: "CITY" },
      ],
      groups: [
        { key: "areas", label: "Areas", rows: rows.filter((r) => !r.comparison).map(econRow) },
        ...(rows.some((r) => r.comparison) ? [{ key: "city", label: "The whole city, to compare with", rows: rows.filter((r) => r.comparison).map(econRow) }] : []),
      ],
      caption: `US Census ${ACS} estimates for residents; medians are population-weighted averages of ZIP or tract medians.`,
    },
    [e],
    ["econ.count", "econ.median", "econ.share"],
  );
}

function econRow(r: { key: string; label: string; sublabel: string | null; population: number; age: number; income: number; home: number }) {
  return { key: r.key, rank: null, label: r.label, sublabel: r.sublabel, ref: null, tagRef: null, type: null, cells: [v(r.population), v(r.age), v(r.income), v(r.home)], flags: [], explain: [] };
}

function tasteTwins(): RunEvent[] {
  const q = "My café does well in Holly, Austin. Which Nashville neighbourhood is its twin?";
  const run = new RunBuilder(
    "dev-taste-twins",
    q,
    intentOf("taste_twins", [], { metro: "austin", area: "Holly", target_metro: "nashville" }, { concepts: ["café"] }, "HOLLY, AUSTIN TWIN NASHVILLE"),
  );
  const ids: Record<string, MetricId> = {};
  let twins = "" as DatasetId;
  let pair = "" as DatasetId;
  let econ = "" as DatasetId;
  const source = area("austin", "holly");
  const targets: [string, number | null, number][] = [
    ["zcta_37206", 0.71, 3],
    ["zcta_37216", 0.58, 2],
    ["zcta_37212", 0.34, 1],
    ["zcta_37204", 0.22, 0],
    ["zcta_37215", -0.08, 0],
    ["zcta_37203", null, 0],
  ];
  const areas = targets.map(([id]) => area("nashville", id));
  run.start([], {
    restated: "Which Nashville areas differ from Nashville the way Holly differs from Austin?",
    hypotheses: [
      {
        statement: "East Nashville is Holly's closest twin.",
        expectation: "East Nashville has the highest match.",
        tool: "taste_twins",
        verdict: "CONFIRMED",
        metrics: () => [ids.rho0 as MetricId],
        note: "East Nashville matches at {{rho0}}.",
      },
    ],
    steps: [
      { tool: "taste_twins", purpose: "Rank Nashville areas by how closely their taste matches Holly's." },
      { tool: "area_economics", purpose: "Who lives in Holly and its closest twins." },
    ],
  });
  run.tool(
    { id: "scan-1", tool: "taste_twins", phase: "scan", args: { source: { kind: "nbhd", ref: "holly", metro: "austin" }, target_metro: "nashville", target_areas: targets.map(([id]) => id), concept_tags: [] }, estimate: 7 },
    (t) => {
      const calls = [
        t.call("/v2/insights", "urn:tag", { "signal.location": "POLYGON((…))", take: "50" }, 50),
        t.call("/v2/insights", "urn:tag", { "signal.location": "Austin locality", take: "50" }, 50, "hit"),
        t.call("/v2/insights", "urn:tag", { "signal.location": "Nashville locality", take: "50" }, 50, "hit"),
        ...areas.map(() => t.call("/v2/insights", "urn:tag", { "signal.location": "POLYGON((…))", take: "50" }, 50)),
      ];
      const e = t.evidence(`Taste of Holly and ${areas.length} Nashville areas, each against its own city`, `${areas.length + 1} area tag lists, 2 city lists`, calls);
      const measured = targets.filter(([, rho]) => rho !== null).length;
      targets.forEach(([id, rho], i) => {
        const name = areas[i]?.name ?? id;
        ids[`rho${i}`] = t.metric({
          key: "twin.rho",
          label: `taste match of ${name} with Holly (rank changes vs each own city)`,
          subjectRefs: [id, "holly"],
          value: rho,
          display: rho === null ? "" : `${f2(rho)} · ${i + 1} of ${measured} matched`,
          unit: "similarity",
          formulaId: "twin.rho",
          evidenceIds: [e],
          comparator: "CITY",
          n: 42,
          reason: rho === null ? "not_measured" : undefined,
        });
      });
      ids.shared = t.metric({
        key: "twin.shared_new",
        label: "tastes new to both cities that Holly and East Nashville share",
        subjectRefs: ["zcta_37206", "holly"],
        value: 3,
        display: "3 shared",
        unit: "count",
        formulaId: "twin.shared_new",
        evidenceIds: [e],
        comparator: "CITY",
      });
      t.finding("TWIN_FOUND", "East Nashville is a clear twin of Holly: its match is the highest of the Nashville areas checked.", [ids.rho0 as MetricId], {
        tool: "block_dna",
        reason: "Read East Nashville's own taste in full.",
      });
      twins = t.dataset(
        "Ranked",
        "Taste twins · Holly in Nashville",
        {
          columns: [
            { key: "rho", label: "Resemblance to Holly (ρ)", unit: "similarity", comparator: "CITY" },
            { key: "shared_new", label: "Shared NEW tags", unit: "count", comparator: null },
          ],
          groups: [
            {
              key: "twins",
              label: "6 of 34 Nashville areas checked",
              rows: targets.map(([id, rho, shared], i) => ({
                key: id,
                rank: rho === null ? null : i + 1,
                label: areas[i]?.name ?? id,
                sublabel: null,
                ref: null,
                tagRef: null,
                type: null,
                cells: [rho === null ? { value: null, reason: "not_measured" as const } : v(rho), v(shared)],
                flags: [],
                explain: [],
              })),
            },
          ],
          caption: "Spearman ρ of the two areas' rank changes against their own cities, over the tags either area lists.",
        },
        [e],
        ["twin.rho", "twin.shared_new"],
      );
      const tags: [string, string, number, number, boolean][] = [
        ["WHAT", "Coffee house", 31, 27, false],
        ["WHAT", "Listening room", 24, 19, true],
        ["WHAT", "Vintage clothing", 18, 22, false],
        ["WHAT", "Sports bar", -21, -17, false],
        ["WHAT", "Chain restaurant", -15, -12, false],
        ["VIBE", "Cozy", 16, 13, false],
        ["VIBE", "Upscale", -11, 4, false],
      ];
      pair = t.dataset(
        "Bars",
        `Holly vs ${areas[0]?.name ?? "East Nashville"}`,
        {
          mode: "butterfly",
          comparator: "CITY",
          valueLabel: "Rank change vs its own city",
          unit: "delta",
          series: [axis("holly", source.name), axis("zcta_37206", areas[0]?.name ?? "East Nashville")],
          groups: (["WHAT", "VIBE"] as const).map((family) => ({
            key: family,
            label: family === "WHAT" ? "What" : "Vibe",
            family,
            bars: tags
              .filter(([f]) => f === family)
              .map(([, label, a, b, isNew], i) => ({ key: `${family}-${i}`, label, tagRef: null, values: [v(a), v(b)], isNew, ranks: null })),
          })),
          method: "POLYGON",
          domain: null,
          caption: "Each area's rank change against its own city; venue-goer taste signals, not residents or census data.",
        },
        [e],
        ["twin.rho"],
      );
    },
  );
  run.tool({ id: "tool-2", tool: "area_economics", phase: "wave1", step: 2, args: { metro: "nashville", areas: ["zcta_37206", "zcta_37216"] }, estimate: 0 }, (t) => {
    econ = areaEconomics(
      t,
      [
        { metro: "austin", query: { get: "B01003_001E,B19013_001E", for: "tract:*", in: "state:48 county:453" } },
        { metro: "nashville", query: { get: "B01003_001E,B19013_001E", for: "zip code tabulation area:37206,37216" } },
      ],
      [
        { key: "holly", label: "Holly", sublabel: "Austin · 6 census tracts", population: 11840, age: 33.1, income: 68400, home: 0.19 },
        { key: "zcta_37206", label: "East Nashville", sublabel: "Nashville · whole ZIP 37206", population: 28310, age: 34.6, income: 71200, home: 0.17 },
        { key: "zcta_37216", label: "Inglewood", sublabel: "Nashville · whole ZIP 37216", population: 19870, age: 37.9, income: 63900, home: 0.13 },
        { key: "nashville", label: "Nashville, all areas", sublabel: "the city as a whole", population: 702100, age: 34.2, income: 66800, home: 0.14, comparison: true },
      ],
      "Area economics · Holly and its twins",
      ids,
      (key) => `inc_${key}`,
    );
  });
  return run.finish({
    names: ids,
    headline: "East Nashville is Holly's closest taste twin in Nashville",
    tag: "Clear twin",
    signal: "strong",
    thesis: "East Nashville matches Holly at {{rho0}}, ahead of Inglewood at {{rho1}}. The two share {{shared}} tastes new to both cities.",
    exhibits: [
      { dataset: () => twins, title: "East Nashville leads the Nashville areas checked", caption: "Match of each area's taste, against its own city, with Holly's." },
      { dataset: () => pair, title: "Coffee houses and listening rooms lead in both", caption: "Rank change of each taste against each area's own city." },
      { dataset: () => econ, title: "Residents of Holly and its twins", caption: "Census estimates for residents ({{PERIOD:inc_holly}}), not customers." },
    ],
    arguments: [
      { section: "geography", fact: "East Nashville matches at {{rho0}}.", read: "The closest mix of tastes to Holly among the areas checked.", strength: "STRONG" },
      { section: "geography", fact: "Inglewood matches at {{rho1}}.", read: "A second area to visit.", strength: "MODERATE" },
      { section: "audience", fact: "Median household income in East Nashville is {{inc_zcta_37206}} ({{PERIOD:inc_zcta_37206}}).", read: "Residents earn about what Holly's do.", strength: "MODERATE" },
    ],
    bearCase: ["Only the six Nashville areas checked are ranked; an area not checked could match better than East Nashville ({{rho0}})."],
    recommendations: [
      { action: "Walk East Nashville and Inglewood on a weekday evening before you look at leases.", priority: "now" },
      { action: "Ask what East Nashville already has too much of before choosing a block.", priority: "next" },
    ],
    nextMoves: [
      { label: "Neighbourhood", question: "What does East Nashville already have too much of?" },
      { label: "Where to open", question: "Where in Nashville should a café open?" },
      { label: "Compare cities", question: "Austin vs Nashville for a café: which city fits best?" },
    ],
    limitations: ["Music tastes are not compared between the areas.", "Only the six Nashville areas checked are ranked, not every area."],
  });
}

function brandCollab(): RunEvent[] {
  const q = "Which brands would make a credible collaboration with Larkfield Soda?";
  const run = new RunBuilder("dev-brand-collab", q, intentOf("brand_collab", [brand("Larkfield Soda")], {}, {}, "LARKFIELD SODA <BRAND> COLLAB"));
  const ids: Record<string, MetricId> = {};
  let hood = "" as DatasetId;
  let scored = "" as DatasetId;
  let contrast = "" as DatasetId;
  const partners: [string, number, number][] = [
    ["Copperline Coffee", 0.94, 0.41],
    ["Fieldnote Outfitters", 0.91, 0.62],
    ["Bramble & Oak Candles", 0.87, 0.18],
    ["Northwind Bikes", 0.82, 0.55],
    ["Tidewater Sauces", 0.74, 0.33],
    ["Quarry Denim", 0.66, 0.7],
  ];
  run.start([exact("Larkfield Soda", "brand", "R1"), ...partners.map(([name], i) => exact(name, "brand", rid(i + 2), "peer"))], {
    restated: "Which brands outside soft drinks share Larkfield Soda's audience?",
    hypotheses: [
      {
        statement: "A coffee brand is the best partner.",
        expectation: "A coffee brand scores highest.",
        tool: "rank_candidates",
        verdict: "CONFIRMED",
        metrics: () => [ids.fit0 as MetricId],
        note: "Copperline Coffee scores {{fit0}}.",
      },
    ],
    steps: [
      { tool: "cross_domain", purpose: "Find brands in other categories its fans like." },
      { tool: "rank_candidates", purpose: "Score the partners on one scale." },
      { tool: "audience_dna", purpose: "Tastes Larkfield Soda shares with its best partner." },
    ],
  });
  run.tool({ id: "scan-1", tool: "cross_domain", phase: "scan", args: { seeds: ["R1"], seed_tags: [], domains: ["brand"], popularity_max: 0.8 }, estimate: 1 }, (t) => {
    const e = t.evidence("Brands Larkfield Soda's fans over-index on", "1 domain, 20 results", [t.call("/v2/insights", "urn:entity:brand", { "signal.interests.entities": "R1", take: "20" }, 20)]);
    ids.utr = t.metric({ key: "xdom.under_the_radar", label: "Brands · under-the-radar pick", subjectRefs: ["R4"], value: 0.69, display: "0.69 · fit 0.87 − popularity 0.18", unit: "score", formulaId: "xdom.under_the_radar", evidenceIds: [e], comparator: "WITHIN_CALL" });
    hood = t.dataset(
      "Ranked",
      "Cultural neighbourhood · Larkfield Soda",
      {
        columns: [{ key: "fit", label: "Fit", unit: "pct", comparator: "WITHIN_CALL" }],
        groups: [
          {
            key: "brand",
            label: "Brands",
            rows: partners.map(([name, fit], i) => ({ key: rid(i + 2), rank: i + 1, label: name, sublabel: null, ref: rid(i + 2), tagRef: null, type: "brand" as const, cells: [v(fit)], flags: i === 2 ? ["UTR" as const] : [], explain: [] })),
          },
        ],
        caption: "Top brands outside the category by fit; explainability is attribution inside Qloo's model, not causation.",
      },
      [e],
      ["pct.within_call", "xdom.under_the_radar"],
    );
  });
  run.tool({ id: "tool-2", tool: "rank_candidates", phase: "wave1", step: 2, args: { candidates: partners.map((_, i) => rid(i + 2)), signal: ["R1"] }, estimate: 1 }, (t) => {
    const e = t.evidence("Partners scored on one scale against Larkfield Soda's audience", "6 candidates in one request", [
      t.call("/v2/insights", "urn:entity:brand", { "signal.interests.entities": "R1", "filter.results.entities": "R2,R3,R4,R5,R6,R7" }, 6),
    ]);
    partners.forEach(([name, fit], i) => {
      ids[`fit${i}`] = t.metric({ key: "rank.fit", label: `fit of ${name} with Larkfield Soda's audience`, subjectRefs: [rid(i + 2)], value: fit, display: `${f2(fit)} · ${i + 1} of 6`, unit: "pct", formulaId: "pct.within_call", evidenceIds: [e], comparator: "WITHIN_CALL" });
    });
    scored = t.dataset(
      "Ranked",
      "Ranked · Larkfield Soda audience",
      {
        columns: [
          { key: "fit", label: "FIT", unit: "pct", comparator: "WITHIN_CALL" },
          { key: "popularity", label: "Popularity", unit: "popularity", comparator: null },
        ],
        groups: [
          {
            key: "audience",
            label: "Larkfield Soda audience",
            rows: partners.map(([name, fit, pop], i) => ({ key: rid(i + 2), rank: i + 1, label: name, sublabel: null, ref: rid(i + 2), tagRef: null, type: "brand" as const, cells: [v(fit), v(pop)], flags: [], explain: [] })),
          },
        ],
        caption: "FIT is the within-call percentile among the 6 brands scored.",
      },
      [e],
      ["pct.within_call", "popularity"],
    );
  });
  run.tool({ id: "tool-3", tool: "audience_dna", phase: "wave1", step: 3, args: { refs: ["R1"], compare: "R2" }, estimate: 2 }, (t) => {
    const e = t.evidence("Facet tags of Larkfield Soda and Copperline Coffee", "2 tag lists", [t.call("/entities", null, { entity_ids: "R1,R2" }, 2, "hit")]);
    ids.shared = t.metric({ key: "dna.distinctive_tags", label: "facet tags Larkfield Soda shares with Copperline Coffee", subjectRefs: ["R1", "R2"], value: 5, display: "5 of 14 tags shared", unit: "count", formulaId: "dna.distinctive_tags", evidenceIds: [e], comparator: "PEERS" });
    const row = (name: string, i: number, facet: string) => ({ key: `${facet}-${i}`, rank: null, label: name, sublabel: facet, ref: null, tagRef: null, type: null, cells: [v(i + 1)], flags: [], explain: [] });
    contrast = t.dataset(
      "Ranked",
      "Facet tags · Larkfield Soda vs Copperline Coffee",
      {
        columns: [{ key: "peers", label: "Same-type peers with the tag", unit: "count", comparator: "PEERS" }],
        groups: [
          { key: "a_only", label: "Only Larkfield Soda", rows: ["Fizzy", "Retro", "Picnic"].map((n, i) => row(n, i, "style")) },
          { key: "shared", label: "Both", rows: ["Small batch", "Outdoors", "Craft", "Road trip", "Indie music"].map((n, i) => row(n, i, "style")) },
          { key: "b_only", label: "Only Copperline Coffee", rows: ["Morning", "Third wave", "Work from cafés", "Pour-over", "Single origin", "Roastery"].map((n, i) => row(n, i, "style")) },
        ],
        caption: "Presence only: a tag missing from one side is not a measured difference.",
      },
      [e],
      ["dna.distinctive_tags"],
    );
  });
  return run.finish({
    names: ids,
    headline: "Copperline Coffee is the most credible collaboration partner for Larkfield Soda",
    tag: "Clear partner",
    signal: "strong",
    thesis: "Copperline Coffee scores {{fit0}} and Fieldnote Outfitters {{fit1}} on one scale. The two audiences share {{shared}}.",
    exhibits: [
      { dataset: () => scored, title: "Copperline Coffee fits best", caption: "Fit with Larkfield Soda's audience, scored in one request." },
      { dataset: () => contrast, title: "What the two audiences share", caption: "Facet tags by presence only." },
      { dataset: () => hood, title: "Brands its fans like outside soft drinks", caption: "Top brands by fit." },
    ],
    arguments: [
      { section: "opportunity", fact: "Copperline Coffee scores {{fit0}}.", read: "The strongest fit of the brands scored.", strength: "STRONG" },
      { section: "audience", fact: "The audiences share {{shared}}.", read: "Small-batch and outdoor tastes overlap.", strength: "MODERATE" },
      { section: "opportunity", fact: "Bramble & Oak Candles is the under-the-radar pick ({{utr}}).", read: "A smaller partner with a close fit.", strength: "MODERATE" },
    ],
    bearCase: ["Fit is shared taste, not shared customers or sales; Quarry Denim scores only {{fit5}}."],
    recommendations: [
      { action: "Pitch a co-branded summer pack to Copperline Coffee.", priority: "now" },
      { action: "Ask who Copperline Coffee's fans are before the pitch.", priority: "next" },
    ],
    nextMoves: [
      { label: "Audience", question: "Who is the Copperline Coffee customer?" },
      { label: "Creators", question: "Which creators fit Larkfield Soda's audience?" },
      { label: "Competitors", question: "Who does Larkfield Soda really compete with?" },
    ],
  });
}

function creatorFit(): RunEvent[] {
  const q = "Which creators fit the Wildcomb Honey audience?";
  const run = new RunBuilder("dev-creator-fit", q, intentOf("creator_fit", [brand("Wildcomb Honey")], {}, { domains: ["artist", "podcast"] }, "WILDCOMB HONEY <BRAND> CRTR"));
  const ids: Record<string, MetricId> = {};
  let hood = "" as DatasetId;
  let scored = "" as DatasetId;
  const lists: ["person" | "artist" | "podcast", string, [string, number, number][]][] = [
    ["person", "Public figures", [["Ines Calder", 0.93, 0.38], ["Theo Brannigan", 0.88, 0.57], ["Ruth Okafor-Lind", 0.81, 0.29]]],
    ["artist", "Music · artists", [["Paper Lanterns", 0.95, 0.24], ["Juno Reyes Band", 0.9, 0.46], ["The Quiet Orchard", 0.84, 0.31]]],
    ["podcast", "Podcasts", [["Field Notes Radio", 0.92, 0.34], ["Small Batch Hour", 0.86, 0.21], ["The Long Pantry", 0.79, 0.4]]],
  ];
  run.start([exact("Wildcomb Honey", "brand", "R1")], {
    restated: "Which public figures, artists and podcasts do Wildcomb Honey's fans over-index on?",
    hypotheses: [
      { statement: "Food podcasts fit best.", expectation: "A food podcast leads its group.", tool: "cross_domain", verdict: "INCONCLUSIVE", metrics: () => [ids.fitpodcast as MetricId], note: "Field Notes Radio fits at {{fitpodcast}}." },
    ],
    steps: [
      { tool: "cross_domain", purpose: "Public figures, artists and podcasts its fans like." },
      { tool: "rank_candidates", purpose: "Score the artists on one scale." },
    ],
  });
  run.tool({ id: "scan-1", tool: "cross_domain", phase: "scan", args: { seeds: ["R1"], seed_tags: [], domains: ["person", "artist", "podcast"], popularity_max: 0.8 }, estimate: 3 }, (t) => {
    const calls = lists.map(([d]) => t.call("/v2/insights", `urn:entity:${d}`, { "signal.interests.entities": "R1", take: "15" }, 15));
    const e = t.evidence("Creators Wildcomb Honey's fans over-index on", "3 creator kinds, 45 results", calls);
    let r = 2;
    const groups = lists.map(([key, label, rows]) => ({
      key,
      label,
      rows: rows.map(([name, fit, pop], i) => {
        const ref = rid(r++);
        if (i === 0) ids[`fit${key}`] = t.metric({ key: "xdom.fit", label: `${label} · best fit with Wildcomb Honey's audience`, subjectRefs: [ref, "R1"], value: fit, display: `${f2(fit)} · 1 of 3 in the group`, unit: "pct", formulaId: "pct.within_call", evidenceIds: [e], comparator: "WITHIN_CALL" });
        if (i === 1 && key !== "person") ids[`utr${key}`] = t.metric({ key: "xdom.under_the_radar", label: `${label} · under-the-radar pick`, subjectRefs: [ref], value: fit - pop, display: `${f2(fit - pop)} · fit ${f2(fit)} − popularity ${f2(pop)}`, unit: "score", formulaId: "xdom.under_the_radar", evidenceIds: [e], comparator: "WITHIN_CALL" });
        return { key: ref, rank: i + 1, label: name, sublabel: null, ref, tagRef: null, type: key, cells: [v(fit)], flags: i === 1 && key !== "person" ? ["UTR" as const] : [], explain: [] };
      }),
    }));
    hood = t.dataset("Ranked", "Cultural neighbourhood · Wildcomb Honey", { columns: [{ key: "fit", label: "Fit", unit: "pct", comparator: "WITHIN_CALL" }], groups, caption: "Top results per creator kind; scores compare only within a kind." }, [e], ["pct.within_call", "xdom.under_the_radar"]);
  });
  run.tool({ id: "tool-2", tool: "rank_candidates", phase: "wave1", step: 2, args: { candidates: ["R5", "R6", "R7"], signal: ["R1"] }, estimate: 1 }, (t) => {
    const artists = lists[1]?.[2] ?? [];
    const e = t.evidence("Artists scored on one scale against Wildcomb Honey's audience", "3 artists in one request", [t.call("/v2/insights", "urn:entity:artist", { "signal.interests.entities": "R1", "filter.results.entities": "R5,R6,R7" }, 3)]);
    artists.forEach(([name, fit], i) => {
      ids[`art${i}`] = t.metric({ key: "rank.fit", label: `fit of ${name} with Wildcomb Honey's audience`, subjectRefs: [rid(i + 5)], value: fit, display: `${f2(fit)} · ${i + 1} of 3`, unit: "pct", formulaId: "pct.within_call", evidenceIds: [e], comparator: "WITHIN_CALL" });
    });
    scored = t.dataset(
      "Ranked",
      "Ranked · Wildcomb Honey audience (artists)",
      {
        columns: [
          { key: "fit", label: "FIT", unit: "pct", comparator: "WITHIN_CALL" },
          { key: "popularity", label: "Popularity", unit: "popularity", comparator: null },
        ],
        groups: [{ key: "artists", label: "Artists", rows: artists.map(([name, fit, pop], i) => ({ key: rid(i + 5), rank: i + 1, label: name, sublabel: null, ref: rid(i + 5), tagRef: null, type: "artist" as const, cells: [v(fit), v(pop)], flags: [], explain: [] })) }],
        caption: "FIT is the within-call percentile among the 3 artists scored.",
      },
      [e],
      ["pct.within_call", "popularity"],
    );
  });
  return run.finish({
    names: ids,
    headline: "Paper Lanterns, Ines Calder and Field Notes Radio fit Wildcomb Honey's audience best",
    tag: "Clear picks per kind",
    signal: "mixed",
    thesis: "Paper Lanterns leads the artists at {{art0}}; Field Notes Radio leads the podcasts at {{fitpodcast}}. Scores compare only within a kind.",
    exhibits: [
      { dataset: () => hood, title: "One clear pick in each kind of creator", caption: "Top results per kind by fit." },
      { dataset: () => scored, title: "Paper Lanterns leads the artists", caption: "Artists scored in one request." },
    ],
    arguments: [
      { section: "opportunity", fact: "Paper Lanterns scores {{art0}}.", read: "The best artist fit of the three scored.", strength: "STRONG" },
      { section: "opportunity", fact: "Small Batch Hour is an under-the-radar pick ({{utrpodcast}}).", read: "A smaller show with a close fit.", strength: "MODERATE" },
      { section: "audience", fact: "Ines Calder fits at {{fitperson}}.", read: "A public figure the audience already likes.", strength: "MODERATE" },
    ],
    bearCase: ["Fit is shared taste, not reach, fees or availability; The Quiet Orchard scores {{art2}}."],
    recommendations: [{ action: "Shortlist Paper Lanterns and Field Notes Radio and ask for their media kits.", priority: "now" }],
    nextMoves: [
      { label: "Sponsor fit", question: "Which brands fit a Paper Lanterns sponsorship?" },
      { label: "Audience", question: "Who is the Wildcomb Honey customer?" },
      { label: "Collaborations", question: "Which brands would make a credible collaboration with Wildcomb Honey?" },
    ],
    limitations: ["Public figures only; scores compare only within one kind of creator."],
  });
}

function launchTest(): RunEvent[] {
  const q = "Ember & Salt is planning a premium hot-sauce line. Which partners and podcasts fit first, and what price should it sell at?";
  const intent = intentOf("launch_test", [brand("Ember & Salt")], {}, { concepts: ["premium hot sauce"], concept_description: "a premium hot-sauce line" }, "PREMIUM HOT SAUCE LNCH");
  // D41: the price part is not covered; the rest is read as a launch test.
  const run = new RunBuilder("dev-launch-test", q, { ...intent, read_as: { nearest: true, not_covered: ["pricing"] } });
  const ids: Record<string, MetricId> = {};
  let verdicts = "" as DatasetId;
  let hood = "" as DatasetId;
  let fin = "" as DatasetId;
  const analogs: [string, number | null, "KEEP" | "VETO" | null][] = [
    ["Red Mesa Pantry", 0.06, "KEEP"],
    ["Smokehouse Supply Co.", 0.03, "KEEP"],
    ["Coastline Chili Works", 0.01, "KEEP"],
    ["Big Flame Foods", -0.11, "VETO"],
    ["Fiesta Snack Corp", -0.08, "VETO"],
    ["Tango Chips", null, null],
  ];
  const adds: [string, number][] = [
    ["Coalfire Provisions", 4],
    ["Pepperhouse Market", 9],
  ];
  run.start([exact("Ember & Salt", "brand", "R1"), ...analogs.map(([name], i) => exact(name, "brand", rid(i + 2), "peer"))], {
    restated: "Does a premium hot-sauce line have an audience, and which brands does it resemble?",
    hypotheses: [
      { statement: "Mass snack brands are good analogs.", expectation: "Big Flame Foods is kept.", tool: "concept_vector", verdict: "REFUTED", metrics: () => [ids.v3 as MetricId], note: "Big Flame Foods falls {{v3}} below the bar." },
    ],
    steps: [
      { tool: "find_tags", purpose: "Taste tags for a premium hot sauce." },
      { tool: "concept_vector", purpose: "Check the AI's analog brands against the concept." },
      { tool: "cross_domain", purpose: "Podcasts and music the concept's audience likes." },
      { tool: "company_financials", purpose: "Ember & Salt's reported financials." },
    ],
  });
  run.tool({ id: "scan-1", tool: "find_tags", phase: "scan", args: { query: "premium hot sauce" }, estimate: 1 }, (t) => {
    t.evidence("Taste tags for the concept", "3 tags matched", [t.call("/v2/tags", null, { "filter.query": "hot sauce", take: "10" }, 10, "hit")]);
  });
  run.tool({ id: "tool-2", tool: "concept_vector", phase: "wave1", step: 2, args: { concept_tags: ["T1", "T2"], type: "brand", analogs: analogs.map((_, i) => rid(i + 2)) }, estimate: 2 }, (t) => {
    const e = t.evidence("The concept's top 50 brands, and the analogs scored in one request with the 50th result", "50 open results, 6 analogs + anchor", [
      t.call("/v2/insights", "urn:entity:brand", { "signal.interests.tags": "T1,T2", take: "50" }, 50),
      t.call("/v2/insights", "urn:entity:brand", { "signal.interests.tags": "T1,T2", "filter.results.entities": "R2,R3,R4,R5,R6,R7,R8" }, 7),
    ]);
    analogs.forEach(([name, gap, verdict], i) => {
      if (verdict === null) return;
      ids[`v${i}`] = t.metric({
        key: "cnpt.verdict",
        label: `${name} against the 50th brand for premium hot sauce (same Qloo call)`,
        subjectRefs: [rid(i + 2), "T1", "T2"],
        value: gap,
        display: `${signed(gap ?? 0)} · ${verdict === "KEEP" ? "kept" : "vetoed"}`,
        unit: "delta",
        formulaId: "cnpt.verdict",
        evidenceIds: [e],
        comparator: "WITHIN_CALL",
      });
    });
    ids.precision = t.metric({ key: "cnpt.precision", label: "share of your brand analogs the concept's taste keeps (premium hot sauce)", subjectRefs: ["T1", "T2"], value: 0.6, display: "3 of 5 kept · 60%", unit: "pct", formulaId: "cnpt.precision", evidenceIds: [e], comparator: "WITHIN_CALL" });
    t.finding("ANALOG_VETOED", "Two of the AI's analogs score below the concept's 50th result.", [ids.v3 as MetricId, ids.v4 as MetricId], { tool: "rank_candidates", reason: "Score the brands the data found instead." });
    const openRank = [12, 27, 44, null, null, null];
    const said = { KEEP: "kept: scores at or above the concept's 50th result", VETO: "vetoed: scores below the concept's 50th result" } as const;
    const analogRows = analogs.map(([name, , verdict], i) => ({
      key: `analog-${i + 1}`,
      rank: null,
      label: name,
      sublabel: verdict === null ? "not scored: tied at the floor of its row" : said[verdict],
      ref: rid(i + 2),
      tagRef: null,
      type: "brand" as const,
      cells: [openRank[i] ? v(openRank[i] as number) : { value: null, reason: "not_measured" as const }, v(0.3 + i * 0.08)],
      flags: verdict === null ? [] : [verdict],
      explain: [],
    }));
    const addRows = adds.map(([name, rank], i) => ({
      key: `add-${i + 1}`,
      rank,
      label: name,
      sublabel: `added: #${rank} for the concept, not among your analogs`,
      ref: null,
      tagRef: null,
      type: "brand" as const,
      cells: [v(rank), v(0.22 + i * 0.1)],
      flags: ["ADD" as const],
      explain: [],
    }));
    verdicts = t.dataset(
      "Ranked",
      "Concept check · premium hot sauce",
      {
        columns: [
          { key: "open_rank", label: "Rank in the concept's top 50", unit: "rank", comparator: null },
          { key: "popularity", label: "Popularity", unit: "popularity", comparator: null },
        ],
        groups: [
          { key: "analogs", label: "Your analogs", rows: analogRows },
          { key: "adds", label: "What Qloo adds for the concept", rows: addRows },
        ],
        caption: "KEEP: the concept's taste scores the analog at least as high as its 50th result, in the same Qloo call; VETO: lower. Not scored is never a VETO.",
      },
      [e],
      ["cnpt.s50", "cnpt.verdict", "cnpt.precision", "popularity"],
    );
  });
  run.tool({ id: "tool-3", tool: "cross_domain", phase: "wave1", step: 3, args: { seeds: [], seed_tags: ["T1", "T2"], domains: ["podcast", "artist"], popularity_max: 0.8 }, estimate: 2 }, (t) => {
    const e = t.evidence("Podcasts and music the concept's audience likes", "2 domains, 30 results", [
      t.call("/v2/insights", "urn:entity:podcast", { "signal.interests.tags": "T1,T2", take: "15" }, 15),
      t.call("/v2/insights", "urn:entity:artist", { "signal.interests.tags": "T1,T2", take: "15" }, 15),
    ]);
    ids.pod = t.metric({ key: "xdom.under_the_radar", label: "Podcasts · under-the-radar pick", subjectRefs: ["R20"], value: 0.52, display: "0.52 · fit 0.89 − popularity 0.37", unit: "score", formulaId: "xdom.under_the_radar", evidenceIds: [e], comparator: "WITHIN_CALL" });
    const group = (key: "podcast" | "artist", label: string, names: string[], base: number) => ({
      key,
      label,
      rows: names.map((name, i) => ({ key: rid(base + i), rank: i + 1, label: name, sublabel: null, ref: rid(base + i), tagRef: null, type: key, cells: [v(0.9 - i * 0.04)], flags: i === 0 && key === "podcast" ? ["UTR" as const] : [], explain: [] })),
    });
    hood = t.dataset(
      "Ranked",
      "Cultural neighbourhood · premium hot sauce",
      {
        columns: [{ key: "fit", label: "Fit", unit: "pct", comparator: "WITHIN_CALL" }],
        groups: [group("podcast", "Podcasts", ["The Heat Index Show", "Kitchen Table Talks", "Smoke & Fire Radio"], 20), group("artist", "Music · artists", ["Copper Saints", "The Dry Creek Band", "Lola Vance"], 30)],
        caption: "Top results per domain for the concept's tags.",
      },
      [e],
      ["pct.within_call", "xdom.under_the_radar"],
    );
  });
  run.tool({ id: "tool-4", tool: "company_financials", phase: "wave1", step: 4, args: { brand: "R1" }, estimate: 0 }, (t) => {
    const calls = [
      t.publicCall("/files/company_tickers.json", "/files/company_tickers.json", {}, "mock-sec-tickers", "hit"),
      t.publicCall("/api/xbrl/companyfacts", "/api/xbrl/companyfacts/CIK0009990001.json", {}, "mock-cik-0009990001"),
    ];
    const e = t.evidence("Ember & Salt Holdings reported financials (SEC 10-K and 10-Q)", "3 fiscal years, 1 quarter", calls);
    const period = "FY2025, 10-K filed 2026-02-19";
    ids.revenue = t.metric({ key: "fin.revenue", label: "Ember & Salt Holdings revenue, FY2025 (company-level, as reported)", subjectRefs: ["R1"], value: 1_412_000_000, display: "$1.4B", unit: "usd", formulaId: "fin.revenue", evidenceIds: [e], badge: "MEASURED", period });
    ids.yoy = t.metric({ key: "fin.yoy", label: "Ember & Salt Holdings revenue change, FY2025 vs FY2024", subjectRefs: ["R1"], value: 0.062, display: "+6.2%", unit: "pct", formulaId: "fin.yoy", evidenceIds: [e], badge: "DERIVED", period });
    const years: [string, string, number, number, number, number | null][] = [
      ["FY2023", "10-K filed 2024-02-21", 1_241_000_000, 0.381, 0.112, null],
      ["FY2024", "10-K filed 2025-02-20", 1_329_000_000, 0.386, 0.118, 0.071],
      ["FY2025", "10-K filed 2026-02-19", 1_412_000_000, 0.392, 0.121, 0.062],
      ["Q2 2026", "10-Q filed 2026-08-06", 368_000_000, 0.397, 0.126, 0.048],
    ];
    fin = t.dataset(
      "Ranked",
      "Reported financials · Ember & Salt Holdings",
      {
        columns: [
          { key: "revenue", label: "Revenue", unit: "usd", comparator: null },
          { key: "gross_margin", label: "Gross margin", unit: "pct", comparator: null },
          { key: "operating_margin", label: "Operating margin", unit: "pct", comparator: null },
          { key: "yoy", label: "Revenue vs a year earlier", unit: "pct", comparator: null },
        ],
        groups: [
          {
            key: "periods",
            label: "Periods",
            rows: years.map(([label, filed, rev, gm, om, yoy], i) => ({
              key: label,
              rank: i + 1,
              label,
              sublabel: filed,
              ref: null,
              tagRef: null,
              type: null,
              cells: [v(rev), v(gm), v(om), yoy === null ? { value: null, reason: "not_reported" as const } : v(yoy)],
              flags: [],
              explain: [],
            })),
          },
        ],
        caption: "Company-level figures as reported in SEC filings; the latest filing per period is kept.",
      },
      [e],
      ["fin.revenue", "fin.margin", "fin.yoy"],
    );
  });
  return run.finish({
    names: ids,
    headline: "The data backs three of the AI's five analog brands for a premium hot sauce, and drops the mass snack brands",
    tag: "Partly backed",
    signal: "mixed",
    thesis: "{{precision}} of the scored analogs are kept: Red Mesa Pantry sits {{v0}} above the concept's 50th result, while Big Flame Foods falls {{v3}} below it.",
    exhibits: [
      { dataset: () => verdicts, title: "Small-batch pantry brands are kept; mass snack brands are dropped", caption: "Each AI analog against the concept's 50th result, in one request." },
      { dataset: () => hood, title: "Food podcasts and roots music lead the concept's audience", caption: "Top results per domain." },
      { dataset: () => fin, title: "Ember & Salt Holdings, as reported", caption: "SEC filings, company-level ({{PERIOD:revenue}})." },
    ],
    arguments: [
      { section: "opportunity", fact: "Red Mesa Pantry sits {{v0}} above the bar.", read: "A small-batch brand the concept's audience shares.", strength: "STRONG" },
      { section: "risk", fact: "Big Flame Foods falls {{v3}} below the bar.", read: "Mass snack brands are the wrong comparison.", strength: "MODERATE" },
      { section: "opportunity", fact: "The Heat Index Show is an under-the-radar podcast pick ({{pod}}).", read: "A launch partner with a matching audience.", strength: "MODERATE" },
    ],
    bearCase: ["Company revenue grew {{yoy}} ({{PERIOD:yoy}}); that is a company-level figure and says nothing about a new hot-sauce line."],
    penalties: [{ rule: "read_as_nearest_job", label: "Read as the closest job", count: 1, points: -5 }],
    readAs: "The question also asks about pricing, which the data does not cover; the rest is answered as a launch test.",
    recommendations: [
      { action: "Benchmark the line against Red Mesa Pantry and Coalfire Provisions, not mass snack brands.", priority: "now" },
      { action: "Pitch The Heat Index Show for a launch segment.", priority: "next" },
    ],
    nextMoves: [
      { label: "Markets", question: "Which cities should Ember & Salt launch a premium hot sauce in first?" },
      { label: "Collaborations", question: "Which brands would make a credible collaboration with Ember & Salt?" },
      { label: "Competitors", question: "Who does Red Mesa Pantry really compete with?" },
    ],
  });
}

function cityCompare(): RunEvent[] {
  const q = "Austin vs Nashville vs Denver for a natural-wine bar: which city fits best?";
  const run = new RunBuilder(
    "dev-city-compare",
    q,
    intentOf("city_compare", [], { cities: ["austin", "nashville", "denver"] }, { concepts: ["natural-wine bar"] }, "AUSTIN VS NASHVILLE VS DENVER CITY NATURAL-WINE BAR"),
  );
  const ids: Record<string, MetricId> = {};
  const prints: DatasetId[] = [];
  let econ = "" as DatasetId;
  const cities: ["austin" | "nashville" | "denver", string, [string, number, boolean][]][] = [
    ["austin", "Austin", [["Natural wine", 34, true], ["Food truck", 27, false], ["Live music venue", 22, false], ["Steakhouse", -14, false]]],
    ["nashville", "Nashville", [["Honky-tonk", 41, false], ["Hot chicken", 30, false], ["Wine bar", 12, false], ["Vegan", -18, false]]],
    ["denver", "Denver", [["Brewery", 38, false], ["Natural wine", 21, true], ["Climbing gym", 19, false], ["Seafood", -16, false]]],
  ];
  run.start([], {
    restated: "How does each city's taste differ from the other map cities, and where does a natural-wine bar fit?",
    hypotheses: [
      { statement: "Austin leans furthest toward natural wine.", expectation: "Natural wine is Austin's top gain.", tool: "block_dna", verdict: "CONFIRMED", metrics: () => [ids.top_austin as MetricId], note: "Natural wine gains {{top_austin}} places in Austin." },
    ],
    steps: cities.map(([, label]) => ({ tool: "block_dna" as const, purpose: `${label}'s taste against the other map cities.` })),
  });
  cities.forEach(([id, label, tags], c) => {
    run.tool({ id: `scan-${c + 1}`, tool: "block_dna", phase: "scan", args: { area: { kind: "city", market: id }, include_brands: false }, estimate: 0 }, (t) => {
      const e = t.evidence(`Taste of ${label} against the other 12 map cities`, "50 city tags against the pooled lists of 12 map cities", [
        t.call("/v2/insights", "urn:tag", { "signal.location": `${label} locality`, take: "50" }, 50, "hit"),
      ]);
      const [topLabel, topDelta, topNew] = tags[0] as [string, number, boolean];
      ids[`top_${id}`] = t.metric({
        key: "block.rank_delta",
        label: `rank gain vs the other 12 map cities: ${topLabel} (WHAT tag, ${label})`,
        subjectRefs: [`T${c + 40}`, id],
        value: topDelta,
        display: `+${topDelta}${topNew ? " · NEW" : ""}`,
        unit: "delta",
        formulaId: "block.rank_delta",
        evidenceIds: [e],
        comparator: "BASELINE",
        n: 50,
      });
      prints.push(
        t.dataset(
          "Bars",
          `Block DNA · ${label} vs the other 12 map cities`,
          {
            mode: "diverging",
            comparator: "BASELINE",
            valueLabel: "Tag rank gain vs the other map cities",
            unit: "delta",
            series: [axis(id, label)],
            groups: [{ key: "WHAT", label: "What", family: "WHAT", bars: tags.map(([name, delta, isNew], i) => ({ key: `${id}-${i}`, label: name, tagRef: null, values: [v(delta)], isNew, ranks: null })) }],
            method: "QUERY",
            domain: null,
            caption: "Rank gain is the panel rank minus the city rank; the panel ranks each tag by its average rank in the other 12 map cities' top-50 lists.",
          },
          [e],
          ["block.rank_delta", "block.new_tag", "block.panel_rank"],
        ),
      );
    });
  });
  run.tool({ id: "tool-4", tool: "area_economics", phase: "wave1", step: 4, args: { metro: "austin", areas: ["holly"] }, estimate: 0 }, (t) => {
    econ = areaEconomics(
      t,
      [
        { metro: "austin", query: { get: "B01003_001E,B19013_001E", for: "tract:*", in: "state:48 county:453" } },
        { metro: "nashville", query: { get: "B01003_001E,B19013_001E", for: "zip code tabulation area:37206,37216" } },
        { metro: "denver", query: { get: "B01003_001E,B19013_001E", for: "zip code tabulation area:80205,80211" } },
      ],
      [
        { key: "austin", label: "Austin", sublabel: "all mapped areas", population: 961800, age: 34.1, income: 86200, home: 0.21 },
        { key: "nashville", label: "Nashville", sublabel: "all mapped areas", population: 702100, age: 34.2, income: 66800, home: 0.14 },
        { key: "denver", label: "Denver", sublabel: "all mapped areas", population: 713300, age: 35.0, income: 88900, home: 0.2 },
      ],
      "Area economics · Austin, Nashville and Denver",
      ids,
      (key) => `inc_${key}`,
    );
  });
  return run.finish({
    names: ids,
    headline: "Austin leans furthest toward natural wine of the three cities",
    tag: "Austin leads",
    signal: "mixed",
    thesis: "Natural wine gains {{top_austin}} places in Austin and {{top_denver}} places for Denver's top taste, brewing; Nashville's top gain is honky-tonks ({{top_nashville}}).",
    exhibits: [
      { dataset: () => prints[0] as DatasetId, title: "Austin leans toward natural wine and food trucks", caption: "Tags Austin ranks higher than the other map cities." },
      { dataset: () => prints[1] as DatasetId, title: "Nashville leans toward honky-tonks", caption: "Tags Nashville ranks higher than the other map cities." },
      { dataset: () => prints[2] as DatasetId, title: "Denver leans toward breweries", caption: "Tags Denver ranks higher than the other map cities." },
      { dataset: () => econ, title: "Residents of the three cities", caption: "Census estimates ({{PERIOD:inc_austin}}), not customers." },
    ],
    arguments: [
      { section: "geography", fact: "Natural wine gains {{top_austin}} places in Austin.", read: "The concept's core taste is already strong there.", strength: "STRONG" },
      { section: "geography", fact: "Denver's top gain is brewing ({{top_denver}}).", read: "A beer city; natural wine is second.", strength: "MODERATE" },
      { section: "audience", fact: "Median household income in Austin is {{inc_austin}} ({{PERIOD:inc_austin}}).", read: "Residents earn more than in Nashville.", strength: "MODERATE" },
    ],
    bearCase: ["A city's taste against the other map cities says nothing about rents or competition; Nashville's honky-tonk lead ({{top_nashville}}) may hide wine bars in some areas."],
    recommendations: [
      { action: "Ask where in Austin a natural-wine bar should open.", priority: "now" },
      { action: "Visit two Austin areas on a weekend night before choosing.", priority: "next" },
    ],
    nextMoves: [
      { label: "Where to open", question: "Where in Austin should a natural-wine bar open?" },
      { label: "Neighbourhood", question: "What does Holly in Austin already have too much of?" },
      { label: "Find a twin", question: "Which Denver neighbourhood is the twin of Holly in Austin?" },
    ],
    limitations: ["No named brand was given, so share of taste across the cities was not measured."],
  });
}

export const JOB_RUNS: Readonly<Record<Job, () => RunEvent[]>> = {
  brand_health: brandHealth,
  head_to_head: headToHead,
  site_selection: siteSelection,
  area_profile: () => tenantMix("area_profile"),
  tenant_mix: () => tenantMix("tenant_mix"),
  sponsorship,
  market_selection: marketSelection,
  audience_discovery: audienceDiscovery,
  taste_twins: tasteTwins,
  brand_collab: brandCollab,
  creator_fit: creatorFit,
  launch_test: launchTest,
  city_compare: cityCompare,
};

const built = new Map<Job, readonly RunEvent[]>();

/** A job's synthetic run, run.created to run.end, built once. Shared: never mutate it. */
export function jobRunEvents(job: Job): readonly RunEvent[] {
  let events = built.get(job);
  if (!events) {
    events = Object.freeze(JOB_RUNS[job]());
    built.set(job, events);
  }
  return events;
}
