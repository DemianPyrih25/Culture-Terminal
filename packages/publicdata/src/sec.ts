import {
  PUBLIC_ENDPOINTS,
  SecConcept,
  type SecCompany,
  type SecCompanyFacts,
  type SecFactPoint,
} from "@ct/contracts";
import { z } from "zod";
import { PublicDataError, type PublicRequest } from "./api";

/**
 * SEC EDGAR (PLAN §5.2): the ticker map (`www.sec.gov/files/company_tickers.json`) and XBRL company
 * facts (`data.sec.gov/api/xbrl/companyfacts/CIK##########.json`). Only the us-gaap SecConcepts in
 * USD are read. Shapes checked live: the ticker map is `{"0": {cik_str, ticker, title}, …}`; company
 * facts are `{cik, entityName, facts: {"us-gaap": {<concept>: {label, description, units: {USD:
 * [{start?, end, val, accn, fy, fp, form, filed, frame?}]}}}}}`.
 */

export const SEC_TICKERS_HOST = PUBLIC_ENDPOINTS["/files/company_tickers.json"].host;
export const SEC_FACTS_HOST = PUBLIC_ENDPOINTS["/api/xbrl/companyfacts"].host;

export const SEC_TICKERS_REFERENCE = "company_tickers.json";

export function secTickersRequest(): PublicRequest {
  return { source: "sec", endpoint: "/files/company_tickers.json", host: SEC_TICKERS_HOST, path: "/files/company_tickers.json", query: {} };
}

/** A CIK as SEC writes it in URLs: 10 digits, zero-padded. Throws bad_request for anything else. */
export function padCik(cik: string | number): string {
  const text = String(cik).trim().replace(/^CIK/i, "");
  if (!/^\d{1,10}$/.test(text) || Number(text) === 0) {
    throw new PublicDataError("bad_request", `"${String(cik).slice(0, 20)}" is not an SEC CIK`, { source: "sec" });
  }
  return text.padStart(10, "0");
}

export function secFactsRequest(cik: string): PublicRequest {
  return {
    source: "sec",
    endpoint: "/api/xbrl/companyfacts",
    host: SEC_FACTS_HOST,
    path: `/api/xbrl/companyfacts/CIK${padCik(cik)}.json`,
    query: {},
  };
}

/** The reference of a company-facts call: `CIK##########`. */
export const secFactsReference = (cik: string): string => `CIK${padCik(cik)}`;

// Ticker map -----------------------------------------------------------------------------------------------

const TickerRow = z.object({ cik_str: z.union([z.number(), z.string()]), ticker: z.string(), title: z.string() });
const TickerMapBody = z.record(z.string(), z.unknown());

/** Tickers as SEC lists them: upper case, class shares with a dash (BRK.B and BRK/B read as BRK-B). */
export function normalizeTicker(ticker: string): string {
  const text = ticker.trim().toUpperCase().replace(/[./]/g, "-");
  if (!/^[A-Z0-9][A-Z0-9-]{0,11}$/.test(text)) {
    throw new PublicDataError("bad_request", `"${ticker.slice(0, 20)}" is not a stock ticker`, { source: "sec" });
  }
  return text;
}

/** Checks the ticker map shape; throws on a body that is not a ticker map. */
export function validateTickerMap(json: unknown): void {
  const body = TickerMapBody.parse(json);
  const first = Object.values(body)[0];
  if (first === undefined) throw new Error("the ticker map is empty");
  TickerRow.parse(first);
}

/** The ticker map as a lookup by normalised ticker. Malformed rows are skipped. */
export function parseTickerMap(json: unknown): Map<string, SecCompany> {
  const out = new Map<string, SecCompany>();
  for (const value of Object.values(TickerMapBody.parse(json))) {
    const row = TickerRow.safeParse(value);
    if (!row.success) continue;
    let ticker: string;
    let cik: string;
    try {
      ticker = normalizeTicker(row.data.ticker);
      cik = padCik(row.data.cik_str);
    } catch {
      continue;
    }
    // The first listing of a ticker wins, as in the file's own order.
    if (!out.has(ticker)) out.set(ticker, { cik, ticker, title: row.data.title.trim() });
  }
  return out;
}

// Company facts ---------------------------------------------------------------------------------------------

const RawPoint = z.object({
  start: z.string().optional(),
  end: z.string(),
  val: z.number(),
  accn: z.string(),
  fy: z.number().nullable().optional(),
  fp: z.string().nullable().optional(),
  form: z.string(),
  filed: z.string(),
});
type RawPoint = z.infer<typeof RawPoint>;

const FactsBody = z.object({
  cik: z.union([z.number(), z.string()]),
  entityName: z.string(),
  facts: z.record(z.string(), z.unknown()).optional(),
});

const ConceptBody = z.object({ units: z.record(z.string(), z.array(z.unknown())) });

/** Periodic reports whose values describe a fiscal period: 10-K, 10-Q, their amendments and transition reports. */
const PERIODIC_FORM = /^10-(K|Q|KT|QT)(\/A)?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/** A 52/53-week or calendar fiscal year. */
const ANNUAL_DAYS = { min: 350, max: 380 } as const;
/** A 13/14-week or calendar quarter. */
const QUARTER_DAYS = { min: 80, max: 100 } as const;

/**
 * Reduces a company-facts body to what the client keeps: the SecConcepts' USD points. The full file is
 * several MB; the cached copy holds only these concepts (the provenance still names the full URL).
 * Throws when the body is not a company-facts file.
 */
export function reduceCompanyFacts(json: unknown): unknown {
  const body = FactsBody.parse(json);
  const gaap = body.facts?.["us-gaap"];
  const concepts: Record<string, { units: { USD: unknown[] } }> = {};
  if (typeof gaap === "object" && gaap !== null) {
    for (const concept of SecConcept.options) {
      const parsed = ConceptBody.safeParse((gaap as Record<string, unknown>)[concept]);
      const usd = parsed.success ? parsed.data.units.USD : undefined;
      if (usd !== undefined) concepts[concept] = { units: { USD: usd } };
    }
  }
  return { cik: body.cik, entityName: body.entityName, facts: { "us-gaap": concepts } };
}

/** Days from the period's first to its last day (2024-01-01..2024-12-31 is 365; a 52-week year is 363). */
function durationDays(start: string, end: string): number {
  return Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS);
}

function spanOf(point: RawPoint): SecFactPoint["span"] {
  if (point.start === undefined) return "other";
  const days = durationDays(point.start, point.end);
  if (point.form.startsWith("10-K") && days >= ANNUAL_DAYS.min && days <= ANNUAL_DAYS.max) return "annual";
  if (point.form.startsWith("10-Q") && days >= QUARTER_DAYS.min && days <= QUARTER_DAYS.max) return "quarterly";
  return "other";
}

/** True when `a` was filed after `b` (accession breaks a same-day tie). */
const filedAfter = (a: RawPoint, b: RawPoint): boolean => a.filed > b.filed || (a.filed === b.filed && a.accn > b.accn);

/**
 * Parsed company facts: every SecConcept point in USD from a periodic report. For one concept and
 * period (start, end) only the latest-filed value is kept, so a restatement replaces the original and
 * a prior-year comparative carries the latest filing's figure. Points are ordered by concept (the
 * SecConcept order), then period end, then start. Malformed points are skipped.
 */
export function parseCompanyFacts(json: unknown, cik: string): SecCompanyFacts {
  const body = FactsBody.parse(json);
  const gaap = body.facts?.["us-gaap"];
  const points: SecFactPoint[] = [];
  for (const concept of SecConcept.options) {
    const parsed = ConceptBody.safeParse(typeof gaap === "object" && gaap !== null ? (gaap as Record<string, unknown>)[concept] : undefined);
    if (!parsed.success) continue;
    const latest = new Map<string, RawPoint>();
    for (const raw of parsed.data.units.USD ?? []) {
      const point = RawPoint.safeParse(raw);
      if (!point.success) continue;
      const p = point.data;
      if (!Number.isFinite(p.val) || !PERIODIC_FORM.test(p.form) || !ISO_DATE.test(p.end) || !ISO_DATE.test(p.filed)) continue;
      if (p.start !== undefined && !ISO_DATE.test(p.start)) continue;
      const period = `${p.start ?? ""}|${p.end}`;
      const current = latest.get(period);
      if (current === undefined || filedAfter(p, current)) latest.set(period, p);
    }
    const kept = [...latest.values()].sort((a, b) => a.end.localeCompare(b.end) || (a.start ?? "").localeCompare(b.start ?? ""));
    for (const p of kept) {
      points.push({
        concept,
        unit: "USD",
        value: p.val,
        start: p.start ?? null,
        end: p.end,
        fy: p.fy ?? null,
        fp: p.fp ?? null,
        form: p.form,
        filed: p.filed,
        accession: p.accn,
        span: spanOf(p),
      });
    }
  }
  return { cik: padCik(cik), entityName: body.entityName.trim(), points };
}
