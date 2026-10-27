// Synthetic fixtures: invented entities, call ids and request ids only, no Qloo values or UUIDs (D29).
import type {
  EventInput,
  MetricInput,
  ProvenanceRequest,
  QlooCallMeta,
  ReportDraft,
  SubmitPlanInput,
  TrendWindow,
} from "@ct/contracts";
import { createRunLedger, type LedgerSnapshot, type RunLedger } from "../../src/ledger";
import { createEntityRegistry, type RunRegistry } from "../../src/registry";

export const WINDOW: TrendWindow = { start: "2025-04-01", end: "2025-09-30" };
export const FETCHED = "2026-10-20T09:00:00.000Z";
export const CREATED_AT = "2026-10-21T09:00:00.000Z";

const PROVENANCE: Record<string, ProvenanceRequest> = {
  "qc-01": { method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:brand", take: "20" } },
  "qc-02": { method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:brand", take: "20" } },
  "qc-03": { method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:brand", "signal.demographics.age": "25_to_29" } },
  "qc-04": { method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:brand", "signal.demographics.age": "55_and_older" } },
  "qc-05": { method: "GET", path: "/v2/trending", query: { "filter.type": "urn:entity:brand", take: "50" } },
  "qc-06": { method: "GET", path: "/v2/insights", query: { "filter.type": "urn:demographics" } },
  "qc-07": { method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:artist", take: "15" } },
  "qc-08": { method: "GET", path: "/search", query: { query: "Brand Alpha", types: "urn:entity:brand", take: "5" } },
};

export const provenanceOf = (id: string): ProvenanceRequest | null => PROVENANCE[id] ?? null;

export function call(id: string, overrides: Partial<QlooCallMeta> = {}): QlooCallMeta {
  return {
    qlooCallId: id,
    requestId: `rq${id.slice(3)}-fixture`,
    cache: "hit",
    fetchedAt: FETCHED,
    ms: 120,
    stale: false,
    originRunId: null,
    ...overrides,
  };
}

export interface LedgerFixture {
  ledger: RunLedger;
  events: EventInput[];
  snapshot: () => LedgerSnapshot;
}

export function emptyLedger(): LedgerFixture {
  const events: EventInput[] = [];
  const ledger = createRunLedger({ emit: (e) => events.push(e), provenanceOf, toolCallId: () => "tc-fixture" });
  return { ledger, events, snapshot: () => ledger.snapshot() };
}

/**
 * A brand-health run on invented brands: E1–E5 (four ok), M1–M10 (M5 STALE, M6 UNAVAILABLE,
 * M7/M9 raw affinities from one call, M8 a raw affinity from another), D1–D3 and F1.
 */
export function brandHealthLedger(): LedgerFixture {
  const fx = emptyLedger();
  const { ledger } = fx;
  const metric: Pick<MetricInput, "subjectRefs" | "reason" | "n" | "conf" | "comparator" | "window"> = {
    subjectRefs: ["R1"],
    reason: null,
    n: 6,
    conf: null,
    comparator: null,
    window: null,
  };

  ledger.addEvidence({
    skill: "peer_landscape",
    purpose: "Substitution matrix for Brand Alpha",
    calls: [call("qc-01"), call("qc-02", { fetchedAt: "2026-10-20T10:00:00.000Z" })],
    status: "ok",
    summary: "Six brands, five triangular calls.",
    flags: [],
  });
  ledger.addEvidence({
    skill: "share_of_taste",
    purpose: "Share of taste by age",
    calls: [call("qc-03"), call("qc-04")],
    status: "ok",
    summary: "Two age contexts.",
    flags: ["THIN_RESULT"],
  });
  ledger.addEvidence({
    skill: "momentum",
    purpose: "Momentum of Brand Alpha",
    calls: [call("qc-05")],
    status: "ok",
    summary: "One trending series.",
    flags: ["TRENDING_HISTORICAL_WINDOW"],
  });
  ledger.addEvidence({
    skill: "audience_dna",
    purpose: "Audience DNA",
    calls: [call("qc-06")],
    status: "partial",
    summary: "One entity not measured.",
    flags: ["DEMOGRAPHICS_ARE_INDICES"],
  });
  ledger.addEvidence({
    skill: "cross_domain",
    purpose: "Cultural neighbourhood in music",
    calls: [call("qc-07", { cache: "miss", fetchedAt: "2026-10-21T08:59:00.000Z" })],
    status: "ok",
    summary: "Fifteen artists.",
    flags: [],
  });

  ledger.addMetric({ ...metric, subjectRefs: ["R1", "R2"], key: "subs.similarity", label: "Similarity to Brand Beta", value: 0.62, display: "0.62", unit: "similarity", badge: "MEASURED", formulaId: "subs.similarity", evidenceIds: ["E1"], comparator: "WITHIN_CALL" });
  ledger.addMetric({ ...metric, key: "subs.distinctiveness", label: "Distinctiveness rank", value: 2, display: "2 of 6", unit: "rank", badge: "DERIVED", formulaId: "subs.distinctiveness", evidenceIds: ["E1"], comparator: "PEERS" });
  ledger.addMetric({ ...metric, key: "share.youth_tilt", label: "Youth tilt", value: 0.14, display: "+0.14", unit: "delta", badge: "DERIVED", formulaId: "share.youth_tilt", evidenceIds: ["E2"], comparator: "WITHIN_CALL" });
  ledger.addMetric({ ...metric, key: "share.metros_won", label: "Metros won", value: 3, display: "3 of 8", unit: "count", badge: "DERIVED", formulaId: "share.metros_won", evidenceIds: ["E2"] });
  ledger.addMetric({ ...metric, key: "mom.label", label: "Momentum of Brand Alpha", value: 0.03, display: "Rising", unit: "delta", badge: "STALE", formulaId: "mom.label", evidenceIds: ["E3"], n: 26, window: WINDOW });
  ledger.addMetric({ ...metric, key: "dna.age_index", label: "Age index of Brand Gamma", value: null, reason: "not_measured", display: "not measured", unit: "index", badge: "UNAVAILABLE", formulaId: "dna.age_index", evidenceIds: ["E4"], n: null });
  ledger.addMetric({ ...metric, key: "xdom.affinity", label: "Affinity of Artist Nova", value: 0.71, display: "0.71", unit: "affinity", badge: "MEASURED", formulaId: "pct.within_call", evidenceIds: ["E1"] });
  ledger.addMetric({ ...metric, key: "xdom.affinity", label: "Affinity of Artist Lumen", value: 0.66, display: "0.66", unit: "affinity", badge: "MEASURED", formulaId: "pct.within_call", evidenceIds: ["E5"] });
  ledger.addMetric({ ...metric, key: "xdom.affinity", label: "Affinity of Artist Vega", value: 0.58, display: "0.58", unit: "affinity", badge: "MEASURED", formulaId: "pct.within_call", evidenceIds: ["E1"] });
  ledger.addMetric({ ...metric, key: "xdom.under_the_radar", label: "Under-the-radar artists", value: 4, display: "4", unit: "count", badge: "DERIVED", formulaId: "xdom.under_the_radar", evidenceIds: ["E5"] });

  ledger.addDataset({
    kind: "Matrix",
    title: "Substitution Map",
    evidenceIds: ["E1"],
    formulaIds: ["subs.similarity", "subs.rank_in_row"],
    payload: {
      mode: "similarity",
      valueLabel: "similarity",
      unit: "similarity",
      comparator: "WITHIN_CALL",
      rows: [
        { key: "R1", label: "Brand Alpha", ref: "R1", group: null },
        { key: "R2", label: "Brand Beta", ref: "R2", group: null },
      ],
      cols: [
        { key: "R1", label: "Brand Alpha", ref: "R1", group: null },
        { key: "R2", label: "Brand Beta", ref: "R2", group: null },
      ],
      cells: [
        [
          { value: null, reason: "self", rank: null },
          { value: 0.62, reason: null, rank: 1 },
        ],
        [
          { value: 0.62, reason: null, rank: 1 },
          { value: null, reason: "self", rank: null },
        ],
      ],
      margin: null,
      targetKey: "R1",
      annotations: [],
    },
  });
  ledger.addDataset({
    kind: "Momentum",
    title: "Momentum",
    evidenceIds: ["E3"],
    formulaIds: ["mom.delta_26w", "mom.label"],
    payload: { window: WINDOW, badgeText: "HISTORICAL · QLOO TRENDING · 2025-04-01..2025-09-30", badge: "STALE", series: [] },
  });
  ledger.addDataset({
    kind: "Ranked",
    title: "Cultural neighbourhood",
    evidenceIds: ["E5"],
    formulaIds: ["xdom.under_the_radar"],
    payload: {
      columns: [{ key: "fit", label: "FIT", unit: "pct", comparator: "WITHIN_CALL" }],
      groups: [
        {
          key: "artist",
          label: "Music",
          rows: [
            {
              key: "R3",
              rank: 1,
              label: "Artist Nova",
              sublabel: null,
              ref: "R3",
              tagRef: null,
              type: "artist",
              cells: [{ value: 0.9, reason: null }],
              flags: ["UTR"],
              explain: [],
            },
          ],
        },
      ],
      caption: null,
    },
  });
  ledger.addFinding({
    kind: "NEAR_SUBSTITUTES",
    severity: "medium",
    text: "Brand Alpha and Brand Beta are mutual nearest peers.",
    metricIds: ["M1"],
    suggestion: { tool: "share_of_taste", reason: "Compare the pair by age." },
  });
  return fx;
}

export function brandHealthRegistry(): RunRegistry {
  const registry = createEntityRegistry();
  const entity = { popularity: 0.5, disambiguation: null, tags: [] } as const;
  registry.registerEntity({ ...entity, entityId: "ent-alpha-01", name: "Brand Alpha", type: "brand" });
  registry.registerEntity({ ...entity, entityId: "ent-beta-01", name: "Brand Beta", type: "brand" });
  registry.registerEntity({ ...entity, entityId: "ent-nova-01", name: "Artist Nova", type: "artist" });
  registry.registerEntity({ ...entity, entityId: "ent-studio-01", name: "Studio 54 Lounge", type: "place" });
  return registry;
}

export function plan(): SubmitPlanInput {
  return {
    restated_question: "Is the Brand Alpha audience a moat or a niche?",
    hypotheses: [
      {
        id: "H1",
        statement: "Brand Beta is the nearest peer of Brand Alpha.",
        expectation: "Brand Beta ranks first in the Brand Alpha row.",
        test_tool: "peer_landscape",
        metric_hint: "similarity to Brand Beta",
      },
      {
        id: "H2",
        statement: "The Brand Alpha audience skews old.",
        expectation: "Negative youth tilt.",
        test_tool: "share_of_taste",
        metric_hint: "youth tilt",
      },
    ],
    steps: [
      { id: "S1", tool: "peer_landscape", purpose: "Map near-substitutes." },
      { id: "S2", tool: "share_of_taste", purpose: "Check the generational skew." },
    ],
    assumptions: ["US geography"],
  };
}

/** A draft that passes every CHECKER rule against brandHealthLedger and plan. */
export function validDraft(): ReportDraft {
  return {
    headline: "Brand Alpha shares its taste pool with Brand Beta {{M1}}",
    signal: "mixed",
    verdict_tag: "Shared taste pool",
    thesis:
      "Brand Alpha sits next to Brand Beta {{M1}} [E1] and ranks {{M2}} for distinctiveness. Its audience tilts young {{M3}} [E2].",
    hypothesis_verdicts: [
      { hypothesis_id: "H1", verdict: "confirmed", metric_ids: ["M1"], note: "Brand Beta is the nearest peer {{M1}}." },
      { hypothesis_id: "H2", verdict: "refuted", metric_ids: ["M3"], note: "The tilt is young, not old {{M3}}." },
    ],
    arguments: [
      {
        id: "A1",
        section: "competition",
        qloo_fact: "Similarity with Brand Beta is {{M1}} [E1].",
        our_read: "The two brands draw on one taste pool.",
        metric_ids: ["M1"],
        evidence_ids: ["E1"],
      },
      {
        id: "A2",
        section: "audience",
        qloo_fact: "Youth tilt is {{M3}} and Brand Alpha wins {{M4}} metros [E2].",
        our_read: "Younger audiences carry the brand.",
        metric_ids: ["M3", "M4"],
        evidence_ids: ["E2"],
      },
      {
        id: "A3",
        section: "momentum",
        qloo_fact: "Momentum was {{M5}} over {{WINDOW}} [E3].",
        our_read: "Historical only; it says little about today.",
        metric_ids: ["M5"],
        evidence_ids: ["E3"],
      },
    ],
    exhibits: [
      { dataset_id: "D1", title: "Substitution Map", caption: "Brand Beta is the nearest peer {{M1}}." },
      { dataset_id: "D2", title: "Momentum", caption: "Historical window {{WINDOW}}." },
    ],
    bear_case: [{ text: "If the youth tilt {{M3}} reverses, the read weakens.", metric_ids: ["M3"] }],
    recommendations: [
      { action: "Test a co-branded drop aimed at the shared taste pool.", priority: "next", argument_ids: ["A1"] },
    ],
    next_moves: [
      { label: "Alpha vs Beta", question: "How does Brand Alpha compare with Brand Beta by age and metro?" },
      { label: "Where Alpha wins", question: "Which metros favour Brand Alpha over its peers?" },
    ],
    open_questions: ["Qloo has no sales data, so share of wallet is unknown."],
  };
}
