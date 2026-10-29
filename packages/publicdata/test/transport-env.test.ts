import { publicDataErrorCode } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { createPublicDataClient } from "../src/client";
import { CENSUS_GET, CENSUS_VARIABLES, censusRequest } from "../src/census";
import { publicDataOptionsFromEnv } from "../src/env";
import { createPublicHttpTransport, publicUrl } from "../src/http-transport";
import { createMockPublicTransport, MOCK_EXTRA_TICKERS, mockCompanies } from "../src/mock";
import { secFactsRequest, secTickersRequest } from "../src/sec";
import { createMemoryPublicStore } from "../src/store";
import { FakeClock, START } from "./support/fakes";

const UA = "Culture Terminal test@culture-terminal.dev";
const FAKE_KEY = "fake-census-key-for-tests";

interface Seen {
  url: string;
  headers: Record<string, string>;
  redirect: RequestInit["redirect"];
}

function fakeFetch(status = 200, body = "{}"): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input), headers: { ...(init?.headers as Record<string, string>) }, redirect: init?.redirect });
    return new Response(status === 204 ? null : body, { status });
  };
  return { fetch: impl as typeof fetch, seen };
}

describe("live transport", () => {
  it("sends SEC_USER_AGENT verbatim to SEC, never follows redirects", async () => {
    const f = fakeFetch(200, '{"a":1}');
    const transport = createPublicHttpTransport({ secUserAgent: UA, censusApiKey: null, fetch: f.fetch });
    const res = await transport(secFactsRequest("42"));
    expect(res).toMatchObject({ status: 200, body: '{"a":1}' });
    expect(f.seen[0]).toMatchObject({
      url: "https://data.sec.gov/api/xbrl/companyfacts/CIK0000000042.json",
      headers: { "User-Agent": UA, Accept: "application/json" },
      redirect: "manual",
    });
    await transport(secTickersRequest());
    expect(f.seen[1]?.url).toBe("https://www.sec.gov/files/company_tickers.json");
  });

  it("adds the Census key on the wire only, and splits the in clause", async () => {
    const f = fakeFetch(200, "[]");
    const transport = createPublicHttpTransport({ secUserAgent: null, censusApiKey: FAKE_KEY, fetch: f.fetch });
    expect(transport.censusKeyed).toBe(true);
    const request = censusRequest(2024, { kind: "tract", state: "01", county: "002" });
    await transport(request);
    expect(f.seen[0]?.url).toBe(`https://api.census.gov/data/2024/acs/acs5?for=tract:*&get=${CENSUS_GET}&in=state:01&in=county:002&key=${FAKE_KEY}`);
    expect(f.seen[0]?.headers["User-Agent"]).toBeUndefined();
    expect(publicUrl(request)).not.toContain(FAKE_KEY);
    expect(JSON.stringify(request)).not.toContain(FAKE_KEY);
    const zcta = censusRequest(2024, { kind: "zcta", zctas: ["00501"] });
    expect(publicUrl(zcta)).toBe(`https://api.census.gov/data/2024/acs/acs5?for=zip%20code%20tabulation%20area:00501&get=${CENSUS_GET}`);
  });

  it("refuses to send without a User-Agent or a Census key", async () => {
    const f = fakeFetch();
    const transport = createPublicHttpTransport({ secUserAgent: null, censusApiKey: null, fetch: f.fetch });
    expect(transport.censusKeyed).toBe(false);
    expect(publicDataErrorCode(await transport(secTickersRequest()).catch((e: unknown) => e))).toBe("not_configured");
    const census = censusRequest(2024, { kind: "zcta", zctas: ["00501"] });
    expect(publicDataErrorCode(await transport(census).catch((e: unknown) => e))).toBe("not_configured");
    expect(f.seen).toHaveLength(0);
    expect(() => createPublicHttpTransport({ secUserAgent: "bad\nagent", censusApiKey: null })).toThrow(/printable ASCII/);
  });

  it("reports a network failure without the URL (which carries the key)", async () => {
    const failing = (async () => {
      throw Object.assign(new TypeError(`fetch failed for key=${FAKE_KEY}`), { cause: { code: "ECONNRESET" } });
    }) as typeof fetch;
    const transport = createPublicHttpTransport({ secUserAgent: null, censusApiKey: FAKE_KEY, fetch: failing });
    const err = await transport(censusRequest(2024, { kind: "zcta", zctas: ["00501"] })).catch((e: unknown) => e);
    expect(publicDataErrorCode(err)).toBe("unavailable");
    expect((err as Error).message).toBe("request to api.census.gov failed (TypeError:ECONNRESET)");
  });

  it("caps the body size", async () => {
    const f = fakeFetch(200, "x".repeat(64));
    const transport = createPublicHttpTransport({ secUserAgent: UA, censusApiKey: null, fetch: f.fetch, maxBytes: 16 });
    expect(publicDataErrorCode(await transport(secTickersRequest()).catch((e: unknown) => e))).toBe("invalid_response");
  });
});

describe("environment", () => {
  const store = createMemoryPublicStore();

  it("QLOO_MOCK=1 selects the mock transport with both sources configured", () => {
    const options = publicDataOptionsFromEnv({ QLOO_MOCK: "1", QLOO_TAG: "agent-x" } as NodeJS.ProcessEnv, { store });
    expect(options).toMatchObject({ env: "mock", tag: "agent-x", secUserAgent: null });
    const client = createPublicDataClient(options);
    expect(client.configured).toEqual({ sec: true, census: true });
  });

  it("live: SEC needs SEC_USER_AGENT and Census needs CENSUS_API_KEY; unset leaves them unconfigured", () => {
    const bare = createPublicDataClient(publicDataOptionsFromEnv({} as NodeJS.ProcessEnv, { store }));
    expect(bare.env).toBe("dev");
    expect(bare.configured).toEqual({ sec: false, census: false });
    const full = publicDataOptionsFromEnv({ SEC_USER_AGENT: ` ${UA} `, CENSUS_API_KEY: FAKE_KEY, NODE_ENV: "production" } as NodeJS.ProcessEnv, { store });
    expect(full).toMatchObject({ env: "prod", secUserAgent: UA, tag: "dev" });
    expect(JSON.stringify(full)).not.toContain(FAKE_KEY);
    expect(createPublicDataClient(full).configured).toEqual({ sec: true, census: true });
    expect(() => publicDataOptionsFromEnv({ SEC_USER_AGENT: `Culture Terminal ${String.fromCharCode(233)}` } as NodeJS.ProcessEnv, { store })).toThrow(/printable ASCII/);
    expect(() => publicDataOptionsFromEnv({ QLOO_MOCK: "yes" } as NodeJS.ProcessEnv, { store })).toThrow(/QLOO_MOCK/);
  });
});

describe("mock transport", () => {
  const clock = new FakeClock();
  const client = createPublicDataClient({
    env: "mock",
    transport: createMockPublicTransport({ now: clock.now }),
    store: createMemoryPublicStore(),
    tag: "test-agent",
    secUserAgent: null,
    now: clock.now,
    sleep: clock.sleep,
  });
  const api = client.standalone().forTool(null);

  it("runs ticker → CIK → facts on invented data with mock references", async () => {
    const ticker = await api.secTicker(MOCK_EXTRA_TICKERS[0]);
    expect(ticker.data?.title).toBe(`Mock Listed Company ${MOCK_EXTRA_TICKERS[0]}`);
    expect(ticker.data?.cik).toMatch(/^0009\d{6}$/);
    expect(ticker.meta.reference).toMatch(/^mock-[0-9a-f]{16}$/);
    const facts = await api.secCompanyFacts(ticker.data?.cik ?? "");
    const annual = facts.data.points.filter((p) => p.span === "annual" && p.concept !== "GrossProfit" && p.concept !== "OperatingIncomeLoss");
    expect(annual.map((p) => p.end)).toEqual(["2020-12-31", "2021-12-31", "2022-12-31", "2023-12-31", "2024-12-31", "2025-12-31"]);
    // The restated year keeps the later filing.
    const fy2023 = annual.find((p) => p.end === "2023-12-31");
    expect(fy2023?.filed).toBe("2026-02-20");
    expect(facts.data.points.some((p) => p.span === "quarterly" && p.end === "2026-06-30")).toBe(true);
    expect(publicDataErrorCode(await api.secCompanyFacts("1").catch((e: unknown) => e))).toBe("not_found");
  });

  it("lists every configured ticker under a unique invented CIK", () => {
    const { byTicker, byCik } = mockCompanies();
    expect(byTicker.size).toBe(byCik.size);
    expect(byTicker.size).toBeGreaterThan(MOCK_EXTRA_TICKERS.length);
  });

  it("answers Census deterministically, from two years back, with withheld values", async () => {
    const zctas = Array.from({ length: 40 }, (_, i) => String(10_001 + i));
    const a = await api.censusAcs({ kind: "zcta", zctas });
    expect(a.data.vintage).toBe(new Date(START).getUTCFullYear() - 2);
    expect(a.data.rows).toHaveLength(40);
    const transport = createMockPublicTransport({ now: clock.now });
    const request = censusRequest(a.data.vintage, { kind: "zcta", zctas });
    expect((await transport(request)).body).toBe((await transport(request)).body);
    const tracts = await api.censusAcs({ kind: "tract", state: "01", county: "002" });
    expect(tracts.data.rows.some((r) => r.geoId === "01002000100")).toBe(true);
    expect(tracts.data.rows.some((r) => r.values.median_household_income === null)).toBe(true);
    const bad = await transport({ ...request, query: { ...request.query, get: `${CENSUS_VARIABLES.population},B02001_002E` } });
    expect(bad.status).toBe(400);
  });
});
