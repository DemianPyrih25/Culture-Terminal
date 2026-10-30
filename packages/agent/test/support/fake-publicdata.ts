// A scripted public-data client for runAgent tests: the PublicDataClient contract with invented SEC,
// Census and OpenStreetMap answers (a made-up CIK, invented figures and places; D29), call records with
// provenance, and the `public` records the run turns into events. No network.
import type {
  CensusAcsData,
  CensusGeo,
  OsmCounts,
  OsmPlace,
  PublicCallMeta,
  PublicDataApi,
  SecCompany,
  SecCompanyFacts,
  SecFactPoint,
} from "@ct/contracts";
import { publicProvenanceRequest, type PublicCallRecord, type PublicDataClient, type RunPublic } from "@ct/publicdata";

const FETCHED = "2026-10-21T08:00:00.000Z";

/** Three fiscal years of invented revenue, gross profit and operating income, plus a later quarter. */
function inventedFacts(cik: string): SecCompanyFacts {
  const point = (concept: SecFactPoint["concept"], value: number, start: string, end: string, fy: number, fp: string, form: string, filed: string): SecFactPoint => ({
    concept,
    unit: "USD",
    value,
    start,
    end,
    fy,
    fp,
    form,
    filed,
    accession: `0000000000-${filed.slice(2, 4)}-00000${fy % 10}`,
    span: form === "10-K" ? "annual" : "quarterly",
  });
  const year = (fy: number, revenue: number) => [
    point("Revenues", revenue, `${fy - 1}-02-01`, `${fy}-01-31`, fy, "FY", "10-K", `${fy}-03-20`),
    point("GrossProfit", revenue * 0.4, `${fy - 1}-02-01`, `${fy}-01-31`, fy, "FY", "10-K", `${fy}-03-20`),
    point("OperatingIncomeLoss", revenue * 0.1, `${fy - 1}-02-01`, `${fy}-01-31`, fy, "FY", "10-K", `${fy}-03-20`),
  ];
  return {
    cik,
    entityName: "Invented Holdings Inc.",
    points: [
      ...year(2023, 900_000_000),
      ...year(2024, 1_000_000_000),
      ...year(2025, 1_150_000_000),
      point("Revenues", 310_000_000, "2025-02-01", "2025-04-30", 2026, "Q1", "10-Q", "2025-06-05"),
    ],
  };
}

export interface FakePublicData extends PublicDataClient {
  /** Every call record, in order. */
  readonly records: PublicCallRecord[];
}

/** `configured` mirrors PublicDataClient.configured: a source set to false is one the server cannot read (D7). */
export function fakePublicData(options: { configured?: { sec?: boolean; census?: boolean; osm?: boolean } } = {}): FakePublicData {
  const records: PublicCallRecord[] = [];
  let next = 0;
  const forScope = (runId: string | null, onCall?: (record: PublicCallRecord) => void): RunPublic => {
    const own = new Map<string, PublicCallRecord>();
    const answer = <T>(toolCallId: string | null, record: Omit<PublicCallRecord, "publicCallId" | "toolCallId" | "runId" | "cache" | "stale" | "ms" | "status" | "cacheAgeMs" | "originRunId" | "fetchedAt" | "error" | "paramsRedacted">, data: T) => {
      next += 1;
      const full: PublicCallRecord = {
        ...record,
        publicCallId: `pc-fake-${next}`,
        toolCallId,
        runId,
        paramsRedacted: { ...record.query },
        cache: "miss",
        stale: false,
        ms: 5,
        status: 200,
        cacheAgeMs: null,
        originRunId: null,
        fetchedAt: FETCHED,
        error: null,
      };
      records.push(full);
      own.set(full.publicCallId, full);
      onCall?.(full);
      const meta: PublicCallMeta = {
        publicCallId: full.publicCallId,
        source: full.source,
        endpoint: full.endpoint,
        reference: full.reference!,
        cache: full.cache,
        fetchedAt: FETCHED,
        ms: full.ms,
        stale: false,
        originRunId: null,
      };
      return Promise.resolve({ data, meta });
    };
    const api = (toolCallId: string | null): PublicDataApi => ({
      secTicker: (ticker) => {
        const company: SecCompany = { cik: "0000000001", ticker, title: "Invented Holdings Inc." };
        const base = { source: "sec" as const, endpoint: "/files/company_tickers.json" as const, host: "www.sec.gov", path: "/files/company_tickers.json", query: {} };
        return answer(toolCallId, { ...base, reference: "company_tickers.json" }, company as SecCompany | null);
      },
      secCompanyFacts: (cik) => {
        const base = { source: "sec" as const, endpoint: "/api/xbrl/companyfacts" as const, host: "data.sec.gov", path: `/api/xbrl/companyfacts/CIK${cik}.json`, query: {} };
        return answer(toolCallId, { ...base, reference: `CIK${cik}` }, inventedFacts(cik));
      },
      censusAcs: (geo: CensusGeo) => {
        const data: CensusAcsData = { vintage: 2023, dataset: "acs/acs5", rows: [] };
        const where = geo.kind === "zcta" ? `zcta ${geo.zctas.join(",")}` : `tract ${geo.state}${geo.county}`;
        const base = { source: "census" as const, endpoint: "/data/acs/acs5" as const, host: "api.census.gov", path: "/data/2023/acs/acs5", query: { for: where } };
        return answer(toolCallId, { ...base, reference: `acs5 2023 ${where}` }, data);
      },
      osmCounts: (q) => {
        // Invented counts: a fixed number per shape and type, so tests can read them back.
        const counts: OsmCounts["counts"] = Object.fromEntries(q.shapes.map((sh, i) => [sh.id, Object.fromEntries(q.types.map((t, j) => [t.key, 3 + i + j]))]));
        const data: OsmCounts = { counts, osmBase: "2026-10-01T00:00:00Z" };
        const base = { source: "osm" as const, endpoint: "/api/interpreter" as const, host: "overpass.example.org", path: "/api/interpreter", query: {}, method: "POST" as const, body: "[out:json];" };
        return answer(toolCallId, { ...base, reference: "osm-2026-10-01T00:00:00Z" }, data);
      },
      osmPlaces: (q) => {
        const places: OsmPlace[] = q.types.slice(0, 1).map((t, i) => ({ name: `Example Place ${i + 1}`, brand: null, lat: 36.1, lon: -86.7, typeKey: t.key, osmType: "node", osmId: 1000 + i }));
        const base = { source: "osm" as const, endpoint: "/api/interpreter" as const, host: "overpass.example.org", path: "/api/interpreter", query: {}, method: "POST" as const, body: "[out:json];" };
        return answer(toolCallId, { ...base, reference: "osm-2026-10-01T00:00:00Z" }, places);
      },
    });
    return {
      forTool: api,
      provenance: (id) => {
        const record = own.get(id);
        return record === undefined ? null : publicProvenanceRequest(record);
      },
      call: (id) => own.get(id) ?? null,
    };
  };
  return {
    env: "mock",
    configured: { sec: options.configured?.sec ?? true, census: options.configured?.census ?? true, osm: options.configured?.osm ?? true },
    records,
    forRun: (scope) => forScope(scope.runId, scope.onCall),
    standalone: (options) => forScope(null, options?.onCall),
    flush: () => Promise.resolve(),
  };
}
