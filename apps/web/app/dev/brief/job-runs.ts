import {
  DEFAULT_RUN_LIMITS,
  FIXED_DISCLAIMERS,
  JOB_PILLAR,
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
}

class RunBuilder {
  private readonly inputs: EventInput[] = [];
  private counts = { q: 0, e: 0, m: 0, d: 0, f: 0 };
  readonly metrics = new Map<MetricId, Metric>();
  readonly datasets = new Map<DatasetId, DatasetEnvelope>();
  readonly evidence = new Map<EvidenceId, Evidence>();
  private readonly calls = new Map<string, { endpoint: QlooPath; filterType: string | null; params: Record<string, string>; requestId: string; cache: CacheStatus }>();
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

  addEvidence(skill: SkillId, purpose: string, summary: string, callIds: string[], flags: Flag[]): EvidenceId {
    const id = `E${++this.counts.e}` as EvidenceId;
    const calls = callIds.map((c) => this.calls.get(c)).filter((c) => c !== undefined);
    const evidence: Evidence = {
      id,
      skill,
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
    const calls = evidenceIds.flatMap((id) => this.evidence.get(id)?.qlooCallIds ?? []).flatMap((c) => this.calls.get(c) ?? []);
    const first = calls[0];
    if (!first) return "Source: Culture Terminal analysis";
    const filter = first.filterType ? ` (${first.filterType})` : "";
    return `Source: Qloo ${first.endpoint}${filter} · req ${first.requestId.slice(0, 8)}… · fetched 2026-10-21 09:00 UTC · Culture Terminal analysis`;
  }

  finish(given: ReportSpec): RunEvent[] {
    const job = this.intent.job;
    const named = (text: string) =>
      text.replace(/\{\{([a-z]\w*)\}\}/gi, (token, name: string) => {
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
    geo: { metro: null, area: null, unsupported_place: null, market: null, ...geo },
    constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [], ...constraints },
    safety: { allowed: true, category: null, reframe: null },
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
export const JOB_RUNS: Readonly<Record<Job, () => RunEvent[]>> = {
  brand_health: brandHealth,
  head_to_head: headToHead,
  site_selection: siteSelection,
  area_profile: () => tenantMix("area_profile"),
  tenant_mix: () => tenantMix("tenant_mix"),
  sponsorship,
  market_selection: marketSelection,
  audience_discovery: audienceDiscovery,
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
