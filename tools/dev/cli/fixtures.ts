// Synthetic agent results for the dev CLI tests: invented brands and request ids only (D29).
import type { AgentRunResult, LedgerSnapshot } from "@ct/agent";
import type { Metric, Report } from "@ct/contracts";

export const FETCHED_AT = "2026-10-22T00:00:00.000Z";

function metric(id: `M${number}`, key: string, label: string, value: number, display: string, badge: Metric["badge"]): Metric {
  return {
    id,
    key,
    label,
    subjectRefs: ["R1"],
    value,
    reason: null,
    display,
    unit: key === "subs.similarity" ? "similarity" : "score",
    badge,
    formulaId: key,
    evidenceIds: ["E1"],
    n: 5,
    conf: null,
    comparator: null,
    window: null,
  };
}

export function syntheticLedger(): LedgerSnapshot {
  return {
    evidence: [
      {
        id: "E1",
        skill: "peer_landscape",
        source: "qloo",
        purpose: "Triangular similarity scoring for the Substitution Map",
        status: "ok",
        qlooCallIds: ["qc_synthetic_1"],
        requestIds: ["req-synthetic-1"],
        cached: false,
        fetchedAt: FETCHED_AT,
        provenance: { requests: [{ method: "GET", path: "/v2/insights", query: { "filter.type": "urn:entity:brand" } }] },
        summary: "4 scoring calls over 5 brands.",
        flags: [],
        qualityGateDrops: 0,
      },
    ],
    metrics: [
      metric("M1", "subs.distinctiveness", "distinctiveness rank of Brand Alpha", 0.2, "1 of 5", "DERIVED"),
      metric("M2", "subs.similarity", "similarity Brand Alpha–Brand Beta", 0.5, "0.50", "MEASURED"),
    ],
    datasets: [],
    findings: [],
  };
}

export function syntheticReport(runId: string): Report {
  return {
    runId,
    question: "How healthy is Brand Alpha's taste signal?",
    pillar: "investment",
    job: "brand_health",
    mode: "live",
    createdAt: FETCHED_AT,
    incomplete: false,
    investmentBanner: true,
    dataFreshness: { fetchedFrom: FETCHED_AT, fetchedTo: FETCHED_AT, trendWindow: null },
    verdict: {
      headline: "Brand Alpha stands apart at {{M1}}",
      signal: "strong",
      thesis: "Brand Alpha ranks {{M1}} on distinctiveness among its peers [E1].",
      confidence: { score: 90, band: "HIGH", breakdown: [{ rule: "thin_result", label: "thin result", count: 1, points: -10 }] },
      coverage: { evidenceOk: 1, evidenceTotal: 1 },
    },
    scorecard: [],
    kpis: [],
    exhibits: [],
    arguments: [
      {
        id: "A1",
        section: "competition",
        qlooFact: "Its nearest peer sits at {{M2}} [E1].",
        ourRead: "A niche with room of its own.",
        metricIds: ["M2"],
        evidenceIds: ["E1"],
        strength: "STRONG",
      },
    ],
    bearCase: [{ text: "A single seed per row.", metricIds: ["M2"] }],
    recommendations: [],
    limitations: [
      { source: "flag", flag: "CANDIDATES_UNSCORED", text: "Entities without a score are shown as not measured." },
      { source: "desk", flag: null, text: "Audience taste similarity, not switching or sales." },
    ],
    disclaimers: ["Analytics, not financial advice."],
    ghost: null,
    nextMoves: [],
    warnings: [],
    receipt: {
      qlooNetwork: 6,
      qlooCached: 2,
      qlooReused: 1,
      endpoints: [{ path: "/v2/insights", filterType: "urn:entity:brand", calls: 6 }],
      publicEndpoints: [],
      ms: 42_000,
      usd: 0.31,
      tokens: { input: 30_000, output: 4_000, cacheRead: 20_000, cacheCreation: 8_000 },
      numbersTraced: { traced: 3, total: 3 },
      models: { clerk: "claude-haiku-5-5", analyst: "claude-sonnet-5-5", ghost: null },
      economy: false,
    },
  };
}

export function syntheticResult(runId: string, overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    status: "completed",
    report: syntheticReport(runId),
    ledger: syntheticLedger(),
    intent: null,
    model: "claude-sonnet-5-5",
    usage: { input: 30_000, output: 4_000, cacheRead: 20_000, cacheCreation: 8_000 },
    usd: 0.31,
    qloo: { network: 6, cached: 2, reused: 1 },
    validation: { issues: [], numbersTraced: { traced: 3, total: 3 } },
    reason: null,
    elapsedMs: 42_000,
    ...overrides,
  };
}
