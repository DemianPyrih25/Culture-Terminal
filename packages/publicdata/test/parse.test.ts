import { CensusField } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import {
  acsValue,
  CENSUS_GET,
  CENSUS_TABLES,
  CENSUS_VARIABLES,
  canonicalGeo,
  censusReference,
  censusRequest,
  parseAcsRows,
} from "../src/census";
import { normalizeTicker, padCik, parseCompanyFacts, parseTickerMap, reduceCompanyFacts, secFactsRequest } from "../src/sec";
import { acsTractBody, acsZctaBody, COMPANY_FACTS, FIXTURE_CIK, TICKER_MAP } from "./support/fakes";

describe("SEC ticker map", () => {
  it("indexes tickers as SEC lists them, CIKs padded to 10 digits", () => {
    const map = parseTickerMap(TICKER_MAP);
    expect(map.get("ZZQA")).toEqual({ cik: FIXTURE_CIK, ticker: "ZZQA", title: "Alpha Fixture Holdings" });
    expect(map.get("ZZQC")?.cik).toBe("0000000044");
    expect(map.get(normalizeTicker("zzq.b"))?.title).toBe("Beta Fixture Group");
    expect(map.get("NOPE")).toBeUndefined();
  });

  it("refuses text that is not a ticker or a CIK", () => {
    expect(() => normalizeTicker("not a ticker")).toThrow(/not a stock ticker/);
    expect(() => padCik("12345678901")).toThrow(/not an SEC CIK/);
    expect(() => padCik("0")).toThrow(/not an SEC CIK/);
    expect(padCik("CIK42")).toBe(FIXTURE_CIK);
    expect(secFactsRequest("42").path).toBe(`/api/xbrl/companyfacts/CIK${FIXTURE_CIK}.json`);
  });
});

describe("SEC company facts", () => {
  const facts = parseCompanyFacts(COMPANY_FACTS, "42");
  const revenue = facts.points.filter((p) => p.concept === "RevenueFromContractWithCustomerExcludingAssessedTax");

  it("keeps the latest-filed value of a restated period, with that filing's accession", () => {
    const fy2023 = revenue.filter((p) => p.start === "2023-01-01" && p.end === "2023-12-31");
    expect(fy2023).toHaveLength(1);
    expect(fy2023[0]).toMatchObject({ value: 880, filed: "2025-02-20", accession: "0000000042-25-000001", fy: 2024, span: "annual" });
  });

  it("classifies annual, quarterly and year-to-date spans, USD from periodic reports only", () => {
    expect(revenue.map((p) => [p.end, p.span, p.value])).toEqual([
      ["2023-12-31", "annual", 880],
      ["2024-12-31", "annual", 1000],
      ["2025-06-30", "other", 500],
      ["2025-06-30", "quarterly", 260],
    ]);
    expect(revenue.every((p) => p.unit === "USD" && p.form !== "8-K")).toBe(true);
    expect(facts.points.map((p) => p.concept)).not.toContain("AccountsPayableCurrent");
    expect(facts.points.find((p) => p.concept === "OperatingIncomeLoss")?.value).toBe(-50);
    expect(facts).toMatchObject({ cik: FIXTURE_CIK, entityName: "Alpha Fixture Holdings" });
  });

  it("reduces the cached body to the read concepts and parses it the same way", () => {
    const reduced = reduceCompanyFacts(COMPANY_FACTS) as { facts: Record<string, Record<string, unknown>> };
    expect(Object.keys(reduced.facts)).toEqual(["us-gaap"]);
    expect(Object.keys(reduced.facts["us-gaap"] ?? {}).sort()).toEqual(
      ["GrossProfit", "OperatingIncomeLoss", "RevenueFromContractWithCustomerExcludingAssessedTax"].sort(),
    );
    expect(parseCompanyFacts(reduced, "42")).toEqual(facts);
  });

  it("throws on a body that is not company facts", () => {
    expect(() => parseCompanyFacts({ hello: "world" }, "42")).toThrow();
  });
});

describe("Census ACS", () => {
  it("requests exactly the fixed variables, all from the population, age, household, income and commute tables", () => {
    expect(CENSUS_GET.split(",")).toEqual(CensusField.options.map((f) => CENSUS_VARIABLES[f]));
    for (const variable of Object.values(CENSUS_VARIABLES)) {
      expect(CENSUS_TABLES.some((t) => variable.startsWith(`${t}_`))).toBe(true);
      expect(variable).toMatch(/^B\d{5}_\d{3}E$/);
    }
    // Race (B02, B03), ancestry, language, citizenship, disability and similar tables are never named.
    expect(CENSUS_TABLES.some((t) => /^B0[2-7]|^B1[68]|^C/.test(t))).toBe(false);
  });

  it("builds canonical requests: ZCTAs de-duplicated and sorted, tracts by county", () => {
    const zcta = censusRequest(2024, { kind: "zcta", zctas: ["00502", "00501", "00502"] });
    expect(zcta).toMatchObject({ source: "census", endpoint: "/data/acs/acs5", host: "api.census.gov", path: "/data/2024/acs/acs5" });
    expect(zcta.query).toEqual({ get: CENSUS_GET, for: "zip code tabulation area:00501,00502" });
    const tract = censusRequest(2023, { kind: "tract", state: "01", county: "002" });
    expect(tract.query).toEqual({ get: CENSUS_GET, for: "tract:*", in: "state:01 county:002" });
    expect(censusReference(2024, { kind: "zcta", zctas: ["00502", "00501"] })).toBe("acs5 2024 zcta 00501,00502");
    expect(() => canonicalGeo({ kind: "zcta", zctas: ["123"] })).toThrow(/5-digit ZCTA/);
    expect(() => canonicalGeo({ kind: "zcta", zctas: [] })).toThrow(/no ZCTA/);
    expect(() => canonicalGeo({ kind: "tract", state: "1", county: "002" })).toThrow(/FIPS/);
  });

  it("reads withheld estimates (negative sentinels, null) as null", () => {
    expect(acsValue("-666666666")).toBeNull();
    expect(acsValue("-999999999")).toBeNull();
    expect(acsValue(-222222222)).toBeNull();
    expect(acsValue(null)).toBeNull();
    expect(acsValue("")).toBeNull();
    expect(acsValue("n/a")).toBeNull();
    expect(acsValue("38.4")).toBe(38.4);
    expect(acsValue("0")).toBe(0);
  });

  it("parses ZCTA and tract rows by header name", () => {
    const zctas = parseAcsRows(acsZctaBody(CENSUS_GET, ["00501", "00502", "00503"]), { kind: "zcta", zctas: ["00501", "00502", "00503"] });
    expect(zctas.map((r) => r.geoId)).toEqual(["00501", "00502", "00503"]);
    expect(zctas[0]?.values.population).toBe(1000);
    expect(zctas[1]?.values.median_household_income).toBeNull();
    expect(zctas[2]?.values.median_age).toBeNull();
    expect(Object.keys(zctas[0]?.values ?? {}).sort()).toEqual([...CensusField.options].sort());

    const tracts = parseAcsRows(acsTractBody(CENSUS_GET, "01", "002"), { kind: "tract", state: "01", county: "002" });
    expect(tracts.map((r) => r.geoId)).toEqual(["01002000100", "01002000201"]);
    expect(parseAcsRows(null, { kind: "tract", state: "01", county: "002" })).toEqual([]);
  });

  it("refuses an answer missing a requested variable", () => {
    const body = [["B01003_001E", "zip code tabulation area"], ["10", "00501"]];
    expect(() => parseAcsRows(body, { kind: "zcta", zctas: ["00501"] })).toThrow(/no B01002_001E column/);
  });
});
