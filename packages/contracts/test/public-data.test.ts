import { describe, expect, it } from "vitest";
import {
  censusDisclaimer,
  Evidence,
  extractMetricIds,
  extractPeriodMetricIds,
  findMalformedTokens,
  GhostAnswer,
  isPublicProvenanceRequest,
  Metric,
  periodToken,
  PUBLIC_ENDPOINTS,
  PublicCallMeta,
  PublicEndpoint,
  publicDataErrorCode,
  Receipt,
  secDisclaimer,
  StoredGhostAnswer,
  stripTokens,
  tokenizeProse,
} from "../src/index";
import { evidence, metric, report } from "./fixtures";

// Invented values only (D29): no real CIK, accession or Census figure.
const secRequest = {
  source: "sec" as const,
  method: "GET" as const,
  host: "data.sec.gov",
  path: "/api/xbrl/companyfacts/CIK0000000001.json",
  query: {},
  reference: "CIK0000000001",
};

describe("public data contracts", () => {
  it("parses public call metadata and maps every endpoint to its source and host", () => {
    const meta = {
      publicCallId: "p1",
      source: "census",
      endpoint: "/data/acs/acs5",
      reference: "acs5 2023 zcta 00001",
      cache: "miss",
      fetchedAt: "2026-01-02T03:04:05.000Z",
      ms: 120,
      stale: false,
      originRunId: null,
    };
    expect(PublicCallMeta.parse(meta)).toEqual(meta);
    expect(PublicCallMeta.safeParse({ ...meta, source: "qloo" }).success).toBe(false);
    for (const endpoint of PublicEndpoint.options) expect(PUBLIC_ENDPOINTS[endpoint].host).toMatch(/\.gov$/);
  });

  it("reads public-data client errors by name and code only", () => {
    expect(publicDataErrorCode(Object.assign(new Error("no UA"), { name: "PublicDataError", code: "not_configured" }))).toBe("not_configured");
    expect(publicDataErrorCode(Object.assign(new Error("x"), { name: "PublicDataError", code: "bogus" }))).toBeNull();
    expect(publicDataErrorCode(Object.assign(new Error("x"), { code: "not_found" }))).toBeNull();
    expect(publicDataErrorCode("not_found")).toBeNull();
  });
});

describe("Evidence sources", () => {
  it("reads a bundle stored before Part 9 as a Qloo bundle", () => {
    const legacy: Record<string, unknown> = { ...evidence };
    delete legacy.source;
    expect(Evidence.parse(legacy).source).toBe("qloo");
  });

  it("holds an SEC bundle with public provenance, one source per bundle", () => {
    const sec = { ...evidence, skill: "company_financials", source: "sec", qlooCallIds: ["p1"], requestIds: ["CIK0000000001"], provenance: { requests: [secRequest] } };
    const parsed = Evidence.parse(sec);
    expect(parsed.provenance.requests.every(isPublicProvenanceRequest)).toBe(true);
    // A Qloo request in an SEC bundle, or an SEC request in a Qloo bundle, is refused.
    expect(Evidence.safeParse({ ...sec, source: "qloo" }).success).toBe(false);
    expect(Evidence.safeParse({ ...evidence, qlooCallIds: [...evidence.qlooCallIds], provenance: { requests: [evidence.provenance.requests[0], secRequest] } }).success).toBe(false);
    expect(Evidence.safeParse({ ...sec, provenance: { requests: [{ ...secRequest, path: "api/no-slash" }] } }).success).toBe(false);
  });

  it("keeps a Qloo request without a source a Qloo request", () => {
    expect(evidence.provenance.requests.every((r) => !isPublicProvenanceRequest(r))).toBe(true);
  });
});

describe("period tokens (V11)", () => {
  it("tokenizes {{PERIOD:M#}} apart from metric citations", () => {
    const text = `Revenue was {{M4}} in {{PERIOD:M4}} [E2].`;
    expect(tokenizeProse(text)).toEqual([
      { kind: "text", text: "Revenue was " },
      { kind: "metric", id: "M4" },
      { kind: "text", text: " in " },
      { kind: "period", id: "M4" },
      { kind: "text", text: " " },
      { kind: "evidence", id: "E2" },
      { kind: "text", text: "." },
    ]);
    expect(extractMetricIds(text)).toEqual(["M4"]);
    expect(extractPeriodMetricIds(text)).toEqual(["M4"]);
    expect(stripTokens(text)).not.toMatch(/\d/);
    expect(periodToken("M4")).toBe("{{PERIOD:M4}}");
  });

  it("reports malformed period tokens", () => {
    expect(findMalformedTokens("in {{PERIOD:M4}}")).toEqual([]);
    expect(findMalformedTokens("in {{PERIOD}} and {{PERIOD:4}} and {{period:M4}}")).toEqual(["{{PERIOD}}", "{{PERIOD:4}}", "{{period:M4}}"]);
  });

  it("lets a metric carry its period, optional for Qloo metrics", () => {
    expect(Metric.parse(metric).period).toBeUndefined();
    const revenue = { ...metric, unit: "usd", period: "FY2024, 10-K filed 2025-01-15" };
    expect(Metric.parse(revenue).period).toBe("FY2024, 10-K filed 2025-01-15");
    expect(Metric.safeParse({ ...revenue, period: "" }).success).toBe(false);
    const suppressed = { ...metric, value: null, reason: "suppressed", badge: "UNAVAILABLE", display: "n/a" };
    expect(Metric.safeParse(suppressed).success).toBe(true);
  });

  it("words the public-data disclaimers as PLAN §6 does", () => {
    expect(secDisclaimer("FY2024")).toBe("Financial figures: SEC EDGAR filings as reported, FY2024.");
    expect(censusDisclaimer("2019-2023")).toBe("Area figures: US Census ACS 5-year estimates, 2019-2023.");
  });
});

describe("stored reports and ghost answers", () => {
  it("reads a receipt stored before Part 9 with no public endpoints", () => {
    const legacy: Record<string, unknown> = { ...report.receipt };
    delete legacy.publicEndpoints;
    expect(Receipt.parse(legacy).publicEndpoints).toEqual([]);
    const withSec = { ...report.receipt, publicEndpoints: [{ source: "sec", endpoint: "/api/xbrl/companyfacts", calls: 1 }] };
    expect(Receipt.parse(withSec).publicEndpoints).toHaveLength(1);
  });

  it("reads a ghost answer stored before creators existed as no creator picks", () => {
    const legacy = { headline: "x", picks: { competitors: [], markets: [], neighbourhoods: [], tenants: [], partners: [] }, numeric_claims: [] };
    expect(StoredGhostAnswer.parse(legacy).picks.creators).toEqual([]);
    expect(GhostAnswer.safeParse(legacy).success).toBe(false);
  });
});
