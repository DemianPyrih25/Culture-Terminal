// A run that read SEC EDGAR and US Census data beside its Qloo evidence: invented call ids, a made-up CIK
// and ZIP area, and invented figures only (D29).
import type { EventInput, MetricInput, ProvenanceRequest, PublicCallMeta, PublicSource, ReportDraft } from "@ct/contracts";
import { createRunLedger } from "../../src/ledger";
import { call, FETCHED, provenanceOf, type LedgerFixture } from "./fixtures";

export const SEC_PERIOD = "FY2024, 10-K filed 2025-02-14";
export const CENSUS_PERIOD = "ACS 2019-2023 5-year";

const PUBLIC: Record<string, ProvenanceRequest & { reference: string }> = {
  "pc-01": {
    source: "sec",
    method: "GET",
    host: "data.sec.gov",
    path: "/api/xbrl/companyfacts/CIK0000000001.json",
    query: {},
    reference: "CIK0000000001",
  },
  "pc-02": {
    source: "census",
    method: "GET",
    host: "api.census.gov",
    path: "/data/2023/acs/acs5",
    query: { for: "zip code tabulation area:00001", get: "B01003_001E" },
    reference: "acs5 2023 zcta 00001",
  },
};

export const publicProvenanceOf = (id: string): ProvenanceRequest | null => PUBLIC[id] ?? provenanceOf(id);

export function publicCall(id: "pc-01" | "pc-02", overrides: Partial<PublicCallMeta> = {}): PublicCallMeta {
  const source: PublicSource = id === "pc-01" ? "sec" : "census";
  return {
    publicCallId: id,
    source,
    endpoint: source === "sec" ? "/api/xbrl/companyfacts" : "/data/acs/acs5",
    reference: PUBLIC[id]!.reference,
    cache: "miss",
    fetchedAt: FETCHED,
    ms: 80,
    stale: false,
    originRunId: null,
    ...overrides,
  };
}

/**
 * E1–E3 ok Qloo bundles (peer_landscape, share_of_taste, cross_domain), E4 an SEC bundle and E5 a Census
 * bundle. M1 similarity (E1), M2 youth tilt (E2), M3 under-the-radar count (E3), M4 revenue (SEC, with its
 * period), M5 median household income (Census, with its vintage); D1 the financials table (E4).
 */
export function publicLedger(): LedgerFixture {
  const events: EventInput[] = [];
  const ledger = createRunLedger({ emit: (e) => events.push(e), provenanceOf: publicProvenanceOf, toolCallId: () => "tc-fixture" });
  const ok = { status: "ok" as const, flags: [] };
  ledger.addEvidence({ ...ok, skill: "peer_landscape", purpose: "Substitution matrix", calls: [call("qc-01")], summary: "Six brands." });
  ledger.addEvidence({ ...ok, skill: "share_of_taste", purpose: "Share by age", calls: [call("qc-03")], summary: "Two ages." });
  ledger.addEvidence({ ...ok, skill: "cross_domain", purpose: "Music neighbourhood", calls: [call("qc-07")], summary: "Fifteen artists." });
  ledger.addEvidence({ ...ok, skill: "company_financials", source: "sec", purpose: "Reported revenue", calls: [publicCall("pc-01")], summary: "Three fiscal years." });
  ledger.addEvidence({ ...ok, skill: "area_economics", source: "census", purpose: "Area economics", calls: [publicCall("pc-02")], summary: "One area." });

  const base: Pick<MetricInput, "reason" | "n" | "conf" | "comparator" | "window"> = { reason: null, n: 6, conf: null, comparator: null, window: null };
  ledger.addMetric({ ...base, subjectRefs: ["R1", "R2"], key: "subs.similarity", label: "Similarity to Brand Beta", value: 0.62, display: "0.62", unit: "similarity", badge: "MEASURED", formulaId: "subs.similarity", evidenceIds: ["E1"], comparator: "WITHIN_CALL" });
  ledger.addMetric({ ...base, subjectRefs: ["R1"], key: "share.youth_tilt", label: "Youth tilt", value: 0.14, display: "+0.14", unit: "delta", badge: "DERIVED", formulaId: "share.youth_tilt", evidenceIds: ["E2"], comparator: "WITHIN_CALL" });
  ledger.addMetric({ ...base, subjectRefs: ["R1"], key: "xdom.under_the_radar", label: "Under-the-radar artists", value: 4, display: "4", unit: "count", badge: "DERIVED", formulaId: "xdom.under_the_radar", evidenceIds: ["E3"] });
  ledger.addMetric({ ...base, subjectRefs: ["R1"], key: "fin.revenue", label: "Revenue, FY2024 (10-K)", value: 1_200_000_000, display: "$1.2B", unit: "usd", badge: "MEASURED", formulaId: "fin.revenue", evidenceIds: ["E4"], n: null, period: SEC_PERIOD });
  ledger.addMetric({ ...base, subjectRefs: ["riverbend"], key: "econ.median_hh_income", label: "Median household income, Riverbend", value: 61_000, display: "$61,000 (approximate)", unit: "usd", badge: "ESTIMATED", formulaId: "econ.median", evidenceIds: ["E5"], n: null, period: CENSUS_PERIOD });

  ledger.addDataset({
    kind: "Ranked",
    title: "Reported financials",
    evidenceIds: ["E4"],
    formulaIds: ["fin.revenue"],
    payload: {
      columns: [{ key: "revenue", label: "Revenue", unit: "usd", comparator: null }],
      groups: [
        {
          key: "annual",
          label: "Fiscal years",
          rows: [
            { key: "fy2024", rank: null, label: "FY2024", sublabel: SEC_PERIOD, ref: null, tagRef: null, type: null, cells: [{ value: 1_200_000_000, reason: null }], flags: [], explain: [] },
          ],
        },
      ],
      caption: null,
    },
  });
  return { ledger, events, snapshot: () => ledger.snapshot() };
}

/** A draft that passes every CHECKER rule against publicLedger and the fixtures' plan, period tokens and all. */
export function publicDraft(): ReportDraft {
  return {
    headline: "Brand Alpha shares its taste pool with Brand Beta {{M1}}",
    signal: "mixed",
    verdict_tag: "Shared taste pool",
    thesis: "Brand Alpha sits next to Brand Beta {{M1}} [E1]. Its listed parent reported revenue of {{M4}} ({{PERIOD:M4}}) [E4].",
    hypothesis_verdicts: [
      { hypothesis_id: "H1", verdict: "confirmed", metric_ids: ["M1"], note: "Brand Beta is the nearest peer {{M1}}." },
      { hypothesis_id: "H2", verdict: "refuted", metric_ids: ["M2"], note: "The tilt is young, not old {{M2}}." },
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
        qloo_fact: "Youth tilt is {{M2}} and {{M3}} artists sit under the radar [E2] [E3].",
        our_read: "Younger audiences carry the brand.",
        metric_ids: ["M2", "M3"],
        evidence_ids: ["E2", "E3"],
      },
      {
        id: "A3",
        section: "risk",
        qloo_fact: "The parent company reported revenue of {{M4}} ({{PERIOD:M4}}) [E4].",
        our_read: "The filing describes the whole company and sits beside the taste read.",
        metric_ids: ["M4"],
        evidence_ids: ["E4"],
      },
    ],
    exhibits: [{ dataset_id: "D1", title: "Reported financials", caption: "Company-level revenue {{M4}} ({{PERIOD:M4}})." }],
    bear_case: [{ text: "If the youth tilt {{M2}} reverses, the read weakens.", metric_ids: ["M2"] }],
    recommendations: [{ action: "Test a co-branded drop aimed at the shared taste pool.", priority: "next", argument_ids: ["A1"] }],
    next_moves: [
      { label: "Alpha vs Beta", question: "How does Brand Alpha compare with Brand Beta by age and metro?" },
      { label: "Where Alpha wins", question: "Which metros favour Brand Alpha over its peers?" },
    ],
    open_questions: [],
  };
}
