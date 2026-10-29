// Test doubles for the public-data client: a fake clock, a scripted transport and invented bodies.
// Every company, CIK, accession and value here is invented (D29).
import type { PublicDataClientOptions, PublicRequest, PublicTransport, PublicTransportResponse } from "../../src/api";
import { createPublicDataClient } from "../../src/client";
import { createMemoryPublicStore, type MemoryPublicStore } from "../../src/store";

export const START = Date.UTC(2026, 9, 22, 12, 0, 0);
export const DAY = 86_400_000;

/** Time moves only when code sleeps or a test advances it. */
export class FakeClock {
  t: number;
  readonly sleeps: number[] = [];

  constructor(start: number = START) {
    this.t = start;
  }

  readonly now = (): number => this.t;

  readonly sleep = async (ms: number, signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    this.sleeps.push(ms);
    this.t += ms;
    await Promise.resolve();
    signal?.throwIfAborted();
  };

  advance(ms: number): void {
    this.t += ms;
  }
}

export interface FakeReply {
  status?: number;
  /** JSON-serialised unless it is already a string. */
  body?: unknown;
  /** Rejects the attempt with this error instead of answering. */
  error?: unknown;
  /** Resolves only when this promise does (to hold a request in flight). */
  gate?: Promise<void>;
}

export interface FakeTransport extends PublicTransport {
  readonly requests: PublicRequest[];
  readonly times: number[];
}

/** A transport answering from `reply(request, attempt)`; the default answers with a valid invented body. */
export function fakeTransport(
  reply: (request: PublicRequest, attempt: number) => FakeReply | Promise<FakeReply> = () => ({}),
  clock?: FakeClock,
): FakeTransport {
  const requests: PublicRequest[] = [];
  const times: number[] = [];
  const transport = async (request: PublicRequest, signal?: AbortSignal): Promise<PublicTransportResponse> => {
    const attempt = requests.length;
    requests.push(request);
    times.push(clock?.now() ?? 0);
    const r = await reply(request, attempt);
    if (r.gate) await r.gate;
    signal?.throwIfAborted();
    if (r.error !== undefined) throw r.error;
    const body = r.body === undefined ? bodyFor(request) : r.body;
    return { status: r.status ?? 200, body: typeof body === "string" ? body : JSON.stringify(body), ms: 5 };
  };
  return Object.assign(transport, { requests, times });
}

export const FIXTURE_CIK = "0000000042";

export const TICKER_MAP = {
  "0": { cik_str: 42, ticker: "ZZQA", title: "Alpha Fixture Holdings" },
  "1": { cik_str: 43, ticker: "ZZQ-B", title: "Beta Fixture Group" },
  "2": { cik_str: 44, ticker: "zzqc", title: "Gamma Fixture Inc." },
};

const point = (over: Record<string, unknown>) => ({
  start: "2024-01-01",
  end: "2024-12-31",
  val: 1_000,
  accn: "0000000042-25-000001",
  fy: 2024,
  fp: "FY",
  form: "10-K",
  filed: "2025-02-20",
  ...over,
});

/** Invented company facts: a restated fiscal year, a quarter, a year-to-date figure and noise to drop. */
export const COMPANY_FACTS = {
  cik: 42,
  entityName: "Alpha Fixture Holdings",
  facts: {
    dei: { EntityCommonStockSharesOutstanding: { units: { shares: [point({ val: 7 })] } } },
    "us-gaap": {
      RevenueFromContractWithCustomerExcludingAssessedTax: {
        label: "Revenue",
        units: {
          USD: [
            // FY2023 as first filed, then restated in the FY2024 10-K.
            point({ start: "2023-01-01", end: "2023-12-31", val: 900, accn: "0000000042-24-000001", fy: 2023, filed: "2024-02-20" }),
            point({ start: "2023-01-01", end: "2023-12-31", val: 880, accn: "0000000042-25-000001", fy: 2024, filed: "2025-02-20" }),
            point({ val: 1_000 }),
            // A quarter and a six-month year-to-date figure from a 10-Q.
            point({ start: "2025-04-01", end: "2025-06-30", val: 260, accn: "0000000042-25-000005", fy: 2025, fp: "Q2", form: "10-Q", filed: "2025-08-05" }),
            point({ start: "2025-01-01", end: "2025-06-30", val: 500, accn: "0000000042-25-000005", fy: 2025, fp: "Q2", form: "10-Q", filed: "2025-08-05" }),
            // An 8-K value: not a periodic report, dropped.
            point({ start: "2024-10-01", end: "2024-12-31", val: 999, form: "8-K", filed: "2025-01-15" }),
            // Malformed: dropped.
            { end: "2024-12-31", val: "lots", accn: "x", form: "10-K", filed: "2025-02-20" },
          ],
          EUR: [point({ val: 5 })],
        },
      },
      GrossProfit: { label: "Gross profit", units: { USD: [point({ val: 400 })] } },
      OperatingIncomeLoss: { label: "Operating income", units: { USD: [point({ val: -50 })] } },
      AccountsPayableCurrent: { label: "Not read", units: { USD: [point({ val: 3 })] } },
    },
  },
};

/** ACS answer for invented ZCTAs, values as strings, with withheld and missing estimates. */
export function acsZctaBody(get: string, zctas: readonly string[]): unknown {
  const vars = get.split(",");
  const rows = zctas.map((z, i) => [...vars.map((v, j) => (v === "B19013_001E" && i === 1 ? "-666666666" : v === "B01002_001E" && i === 2 ? null : String(1000 * (i + 1) + j))), z]);
  return [[...vars, "zip code tabulation area"], ...rows];
}

export function acsTractBody(get: string, state: string, county: string): unknown {
  const vars = get.split(",");
  return [
    [...vars, "state", "county", "tract"],
    [...vars.map((_, j) => String(100 + j)), state, county, "000100"],
    [...vars.map((_, j) => String(200 + j)), state, county, "000201"],
  ];
}

/** A valid invented body for any request. */
export function bodyFor(request: PublicRequest): unknown {
  if (request.endpoint === "/files/company_tickers.json") return TICKER_MAP;
  if (request.endpoint === "/api/xbrl/companyfacts") return COMPANY_FACTS;
  const get = request.query.get ?? "";
  const forClause = request.query.for ?? "";
  if (forClause.startsWith("zip code tabulation area:")) return acsZctaBody(get, forClause.split(":")[1]?.split(",") ?? []);
  const m = /^state:(\d+) county:(\d+)$/.exec(request.query.in ?? "");
  return acsTractBody(get, m?.[1] ?? "00", m?.[2] ?? "000");
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export interface Harness {
  client: ReturnType<typeof createPublicDataClient>;
  clock: FakeClock;
  store: MemoryPublicStore;
  transport: FakeTransport;
}

/** A client on a fake clock and a memory store; fast pacing unless the test sets rps. */
export function harness(
  over: Partial<PublicDataClientOptions> & { transport?: FakeTransport; store?: MemoryPublicStore; clock?: FakeClock } = {},
): Harness {
  const clock = over.clock ?? new FakeClock();
  const store = over.store ?? createMemoryPublicStore();
  const transport = over.transport ?? fakeTransport(undefined, clock);
  const client = createPublicDataClient({
    env: "dev",
    tag: "test-agent",
    secUserAgent: "Culture Terminal test@culture-terminal.dev",
    rps: { sec: 100, census: 100 },
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    ...over,
    transport,
    store,
  });
  return { client, clock, store, transport };
}
