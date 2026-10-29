// company_financials over a fake public-data API with invented companies and figures (D29): a
// restated period (the later filing wins), revenue lines by concept order, margins, year-on-year
// change, the latest quarters, and every way a brand gets no figures.
import {
  DatasetEnvelope,
  digestFits,
  Metric,
  ModelDigest,
  PUBLIC_DATA_NOTICE,
  type PublicCallMeta,
  type PublicDataApi,
  type SecFactPoint,
} from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { listedCompaniesFrom, makeCompanyFinancialsSkill } from "../../src/skills/companyFinancials";
import { financialsOf, latestFiled, percent, usd } from "../../src/skills/companyFinancials/facts";
import { fakeQloo, fakeRun, FakeRegistry, FETCHED_AT, registerInvented } from "./support/fakes";

const LISTED = listedCompaniesFrom({
  brands: {
    "Brand Alpha": { ticker: "ALPH", company: "Alpha Holdings Inc." },
    "Alpha Light": { ticker: "ALPH", company: "Alpha Holdings Inc.", note: "A brand of Alpha Holdings; figures are company-wide." },
  },
});
const skill = makeCompanyFinancialsSkill(LISTED);

let n = 0;
const point = (p: Partial<SecFactPoint> & Pick<SecFactPoint, "concept" | "value" | "end">): SecFactPoint => ({
  unit: "USD",
  start: null,
  fy: null,
  fp: null,
  form: "10-K",
  filed: "2025-02-01",
  accession: `0000000000-25-${String(++n).padStart(6, "0")}`,
  span: "annual",
  ...p,
});
const year = (end: string, start: string, revenue: number, filed: string, extra: Partial<SecFactPoint> = {}): SecFactPoint[] => [
  point({ concept: "Revenues", value: revenue, start, end, filed, ...extra }),
];

const POINTS: SecFactPoint[] = [
  // FY ended 2022-12-31 filed once; FY2023 filed, then restated in the next 10-K (the later filing wins).
  ...year("2022-12-31", "2022-01-01", 800e6, "2023-02-10"),
  ...year("2023-12-31", "2023-01-01", 900e6, "2024-02-10"),
  point({ concept: "Revenues", value: 950e6, start: "2023-01-01", end: "2023-12-31", filed: "2025-02-12" }),
  ...year("2024-12-31", "2024-01-01", 1.14e9, "2025-02-12"),
  // An older revenue line for the same period ranks after Revenues only when Revenues is missing.
  point({ concept: "SalesRevenueNet", value: 1, start: "2024-01-01", end: "2024-12-31", filed: "2025-02-12" }),
  point({ concept: "GrossProfit", value: 456e6, start: "2024-01-01", end: "2024-12-31", filed: "2025-02-12" }),
  point({ concept: "OperatingIncomeLoss", value: -11.4e6, start: "2024-01-01", end: "2024-12-31", filed: "2025-02-12" }),
  // FY2021 exists but only three years are shown.
  ...year("2021-12-31", "2021-01-01", 700e6, "2022-02-10"),
  // Quarters: one after the latest FY (shown), one before it (not), and its year-earlier quarter.
  point({ concept: "Revenues", value: 300e6, start: "2025-01-01", end: "2025-03-31", form: "10-Q", filed: "2025-05-01", span: "quarterly" }),
  point({ concept: "Revenues", value: 250e6, start: "2024-01-01", end: "2024-03-31", form: "10-Q", filed: "2024-05-01", span: "quarterly" }),
  // A year-to-date figure is neither annual nor quarterly.
  point({ concept: "Revenues", value: 999e6, start: "2025-01-01", end: "2025-06-30", form: "10-Q", filed: "2025-08-01", span: "other" }),
];

const meta = (id: string, reference: string, endpoint: PublicCallMeta["endpoint"]): PublicCallMeta => ({
  publicCallId: id,
  source: "sec",
  endpoint,
  reference,
  cache: "miss",
  fetchedAt: FETCHED_AT,
  ms: 3,
  stale: false,
  originRunId: null,
});

class PublicDataError extends Error {
  override name = "PublicDataError";
  constructor(readonly code: string) {
    super(code);
  }
}

function publicApi(options: { failFacts?: string; noTicker?: boolean } = {}): PublicDataApi & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    secTicker: async (ticker) => {
      asked.push(`ticker:${ticker}`);
      return { data: options.noTicker ? null : { cik: "0000000042", ticker, title: "ALPHA HOLDINGS INC" }, meta: meta("pc-1", "company_tickers.json", "/files/company_tickers.json") };
    },
    secCompanyFacts: async (cik) => {
      asked.push(`facts:${cik}`);
      if (options.failFacts) throw new PublicDataError(options.failFacts);
      return { data: { cik, entityName: "ALPHA HOLDINGS INC", points: POINTS }, meta: meta("pc-2", `CIK${cik}`, "/api/xbrl/companyfacts") };
    },
    censusAcs: async () => {
      throw new Error("unused");
    },
  };
}

function setup(name: string, api: PublicDataApi | null = publicApi()) {
  const registry = new FakeRegistry();
  const run = fakeRun(fakeQloo().api, registry);
  const brand = registerInvented(registry, { id: "ent-alpha-01", name, category: null });
  const ctx = { ...run.ctx, publicdata: api };
  return { ...run, ctx, brand, input: skill.input.parse({ brand: brand.ref, trigger_finding_id: null, step_id: "S5" }) };
}

describe("financial facts", () => {
  it("keeps the latest-filed value of a restated period", () => {
    const resolved = latestFiled(POINTS).filter((p) => p.end === "2023-12-31" && p.concept === "Revenues");
    expect(resolved.map((p) => p.value)).toEqual([950e6]);
  });

  it("reads three fiscal years with margins and year-on-year change, and the quarters after them", () => {
    const fin = financialsOf(POINTS);
    expect(fin.years.map((y) => y.end)).toEqual(["2024-12-31", "2023-12-31", "2022-12-31"]);
    const [fy24, fy23, fy22] = fin.years;
    expect(fy24?.revenueConcept).toBe("Revenues");
    expect(fy24?.grossMargin).toBeCloseTo(0.4, 10);
    expect(fy24?.operatingMargin).toBeCloseTo(-0.01, 10);
    // The restated FY2023 is the base of FY2024's change: 1.14B / 0.95B − 1 = +20%.
    expect(fy24?.yoy).toBeCloseTo(0.2, 10);
    expect(fy23?.yoy).toBeCloseTo(950 / 800 - 1, 10);
    expect(fy22?.yoy).toBeCloseTo(800 / 700 - 1, 10);
    expect(fy23?.grossMargin).toBeNull();
    expect(fin.quarters.map((q) => [q.end, q.yoy])).toEqual([["2025-03-31", 0.19999999999999996]]);
  });

  it("formats dollars and shares for a reader", () => {
    expect(usd(1.14e9)).toBe("$1.14B");
    expect(usd(456.7e6)).toBe("$456.7M");
    expect(usd(-12345)).toBe("−$12,345");
    expect(percent(0.4)).toBe("40.0%");
    expect(percent(-0.015, true)).toBe("−1.5%");
    expect(percent(0.2, true)).toBe("+20.0%");
  });
});

describe("company_financials", () => {
  it("writes period-labelled SEC metrics, a table and a public-data digest", async () => {
    const run = setup("Brand Alpha");
    const result = await skill.run(run.input, run.ctx);
    expect(result.status).toBe("ok");
    expect(run.ctx.publicdata && (run.ctx.publicdata as ReturnType<typeof publicApi>).asked).toEqual(["ticker:ALPH", "facts:0000000042"]);

    const [evidence] = run.ledger.evidences;
    expect(evidence?.source).toBe("sec");
    expect(evidence?.requestIds).toEqual(["company_tickers.json", "CIK0000000042"]);
    expect(evidence?.summary).toContain("accessions");

    for (const m of run.ledger.metrics) Metric.parse(m);
    const revenue = run.ledger.metrics.filter((m) => m.key === "fin.revenue");
    expect(revenue.map((m) => m.display)).toEqual(["$1.14B", "$950.0M", "$800.0M", "$300.0M"]);
    expect(revenue[0]?.badge).toBe("MEASURED");
    expect(revenue[0]?.period).toBe("fiscal year ended 2024-12-31 (10-K filed 2025-02-12)");
    expect(revenue[3]?.period).toBe("quarter ended 2025-03-31 (10-Q filed 2025-05-01)");
    expect(run.ledger.metrics.every((m) => typeof m.period === "string")).toBe(true);
    const gross = run.ledger.metrics.filter((m) => m.key === "fin.gross_margin");
    expect(gross.map((m) => [m.display, m.reason])).toEqual([
      ["40.0% of revenue", null],
      ["not measured", "not_reported"],
      ["not measured", "not_reported"],
    ]);
    expect(run.ledger.metrics.find((m) => m.key === "fin.yoy")?.display).toBe("+20.0% vs the period ended 2023-12-31");

    const table = run.ledger.datasets[0];
    if (table?.kind !== "Ranked") throw new Error("expected the financials table");
    DatasetEnvelope.parse(table);
    expect(table.payload.groups.map((g) => g.rows.length)).toEqual([3, 1]);

    const digest = ModelDigest.parse(result.forModel);
    expect(digest._data_notice).toBe(PUBLIC_DATA_NOTICE);
    expect(digestFits(digest, { tool: "company_financials", step: "S5" })).toBe(true);
    expect(skill.limitations([])).toContain(
      "Company-level reported figures from SEC filings; one brand may be a small part of a company, and none of this is advice.",
    );
  });

  it("matches only the exact resolved name, case aside, and says when figures are company-wide", async () => {
    const run = setup("alpha light");
    const result = await skill.run(run.input, run.ctx);
    expect(result.status).toBe("ok");
    expect(result.forModel.notices).toContain("A brand of Alpha Holdings; figures are company-wide.");
    const near = setup("Brand Alpha Zero");
    const miss = await skill.run(near.input, near.ctx);
    expect(miss.status).toBe("empty");
    expect(miss.flags).toEqual(["NOT_A_LISTED_COMPANY"]);
    expect(near.ledger.metrics[0]).toMatchObject({ badge: "UNAVAILABLE", reason: "not_listed", value: null });
    expect(near.ledger.evidences).toHaveLength(0);
  });

  it("turns a public-data failure into an unavailable figure with a plain reason, never a guess", async () => {
    const run = setup("Brand Alpha", publicApi({ failFacts: "not_configured" }));
    const result = await skill.run(run.input, run.ctx);
    expect(result.status).toBe("error");
    expect(run.ledger.metrics.map((m) => [m.badge, m.reason])).toEqual([["UNAVAILABLE", "unavailable"]]);
    expect(result.forModel.notices[0]).toContain("SEC access is not configured on this server");
    // The ticker lookup that did answer stays as evidence.
    expect(run.ledger.evidences[0]?.requestIds).toEqual(["company_tickers.json"]);
    // Any other error is a bug and propagates.
    const other = setup("Brand Alpha", { ...publicApi(), secCompanyFacts: async () => Promise.reject(new Error("boom")) });
    await expect(skill.run(other.input, other.ctx)).rejects.toThrow("boom");
  });

  it("reports a ticker no longer in the SEC map, and a run without public data", async () => {
    const gone = setup("Brand Alpha", publicApi({ noTicker: true }));
    expect((await skill.run(gone.input, gone.ctx)).flags).toEqual(["NOT_A_LISTED_COMPANY"]);
    const off = setup("Brand Alpha", null);
    const result = await skill.run(off.input, off.ctx);
    expect(result.status).toBe("error");
    expect(off.ledger.metrics[0]?.reason).toBe("unavailable");
  });

  it("raises TASTE_FINANCIALS_SPLIT when the brand's momentum in this run points against revenue", async () => {
    const run = setup("Brand Alpha");
    run.ledger.addMetric({
      key: "mom.delta_26w",
      label: "26-week momentum of Brand Alpha",
      subjectRefs: [run.brand.ref],
      value: -0.15,
      reason: null,
      display: "−0.150",
      unit: "delta",
      badge: "STALE",
      formulaId: "mom.delta_26w",
      evidenceIds: [],
      n: 26,
      conf: 0.5,
      comparator: "WITHIN_CALL",
      window: { start: "2025-04-01", end: "2025-09-30" },
    });
    await skill.run(run.input, run.ctx);
    const split = run.ledger.findings.find((f) => f.kind === "TASTE_FINANCIALS_SPLIT");
    expect(split?.suggestion).toBeNull();
    expect(split?.text).toContain("Brand Alpha's taste momentum fell in the 2025-04-01..2025-09-30 trending window");
    expect(split?.metricIds[0]).toBe("M1");
  });

  it("costs no Qloo calls", async () => {
    const run = setup("Brand Alpha");
    expect(await skill.estimateCalls(run.input, { has: async () => false }, run.registry)).toBe(0);
  });
});
