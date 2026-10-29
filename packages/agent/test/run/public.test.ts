// runAgent with public data (PLAN §5.2, D40) and the nearest-job rule (D41): the scripted fake ANALYST,
// the mock Qloo client and a scripted public-data client. Invented entities and figures only (D29); the
// listed brand's name is read from config/listed_companies.json, never written here.
import { PUBLIC_NOT_CONFIGURED_REASON, Report, type EventInput, type EventInputOf } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import listedConfig from "../../../../config/listed_companies.json";
import { OUT_OF_SCOPE_CARD } from "../../src/run/agentRun";
import { QLOO_DISABLED_NOTICE } from "../../src/run/tools";
import { fakePublicData } from "../support/fake-publicdata";
import { draftFrom, intentFor, parseAll, planCall, reportCall, reportWithoutFollowup, respond, run, toolUse, userTexts } from "./support";

type Of<T extends EventInput["type"]> = EventInputOf<T>;
const ofType = <T extends EventInput["type"]>(events: readonly EventInput[], type: T): Of<T>[] =>
  events.filter((e): e is Of<T> => e.type === type);

const LISTED_NAME = Object.keys((listedConfig as { brands: Record<string, unknown> }).brands)[0]!;

describe("runAgent: public data", () => {
  it("reads a listed brand's filings in the scan beside the taste read: public events, SEC provenance, receipt and disclaimer", async () => {
    const publicdata = fakePublicData();
    const intent = intentFor({ mentions: [{ text: LISTED_NAME, entity_type: "brand", role: "primary", public_figure: false }] });
    const { result, events, fake } = await run({ intent, publicdata, stream: [respond([planCall()]), ...reportWithoutFollowup()] });
    expect(result.status).toBe("completed");
    parseAll(events);

    // The scan's company_financials step: 0 Qloo calls, two SEC reads attributed to it.
    const fin = ofType(events, "tool.start").find((e) => e.tool === "company_financials");
    expect(fin).toMatchObject({ phase: "scan", estimatedCalls: 0, args: { brand: "R1" } });
    expect(ofType(events, "qloo").filter((e) => e.toolCallId === fin?.toolCallId)).toEqual([]);
    const reads = ofType(events, "public");
    expect(reads.map((e) => [e.toolCallId, e.source, e.endpoint])).toEqual([
      [fin?.toolCallId, "sec", "/files/company_tickers.json"],
      [fin?.toolCallId, "sec", "/api/xbrl/companyfacts"],
    ]);
    expect(reads.map((e) => e.publicCallId)).toEqual(publicdata.records.map((r) => r.publicCallId));

    // The model reads it as public data, never as Qloo data.
    const seen = userTexts(fake.streamRequests[1]!).join("\n");
    expect(seen).toMatch(/<public_data tool="FIN">/);
    expect(seen).not.toMatch(/<qloo_data tool="FIN"/);

    // The ledger traces each figure to its SEC request; the receipt lists the reads apart from Qloo's.
    const sec = result.ledger.evidence.filter((e) => e.source === "sec");
    expect(sec).toHaveLength(1);
    expect(sec[0]?.provenance.requests.map((r) => ("host" in r ? `${r.host}${r.path}` : r.path))).toEqual([
      "www.sec.gov/files/company_tickers.json",
      "data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json",
    ]);
    expect(result.ledger.metrics.filter((m) => m.evidenceIds.includes(sec[0]!.id) && m.value !== null).every((m) => typeof m.period === "string")).toBe(true);
    const report = Report.parse(result.report);
    expect(report.receipt.publicEndpoints).toEqual([
      { source: "sec", endpoint: "/files/company_tickers.json", calls: 1 },
      { source: "sec", endpoint: "/api/xbrl/companyfacts", calls: 1 },
    ]);
    expect(report.receipt.qlooNetwork + report.receipt.qlooCached + report.receipt.qlooReused).toBe(result.qloo.network + result.qloo.cached + result.qloo.reused);
    expect(report.disclaimers.some((d) => d.startsWith("Financial figures: SEC EDGAR filings as reported, "))).toBe(true);
  });

  it("leaves company_financials out of the scan without a public-data client, and says why", async () => {
    const intent = intentFor({ mentions: [{ text: LISTED_NAME, entity_type: "brand", role: "primary", public_figure: false }] });
    const { result, events, fake } = await run({ intent, stream: [respond([planCall()]), ...reportWithoutFollowup()] });
    expect(result.status).toBe("completed");
    expect(ofType(events, "tool.start").some((e) => e.tool === "company_financials")).toBe(false);
    expect(ofType(events, "public")).toEqual([]);
    expect(String(fake.streamRequests[0]?.messages[0]?.content)).toContain("company_financials (FIN): skipped, needs a brand primary that maps to a US-listed company, and public data on this server.");
  });

  it("still runs the public-data tools with Qloo disabled, and only those", async () => {
    const publicdata = fakePublicData();
    const { result, events, fake } = await run({
      qlooEnabled: false,
      publicdata,
      limits: { modelResponses: 2 },
      stream: [
        respond([planCall(), toolUse("toolu_fin", "company_financials", { brand: "R1", trigger_finding_id: null, step_id: null })]),
        respond([reportCall("toolu_report", draftFrom({ evidence: ["E1"], metrics: ["M1"], datasets: [], findings: [] }))]),
      ],
    });
    expect(result.status).toBe("completed");
    expect(ofType(events, "qloo")).toEqual([]);
    const context = String(fake.streamRequests[0]?.messages[0]?.content);
    expect(context).toContain("Only company_financials and area_economics still read SEC and Census data.");
    expect(context).toMatch(/UNAVAILABLE TOOLS: (?!.*company_financials)(?!.*area_economics).*peer_landscape/);
    // The call ran its skill (no registered brand here, so it answers why), not the Qloo-disabled notice.
    const answer = userTexts(fake.streamRequests[1]!).join("\n");
    expect(answer).not.toContain(QLOO_DISABLED_NOTICE);
    expect(ofType(events, "tool.start").find((e) => e.toolCallId === "toolu_fin")).toMatchObject({ estimatedCalls: 0 });
    parseAll(events);
  });
});

describe("runAgent: a public source that is not configured (D7)", () => {
  it("leaves the step out of the scan, refuses an ANALYST call with the exact reason and states it in the limitations", async () => {
    const publicdata = fakePublicData({ configured: { sec: false } });
    const intent = intentFor({ mentions: [{ text: LISTED_NAME, entity_type: "brand", role: "primary", public_figure: false }] });
    const { result, events, fake } = await run({
      intent,
      publicdata,
      stream: [
        respond([planCall(), toolUse("toolu_fin", "company_financials", { brand: "R1", trigger_finding_id: null, step_id: null })]),
        ...reportWithoutFollowup(),
      ],
    });
    expect(result.status).toBe("completed");
    expect(ofType(events, "public")).toEqual([]);
    expect(ofType(events, "tool.start").filter((e) => e.tool === "company_financials").map((e) => e.toolCallId)).toEqual(["toolu_fin"]);
    const context = String(fake.streamRequests[0]?.messages[0]?.content);
    expect(context).toContain(`company_financials (FIN): skipped, ${PUBLIC_NOT_CONFIGURED_REASON.sec}.`);
    expect(context).toMatch(/UNAVAILABLE TOOLS: .*company_financials/);
    const answer = userTexts(fake.streamRequests[1]!).join("\n");
    expect(answer).toContain(`SOURCE_NOT_CONFIGURED: ${PUBLIC_NOT_CONFIGURED_REASON.sec}`);
    const end = ofType(events, "tool.end").find((e) => e.toolCallId === "toolu_fin");
    expect(end).toMatchObject({ ok: false, error: { code: "public_unavailable" } });
    const report = Report.parse(result.report);
    const flagged = report.limitations.filter((l) => l.flag === "SEC_NOT_CONFIGURED");
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.text).toContain(PUBLIC_NOT_CONFIGURED_REASON.sec);
    parseAll(events);
  });
});

describe("runAgent: a trade question (D9)", () => {
  it("is never read as the nearest job: no coverage limitation and no 5 points off", async () => {
    const intent = intentFor({
      read_as: { nearest: true, not_covered: ["stock price"] },
      safety: { allowed: true, category: "financial_advice", reframe: "Reads taste-signal health only; not investment advice." },
    });
    const { result, events } = await run({ intent, stream: [respond([planCall()]), ...reportWithoutFollowup()] });
    expect(result.status).toBe("completed");
    expect(ofType(events, "clerk")[0]?.intent.read_as).toEqual({ nearest: false, not_covered: [] });
    const report = Report.parse(result.report);
    expect(report.limitations.some((l) => l.flag === "READ_AS_NEAREST_JOB")).toBe(false);
    expect(report.verdict.confidence.breakdown.some((l) => l.rule === "read_as_nearest_job")).toBe(false);
  });
});

describe("runAgent: the nearest-job rule (D41)", () => {
  it("runs a business question outside the jobs as its nearest job, with the coverage limitation and 5 points off", async () => {
    const readAs = { nearest: true, not_covered: ["sales", "store rents"] };
    // CLERK marked it out of scope and not allowed, yet read it as a job: code runs it, it never refuses it.
    for (const safety of [
      { allowed: true, category: null, reframe: null },
      { allowed: false, category: "out_of_scope" as const, reframe: null },
    ]) {
      const intent = intentFor({ read_as: readAs, safety });
      const { result, events } = await run({ intent, stream: [respond([planCall()]), ...reportWithoutFollowup()] });
      expect(result.status).toBe("completed");
      expect(ofType(events, "clerk")[0]?.intent.read_as).toEqual(readAs);
      const report = Report.parse(result.report);
      expect(report.limitations[0]).toEqual({
        source: "flag",
        flag: "READ_AS_NEAREST_JOB",
        text: "Read as brand health: the data does not cover sales and store rents, so the note answers the nearest question the data can measure.",
      });
      expect(report.verdict.confidence.breakdown).toContainEqual(expect.objectContaining({ rule: "read_as_nearest_job", count: 1, points: -5 }));
      parseAll(events);
    }
  });

  it("gives a question with no business or taste content the plain out-of-scope card, with no Qloo call", async () => {
    const intent = intentFor({ safety: { allowed: false, category: "out_of_scope", reframe: null } });
    const { result, events } = await run({ intent });
    expect(result).toMatchObject({ status: "refused", reason: OUT_OF_SCOPE_CARD, report: null });
    expect(ofType(events, "qloo")).toEqual([]);
  });
});
