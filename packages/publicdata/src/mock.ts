import { createHash } from "node:crypto";
import { type Now, realNow } from "@ct/qloo";
import listed from "../../../config/listed_companies.json";
import type { PublicRequest, PublicTransport, PublicTransportResponse } from "./api";
import { CENSUS_VARIABLES } from "./census";
import { osmAnswer } from "./osm/mock";

/**
 * The synthetic public-data transport (QLOO_MOCK=1): a clean clone runs SEC, Census and OpenStreetMap
 * reads with no key and no network. Every value is invented and a pure function of the request (sha256, never
 * Math.random), in the live response shapes:
 * - the ticker map lists every ticker of config/listed_companies.json (plus three invented ones) under
 *   an invented title and an invented CIK (0009xxxxxx), so the brand → ticker → CIK path works;
 * - company facts give four fiscal years and recent quarters of invented revenue, gross profit and
 *   operating income, with one restated fiscal year (a later 10-K changes it) and year-to-date points;
 * - Census answers ACS 5-year vintages up to two years before `now` (a later one is a 404, as live
 *   before Census publishes it), any 5-digit ZCTA, and for a county the tract codes 000100..129909
 *   (basic numbers 0001-1299, suffixes 00-09). Real tract codes outside that grid get no mock row.
 * Only the fixed ACS variables are answered; any other variable is a 400, as live.
 * - OpenStreetMap (Overpass) counts and named places come from osm/mock.ts, from the request's plan.
 */

export interface MockPublicFault {
  /** Substring of the path plus the unencoded query, e.g. "/api/xbrl/companyfacts/CIK0009". */
  match: string;
  status: number;
  /** Response body; defaults to a short error text. */
  body?: string;
  /** Fail this many matching attempts, then answer normally; every attempt when omitted. */
  times?: number;
}

export interface MockPublicTransportOptions {
  /** Simulated latency per attempt in ms. */
  latencyMs?: number;
  /** Injected failures, checked in order before any synthetic answer. */
  faults?: readonly MockPublicFault[];
  /** The clock that decides which fiscal periods and ACS vintages exist (default: real time). */
  now?: Now;
}

/** Invented tickers listed in the mock map besides the config ones (no real listing uses them). */
export const MOCK_EXTRA_TICKERS = ["ZZQA", "ZZQB", "ZZQC"] as const;

const DAY = 86_400_000;
const ALLOWED_VARIABLES: ReadonlySet<string> = new Set(Object.values(CENSUS_VARIABLES));
const TRACT_BASIC_MAX = 1299;
const TRACT_SUFFIXES = 10;

const hex = (...parts: readonly (string | number)[]): string => createHash("sha256").update(parts.join("|")).digest("hex");
/** Uniform [0, 1) from the parts. */
const unit = (...parts: readonly (string | number)[]): number => Number.parseInt(hex(...parts).slice(0, 13), 16) / 2 ** 52;
const between = (lo: number, hi: number, ...parts: readonly (string | number)[]): number => lo + unit(...parts) * (hi - lo);

interface MockCompany {
  cik: string;
  ticker: string;
  title: string;
}

let companiesMemo: { byTicker: Map<string, MockCompany>; byCik: Map<string, MockCompany> } | null = null;

/** The mock ticker map, built once: every listed ticker gets a unique invented CIK. */
export function mockCompanies(): { byTicker: Map<string, MockCompany>; byCik: Map<string, MockCompany> } {
  if (companiesMemo) return companiesMemo;
  const brands = (listed as { brands: Record<string, { ticker: string }> }).brands;
  const tickers = [...new Set([...Object.values(brands).map((b) => b.ticker.toUpperCase()), ...MOCK_EXTRA_TICKERS])].sort();
  const byTicker = new Map<string, MockCompany>();
  const byCik = new Map<string, MockCompany>();
  for (const ticker of tickers) {
    let n = Number.parseInt(hex("cik", ticker).slice(0, 8), 16) % 1_000_000;
    while (byCik.has(`0009${String(n).padStart(6, "0")}`)) n = (n + 1) % 1_000_000;
    const cik = `0009${String(n).padStart(6, "0")}`;
    const company = { cik, ticker, title: `Mock Listed Company ${ticker}` };
    byTicker.set(ticker, company);
    byCik.set(cik, company);
  }
  companiesMemo = { byTicker, byCik };
  return companiesMemo;
}

function tickerMapBody(): unknown {
  const out: Record<string, { cik_str: number; ticker: string; title: string }> = {};
  let i = 0;
  for (const c of mockCompanies().byTicker.values()) out[String(i++)] = { cik_str: Number(c.cik), ticker: c.ticker, title: c.title };
  return out;
}

const iso = (t: number): string => new Date(t).toISOString().slice(0, 10);
const utc = (y: number, m: number, d: number): number => Date.UTC(y, m, d);
/** The last day of month m (0-based) of year y. */
const monthEnd = (y: number, m: number): number => Date.UTC(y, m + 1, 0);

interface MockPoint {
  start: string;
  end: string;
  val: number;
  accn: string;
  fy: number;
  fp: string;
  form: string;
  filed: string;
}

/** Invented facts for one mock company, as of `now`. Calendar fiscal years. */
function companyFactsBody(company: MockCompany, now: number): unknown {
  const year = new Date(now).getUTCFullYear();
  const revenueConcept = unit("concept", company.cik) < 0.6 ? "RevenueFromContractWithCustomerExcludingAssessedTax" : "Revenues";
  const hasGross = unit("gross", company.cik) >= 0.2;
  const base = between(2e9, 60e9, "base", company.cik);
  const grossMargin = between(0.3, 0.65, "gm", company.cik);
  const opMargin = between(0.04, 0.22, "om", company.cik);
  const accn = (fy: number, seq: number): string =>
    `${company.cik}-${String(fy % 100).padStart(2, "0")}-${String(Number.parseInt(hex("accn", company.cik, fy, seq).slice(0, 6), 16) % 1_000_000).padStart(6, "0")}`;
  const revenue: MockPoint[] = [];
  const gross: MockPoint[] = [];
  const operating: MockPoint[] = [];
  const add = (start: number, end: number, rev: number, filing: { accn: string; fy: number; fp: string; form: string; filed: number }) => {
    const p = { start: iso(start), end: iso(end), accn: filing.accn, fy: filing.fy, fp: filing.fp, form: filing.form, filed: iso(filing.filed) };
    revenue.push({ ...p, val: Math.round(rev) });
    if (hasGross) gross.push({ ...p, val: Math.round(rev * grossMargin) });
    operating.push({ ...p, val: Math.round(rev * opMargin) });
  };
  const annual = (fy: number): number => base * (1 + between(-0.08, 0.15, "growth", company.cik, fy)) ** (fy - (year - 5));
  const quarterShare = (q: number): number => [0.23, 0.24, 0.25, 0.28][q] ?? 0.25;

  // Each 10-K reports its year and the two before; from the 10-K of year-2 on, year-3 is restated (×0.99).
  for (let fy = year - 4; fy <= year - 1; fy++) {
    const filed = utc(fy + 1, 1, 20);
    if (filed > now) continue;
    const filing = { accn: accn(fy, 0), fy, fp: "FY", form: "10-K", filed };
    for (let y = fy - 2; y <= fy; y++) {
      const restated = fy >= year - 2 && y === year - 3 ? 0.99 : 1;
      add(utc(y, 0, 1), utc(y, 11, 31), annual(y) * restated, filing);
    }
  }
  // 10-Qs for Q1-Q3 of the last two years: the quarter, its comparative, and the year-to-date figure.
  for (let fy = year - 1; fy <= year; fy++) {
    for (let q = 0; q < 3; q++) {
      const end = monthEnd(fy, q * 3 + 2);
      const filed = end + 40 * DAY;
      if (filed > now) continue;
      const filing = { accn: accn(fy, q + 1), fy, fp: `Q${q + 1}`, form: "10-Q", filed };
      for (const y of [fy - 1, fy]) {
        add(utc(y, q * 3, 1), monthEnd(y, q * 3 + 2), annual(y) * quarterShare(q), filing);
        if (q > 0) {
          const ytd = [0, 1, 2].slice(0, q + 1).reduce((s, k) => s + quarterShare(k), 0);
          add(utc(y, 0, 1), monthEnd(y, q * 3 + 2), annual(y) * ytd, filing);
        }
      }
    }
  }
  const concept = (points: MockPoint[]) => ({ label: "Mock concept", description: "Invented values.", units: { USD: points } });
  const gaap: Record<string, unknown> = { [revenueConcept]: concept(revenue), OperatingIncomeLoss: concept(operating) };
  if (hasGross) gaap.GrossProfit = concept(gross);
  return { cik: Number(company.cik), entityName: company.title, facts: { "us-gaap": gaap } };
}

// Census ----------------------------------------------------------------------------------------------------

function acsRow(vintage: number, geoId: string, kind: "zcta" | "tract"): Record<string, string | null> {
  const seed = (name: string) => unit("acs", vintage, geoId, name);
  const population = Math.round(kind === "zcta" ? 4_000 + seed("pop") * 42_000 : 1_200 + seed("pop") * 6_000);
  const workers = Math.round(population * (0.42 + seed("workers") * 0.16));
  const home = Math.round(workers * (0.06 + seed("home") * 0.18));
  const transit = Math.round(workers * seed("transit") * 0.25);
  const walked = Math.round(workers * seed("walk") * 0.08);
  const bicycle = Math.round(workers * seed("bike") * 0.03);
  const drove = Math.max(0, Math.round(workers * (0.5 + seed("drove") * 0.3)) - transit);
  // About one row in thirty has its median income withheld, as live tables do for small samples.
  const income = seed("suppress") < 1 / 30 ? "-666666666" : String(Math.round(32_000 + seed("income") * 150_000));
  return {
    [CENSUS_VARIABLES.population]: String(population),
    [CENSUS_VARIABLES.median_age]: (27 + seed("age") * 22).toFixed(1),
    [CENSUS_VARIABLES.households]: String(Math.round(population / (1.9 + seed("hh") * 1.0))),
    [CENSUS_VARIABLES.median_household_income]: income,
    [CENSUS_VARIABLES.workers]: String(workers),
    [CENSUS_VARIABLES.commute_drove_alone]: String(drove),
    [CENSUS_VARIABLES.commute_public_transit]: String(transit),
    [CENSUS_VARIABLES.commute_bicycle]: String(bicycle),
    [CENSUS_VARIABLES.commute_walked]: String(walked),
    [CENSUS_VARIABLES.commute_worked_from_home]: String(home),
  };
}

function censusAnswer(request: PublicRequest, now: number): { status: number; body: string } {
  const vintage = Number(/^\/data\/(\d{4})\/acs\/acs5$/.exec(request.path)?.[1] ?? Number.NaN);
  if (!Number.isInteger(vintage) || vintage > new Date(now).getUTCFullYear() - 2) return { status: 404, body: "404 Not Found" };
  const vars = (request.query.get ?? "").split(",");
  const unknown = vars.find((v) => !ALLOWED_VARIABLES.has(v));
  if (unknown !== undefined) return { status: 400, body: `error: unknown variable '${unknown}'` };
  const forClause = request.query.for ?? "";
  if (forClause.startsWith("zip code tabulation area:")) {
    const zctas = forClause.slice("zip code tabulation area:".length).split(",");
    const rows = zctas.map((z) => {
      const row = acsRow(vintage, z, "zcta");
      return [...vars.map((v) => row[v] ?? null), z];
    });
    return { status: 200, body: JSON.stringify([[...vars, "zip code tabulation area"], ...rows]) };
  }
  const m = /^state:(\d{2}) county:(\d{3})$/.exec(request.query.in ?? "");
  if (forClause === "tract:*" && m) {
    const [, state, county] = m as unknown as [string, string, string];
    const rows: (string | null)[][] = [];
    for (let basic = 1; basic <= TRACT_BASIC_MAX; basic++) {
      for (let suffix = 0; suffix < TRACT_SUFFIXES; suffix++) {
        const tract = `${String(basic).padStart(4, "0")}${String(suffix).padStart(2, "0")}`;
        const row = acsRow(vintage, `${state}${county}${tract}`, "tract");
        rows.push([...vars.map((v) => row[v] ?? null), state, county, tract]);
      }
    }
    return { status: 200, body: JSON.stringify([[...vars, "state", "county", "tract"], ...rows]) };
  }
  return { status: 400, body: "error: unknown/unsupported geography hierarchy" };
}

function secAnswer(request: PublicRequest, now: number): { status: number; body: string } {
  if (request.path === "/files/company_tickers.json") return { status: 200, body: JSON.stringify(tickerMapBody()) };
  const m = /^\/api\/xbrl\/companyfacts\/CIK(\d{10})\.json$/.exec(request.path);
  const company = m ? mockCompanies().byCik.get(m[1] ?? "") : undefined;
  if (company === undefined) return { status: 404, body: "<Error><Code>NoSuchKey</Code></Error>" };
  return { status: 200, body: JSON.stringify(companyFactsBody(company, now)) };
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createMockPublicTransport(options: MockPublicTransportOptions = {}): PublicTransport {
  const faults = options.faults ?? [];
  const faultUses = new Map<MockPublicFault, number>();
  const now = options.now ?? realNow;

  function injected(request: PublicRequest): { status: number; body: string } | null {
    const target = `${request.path}?${Object.entries(request.query)
      .map(([k, v]) => `${k}=${v}`)
      .join("&")}`;
    for (const fault of faults) {
      const uses = faultUses.get(fault) ?? 0;
      if (!target.includes(fault.match) || (fault.times !== undefined && uses >= fault.times)) continue;
      faultUses.set(fault, uses + 1);
      return { status: fault.status, body: fault.body ?? `mock fault ${fault.status}` };
    }
    return null;
  }

  return async (request, signal): Promise<PublicTransportResponse> => {
    const started = performance.now();
    signal?.throwIfAborted();
    if (options.latencyMs !== undefined && options.latencyMs > 0) await sleep(options.latencyMs, signal);
    const reply =
      injected(request) ??
      (request.source === "sec" ? secAnswer(request, now()) : request.source === "osm" ? osmAnswer(request) : censusAnswer(request, now()));
    return { status: reply.status, body: reply.body, ms: Math.round(performance.now() - started) };
  };
}
