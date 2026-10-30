// Synthetic fixtures: invented entities only, no Qloo values, ids or request ids (D29).
import {
  type AiContextBlock,
  type WebContextBlock,
  DEFAULT_RUN_LIMITS,
  GHOST_HONESTY_LINE,
  stampEvent,
  type DatasetEnvelope,
  type EventInput,
  type Evidence,
  type Finding,
  type Intent,
  type Metric,
  type Report,
  type ReportDraft,
  type RunEvent,
  type SubmitPlanInput,
} from "../src/index";

export const RUN_ID = "run-fixture-1";
const T0 = Date.parse("2026-01-01T00:00:00Z");
export const ts = (seq: number): string => new Date(T0 + seq * 1000).toISOString();

export const intent: Intent = {
  pillar: "investment",
  job: "brand_health",
  mentions: [
    { text: "Juniper Cola", entity_type: "brand", role: "primary", public_figure: false },
    { text: "Aurora Footwear", entity_type: "brand", role: "peer", public_figure: false },
  ],
  geo: { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: [] },
  constraints: { concepts: [], sponsor_categories: [], domains: ["artist"], ages: [], notes: [], concept_description: null },
  safety: { allowed: true, category: null, reframe: null },
  read_as: { nearest: false, not_covered: [] },
  candidates: { named_areas: [], named_markets: [], obvious_entities: [], obvious_areas: [], obvious_markets: [] },
  assumptions: ["US geography"],
  mnemonic: "JUNIPER COLA <BRAND> HLTH",
};

export const plan: SubmitPlanInput = {
  restated_question: "Is the Juniper Cola audience a moat or a niche?",
  hypotheses: [
    {
      id: "H1",
      statement: "Juniper Cola competes with energy drinks.",
      expectation: "An energy drink ranks first in its row.",
      test_tool: "peer_landscape",
      metric_hint: "rank of the nearest peer in the Juniper Cola row",
    },
    {
      id: "H2",
      statement: "Its audience skews young.",
      expectation: "Positive youth tilt.",
      test_tool: "share_of_taste",
      metric_hint: "youth tilt",
    },
  ],
  steps: [
    { id: "S1", tool: "peer_landscape", purpose: "Map near-substitutes." },
    { id: "S2", tool: "share_of_taste", purpose: "Check generational skew." },
  ],
  assumptions: [],
};

export const evidence: Evidence = {
  id: "E1",
  skill: "peer_landscape",
  source: "qloo",
  purpose: "Substitution matrix for Juniper Cola",
  status: "ok",
  qlooCallIds: ["q1", "q2"],
  requestIds: ["req-fixture-1", "req-fixture-2"],
  cached: false,
  fetchedAt: ts(7),
  qualityGateDrops: 0,
  provenance: {
    requests: [
      { method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:brand", take: "20" } },
      { method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:brand", take: "20" } },
    ],
  },
  summary: "6 × 6 matrix, 15 pairs",
  flags: [],
};

export const metric: Metric = {
  id: "M1",
  key: "subs.distinctiveness",
  label: "Distinctiveness of Juniper Cola",
  subjectRefs: ["R1"],
  value: 0.42,
  reason: null,
  display: "0.42",
  unit: "score",
  badge: "MEASURED",
  formulaId: "distinctiveness",
  evidenceIds: ["E1"],
  n: 5,
  conf: 0.55,
  comparator: "PEERS",
  window: null,
};

export const staleMetric: Metric = {
  ...metric,
  id: "M2",
  key: "mom.delta26w",
  label: "Momentum of Aurora Footwear",
  subjectRefs: ["R2"],
  value: 0.03,
  display: "Rising",
  unit: "delta",
  badge: "STALE",
  formulaId: "theil_sen_26w",
  comparator: null,
  window: { start: "2025-04-01", end: "2025-09-30" },
};

export const unavailableMetric: Metric = {
  ...metric,
  id: "M3",
  key: "mom.delta26w",
  label: "Momentum of Marlowe Ridge",
  subjectRefs: ["R3"],
  value: null,
  reason: "unavailable",
  display: "not measured",
  badge: "UNAVAILABLE",
  conf: null,
  n: null,
  comparator: null,
};

export const finding: Finding = {
  id: "F1",
  kind: "TASTE_ISLAND",
  severity: "high",
  text: "Juniper Cola is last in 5 of 6 rows.",
  metricIds: ["M1"],
  suggestion: { tool: "cross_domain", reason: "Find its cultural home outside the category." },
};

export const matrixDataset: DatasetEnvelope = {
  id: "D1",
  kind: "Matrix",
  title: "Substitution Map",
  evidenceIds: ["E1"],
  formulaIds: ["similarity"],
  payload: {
    mode: "similarity",
    valueLabel: "similarity",
    unit: "similarity",
    comparator: "WITHIN_CALL",
    rows: [
      { key: "R1", label: "Juniper Cola", ref: "R1", group: null },
      { key: "R2", label: "Aurora Footwear", ref: "R2", group: null },
    ],
    cols: [
      { key: "R1", label: "Juniper Cola", ref: "R1", group: null },
      { key: "R2", label: "Aurora Footwear", ref: "R2", group: null },
    ],
    cells: [
      [
        { value: null, reason: "self", rank: null },
        { value: 0.31, reason: null, rank: 1 },
      ],
      [
        { value: 0.31, reason: null, rank: 1 },
        { value: null, reason: "self", rank: null },
      ],
    ],
    margin: { label: "Hub", values: [{ value: 0.5, reason: null }, { value: null, reason: "not_scored" }] },
    targetKey: "R1",
    annotations: [{ text: "Taste island: last in 5/6 rows", rowKey: "R1", colKey: null }],
  },
};

export const draft: ReportDraft = {
  headline: "Juniper Cola is a taste island {{M1}}",
  signal: "mixed",
  verdict_tag: "Taste island",
  thesis: "Its audience sits apart from its category {{M1}} [E1].",
  hypothesis_verdicts: [{ hypothesis_id: "H1", verdict: "refuted", metric_ids: ["M1"], note: "Last in its row {{M1}}." }],
  arguments: [
    {
      id: "A1",
      section: "competition",
      qloo_fact: "Distinctiveness is high {{M1}} [E1].",
      our_read: "A niche with a loyal core.",
      metric_ids: ["M1"],
      evidence_ids: ["E1"],
    },
    {
      id: "A2",
      section: "momentum",
      qloo_fact: "Aurora Footwear rose {{M2}} over {{WINDOW}}.",
      our_read: "Historical only.",
      metric_ids: ["M2"],
      evidence_ids: ["E1"],
    },
    {
      id: "A3",
      section: "risk",
      qloo_fact: "Marlowe Ridge is not measured {{M3}}.",
      our_read: "A gap in coverage.",
      metric_ids: ["M3"],
      evidence_ids: [],
    },
  ],
  exhibits: [{ dataset_id: "D1", title: "Substitution Map", caption: "Similarity within one call." }],
  bear_case: [{ text: "A wider peer set could close the gap.", metric_ids: ["M1"] }],
  recommendations: [{ action: "Test a cross-category collaboration.", priority: "next", argument_ids: ["A1"] }],
  next_moves: [
    { label: "Audience", question: "Who is the Juniper Cola audience?" },
    { label: "Markets", question: "Which markets fit Juniper Cola?" },
  ],
  open_questions: ["How stable is the gap across markets?"],
};

export const report: Report = {
  runId: RUN_ID,
  question: "Is the Juniper Cola audience a moat or a niche?",
  pillar: "investment",
  job: "brand_health",
  mode: "live",
  createdAt: ts(1),
  incomplete: false,
  investmentBanner: true,
  dataFreshness: { fetchedFrom: ts(7), fetchedTo: ts(18), trendWindow: { start: "2025-04-01", end: "2025-09-30" } },
  verdict: {
    headline: draft.headline,
    signal: "mixed",
    tag: draft.verdict_tag,
    thesis: draft.thesis,
    confidence: {
      score: 80,
      band: "HIGH",
      breakdown: [{ rule: "code_fallback", label: "CODE FALLBACK", count: 1, points: -10 }],
    },
    coverage: { evidenceOk: 3, evidenceTotal: 3 },
  },
  scorecard: [
    {
      hypothesisId: "H1",
      statement: "Juniper Cola competes with energy drinks.",
      expectation: "An energy drink ranks first in its row.",
      testTool: "peer_landscape",
      verdict: "REFUTED",
      metricIds: ["M1"],
      evidenceIds: ["E1"],
      note: "Last in its row {{M1}}.",
    },
  ],
  kpis: [{ metricId: "M1", label: "Distinctiveness", comparator: "PEERS" }],
  exhibits: [
    {
      datasetId: "D1",
      kind: "Matrix",
      viz: "MatrixGrid",
      title: "Substitution Map",
      caption: "Similarity within one call.",
      badges: ["MEASURED"],
      sourceLine: "Source: Qloo /v2/insights (urn:entity:brand) · req fixture · Culture Terminal analysis",
      evidenceIds: ["E1"],
    },
  ],
  arguments: [
    {
      id: "A1",
      section: "competition",
      qlooFact: "Distinctiveness is high {{M1}} [E1].",
      ourRead: "A niche with a loyal core.",
      metricIds: ["M1"],
      evidenceIds: ["E1"],
      strength: "MODERATE",
    },
  ],
  bearCase: [{ text: "A wider peer set could close the gap.", metricIds: ["M1"] }],
  recommendations: [{ action: "Test a cross-category collaboration.", priority: "next", argumentIds: ["A1"] }],
  limitations: [
    { source: "flag", flag: "LOCATION_FALLBACK", text: "A location fallback was used." },
    { source: "open_question", flag: null, text: "How stable is the gap across markets?" },
  ],
  disclaimers: ["Analytics, not financial advice."],
  ghost: null,
  nextMoves: draft.next_moves,
  warnings: [],
  receipt: {
    qlooNetwork: 1,
    qlooCached: 2,
    qlooReused: 1,
    endpoints: [{ path: "/v2/insights", filterType: "urn:entity:brand", calls: 4 }],
    publicEndpoints: [],
    ms: 52_000,
    usd: 0.18,
    tokens: { input: 12_000, output: 3_000, cacheRead: 8_000, cacheCreation: 4_000 },
    numbersTraced: { traced: 3, total: 3 },
    models: { clerk: "claude-haiku-5-5", analyst: "claude-sonnet-5-5", ghost: null },
    economy: false,
  },
};

const qloo = (qlooCallId: string, cache: "hit" | "miss" | "stale" | "coalesced" | "reused", toolCallId: string | null) =>
  ({
    type: "qloo",
    qlooCallId,
    toolCallId,
    endpoint: "/v2/insights",
    filterType: "urn:entity:brand",
    paramsRedacted: { "signal.interests.entities": "R1", take: "20" },
    cache,
    ms: cache === "miss" ? 154 : 2,
    requestId: `req-${qlooCallId}`,
    status: 200,
    rows: 15,
    cacheAgeMs: cache === "miss" ? null : 3_600_000,
    originRunId: cache === "reused" ? "run-fixture-0" : null,
    error: null,
  }) satisfies EventInput;

/** One input per event type, in a plausible run order (needs_input belongs to a different run shape). */
export const fullRunInputs: EventInput[] = [
  { type: "run.created", question: report.question, mode: "live", lane: "public", limits: DEFAULT_RUN_LIMITS, parentRunId: null, model: "claude-sonnet-5-5" },
  { type: "clerk", intent, ms: 900 },
  {
    type: "resolve",
    entities: [
      {
        mention: "Juniper Cola",
        role: "primary",
        entityType: "brand",
        match: "exact",
        ref: "R1",
        name: "Juniper Cola",
        popularity: 0.8,
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
        alternatives: [{ name: "Marlowe Ridge Outfitters", disambiguation: null, popularity: 0.4 }],
        source: "gate",
      },
    ],
  },
  { type: "plan", plan, estimates: [{ stepId: "S1", calls: 7 }, { stepId: "S2", calls: 3 }] },
  { type: "note", text: "Checking the substitution map first." },
  {
    type: "tool.start",
    toolCallId: "toolu_fixture_1",
    tool: "peer_landscape",
    phase: "wave1",
    args: { target: "R1", peers: ["R2"], discover: true, k: 6, trigger_finding_id: null, step_id: "S1" },
    stepId: "S1",
    triggerFindingId: null,
    estimatedCalls: 7,
  },
  qloo("q1", "miss", "toolu_fixture_1"),
  qloo("q2", "hit", "toolu_fixture_1"),
  qloo("q3", "reused", "toolu_fixture_1"),
  { type: "evidence", evidence },
  { type: "metric", metric },
  { type: "metric", metric: staleMetric },
  { type: "metric", metric: unavailableMetric },
  { type: "dataset.ready", datasetId: "D1", kind: "Matrix", title: "Substitution Map", bytes: 2048, inline: matrixDataset },
  { type: "finding", finding, toolCallId: "toolu_fixture_1" },
  {
    type: "tool.end",
    toolCallId: "toolu_fixture_1",
    tool: "peer_landscape",
    ok: true,
    status: "ok",
    ms: 2100,
    evidenceIds: ["E1"],
    metricIds: ["M1"],
    datasetIds: ["D1"],
    findingIds: ["F1"],
    flags: [],
    error: null,
  },
  { type: "fallback", from: "POLYGON", to: "POINT", reason: "polygon returned no tags", toolCallId: "toolu_fixture_1", findingId: null },
  {
    type: "pivot",
    triggerFindingId: "F1",
    tool: "cross_domain",
    args: { seeds: ["R1"], seed_tags: [], domains: ["artist"], popularity_max: 0.9, trigger_finding_id: "F1", step_id: null },
    toolCallId: "toolu_fixture_2",
  },
  {
    type: "tool.start",
    toolCallId: "toolu_fixture_2",
    tool: "cross_domain",
    phase: "followup",
    args: { seeds: ["R1"], seed_tags: [], domains: ["artist"], popularity_max: 0.9, trigger_finding_id: "F1", step_id: null },
    stepId: null,
    triggerFindingId: "F1",
    estimatedCalls: 1,
  },
  qloo("q4", "coalesced", "toolu_fixture_2"),
  {
    type: "public",
    publicCallId: "p1",
    toolCallId: "toolu_fixture_2",
    source: "sec",
    endpoint: "/api/xbrl/companyfacts",
    paramsRedacted: { cik: "CIK0000000001" },
    cache: "hit",
    ms: 3,
    status: 200,
    reference: "CIK0000000001",
    cacheAgeMs: 7_200_000,
    originRunId: null,
    error: null,
  },
  {
    type: "tool.end",
    toolCallId: "toolu_fixture_2",
    tool: "cross_domain",
    ok: true,
    status: "partial",
    ms: 900,
    evidenceIds: [],
    metricIds: [],
    datasetIds: [],
    findingIds: [],
    flags: ["QUALITY_GATE_DROPPED"],
    error: null,
  },
  { type: "report.draft", draft, attempt: 1 },
  { type: "validation", ok: true, attempt: 1, issues: [], numbersTraced: { traced: 3, total: 3 }, adviceTerms: 0 },
  {
    type: "ghost",
    answer: {
      headline: "Juniper Cola competes with energy drinks.",
      picks: { competitors: ["Aurora Footwear"], markets: [], neighbourhoods: [], tenants: [], partners: [], creators: [] },
      numeric_claims: [],
    },
    diff: {
      items: [{ name: "Aurora Footwear", category: "competitors", status: "both", resolvesInQloo: null, ref: "R2" }],
      overlapAt5: 0.2,
      resolvability: 1,
      unsourcedNumericClaims: 0,
      meanPopularity: { ghost: 0.7, qloo: 0.5 },
      honestyLine: GHOST_HONESTY_LINE,
    },
  },
  { type: "context.ai", block: aiContextBlock(), usd: 0.012, ms: 6_400 },
  { type: "context.web", block: webContextBlock(), usd: 0.041, ms: 18_200 },
  {
    type: "usage",
    llmUsd: 0.18,
    tokens: { input: 12_000, output: 3_000, cacheRead: 8_000, cacheCreation: 4_000 },
    qloo: { network: 1, cached: 2, reused: 1 },
    elapsedMs: 52_000,
  },
  { type: "report.final", report },
  { type: "error", code: "qloo_rate_limited", message: "Throttled; retried.", retryable: true },
  { type: "run.end", status: "completed", elapsedMs: 53_000, reason: null },
];

/** An invented "What AI knows (not verified)" block: no digits, no spelled numbers (R4). */
export function aiContextBlock(): AiContextBlock {
  return {
    status: "ok",
    items: [
      { topic: "Ownership", text: "Juniper Cola is reported to be independently owned.", kind: "deal" },
      { topic: "Footprint", text: "It is said to sell mainly through regional grocers.", kind: "footprint" },
    ],
    presenceMarkets: ["nashville"],
    model: "claude-sonnet-5-5",
    generatedAt: ts(40),
    cached: false,
    note: null,
    droppedForNumbers: 1,
  };
}

/** An invented "From the web" block with example.com links (R5). */
export function webContextBlock(): WebContextBlock {
  return {
    status: "ok",
    items: [
      {
        claim: "Juniper Cola opened a tasting room in Nashville last spring.",
        url: "https://news.example.com/juniper-cola-tasting-room",
        title: "Juniper Cola opens a tasting room",
        publisher: "news.example.com",
        published: "April 30, 2025",
        publishedIso: "2025-04-30",
        retrievedAt: ts(41),
        citedText: "Juniper Cola opened a tasting room in Nashville",
      },
    ],
    model: "claude-haiku-5-5",
    searches: 2,
    retrievedAt: ts(41),
    cached: false,
    note: null,
    droppedForNumbers: 0,
  };
}

/** A run waiting second in the global queue (D24). */
export const queuedInput: EventInput = { type: "run.queued", position: 2, ahead: 1, waitSMax: 120 };

export const needsInputInput: EventInput = {
  type: "needs_input",
  mention: "Marlowe Ridge",
  entityType: "brand",
  reason: "ambiguous",
  candidates: [
    { key: "c1", name: "Marlowe Ridge", disambiguation: "Outdoor apparel", popularity: 0.6 },
    { key: "c2", name: "Marlowe Ridge", disambiguation: "Winery", popularity: 0.3 },
  ],
};

export function stampAll(inputs: readonly EventInput[], runId = RUN_ID, firstSeq = 1): RunEvent[] {
  return inputs.map((input, i) => stampEvent(input, { seq: firstSeq + i, ts: ts(firstSeq + i), runId }));
}

/** Recursively freezes a value so tests catch any mutation. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}
