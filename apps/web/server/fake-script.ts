import "server-only";
import {
  DEFAULT_RUN_LIMITS,
  FIXED_DISCLAIMERS,
  type CacheStatus,
  type DatasetEnvelope,
  type DatasetId,
  type EventInput,
  type Evidence,
  type EvidenceId,
  type Finding,
  type Intent,
  type Metric,
  type MetricId,
  type Phase,
  type QlooPath,
  type Report,
  type ReportDraft,
  type ResolvedMention,
  type SkillId,
  type StepId,
  type SubmitPlanInput,
  type TrendWindow,
  type ValidationIssue,
} from "@ct/contracts";

/**
 * The Foundation fake agent run (PLAN Part 1): a contract-valid brand-health run on invented
 * entities, paced over the run's duration. It exercises every event type the trace rail shows,
 * including an ANALYST PIVOT and a CODE FALLBACK. No Qloo or model call is made, so the usage
 * events report zero LLM spend and the receipt says the data is synthetic.
 */

export const FAKE_QUESTION = "Test run: is the Juniper Cola audience a moat or a niche?";
export const FAKE_MODEL = "fake";

export interface FakeStep {
  /** When to emit, as a fraction of the run's duration (0 ≤ at < 1). run.end is due at 1. */
  at: number;
  input: EventInput;
}

export interface FakeScript {
  steps: FakeStep[];
  report: Report;
}

export interface FakeScriptContext {
  runId: string;
  startedAt: number;
  durationMs: number;
}

const TREND_WINDOW: TrendWindow = { start: "2025-04-07", end: "2025-09-29" };
const SOURCE_LINE = "Source: synthetic test data · Culture Terminal analysis";

const ENTITIES = [
  { ref: "R1", name: "Juniper Cola" },
  { ref: "R2", name: "Kestrel Tonic" },
  { ref: "R3", name: "Halcyon Brew" },
  { ref: "R4", name: "Lumen Sparkling" },
  { ref: "R5", name: "Copperline Kombucha" },
  { ref: "R6", name: "Aurora Footwear" },
] as const;

// Symmetric pair similarities for the substitution map. Juniper Cola (R1) is last in four of the
// five other rows, and its nearest neighbour is outside the category (R6).
const SIMILARITY: readonly (readonly (number | null)[])[] = [
  [null, 0.08, 0.07, 0.1, 0.06, 0.34],
  [0.08, null, 0.52, 0.47, 0.31, 0.09],
  [0.07, 0.52, null, 0.44, 0.38, 0.11],
  [0.1, 0.47, 0.44, null, 0.29, 0.14],
  [0.06, 0.31, 0.38, 0.29, null, 0.1],
  [0.34, 0.09, 0.11, 0.14, 0.1, null],
];

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rank of each value within its row, 1 = highest; null cells stay unranked. */
function rowRanks(row: readonly (number | null)[]): (number | null)[] {
  const scored = row.filter((v): v is number => v !== null).sort((a, b) => b - a);
  return row.map((v) => (v === null ? null : scored.indexOf(v) + 1));
}

interface CallRecord {
  qlooCallId: string;
  requestId: string;
  path: QlooPath;
  query: Record<string, string>;
  cache: CacheStatus;
  at: string;
}

/** Collects events with pacing weights; `total` (from a first pass) turns positions into times. */
class ScriptWriter {
  readonly items: { pos: number; input: EventInput }[] = [];
  pos = 0;
  private calls = 0;
  readonly qloo = { network: 0, cached: 0, reused: 0 };
  readonly endpoints = new Map<string, { path: QlooPath; filterType: string | null; calls: number }>();
  readonly evidenceTimes: string[] = [];

  constructor(
    private readonly ctx: FakeScriptContext,
    private readonly total: number | null,
  ) {}

  /** The wall-clock time at the current position, as an ISO string. */
  time(): string {
    const fraction = this.total ? this.pos / this.total : 0;
    return new Date(this.ctx.startedAt + fraction * this.ctx.durationMs).toISOString();
  }

  elapsedMs(): number {
    return Math.round((this.total ? this.pos / this.total : 0) * this.ctx.durationMs);
  }

  push(weight: number, input: EventInput): void {
    this.pos += weight;
    this.items.push({ pos: this.pos, input });
  }

  note(weight: number, text: string): void {
    this.push(weight, { type: "note", text });
  }

  call(
    weight: number,
    toolCallId: string | null,
    path: QlooPath,
    filterType: string | null,
    query: Record<string, string>,
    cache: CacheStatus,
    rows: number,
  ): CallRecord {
    this.calls += 1;
    const n = this.calls;
    const network = cache === "miss";
    if (network) this.qloo.network += 1;
    else if (cache === "reused") this.qloo.reused += 1;
    else this.qloo.cached += 1;
    const key = `${path} ${filterType ?? ""}`;
    const endpoint = this.endpoints.get(key) ?? { path, filterType, calls: 0 };
    endpoint.calls += 1;
    this.endpoints.set(key, endpoint);

    const record: CallRecord = {
      qlooCallId: `q${n}`,
      requestId: `synthetic-req-${n}`,
      path,
      query: filterType ? { "filter.type": filterType, ...query } : query,
      cache,
      at: "",
    };
    this.push(weight, {
      type: "qloo",
      qlooCallId: record.qlooCallId,
      toolCallId,
      endpoint: path,
      filterType,
      paramsRedacted: record.query,
      cache,
      ms: network ? 140 + ((n * 37) % 260) : 2 + (n % 5),
      requestId: record.requestId,
      status: 200,
      rows,
      cacheAgeMs: network ? null : 3_600_000 * (1 + (n % 6)),
      originRunId: cache === "reused" ? "fake-earlier-run" : null,
      error: null,
    });
    record.at = this.time();
    return record;
  }

  evidence(
    weight: number,
    id: EvidenceId,
    skill: SkillId,
    purpose: string,
    calls: CallRecord[],
    summary: string,
    options: { status?: Evidence["status"]; flags?: Evidence["flags"] } = {},
  ): Evidence {
    const evidence: Evidence = {
      id,
      skill,
      purpose,
      status: options.status ?? "ok",
      qlooCallIds: calls.map((c) => c.qlooCallId),
      requestIds: calls.map((c) => c.requestId),
      cached: calls.every((c) => c.cache !== "miss"),
      fetchedAt: calls[0]?.at ?? this.time(),
      provenance: { requests: calls.map((c) => ({ method: "GET" as const, path: c.path, query: c.query })) },
      summary,
      flags: options.flags ?? [],
    };
    this.evidenceTimes.push(evidence.fetchedAt);
    this.push(weight, { type: "evidence", evidence });
    return evidence;
  }

  metric(weight: number, metric: Metric): void {
    this.push(weight, { type: "metric", metric });
  }

  finding(weight: number, finding: Finding, toolCallId: string | null): void {
    this.push(weight, { type: "finding", finding, toolCallId });
  }

  dataset(weight: number, dataset: DatasetEnvelope): void {
    this.push(weight, {
      type: "dataset.ready",
      datasetId: dataset.id,
      kind: dataset.kind,
      title: dataset.title,
      bytes: JSON.stringify(dataset).length,
      inline: dataset,
    });
  }

  toolStart(
    weight: number,
    toolCallId: string,
    tool: SkillId,
    phase: Phase,
    args: Record<string, unknown>,
    stepId: StepId | null,
    triggerFindingId: Finding["id"] | null,
    estimatedCalls: number,
  ): void {
    this.push(weight, {
      type: "tool.start",
      toolCallId,
      tool,
      phase,
      args: JSON.parse(JSON.stringify(args)),
      stepId,
      triggerFindingId,
      estimatedCalls,
    });
  }

  toolEnd(
    weight: number,
    toolCallId: string,
    tool: SkillId,
    ms: number,
    ids: {
      evidenceIds?: EvidenceId[];
      metricIds?: MetricId[];
      datasetIds?: DatasetId[];
      findingIds?: Finding["id"][];
      flags?: Evidence["flags"];
      status?: Evidence["status"];
    },
  ): void {
    this.push(weight, {
      type: "tool.end",
      toolCallId,
      tool,
      ok: true,
      status: ids.status ?? "ok",
      ms,
      evidenceIds: ids.evidenceIds ?? [],
      metricIds: ids.metricIds ?? [],
      datasetIds: ids.datasetIds ?? [],
      findingIds: ids.findingIds ?? [],
      flags: ids.flags ?? [],
      error: null,
    });
  }

  usage(weight: number): void {
    this.push(weight, {
      type: "usage",
      llmUsd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      qloo: { ...this.qloo },
      elapsedMs: this.elapsedMs(),
    });
  }
}

const metric = (
  m: Omit<Metric, "reason" | "n" | "conf" | "comparator" | "window" | "badge"> &
    Partial<Pick<Metric, "reason" | "n" | "conf" | "comparator" | "window" | "badge">>,
): Metric => ({
  badge: "MEASURED",
  reason: null,
  n: null,
  conf: null,
  comparator: null,
  window: null,
  ...m,
});

const axis = (key: string, label: string, ref: `R${number}` | null, group: string | null = null) => ({
  key,
  label,
  ref,
  group,
});

function substitutionMap(): DatasetEnvelope {
  const items = ENTITIES.map((e) => axis(e.ref, e.name, e.ref));
  const cells = SIMILARITY.map((row) => {
    const ranks = rowRanks(row);
    return row.map((value, j) =>
      value === null
        ? { value: null, reason: "self" as const, rank: null }
        : { value, reason: null, rank: ranks[j] ?? null },
    );
  });
  const hub = ENTITIES.map((_, j) => {
    const column = SIMILARITY.map((row) => row[j]).filter((v): v is number => v !== null && v !== undefined);
    return { value: round2(column.reduce((a, b) => a + b, 0) / column.length), reason: null };
  });
  return {
    id: "D1",
    kind: "Matrix",
    title: "Substitution Map",
    evidenceIds: ["E4"],
    formulaIds: ["similarity", "hub_score"],
    payload: {
      mode: "similarity",
      valueLabel: "pair similarity",
      unit: "similarity",
      comparator: "WITHIN_CALL",
      rows: items,
      cols: items,
      cells,
      margin: { label: "Hub", values: hub },
      targetKey: "R1",
      annotations: [{ text: "Taste island: last in 4 of 5 rows", rowKey: null, colKey: "R1" }],
    },
  };
}

function shareOfTaste(): DatasetEnvelope {
  const rows = [
    axis("24_and_younger", "≤24", null, "AGE"),
    axis("25_to_29", "25–29", null, "AGE"),
    axis("55_and_older", "55+", null, "AGE"),
  ];
  const cols = ENTITIES.slice(0, 3).map((e) => axis(e.ref, e.name, e.ref));
  const values = [
    [0.94, 0.61, 0.48],
    [0.88, 0.7, 0.52],
    [0.21, 0.83, 0.77],
  ];
  return {
    id: "D2",
    kind: "Matrix",
    title: "Share of Taste by Age",
    evidenceIds: ["E5"],
    formulaIds: ["within_call_pct", "youth_tilt"],
    payload: {
      mode: "share",
      valueLabel: "within-call percentile",
      unit: "pct",
      comparator: "WITHIN_CALL",
      rows,
      cols,
      cells: values.map((row) => {
        const ranks = rowRanks(row);
        return row.map((value, j) => ({ value, reason: null, rank: ranks[j] ?? null }));
      }),
      margin: null,
      targetKey: "R1",
      annotations: [{ text: "Generational split", rowKey: null, colKey: "R1" }],
    },
  };
}

function audienceDna(): DatasetEnvelope {
  const bar = (key: string, label: string, value: number) => ({
    key,
    label,
    tagRef: null,
    values: [{ value, reason: null }],
    isNew: false,
    ranks: null,
  });
  return {
    id: "D3",
    kind: "Bars",
    title: "Audience DNA",
    evidenceIds: ["E6"],
    formulaIds: ["demographic_index"],
    payload: {
      mode: "diverging",
      comparator: "BASELINE",
      valueLabel: "index vs baseline",
      unit: "index",
      series: [axis("R1", "Juniper Cola", "R1")],
      groups: [
        {
          key: "age",
          label: "Age",
          family: null,
          bars: [
            bar("24_and_younger", "≤24", 38),
            bar("25_to_29", "25–29", 22),
            bar("30_to_34", "30–34", 6),
            bar("35_to_44", "35–44", -4),
            bar("45_to_54", "45–54", -19),
            bar("55_and_older", "55+", -36),
          ],
        },
        { key: "gender", label: "Gender", family: null, bars: [bar("male", "Male", -3), bar("female", "Female", 3)] },
      ],
      method: null,
      domain: { min: -50, max: 50 },
      caption: "Index minus 100: positive means over-indexed against the baseline.",
    },
  };
}

const INTENT: Intent = {
  pillar: "investment",
  job: "brand_health",
  mentions: [
    { text: "Juniper Cola", entity_type: "brand", role: "primary", public_figure: false },
    { text: "Kestrel Tonic", entity_type: "brand", role: "peer", public_figure: false },
    { text: "Marlowe Ridge", entity_type: "brand", role: "secondary", public_figure: false },
  ],
  geo: { metro: null, area: null, unsupported_place: null },
  constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [] },
  safety: { allowed: true, category: "financial_advice", reframe: "Juniper Cola taste-signal health" },
  assumptions: ["US geography", "Synthetic test data"],
  mnemonic: "JUNIPER COLA <BRAND> HLTH",
};

const RESOLVED: ResolvedMention[] = [
  {
    mention: "Juniper Cola",
    role: "primary",
    entityType: "brand",
    match: "exact",
    ref: "R1",
    name: "Juniper Cola",
    popularity: 0.62,
    disambiguation: null,
    alternatives: [],
    source: "gate",
  },
  {
    mention: "Kestrel Tonic",
    role: "peer",
    entityType: "brand",
    match: "exact",
    ref: "R2",
    name: "Kestrel Tonic",
    popularity: 0.71,
    disambiguation: null,
    alternatives: [],
    source: "gate",
  },
  {
    mention: "Marlowe Ridge",
    role: "secondary",
    entityType: "brand",
    match: "inexact",
    ref: null,
    name: null,
    popularity: null,
    disambiguation: null,
    alternatives: [{ name: "Marlowe Ridge Cellars", disambiguation: "Winery", popularity: 0.22 }],
    source: "gate",
  },
];

const PLAN: SubmitPlanInput = {
  restated_question: "Is the Juniper Cola audience a defensible moat or a niche?",
  hypotheses: [
    {
      id: "H1",
      statement: "Juniper Cola and Kestrel Tonic are near-substitutes.",
      expectation: "Each ranks the other first in its row of the substitution map.",
      test_tool: "peer_landscape",
      metric_hint: "mutual rank of Juniper Cola and Kestrel Tonic",
    },
    {
      id: "H2",
      statement: "The Juniper Cola audience skews young.",
      expectation: "A positive youth tilt against its peers.",
      test_tool: "share_of_taste",
      metric_hint: "youth tilt across age contexts",
    },
    {
      id: "H3",
      statement: "Interest in Juniper Cola is rising.",
      expectation: "A rising trend across the frozen window.",
      test_tool: "momentum",
      metric_hint: "26-week change",
    },
  ],
  steps: [
    { id: "S1", tool: "peer_landscape", purpose: "Map near-substitutes and the hub of the category." },
    { id: "S2", tool: "share_of_taste", purpose: "Compare shares of taste across age groups." },
    { id: "S3", tool: "audience_dna", purpose: "Read age and gender indices against the baseline." },
    { id: "S4", tool: "momentum", purpose: "Check the direction of interest in the frozen window." },
  ],
  assumptions: ["US geography", "Synthetic test data"],
};

const DRAFT: ReportDraft = {
  headline: "Juniper Cola is a taste island with a young core {{M2}}",
  signal: "mixed",
  thesis:
    "Juniper Cola sits apart from its category {{M2}} [E4] and its nearest neighbour is a footwear brand {{M10}} [E9]. Its audience skews young {{M5}} [E5].",
  hypothesis_verdicts: [
    { hypothesis_id: "H1", verdict: "refuted", metric_ids: ["M3"], note: "Juniper Cola is last in {{M3}} rows." },
    { hypothesis_id: "H2", verdict: "confirmed", metric_ids: ["M5"], note: "Youth tilt of {{M5}} against peers." },
    { hypothesis_id: "H3", verdict: "inconclusive", metric_ids: ["M8"], note: "Historical window only {{M8}}." },
  ],
  arguments: [
    {
      id: "A1",
      section: "competition",
      qloo_fact: "Distinctiveness is high {{M2}} and Juniper Cola is last in {{M3}} rows [E4].",
      our_read: "It does not compete head-on with other sodas; its audience is shared with few of them.",
      metric_ids: ["M2", "M3"],
      evidence_ids: ["E4"],
    },
    {
      id: "A2",
      section: "audience",
      qloo_fact: "Youth tilt {{M5}} [E5]; the under-25 index is {{M1}} [E2].",
      our_read: "A young core that the category's leaders do not own.",
      metric_ids: ["M5", "M1"],
      evidence_ids: ["E5", "E2"],
    },
    {
      id: "A3",
      section: "opportunity",
      qloo_fact: "Aurora Footwear is its nearest neighbour {{M10}} [E9], with {{M9}} under-the-radar artists nearby [E8].",
      our_read: "Its cultural home sits outside beverages, which points to cross-category partners.",
      metric_ids: ["M10", "M9"],
      evidence_ids: ["E9", "E8"],
    },
  ],
  exhibits: [
    { dataset_id: "D1", title: "Substitution Map", caption: "Pair similarity within one call." },
    { dataset_id: "D2", title: "Share of Taste by Age", caption: "Within-call percentile per age context." },
    { dataset_id: "D3", title: "Audience DNA", caption: "Indices against the baseline, not shares." },
  ],
  bear_case: [{ text: "A wider peer set could place Juniper Cola closer to its category.", metric_ids: ["M2"] }],
  recommendations: [
    { action: "Test a collaboration with a footwear brand that shares its audience.", priority: "next", argument_ids: ["A3"] },
    { action: "Track the youth tilt across a second window before relying on it.", priority: "later", argument_ids: ["A2"] },
  ],
  next_moves: [
    { label: "Audience", question: "Who is the Juniper Cola audience beyond beverages?" },
    { label: "Markets", question: "Which markets fit Juniper Cola best?" },
  ],
  open_questions: ["Does the gap hold across metros?"],
};

const CHECKER_WARNING: ValidationIssue = {
  rule: "V9",
  action: "warn",
  message: "The thesis is close to its length limit.",
  path: "thesis",
  subjects: [],
};

function compose(w: ScriptWriter, ctx: FakeScriptContext): Report {
  const createdAt = w.time();

  // A: CLERK and the resolution gate.
  w.push(0, {
    type: "run.created",
    question: FAKE_QUESTION,
    mode: "live",
    lane: "public",
    limits: DEFAULT_RUN_LIMITS,
    parentRunId: null,
    model: FAKE_MODEL,
  });
  w.note(2, "Reading the question: a brand-health check on Juniper Cola, with Kestrel Tonic as the named peer.");
  w.push(2, { type: "clerk", intent: INTENT, ms: 870 });
  w.note(2, "Resolving the named brands against exact names only.");
  w.push(2, { type: "resolve", entities: RESOLVED });
  w.note(2, "Marlowe Ridge did not resolve exactly, so it is dropped as a secondary mention.");

  // C: opening scan (code), keyed by the brand_health job.
  w.note(2, "Opening scan: discovering peers, the audience shape and travel taste.");
  w.toolStart(1, "scan_1", "peer_landscape", "scan", { target: "R1", discover: true, k: 6 }, null, null, 2);
  const s1a = w.call(2, "scan_1", "/v2/insights", "urn:entity:brand", { "signal.interests.entities": "R1", take: "20" }, "miss", 20);
  const s1b = w.call(2, "scan_1", "/v2/insights", "urn:entity:brand", { "signal.interests.entities": "R2", take: "20" }, "miss", 20);
  w.evidence(1, "E1", "peer_landscape", "Peer discovery for Juniper Cola", [s1a, s1b], "Four peers discovered across two calls");
  w.toolEnd(1, "scan_1", "peer_landscape", 1840, { evidenceIds: ["E1"] });

  w.toolStart(1, "scan_2", "audience_dna", "scan", { targets: ["R1"] }, null, null, 1);
  const s2 = w.call(2, "scan_2", "/v2/insights", "urn:demographics", { "signal.interests.entities": "R1" }, "hit", 8);
  w.evidence(1, "E2", "audience_dna", "Demographic indices for Juniper Cola", [s2], "Age and gender indices for one brand");
  w.metric(
    1,
    metric({
      id: "M1",
      key: "dna.index_24_and_younger",
      label: "Under-25 index for Juniper Cola",
      subjectRefs: ["R1"],
      value: 1.38,
      display: "138",
      unit: "index",
      formulaId: "demographic_index",
      evidenceIds: ["E2"],
      comparator: "BASELINE",
      conf: 0.7,
    }),
  );
  w.toolEnd(1, "scan_2", "audience_dna", 410, { evidenceIds: ["E2"], metricIds: ["M1"], flags: ["DEMOGRAPHICS_ARE_INDICES"] });

  w.toolStart(1, "scan_3", "destination_affinity", "scan", { target: "R1", take: 50 }, null, null, 1);
  const s3 = w.call(2, "scan_3", "/v2/insights", "urn:entity:destination", { "signal.interests.entities": "R1", take: "50" }, "reused", 50);
  w.evidence(1, "E3", "destination_affinity", "Travel taste of the Juniper Cola audience", [s3], "50 destinations, popularity against fit");
  w.toolEnd(1, "scan_3", "destination_affinity", 95, { evidenceIds: ["E3"] });
  w.usage(1);

  // D: ANALYST turn 1, priors before data, then wave 1.
  w.note(3, "Opening scan done. Writing priors before reading any results.");
  w.note(3, "Prior one: Kestrel Tonic is the obvious substitute. Prior two: the audience is young. Prior three: interest is rising.");
  w.push(3, {
    type: "plan",
    plan: PLAN,
    estimates: [
      { stepId: "S1", calls: 7 },
      { stepId: "S2", calls: 3 },
      { stepId: "S3", calls: 1 },
      { stepId: "S4", calls: 2 },
    ],
  });
  w.note(2, "Starting with the substitution map, since it decides the first prior.");

  w.toolStart(
    1,
    "toolu_fake_01",
    "peer_landscape",
    "wave1",
    { target: "R1", peers: ["R2"], discover: true, k: 6, trigger_finding_id: null, step_id: "S1" },
    "S1",
    null,
    7,
  );
  const subsCalls: ReturnType<ScriptWriter["call"]>[] = [];
  const subsCache: CacheStatus[] = ["hit", "hit", "miss", "miss", "coalesced", "miss", "miss"];
  subsCache.forEach((cache, i) => {
    const seed = ENTITIES[i % ENTITIES.length]?.ref ?? "R1";
    subsCalls.push(
      w.call(2, "toolu_fake_01", "/v2/insights", "urn:entity:brand", { "signal.interests.entities": seed, "filter.results.entities": "R1,R2,R3,R4,R5,R6" }, cache, 6),
    );
    if (i === 2) w.note(2, "Scoring the pairs on one scale so the rows are comparable.");
    if (i === 5) w.note(2, "Fifteen pairs scored. Reading the rows.");
  });
  w.evidence(1, "E4", "peer_landscape", "Substitution matrix for Juniper Cola and five peers", subsCalls, "6 × 6 matrix, 15 pairs");
  w.metric(
    1,
    metric({
      id: "M2",
      key: "subs.distinctiveness",
      label: "Distinctiveness of Juniper Cola",
      subjectRefs: ["R1"],
      value: 0.91,
      display: "0.91",
      unit: "score",
      formulaId: "distinctiveness",
      evidenceIds: ["E4"],
      comparator: "PEERS",
      n: 5,
      conf: 0.55,
    }),
  );
  w.metric(
    1,
    metric({
      id: "M3",
      key: "subs.rows_last",
      label: "Rows where Juniper Cola ranks last",
      subjectRefs: ["R1"],
      value: 4,
      display: "4 of 5",
      unit: "count",
      formulaId: "row_rank",
      evidenceIds: ["E4"],
      comparator: "PEERS",
      n: 5,
      conf: 0.55,
    }),
  );
  w.metric(
    1,
    metric({
      id: "M4",
      key: "subs.nearest_similarity",
      label: "Similarity of Juniper Cola to its nearest neighbour",
      subjectRefs: ["R1", "R6"],
      value: 0.34,
      display: "0.34",
      unit: "similarity",
      formulaId: "similarity",
      evidenceIds: ["E4"],
      comparator: "WITHIN_CALL",
    }),
  );
  w.dataset(1, substitutionMap());
  w.note(2, "Juniper Cola ranks last in most rows. That looks like a taste island, not a substitute for Kestrel Tonic.");
  w.finding(
    2,
    {
      id: "F1",
      kind: "TASTE_ISLAND",
      severity: "high",
      text: "Juniper Cola is last in 4 of 5 rows of the substitution map.",
      metricIds: ["M3", "M2"],
      suggestion: { tool: "cross_domain", reason: "Find its cultural home outside the category." },
    },
    "toolu_fake_01",
  );
  w.finding(
    2,
    {
      id: "F2",
      kind: "OUTSIDE_CATEGORY_NEIGHBOUR",
      severity: "medium",
      text: "Aurora Footwear, a footwear brand, is the nearest neighbour of Juniper Cola.",
      metricIds: ["M4"],
      suggestion: { tool: "peer_landscape", reason: "Add Aurora Footwear to the substitution set and score the pair." },
    },
    "toolu_fake_01",
  );
  w.toolEnd(1, "toolu_fake_01", "peer_landscape", 6120, {
    evidenceIds: ["E4"],
    metricIds: ["M2", "M3", "M4"],
    datasetIds: ["D1"],
    findingIds: ["F1", "F2"],
  });

  w.note(3, "Share of taste by age next: does the audience skew young against its peers?");
  w.toolStart(
    1,
    "toolu_fake_02",
    "share_of_taste",
    "wave1",
    { targets: ["R1", "R2", "R3"], contexts: { ages: ["24_and_younger", "25_to_29", "55_and_older"] }, trigger_finding_id: null, step_id: "S2" },
    "S2",
    null,
    3,
  );
  const shareCalls = [
    w.call(2, "toolu_fake_02", "/v2/insights", "urn:entity:brand", { "filter.results.entities": "R1,R2,R3", "signal.demographics.age": "24_and_younger" }, "miss", 3),
    w.call(2, "toolu_fake_02", "/v2/insights", "urn:entity:brand", { "filter.results.entities": "R1,R2,R3", "signal.demographics.age": "25_to_29" }, "miss", 3),
    w.call(2, "toolu_fake_02", "/v2/insights", "urn:entity:brand", { "filter.results.entities": "R1,R2,R3", "signal.demographics.age": "55_and_older" }, "hit", 3),
  ];
  w.evidence(1, "E5", "share_of_taste", "Share of taste by age for three brands", shareCalls, "3 age contexts × 3 brands");
  w.metric(
    1,
    metric({
      id: "M5",
      key: "share.youth_tilt",
      label: "Youth tilt of Juniper Cola against peers",
      subjectRefs: ["R1"],
      value: 0.21,
      display: "+0.21",
      unit: "delta",
      formulaId: "youth_tilt",
      evidenceIds: ["E5"],
      comparator: "PEERS",
      n: 3,
      conf: 0.42,
    }),
  );
  w.metric(
    1,
    metric({
      id: "M6",
      key: "share.rank_24_and_younger",
      label: "Rank of Juniper Cola among under-25s",
      subjectRefs: ["R1"],
      value: 1,
      display: "1 of 3",
      unit: "rank",
      formulaId: "row_rank",
      evidenceIds: ["E5"],
      comparator: "WITHIN_CALL",
    }),
  );
  w.dataset(1, shareOfTaste());
  w.note(2, "Under-30 rows put Juniper Cola first; the 55+ row puts it last.");
  w.finding(
    2,
    {
      id: "F3",
      kind: "GENERATIONAL_SPLIT",
      severity: "medium",
      text: "Under-30s rank Juniper Cola first while over-55s rank it last.",
      metricIds: ["M5", "M6"],
      suggestion: null,
    },
    "toolu_fake_02",
  );
  w.toolEnd(1, "toolu_fake_02", "share_of_taste", 2950, {
    evidenceIds: ["E5"],
    metricIds: ["M5", "M6"],
    datasetIds: ["D2"],
    findingIds: ["F3"],
  });
  w.usage(1);

  w.note(3, "Audience DNA: indices against the baseline, read as over- and under-indexing, never as shares.");
  w.toolStart(1, "toolu_fake_03", "audience_dna", "wave1", { targets: ["R1"], trigger_finding_id: null, step_id: "S3" }, "S3", null, 1);
  const dnaCall = w.call(2, "toolu_fake_03", "/v2/insights", "urn:demographics", { "signal.interests.entities": "R1" }, "coalesced", 8);
  w.evidence(1, "E6", "audience_dna", "Age and gender indices for Juniper Cola", [dnaCall], "6 age and 2 gender indices", {
    flags: ["DEMOGRAPHICS_ARE_INDICES"],
  });
  w.metric(
    1,
    metric({
      id: "M7",
      key: "dna.index_55_and_older",
      label: "55+ index for Juniper Cola",
      subjectRefs: ["R1"],
      value: 0.64,
      display: "64",
      unit: "index",
      formulaId: "demographic_index",
      evidenceIds: ["E6"],
      comparator: "BASELINE",
      conf: 0.7,
    }),
  );
  w.dataset(1, audienceDna());
  w.toolEnd(1, "toolu_fake_03", "audience_dna", 380, {
    evidenceIds: ["E6"],
    metricIds: ["M7"],
    datasetIds: ["D3"],
    flags: ["DEMOGRAPHICS_ARE_INDICES"],
  });

  w.note(3, "Momentum last: the trending window is historical, so any result is badged STALE.");
  w.toolStart(1, "toolu_fake_04", "momentum", "wave1", { targets: ["R1", "R2"], trigger_finding_id: null, step_id: "S4" }, "S4", null, 2);
  const momA = w.call(2, "toolu_fake_04", "/v2/trending", "urn:entity:brand", { "signal.interests.entities": "R1", take: "50" }, "hit", 26);
  const momB = w.call(2, "toolu_fake_04", "/v2/trending", "urn:entity:brand", { "signal.interests.entities": "R2", take: "50" }, "stale", 0);
  w.push(2, {
    type: "fallback",
    from: "26-week window",
    to: "13-week window",
    reason: "A scale break inside the frozen window; the stable half is used.",
    toolCallId: "toolu_fake_04",
    findingId: null,
  });
  w.evidence(1, "E7", "momentum", "Trending series for Juniper Cola and Kestrel Tonic", [momA, momB], "One usable series; one flat", {
    status: "partial",
    flags: ["TRENDING_HISTORICAL_WINDOW", "NO_TREND_SIGNAL"],
  });
  w.metric(
    1,
    metric({
      id: "M8",
      key: "mom.delta13w",
      label: "Momentum of Juniper Cola",
      subjectRefs: ["R1"],
      value: 0.04,
      display: "Rising",
      unit: "delta",
      badge: "STALE",
      formulaId: "theil_sen",
      evidenceIds: ["E7"],
      n: 13,
      conf: 0.3,
      window: TREND_WINDOW,
    }),
  );
  w.metric(
    1,
    metric({
      id: "M11",
      key: "mom.delta13w",
      label: "Momentum of Kestrel Tonic",
      subjectRefs: ["R2"],
      value: null,
      reason: "no_signal",
      display: "no signal",
      unit: "delta",
      badge: "UNAVAILABLE",
      formulaId: "theil_sen",
      evidenceIds: ["E7"],
    }),
  );
  w.finding(
    2,
    {
      id: "F4",
      kind: "NO_TREND_SIGNAL",
      severity: "low",
      text: "Kestrel Tonic has no usable trend in the frozen window.",
      metricIds: ["M11"],
      suggestion: null,
    },
    "toolu_fake_04",
  );
  w.toolEnd(1, "toolu_fake_04", "momentum", 520, {
    evidenceIds: ["E7"],
    metricIds: ["M8", "M11"],
    findingIds: ["F4"],
    flags: ["TRENDING_HISTORICAL_WINDOW", "NO_TREND_SIGNAL"],
    status: "partial",
  });
  w.usage(1);

  // E: ANALYST turn 2, follow-ups that each cite a finding.
  w.note(4, "F1 says Juniper Cola sits apart from its category. Following it outside the category.");
  const xdomArgs = {
    seeds: ["R1"],
    seed_tags: [],
    domains: ["artist", "podcast", "tv_show"],
    popularity_max: 0.85,
    trigger_finding_id: "F1",
    step_id: null,
  };
  w.push(2, { type: "pivot", triggerFindingId: "F1", tool: "cross_domain", args: xdomArgs, toolCallId: "toolu_fake_05" });
  w.toolStart(1, "toolu_fake_05", "cross_domain", "followup", xdomArgs, null, "F1", 3);
  const xdomCalls = [
    w.call(2, "toolu_fake_05", "/v2/insights", "urn:entity:artist", { "signal.interests.entities": "R1", "filter.popularity.max": "0.85" }, "miss", 20),
    w.call(2, "toolu_fake_05", "/v2/insights", "urn:entity:podcast", { "signal.interests.entities": "R1", "filter.popularity.max": "0.85" }, "miss", 20),
    w.call(2, "toolu_fake_05", "/v2/insights", "urn:entity:tv_show", { "signal.interests.entities": "R1", "filter.popularity.max": "0.85" }, "coalesced", 20),
  ];
  w.note(2, "Artists such as The Velvet Orchard and Nova Saint sit close to this audience and are not mainstream.");
  w.evidence(1, "E8", "cross_domain", "Cross-domain neighbours of Juniper Cola", xdomCalls, "Artists, podcasts and shows near the audience");
  w.metric(
    1,
    metric({
      id: "M9",
      key: "xdom.under_the_radar",
      label: "Under-the-radar artists near Juniper Cola",
      subjectRefs: ["R1"],
      value: 3,
      display: "3",
      unit: "count",
      formulaId: "under_the_radar",
      evidenceIds: ["E8"],
      comparator: "WITHIN_CALL",
    }),
  );
  w.toolEnd(1, "toolu_fake_05", "cross_domain", 2410, { evidenceIds: ["E8"], metricIds: ["M9"] });

  w.note(3, "F2: scoring Juniper Cola against Aurora Footwear directly, on one scale.");
  const pairArgs = { target: "R1", peers: ["R6"], discover: false, k: 2, trigger_finding_id: "F2", step_id: null };
  w.push(2, { type: "pivot", triggerFindingId: "F2", tool: "peer_landscape", args: pairArgs, toolCallId: "toolu_fake_06" });
  w.toolStart(1, "toolu_fake_06", "peer_landscape", "followup", pairArgs, null, "F2", 2);
  const pairCalls = [
    w.call(2, "toolu_fake_06", "/v2/insights", "urn:entity:brand", { "signal.interests.entities": "R1", "filter.results.entities": "R6" }, "miss", 1),
    w.call(2, "toolu_fake_06", "/v2/insights", "urn:entity:brand", { "signal.interests.entities": "R6", "filter.results.entities": "R1" }, "hit", 1),
  ];
  w.evidence(1, "E9", "peer_landscape", "Pair score for Juniper Cola and Aurora Footwear", pairCalls, "One symmetric pair, scored both ways");
  w.metric(
    1,
    metric({
      id: "M10",
      key: "subs.pair_similarity",
      label: "Similarity of Juniper Cola and Aurora Footwear",
      subjectRefs: ["R1", "R6"],
      value: 0.34,
      display: "0.34",
      unit: "similarity",
      formulaId: "similarity",
      evidenceIds: ["E9"],
      comparator: "WITHIN_CALL",
      n: 2,
      conf: 0.3,
    }),
  );
  w.toolEnd(1, "toolu_fake_06", "peer_landscape", 1330, { evidenceIds: ["E9"], metricIds: ["M10"] });
  w.usage(1);

  // F–H: the report, the CHECKER and assembly.
  w.note(4, "Enough evidence for a note. Drafting it with tokens for every number.");
  w.note(4, "Keeping the bear case: a wider peer set could close the gap.");
  w.push(3, { type: "report.draft", draft: DRAFT, attempt: 1 });
  w.note(3, "CHECKER: every number in the draft is a token and every token resolves.");
  w.push(2, {
    type: "validation",
    ok: true,
    attempt: 1,
    issues: [CHECKER_WARNING],
    numbersTraced: { traced: 10, total: 10 },
    adviceTerms: 0,
  });
  w.usage(2);

  const fetchedTimes = [...w.evidenceTimes].sort();
  const report: Report = {
    runId: ctx.runId,
    question: FAKE_QUESTION,
    pillar: "investment",
    job: "brand_health",
    mode: "live",
    createdAt,
    incomplete: false,
    investmentBanner: true,
    dataFreshness: {
      fetchedFrom: fetchedTimes[0] ?? null,
      fetchedTo: fetchedTimes.at(-1) ?? null,
      trendWindow: TREND_WINDOW,
    },
    verdict: {
      headline: DRAFT.headline,
      signal: DRAFT.signal,
      thesis: DRAFT.thesis,
      confidence: {
        score: 50,
        band: "MED",
        breakdown: [
          { rule: "dropped_entity", label: "DROPPED ENTITY", count: 1, points: -15 },
          { rule: "code_fallback", label: "CODE FALLBACK", count: 1, points: -10 },
          { rule: "stale_momentum", label: "STALE MOMENTUM", count: 1, points: -20 },
          { rule: "checker_warning", label: "CHECKER WARNING", count: 1, points: -5 },
        ],
      },
      coverage: { evidenceOk: 8, evidenceTotal: 9 },
    },
    scorecard: PLAN.hypotheses.map((h, i) => {
      const verdict = DRAFT.hypothesis_verdicts[i];
      return {
        hypothesisId: h.id,
        statement: h.statement,
        expectation: h.expectation,
        testTool: h.test_tool,
        verdict: verdict?.verdict === "confirmed" ? "CONFIRMED" : verdict?.verdict === "refuted" ? "REFUTED" : "INCONCLUSIVE",
        metricIds: verdict?.metric_ids ?? [],
        evidenceIds: (["E4", "E5", "E7"] as const).slice(i, i + 1),
        note: verdict?.note ?? "",
      };
    }),
    kpis: [
      { metricId: "M2", label: "Distinctiveness", comparator: "PEERS" },
      { metricId: "M5", label: "Youth tilt", comparator: "PEERS" },
      { metricId: "M10", label: "Nearest neighbour", comparator: "WITHIN_CALL" },
    ],
    exhibits: [
      {
        datasetId: "D1",
        kind: "Matrix",
        viz: "MatrixGrid",
        title: "Substitution Map",
        caption: "Pair similarity within one call.",
        badges: ["MEASURED"],
        sourceLine: SOURCE_LINE,
        evidenceIds: ["E4"],
      },
      {
        datasetId: "D2",
        kind: "Matrix",
        viz: "MatrixGrid",
        title: "Share of Taste by Age",
        caption: "Within-call percentile per age context.",
        badges: ["MEASURED"],
        sourceLine: SOURCE_LINE,
        evidenceIds: ["E5"],
      },
      {
        datasetId: "D3",
        kind: "Bars",
        viz: "DivergingBars",
        title: "Audience DNA",
        caption: "Indices against the baseline, not shares.",
        badges: ["MEASURED"],
        sourceLine: SOURCE_LINE,
        evidenceIds: ["E6"],
      },
    ],
    arguments: DRAFT.arguments.map((a, i) => ({
      id: a.id,
      section: a.section,
      qlooFact: a.qloo_fact,
      ourRead: a.our_read,
      metricIds: a.metric_ids,
      evidenceIds: a.evidence_ids,
      strength: i === 0 ? "STRONG" : "MODERATE",
    })),
    bearCase: DRAFT.bear_case.map((b) => ({ text: b.text, metricIds: b.metric_ids })),
    recommendations: DRAFT.recommendations.map((r) => ({
      action: r.action,
      priority: r.priority,
      argumentIds: r.argument_ids,
    })),
    limitations: [
      { source: "flag", flag: "SECONDARY_ENTITY_DROPPED", text: "Marlowe Ridge did not resolve exactly and was left out." },
      { source: "flag", flag: "TRENDING_HISTORICAL_WINDOW", text: "Momentum covers a past window only." },
      { source: "desk", flag: null, text: "Taste signals describe groups of people, not purchases." },
      { source: "open_question", flag: null, text: "Does the gap hold across metros?" },
    ],
    disclaimers: [
      ...FIXED_DISCLAIMERS,
      "Data: synthetic test data from the Foundation test run; no Qloo or model calls were made.",
    ],
    ghost: null,
    nextMoves: DRAFT.next_moves,
    warnings: [CHECKER_WARNING],
    receipt: {
      qlooNetwork: w.qloo.network,
      qlooCached: w.qloo.cached,
      qlooReused: w.qloo.reused,
      endpoints: [...w.endpoints.values()],
      ms: Math.round(ctx.durationMs),
      usd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      numbersTraced: { traced: 10, total: 10 },
      models: { clerk: null, analyst: null, ghost: null },
      economy: false,
    },
  };

  w.push(2, { type: "report.final", report });
  w.note(1, "Note published.");
  return report;
}

/** Pause before run.end, in the same units as the event weights. */
const END_WEIGHT = 2;

export function buildFakeScript(ctx: FakeScriptContext): FakeScript {
  // First pass measures the total weight; the second stamps times that depend on it.
  const probe = new ScriptWriter(ctx, null);
  compose(probe, ctx);
  const total = probe.pos + END_WEIGHT;

  const writer = new ScriptWriter(ctx, total);
  const report = compose(writer, ctx);
  return { steps: writer.items.map((item) => ({ at: item.pos / total, input: item.input })), report };
}
