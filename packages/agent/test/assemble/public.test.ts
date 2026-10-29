// ASSEMBLE with SEC and Census evidence (PLAN §6, D40) and a question read as its nearest job (D41).
// Invented ledger and figures (D29).
import { censusDisclaimer, CONFIDENCE_PENALTY, FIXED_DISCLAIMERS, Report, secDisclaimer } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { assembleReport, type ReportContext } from "../../src/assemble";
import { checkReport } from "../../src/checker";
import { readAsLimitation } from "../../src/report/publicData";
import { recordScorecard } from "../../src/scorecard";
import { brandHealthRegistry, plan } from "../ledger/fixtures";
import { publicDraft, publicLedger } from "../ledger/publicFixtures";
import { context } from "./support";

function assemble(overrides: Partial<ReportContext> = {}) {
  const fx = publicLedger();
  const draft = publicDraft();
  recordScorecard(fx.ledger, plan(), draft);
  const ledger = fx.ledger.snapshot();
  const check = checkReport({ draft, plan: plan(), ledger, qlooEnabled: true, registry: brandHealthRegistry() });
  return Report.parse(assembleReport({ ...context(ledger, overrides), check }));
}

describe("assembleReport with public data", () => {
  it("adds one disclaimer per public source used, and dates the Qloo data line from Qloo bundles only", () => {
    const report = assemble();
    expect(report.disclaimers).toEqual([
      ...FIXED_DISCLAIMERS,
      "Data: Qloo hackathon dataset, fetched 2026-10-20.",
      secDisclaimer("FY2024"),
      censusDisclaimer("2019-2023"),
    ]);
  });

  it("writes the SEC source line with its host, path and reference, never a Qloo request id", () => {
    const report = assemble();
    const financials = report.exhibits.find((e) => e.title === "Reported financials");
    expect(financials?.sourceLine).toBe(
      "Source: SEC EDGAR data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json · ref CIK0000000001 · fetched 2026-10-20 09:00 UTC · live · Culture Terminal analysis",
    );
  });

  it("lists SEC and Census calls by endpoint in the receipt, apart from the Qloo counts", () => {
    const report = assemble({
      publicCalls: [
        { publicCallId: "pc-01", source: "sec", endpoint: "/api/xbrl/companyfacts" },
        { publicCallId: "pc-03", source: "sec", endpoint: "/files/company_tickers.json" },
        { publicCallId: "pc-02", source: "census", endpoint: "/data/acs/acs5" },
        { publicCallId: "pc-01", source: "sec", endpoint: "/api/xbrl/companyfacts" },
      ],
    });
    expect(report.receipt.publicEndpoints).toEqual([
      { source: "sec", endpoint: "/api/xbrl/companyfacts", calls: 1 },
      { source: "sec", endpoint: "/files/company_tickers.json", calls: 1 },
      { source: "census", endpoint: "/data/acs/acs5", calls: 1 },
    ]);
    expect(assemble().receipt.publicEndpoints).toEqual([]);
  });
});

describe("a question read as its nearest job (D41)", () => {
  it("leads the limitations with what the data does not cover and costs 5 points once", () => {
    const plain = assemble();
    const read = assemble({ readAs: { notCovered: ["sales", " rents ", "Sales", "foot traffic"] } });
    expect(read.limitations[0]).toEqual({
      source: "flag",
      flag: "READ_AS_NEAREST_JOB",
      text: "Read as brand health: the data does not cover sales, rents and foot traffic, so the note answers the nearest question the data can measure.",
    });
    expect(read.verdict.confidence.score).toBe(plain.verdict.confidence.score - CONFIDENCE_PENALTY.read_as_nearest_job);
    expect(read.verdict.confidence.breakdown.filter((l) => l.rule === "read_as_nearest_job")).toEqual([
      expect.objectContaining({ count: 1, points: -CONFIDENCE_PENALTY.read_as_nearest_job }),
    ]);
    expect(plain.limitations.some((l) => l.flag === "READ_AS_NEAREST_JOB")).toBe(false);
  });

  it("says plainly when CLERK named nothing, and keeps user text short and on one line", () => {
    expect(readAsLimitation("site_selection", []).text).toBe(
      "Read as site selection: part of what it asks is outside what taste data can measure, so the note answers the nearest question the data can measure.",
    );
    const long = readAsLimitation("city_compare", ["a".repeat(80), "<b>rent\nlevels</b>"]).text;
    expect(long).toContain(`${"a".repeat(40)} and b rent levels /b`);
  });
});
