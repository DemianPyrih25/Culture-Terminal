// ASSEMBLE with SEC and Census evidence (PLAN §6, D40) and a question read as its nearest job (D41).
// Invented ledger and figures (D29).
import { censusDisclaimer, CONFIDENCE_PENALTY, FIXED_DISCLAIMERS, PUBLIC_NOT_CONFIGURED_REASON, Report, secDisclaimer } from "@ct/contracts";
import { DESK_LIMITATIONS, SKILL_LIMITATIONS } from "@ct/quant";
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

  it("weighs a reported SEC figure by its source and badge, not by a Qloo sample size it lacks (Q8)", () => {
    const report = assemble();
    const financial = report.arguments.find((a) => a.metricIds.includes("M4"));
    // M4 is MEASURED with n null: by the Qloo rule it would carry no weight and read THIN.
    expect(financial?.strength).toBe("STRONG");
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

describe("a concept that is not in the data (the owner's o03 decision)", () => {
  it("opens the thesis with what was tested instead and leads the limitations with it, before the nearest-job line", () => {
    const plain = assemble();
    const substitutes = [{ concept: "fizzy kelp tonic", scope: "brand", categories: ["Sea Snacks"] }];
    const report = assemble({ conceptSubstitutes: substitutes, readAs: { notCovered: ["prices"] } });
    const sentence = 'The exact product, "fizzy kelp tonic", is not in the data, so the category "Sea Snacks" was tested instead.';
    expect(report.verdict.thesis).toBe(`${sentence} ${plain.verdict.thesis}`);
    expect(report.limitations[0]).toEqual({ source: "flag", flag: "CONCEPT_NOT_IN_DATA", text: sentence });
    expect(report.limitations[1]?.flag).toBe("READ_AS_NEAREST_JOB");
    expect(report.limitations.filter((l) => l.flag === "CONCEPT_NOT_IN_DATA")).toHaveLength(1);
    expect(plain.limitations.some((l) => l.flag === "CONCEPT_NOT_IN_DATA")).toBe(false);
    const untested = assemble({ conceptSubstitutes: [{ concept: "fizzy kelp tonic", scope: "brand", categories: [] }] });
    expect(untested.verdict.thesis.startsWith('The exact product, "fizzy kelp tonic", is not in the data, and no close category was found either')).toBe(true);
  });
});

describe("Part 9 close-out: run flags, partly tested concepts and desk bullets", () => {
  it("states a not-configured source with its exact reason (D7)", () => {
    const report = assemble({ runFlags: ["SEC_NOT_CONFIGURED", "CENSUS_NOT_CONFIGURED"] });
    const texts = report.limitations.filter((l) => l.flag === "SEC_NOT_CONFIGURED" || l.flag === "CENSUS_NOT_CONFIGURED").map((l) => l.text);
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes(PUBLIC_NOT_CONFIGURED_REASON.sec))).toBe(true);
    expect(texts.some((t) => t.includes(PUBLIC_NOT_CONFIGURED_REASON.census))).toBe(true);
    expect(assemble().limitations.some((l) => l.flag === "SEC_NOT_CONFIGURED")).toBe(false);
  });

  it("takes 30 points once for a partly tested concept, so the note is never HIGH (D2)", () => {
    const plain = assemble();
    const partly = assemble({ conceptPartlyTagged: true });
    expect(partly.verdict.confidence.score).toBe(Math.max(0, plain.verdict.confidence.score - CONFIDENCE_PENALTY.concept_partly_tagged));
    expect(partly.verdict.confidence.breakdown.filter((l) => l.rule === "concept_partly_tagged")).toEqual([
      expect.objectContaining({ count: 1, points: -CONFIDENCE_PENALTY.concept_partly_tagged }),
    ]);
    expect(partly.verdict.confidence.band).not.toBe("HIGH");
    expect(plain.verdict.confidence.breakdown.some((l) => l.rule === "concept_partly_tagged")).toBe(false);
  });

  it("shows a marketing or audience desk bullet only when a skill using its method ran (Q4)", () => {
    // The fixture ledger holds cross_domain, share_of_taste, audience_dna, momentum and peer_landscape evidence.
    const [sponsorFit, localitySignal, underTheRadar] = DESK_LIMITATIONS.marketing;
    const marketing = assemble({ job: "creator_fit" }).limitations.map((l) => l.text);
    expect(SKILL_LIMITATIONS.sponsor_slate).toContain(sponsorFit);
    expect(marketing).not.toContain(sponsorFit);
    expect(marketing).toContain(localitySignal);
    expect(marketing).toContain(underTheRadar);
    const travel = SKILL_LIMITATIONS.destination_affinity.find((t) => DESK_LIMITATIONS.audience.includes(t));
    expect(travel).toBeDefined();
    const audience = assemble({ job: "audience_discovery" }).limitations.map((l) => l.text);
    expect(audience).not.toContain(travel);
    expect(audience).toContain(DESK_LIMITATIONS.audience[0]);
    // The investment desk's bullets describe every read of the desk and always show.
    const investment = assemble().limitations.map((l) => l.text);
    for (const text of DESK_LIMITATIONS.investment) expect(investment).toContain(text);
  });
});
