import {
  CONFIDENCE_PENALTY,
  FIXED_DISCLAIMERS,
  Report,
  VIZ_COMPAT,
  type Job,
  type ReportDraft,
  type ReportDraftShape,
} from "@ct/contracts";
import { argumentStrength, metricConfidence } from "@ct/quant";
import { describe, expect, it } from "vitest";
import {
  acceptedWarnings,
  assembleReport,
  NO_DATA_DISCLAIMER,
  ReportAssemblyError,
  reportTag,
  SCORECARD_CAPTION,
  type ReportContext,
} from "../../src/assemble";
import { checkReport } from "../../src/checker";
import { recordScorecard } from "../../src/scorecard";
import { brandHealthLedger, brandHealthRegistry, call, CREATED_AT, emptyLedger, plan, validDraft, WINDOW } from "../ledger/fixtures";
import { context, QLOO_CALLS } from "./support";

/** Records the Scorecard, checks the draft and assembles, as the run manager does. */
function assemble(
  draft: ReportDraftShape = validDraft(),
  opts: { attempt?: 1 | 2; qlooEnabled?: boolean; overrides?: Partial<ReportContext> } = {},
) {
  const fx = brandHealthLedger();
  recordScorecard(fx.ledger, plan(), draft);
  const ledger = fx.ledger.snapshot();
  const check = checkReport({
    draft,
    plan: plan(),
    ledger,
    qlooEnabled: opts.qlooEnabled ?? true,
    registry: brandHealthRegistry(),
    attempt: opts.attempt ?? 1,
  });
  return { check, report: assembleReport({ ...context(ledger, opts.overrides), check }) };
}

describe("assembleReport", () => {
  it("builds a Report that parses with the contracts schema", () => {
    const { report } = assemble();
    expect(Report.safeParse(report).success).toBe(true);
    expect(report).toMatchObject({
      runId: "run-alpha-01",
      pillar: "investment",
      job: "brand_health",
      incomplete: false,
      investmentBanner: true,
      ghost: null,
      warnings: [],
      verdict: { signal: "mixed", tag: validDraft().verdict_tag, coverage: { evidenceOk: 4, evidenceTotal: 5 } },
      dataFreshness: { fetchedFrom: "2026-10-20T09:00:00.000Z", fetchedTo: "2026-10-21T08:59:00.000Z", trendWindow: WINDOW },
    });
    expect(report.nextMoves).toEqual(validDraft().next_moves);
    expect(report.scorecard.map((r) => r.verdict)).toEqual(["CONFIRMED", "REFUTED"]);
  });

  it("leads with the Scorecard and picks every chart from VIZ_COMPAT", () => {
    const { report } = assemble();
    expect(report.exhibits.map((e) => [e.datasetId, e.kind, e.viz])).toEqual([
      ["D4", "Scorecard", "ScorecardTable"],
      ["D1", "Matrix", VIZ_COMPAT.Matrix],
      ["D2", "Momentum", VIZ_COMPAT.Momentum],
    ]);
    expect(report.exhibits[0]?.caption).toBe(SCORECARD_CAPTION);
    expect(report.exhibits[1]).toMatchObject({ title: "Substitution Map", caption: "Brand Beta is the nearest peer {{M1}}." });
  });

  it("writes the source line and badges of each exhibit", () => {
    const { report } = assemble();
    const [, matrix, momentum] = report.exhibits;
    expect(matrix?.sourceLine).toBe(
      "Source: Qloo /v2/insights (urn:entity:brand) · req rq01… +1 · fetched 2026-10-20 09:00 UTC · cache 24h · Culture Terminal analysis",
    );
    expect(momentum?.sourceLine).toBe(
      "Source: Qloo /v2/trending (urn:entity:brand) · req rq05… · fetched 2026-10-20 09:00 UTC · cache 24h · Culture Terminal analysis",
    );
    expect(matrix?.badges).toEqual(["MEASURED", "DERIVED"]);
    expect(momentum?.badges).toEqual(["STALE"]);
    expect(report.exhibits[0]?.sourceLine).toMatch(/^Source: the AI's expectations, recorded before any data/);
  });

  it("computes confidence from run facts, cited STALE metrics and CHECKER warnings", () => {
    const clean = assemble().report.verdict.confidence;
    const expected = 100 - CONFIDENCE_PENALTY.dropped_entity - CONFIDENCE_PENALTY.stale_momentum - CONFIDENCE_PENALTY.thin_result;
    expect(clean.score).toBe(expected);
    expect(clean.band).toBe("MED");
    expect(clean.breakdown.map((b) => b.rule)).toEqual(["dropped_entity", "stale_momentum", "thin_result"]);

    const draft = validDraft();
    draft.thesis = "Brand Alpha sits next to Brand Beta at 0.62 {{M1}} [E1].";
    draft.arguments[2] = { ...draft.arguments[2]!, qloo_fact: "Momentum is history [E3].", metric_ids: ["M2"] };
    // A bare number rejects the first attempt; left in the repair, it is accepted as a warning.
    const { report } = assemble(draft, { attempt: 2, overrides: { codeFallbacks: 2 } });
    expect(report.warnings.map((w) => [w.rule, w.action])).toEqual([["V3", "warn"]]);
    expect(report.verdict.confidence.breakdown).toEqual([
      expect.objectContaining({ rule: "dropped_entity", count: 1 }),
      expect.objectContaining({ rule: "code_fallback", count: 2 }),
      expect.objectContaining({ rule: "thin_result", count: 1 }),
      expect.objectContaining({ rule: "checker_warning", count: 1 }),
    ]);
  });

  it("picks the brand-health KPI strip by metric key", () => {
    const { report } = assemble();
    expect(report.kpis).toEqual([
      { metricId: "M1", label: "Similarity to Brand Beta", comparator: "WITHIN_CALL" },
      { metricId: "M2", label: "Distinctiveness rank", comparator: "PEERS" },
      { metricId: "M3", label: "Youth tilt", comparator: "WITHIN_CALL" },
      { metricId: "M4", label: "Metros won", comparator: null },
    ]);
    // Audience discovery's strip: of its key figures, only the under-the-radar count is in this ledger.
    const audience = assemble(validDraft(), { overrides: { job: "audience_discovery" } }).report;
    expect(audience.kpis).toEqual([{ metricId: "M10", label: "Under-the-radar artists", comparator: null }]);
    expect(audience.investmentBanner).toBe(false);
  });

  it("falls back to cited metrics when no KPI slot matches the job", () => {
    const { report } = assemble(validDraft(), { overrides: { job: "site_selection" as Job } });
    expect(report.kpis.map((k) => k.metricId)).toEqual(["M1", "M3", "M4", "M5"]);
  });

  it("maps arguments with strength pills and drops ids that do not exist", () => {
    const draft: ReportDraftShape = validDraft();
    draft.arguments = draft.arguments.map((a, i) => ({ ...a, id: ["A2", "A5", "A7"][i]! }));
    draft.arguments[0]!.metric_ids = ["M1", "M42"];
    draft.arguments[0]!.evidence_ids = ["E1", "E8"];
    draft.recommendations[0]!.argument_ids = ["A5", "A9", "A5"];
    draft.bear_case[0]!.metric_ids = ["M3", "M77"];
    draft.exhibits.push({ dataset_id: "D9", title: "Ghost exhibit", caption: "None." }, { dataset_id: "D1", title: "Again", caption: "Twice." });
    const { check, report } = assemble(draft, { attempt: 2 });
    expect(check.reject).toBe(false);
    expect(report.arguments.map((a) => a.id)).toEqual(["A1", "A2", "A3"]);
    expect(report.arguments[0]).toMatchObject({ metricIds: ["M1"], evidenceIds: ["E1"] });
    expect(report.arguments[1]?.metricIds).toEqual(["M3", "M4"]);
    expect(report.recommendations[0]?.argumentIds).toEqual(["A2"]);
    expect(report.bearCase[0]?.metricIds).toEqual(["M3"]);
    expect(report.exhibits.map((e) => e.datasetId)).toEqual(["D4", "D1", "D2"]);
    expect(report.arguments[0]?.strength).toBe(argumentStrength([metricConfidence("MEASURED", 6)]));
    expect(report.warnings.length).toBeGreaterThan(0);
    expect(report.warnings.every((w) => w.action === "warn")).toBe(true);
  });

  it("weighs a cited STALE metric without a stored conf by its window's freshness at report time", () => {
    const recent = { start: "2026-04-01", end: "2026-09-30" };
    const strengthAt = (createdAt: string) => {
      const fx = emptyLedger();
      fx.ledger.addEvidence({
        skill: "momentum",
        purpose: "Momentum of Brand Alpha",
        calls: [call("qc-05")],
        status: "ok",
        summary: "One trending series.",
        flags: ["TRENDING_HISTORICAL_WINDOW"],
      });
      fx.ledger.addMetric({
        key: "mom.label",
        label: "Momentum of Brand Alpha",
        subjectRefs: ["R1"],
        value: 0.03,
        reason: null,
        display: "Rising",
        unit: "delta",
        badge: "STALE",
        formulaId: "mom.label",
        evidenceIds: ["E1"],
        n: 26,
        conf: null,
        comparator: null,
        window: recent,
      });
      const ledger = fx.ledger.snapshot();
      const draft = { ...validDraft(), hypothesis_verdicts: [], exhibits: [] };
      const check = checkReport({ draft, plan: null, ledger, qlooEnabled: true, attempt: 2 });
      const report = assembleReport({ ...context(ledger, { plan: null, createdAt }), check });
      expect(report.arguments[0]?.metricIds).toEqual(["M1"]);
      return report.arguments[0]?.strength;
    };
    // The default F of an unknown age (twelve months) would mark a 26-point series THIN at any date.
    expect(argumentStrength([metricConfidence("STALE", 26)])).toBe("THIN");
    expect(strengthAt(CREATED_AT)).toBe("STRONG");
    expect(strengthAt("2027-03-21T09:00:00.000Z")).toBe("MODERATE");
    expect(strengthAt("2027-10-21T09:00:00.000Z")).toBe("THIN");
  });

  it("carries the signal after V7 and the V8 window token", () => {
    const draft: ReportDraft = validDraft();
    draft.signal = "strong";
    draft.arguments[2]!.qloo_fact = "Momentum was {{M5}} [E3].";
    const { report } = assemble(draft, { qlooEnabled: false });
    expect(report.verdict.signal).toBe("insufficient_evidence");
    expect(report.arguments[2]?.qlooFact).toBe("Momentum was {{M5}} ({{WINDOW}}) [E3].");
    expect(report.warnings).toEqual([]);
    expect(report.verdict.confidence.breakdown.at(-1)).toMatchObject({ rule: "insufficient_evidence", count: 1 });
    expect(report.verdict.confidence.band).toBe("LOW");
  });

  it("scores a note LOW when the ANALYST chose insufficient_evidence itself, whatever the ok bundles", () => {
    const draft: ReportDraft = validDraft();
    draft.signal = "insufficient_evidence";
    const { check, report } = assemble(draft);
    // Four ok bundles: V7 had nothing to force.
    expect(check.forcedSignal).toBeUndefined();
    expect(report.verdict.signal).toBe("insufficient_evidence");
    expect(report.verdict.confidence.breakdown.at(-1)).toMatchObject({ rule: "insufficient_evidence", count: 1 });
    expect(report.verdict.confidence.band).toBe("LOW");
  });

  it("orders limitations flags, desk, open questions and closes the disclaimers with the data line", () => {
    const { report } = assemble();
    const order = ["flag", "desk", "open_question"];
    const sources = report.limitations.map((l) => order.indexOf(l.source));
    expect(sources).toEqual([...sources].sort((a, b) => a - b));
    expect(report.limitations.filter((l) => l.source === "flag").map((l) => l.flag).sort()).toEqual([
      "DEMOGRAPHICS_ARE_INDICES",
      "THIN_RESULT",
      "TRENDING_HISTORICAL_WINDOW",
    ]);
    expect(report.limitations.at(-1)).toEqual({
      source: "open_question",
      flag: null,
      text: "Qloo has no sales data, so share of wallet is unknown.",
    });
    expect(report.disclaimers).toEqual([
      ...FIXED_DISCLAIMERS,
      "Data: Qloo hackathon dataset, fetched 2026-10-20 to 2026-10-21; trending window 2025-04-01..2025-09-30.",
    ]);
  });

  it("builds the receipt from the run's call log", () => {
    const { report } = assemble(validDraft(), { overrides: { mode: "economy" } });
    // qc-05 is stale: it made its own network attempt before the expired entry was served.
    expect(report.receipt).toEqual({
      qlooNetwork: 3,
      qlooCached: 4,
      qlooReused: 1,
      endpoints: [
        { path: "/search", filterType: null, calls: 1 },
        { path: "/v2/insights", filterType: "urn:entity:brand", calls: 4 },
        { path: "/v2/trending", filterType: "urn:entity:brand", calls: 1 },
        { path: "/v2/insights", filterType: "urn:demographics", calls: 1 },
        { path: "/v2/insights", filterType: "urn:entity:artist", calls: 1 },
      ],
      publicEndpoints: [],
      ms: 95_433,
      usd: 0.21,
      tokens: { input: 12_000, output: 3_000, cacheRead: 8_000, cacheCreation: 2_000 },
      numbersTraced: { traced: 12, total: 12 },
      models: { clerk: "claude-haiku-5-5", analyst: "claude-sonnet-5-5", ghost: null },
      economy: true,
    });
  });

  it("refuses to assemble without the Scorecard when the plan has hypotheses", () => {
    const ledger = brandHealthLedger().snapshot();
    const check = checkReport({ draft: validDraft(), plan: plan(), ledger, qlooEnabled: true });
    expect(() => assembleReport({ ...context(ledger), check })).toThrow(ReportAssemblyError);
  });

  it("leads with the draft's exhibits when there is no plan, so no Scorecard", () => {
    const ledger = brandHealthLedger().snapshot();
    const check = checkReport({ draft: validDraft(), plan: null, ledger, qlooEnabled: true, attempt: 2 });
    const report = assembleReport({ ...context(ledger, { plan: null }), check });
    expect(report.exhibits.map((e) => e.datasetId)).toEqual(["D1", "D2"]);
    expect(report.scorecard).toEqual([]);
  });

  it("turns rejections still standing into warnings when a first draft is accepted", () => {
    const draft = validDraft();
    draft.thesis = "We should buy Brand Alpha {{M1}} [E1].";
    const { check, report } = assemble(draft);
    expect(check.reject).toBe(true);
    expect(report.warnings).toEqual([
      expect.objectContaining({ rule: "V4", action: "warn", path: "thesis", subjects: ["We should buy"] }),
    ]);
    const breakdown = report.verdict.confidence.breakdown;
    expect(breakdown.find((b) => b.rule === "checker_warning")).toMatchObject({
      count: 1,
      points: -CONFIDENCE_PENALTY.checker_warning,
    });
    expect(report.verdict.confidence.score).toBe(assemble().report.verdict.confidence.score - CONFIDENCE_PENALTY.checker_warning);
  });

  it("copies the verdict tag as checked: cut on the last attempt, dropped with a forced signal", () => {
    const long = { ...validDraft(), verdict_tag: "Shared taste pool, with the brand next door" };
    const cut = assemble(long, { attempt: 2 }).report;
    expect(cut.verdict.tag).toBe("Shared taste pool");
    expect(cut.warnings).toEqual([]);
    expect(cut.verdict.confidence.score).toBe(assemble().report.verdict.confidence.score);
    // No clean cut: the tag is dropped and the brief prints the signal label.
    const uncut = { ...validDraft(), verdict_tag: "Shared taste pool with the brand next door" };
    expect(assemble(uncut, { attempt: 2 }).report.verdict.tag).toBeNull();
    expect(assemble(validDraft(), { qlooEnabled: false }).report.verdict).toMatchObject({ signal: "insufficient_evidence", tag: null });
  });

  it("reportTag: spaces collapsed, null for a tag that breaks its rule", () => {
    expect(reportTag("  Clear   lead ")).toBe("Clear lead");
    expect(reportTag("")).toBeNull();
    expect(reportTag("Island")).toBeNull();
    expect(reportTag("Top 3 pick")).toBeNull();
  });

  it("keeps code fixes out of the warnings", () => {
    const issues = checkReport({
      draft: { ...validDraft(), signal: "strong" },
      plan: plan(),
      ledger: brandHealthLedger().snapshot(),
      qlooEnabled: false,
    }).issues;
    expect(issues.map((i) => i.action)).toEqual(["forced"]);
    expect(acceptedWarnings(issues)).toEqual([]);
  });

  it("counts thin results per call from the call log's row counts", () => {
    const rows: Record<string, number> = { "qc-03": 3, "qc-04": 2, "qc-01": 1 };
    const qlooCalls = QLOO_CALLS.map((c) => ({ ...c, rows: rows[c.qlooCallId] ?? 20 }));
    const { report } = assemble(validDraft(), { overrides: { qlooCalls } });
    // E2 (THIN_RESULT) holds qc-03 and qc-04, both thin; qc-01 is thin but its bundle is not flagged.
    expect(report.verdict.confidence.breakdown.find((b) => b.rule === "thin_result")).toMatchObject({
      count: 2,
      points: -2 * CONFIDENCE_PENALTY.thin_result,
    });
  });

  it("writes next moves as plain text, since a child run cannot resolve this run's tokens", () => {
    const draft = validDraft();
    draft.next_moves[0]!.question = "Does the similarity {{M1}} [E1] hold by metro?";
    const { report } = assemble(draft, { attempt: 2 });
    expect(report.nextMoves[0]?.question).toBe("Does the similarity 0.62 hold by metro?");
    expect(report.warnings.map((w) => w.rule)).toEqual(["V2"]);
  });

  it("does not claim a fetch when the run collected no Qloo evidence", () => {
    const fx = emptyLedger();
    const draft = { ...validDraft(), hypothesis_verdicts: [], exhibits: [] };
    const ledger = fx.ledger.snapshot();
    const check = checkReport({ draft, plan: null, ledger, qlooEnabled: false, attempt: 2 });
    const report = assembleReport({ ...context(ledger, { plan: null, qlooCalls: [] }), check });
    expect(report.disclaimers.at(-1)).toBe(NO_DATA_DISCLAIMER);
    expect(report.dataFreshness).toEqual({ fetchedFrom: null, fetchedTo: null, trendWindow: null });
    expect(report.verdict.signal).toBe("insufficient_evidence");
    expect(report.verdict.confidence.band).toBe("LOW");
    expect(report.verdict.confidence.breakdown.map((b) => b.rule)).toContain("insufficient_evidence");
  });
});
