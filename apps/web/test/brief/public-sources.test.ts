// Part 9 public data in the brief and the drawer: SEC EDGAR and US Census lookups sit beside the Qloo
// ones in the ledger, the sources list, footnotes and figure source lines, with their reference and a
// public URL (never a key). Plus the D41 "Read as" sentence, the period token, the new number units and
// the concept check's flag words. Every entity, CIK, ZIP and value is invented (D29).
import { reduceRunEvents, stampEvent, type EventInput, type Intent, type RunEvent } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { buildLedger, buildSources, createFootnoteRegistry, figureSource, inlineText } from "../../lib/brief";
import { publicEndpointOf, requestHead, requestsForEvidence, shortReference } from "../../lib/brief/ledger";
import { readAsOf } from "../../lib/brief/method";
import { publicRequestLink, requestCurl } from "../../components/drawer/curl";
import { requestPairs, sourceDescription, sourceLine } from "../../components/drawer/source-copy";
import { publicNote } from "../../components/drawer/source-row";
import { focusView } from "../../components/drawer/focus-card";
import { formatNumber, REASON_LABEL } from "../../components/figures/format";
import { FLAG_LABEL } from "../../components/figures/ranked-table";
import { sourceFromEvidence } from "../../components/figures/source";
import { lookupChips } from "../../components/working/sources";
import { FAKE_RUN, fakeRunEvents } from "./support";

vi.mock("server-only", () => ({}));

const CIK = "CIK0000000042";
const CENSUS_REF = "acs5 2023 zcta 00601,00602";
const FETCHED = "2026-10-14T09:13:00.000Z";

function publicRunEvents(): RunEvent[] {
  const base = fakeRunEvents();
  const end = base.at(-1) as RunEvent;
  const body = base.slice(0, -1);
  const last = body.at(-1) as RunEvent;
  const inputs: EventInput[] = [
    {
      type: "public",
      publicCallId: "pc-sec-1",
      toolCallId: null,
      source: "sec",
      endpoint: "/api/xbrl/companyfacts",
      paramsRedacted: {},
      cache: "miss",
      ms: 120,
      status: 200,
      reference: CIK,
      cacheAgeMs: null,
      originRunId: null,
      error: null,
    },
    {
      type: "public",
      publicCallId: "pc-census-1",
      toolCallId: null,
      source: "census",
      endpoint: "/data/acs/acs5",
      paramsRedacted: { get: "B01003_001E", for: "zip code tabulation area:00601,00602" },
      cache: "hit",
      ms: 4,
      status: 200,
      reference: CENSUS_REF,
      cacheAgeMs: 3_600_000,
      originRunId: null,
      error: null,
    },
    {
      type: "evidence",
      evidence: {
        id: "E90",
        skill: "company_financials",
        source: "sec",
        purpose: "Reported financials",
        status: "ok",
        qlooCallIds: ["pc-sec-1"],
        requestIds: [CIK],
        cached: false,
        fetchedAt: FETCHED,
        provenance: { requests: [{ source: "sec", method: "GET", host: "data.sec.gov", path: `/api/xbrl/companyfacts/${CIK}.json`, query: {}, reference: CIK }] },
        summary: "Three fiscal years of revenue",
        flags: [],
        qualityGateDrops: 0,
      },
    },
    {
      type: "metric",
      metric: {
        id: "M90",
        key: "fin.revenue",
        label: "Revenue",
        subjectRefs: ["R1"],
        value: 1_234_000_000,
        reason: null,
        display: "$1.2B",
        unit: "usd",
        badge: "MEASURED",
        formulaId: "fin.revenue",
        evidenceIds: ["E90"],
        n: null,
        conf: null,
        comparator: null,
        window: null,
        period: "FY2025, 10-K filed 2026-02-10",
      },
    },
  ];
  const added = inputs.map((input, i) => stampEvent(input, { seq: last.seq + 1 + i, ts: FETCHED, runId: FAKE_RUN }));
  const closing = stampEvent({ type: "run.end", status: "completed", elapsedMs: 120_000, reason: null }, { seq: last.seq + 1 + inputs.length, ts: end.ts, runId: FAKE_RUN });
  return [...body, ...added, closing];
}

const state = reduceRunEvents(FAKE_RUN, publicRunEvents());

describe("public lookups in the ledger and the sources list", () => {
  it("merges SEC and Census calls with the Qloo calls in arrival order", () => {
    const ledger = buildLedger(state);
    expect(ledger.calls).toHaveLength(state.qloo.chips.length + 2);
    expect(ledger.calls.map((c) => c.index)).toEqual(ledger.calls.map((_, i) => i));
    expect(ledger.callById.get("pc-sec-1")).toMatchObject({ source: "sec", host: "data.sec.gov", requestId: CIK, rows: null });
    for (const [id, { index }] of ledger.chips) expect(ledger.calls[index]?.id).toBe(id);

    const sources = buildSources(ledger);
    const sec = sources.items.find((s) => s.qlooCallId === "pc-sec-1");
    const census = sources.items.find((s) => s.qlooCallId === "pc-census-1");
    expect(sec).toMatchObject({ source: "sec", endpoint: "/api/xbrl/companyfacts", requestId: CIK, shortRequestId: CIK, evidenceIds: ["E90"] });
    expect(census).toMatchObject({ source: "census", host: "api.census.gov", cache: "hit" });
    expect(sources.line).toContain(`${sources.items.length} requests`);
  });

  it("cites a public number by its source, reference and period", () => {
    const ledger = buildLedger(state);
    const requests = requestsForEvidence(ledger, ["E90"]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ source: "sec", requestId: CIK, endpoint: "/api/xbrl/companyfacts" });
    expect(requestHead(ledger, requests)).toMatch(/^SEC EDGAR \/api\/xbrl\/companyfacts/);

    const notes = createFootnoteRegistry(state);
    const prose = notes.prose("Revenue was {{M90}} in {{PERIOD:M90}}.", "answer");
    expect(inlineText(prose)).toBe("Revenue was $1.2B in FY2025, 10-K filed 2026-02-10.");
    const note = notes.list().find((n) => n.key === "M90");
    expect(note?.text).toContain("SEC EDGAR");
    expect(note?.text).toContain("FY2025, 10-K filed 2026-02-10");
    expect(note?.short.trace).toContain(`ref ${CIK}`);
    expect(note?.metric?.period).toBe("FY2025, 10-K filed 2026-02-10");

    const view = focusView(note!);
    expect(view.rows).toContainEqual({ key: "Source", value: "From SEC EDGAR filings" });
    expect(view.rows).toContainEqual({ key: "Period", value: "FY2025, 10-K filed 2026-02-10" });
    expect(view.rows).toContainEqual({ key: "Built from", value: "1 SEC EDGAR lookup" });
  });

  it("names the source on figure source lines", () => {
    const ledger = buildLedger(state);
    expect(figureSource(ledger, ["E90"], null).text).toBe("Source: SEC EDGAR /api/xbrl/companyfacts · 1 request · computed in code");
    const evidence = state.evidence.E90!;
    expect(sourceFromEvidence([evidence]).text).toBe(`Source: SEC EDGAR /api/xbrl/companyfacts/${CIK}.json · 1 request · computed in code`);
  });

  it("counts public lookups apart on the working view", () => {
    expect(lookupChips(state).map((c) => c.label)).toEqual([`Qloo ${state.qloo.chips.length}`, "SEC EDGAR 1", "US Census 1"]);
  });
});

describe("the request inspector for public lookups", () => {
  const ledger = buildLedger(state);
  const sources = buildSources(ledger);
  const sec = sources.items.find((s) => s.qlooCallId === "pc-sec-1")!;
  const census = sources.items.find((s) => s.qlooCallId === "pc-census-1")!;

  it("describes them in plain words with their host and reference", () => {
    expect(sourceDescription(sec)).toMatch(/Reported financials.*\(SEC EDGAR filings\)$/);
    expect(sourceDescription(census)).toMatch(/^Resident estimates.*\(US Census ACS 5-year\)$/);
    expect(sourceLine(sec)).toBe("data.sec.gov/api/xbrl/companyfacts · SEC EDGAR");
    expect(requestPairs(sec)).toContainEqual(["reference", CIK]);
  });

  it("gives an SEC or Census URL, never a curl and never a key", () => {
    expect(requestCurl(sec, undefined)).toBeNull();
    const exact = publicRequestLink(sec, { path: `/api/xbrl/companyfacts/${CIK}.json`, query: {}, host: "data.sec.gov" });
    expect(exact).toEqual({ url: `https://data.sec.gov/api/xbrl/companyfacts/${CIK}.json`, exact: true });
    expect(publicRequestLink(sec, undefined)?.url).toBe(`https://data.sec.gov/api/xbrl/companyfacts/${CIK}.json`);
    const rebuilt = publicRequestLink({ ...census, params: [...census.params, ["key", "invented-key-value"]] }, undefined);
    expect(rebuilt?.url).toMatch(/^https:\/\/api\.census\.gov\/data\/2023\/acs\/acs5\?/);
    expect(rebuilt?.url).not.toContain("invented-key-value");
    expect(publicRequestLink({ ...sec, requestId: "mock-ab12" }, undefined)).toBeNull();
    expect(publicNote({ source: "sec", requestId: "mock-ab12" }, null)).toMatch(/^Test data/);
    expect(publicNote(sec, exact)).toContain("User-Agent");
  });

  it("maps concrete public paths to their endpoint and shortens long references", () => {
    expect(publicEndpointOf(`/api/xbrl/companyfacts/${CIK}.json`)).toBe("/api/xbrl/companyfacts");
    expect(publicEndpointOf("/data/2023/acs/acs5")).toBe("/data/acs/acs5");
    expect(shortReference("census", `acs5 2023 zcta ${"00601,".repeat(10)}`)).toMatch(/…$/);
    expect(shortReference("qloo", "0123456789abcdef")).toBe("0123…cdef");
  });
});

describe("read as the nearest job (D41)", () => {
  const intent = (readAs: Intent["read_as"]): Intent => ({ ...state.intent!, read_as: readAs });

  it("says what is not covered in a plain sentence", () => {
    const view = readAsOf(intent({ nearest: true, not_covered: ["sales", "prices"] }));
    expect(view?.chip).toMatch(/^Read as: /);
    expect(view?.line).toContain("Not covered: sales and prices");
    expect(readAsOf(intent({ nearest: false, not_covered: [] }))).toBeNull();
  });
});

describe("numbers and flags for the new jobs", () => {
  it("prints dollars, people and years", () => {
    expect(formatNumber(1_234_000_000, "usd")).toBe("$1.2B");
    expect(formatNumber(-40_300_000, "usd")).toBe("−$40.3M");
    expect(formatNumber(72_412, "usd")).toBe("$72,412");
    expect(formatNumber(12_340, "people")).toBe("12,340");
    expect(formatNumber(34.56, "years")).toBe("34.6");
    expect(REASON_LABEL.not_listed).toBe("not a listed company");
  });

  it("never reads a vetoed guess as a pick", () => {
    expect(FLAG_LABEL.VETO).toBe("AI guess dropped");
    expect(FLAG_LABEL.KEEP).toBe("AI guess kept");
    expect(FLAG_LABEL.ADD).toBe("Found in the data");
  });
});
