// Test doubles for the Qloo client: a fake clock, a scripted transport and synthetic bodies.
// Every entity, id and value here is invented (D29); request ids carry no digits.
import { DEFAULT_RUN_LIMITS, type QlooParams } from "@ct/contracts";
import { type QlooClientOptions, type RunScope, createQlooClient } from "../../src/client";
import { createMemoryQlooStore, type MemoryQlooStore } from "../../src/store";
import type { CanonicalRequest, QlooHeaders, Transport, TransportResponse } from "../../src/transport-types";

export const START = Date.UTC(2026, 9, 22, 12, 0, 0);
export const MINUTE = 60_000;
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
  headers?: Partial<QlooHeaders>;
  /** Rejects the attempt with this error instead of answering. */
  error?: unknown;
  /** Resolves only when this promise does (to hold a request in flight). */
  gate?: Promise<void>;
}

export interface FakeTransport extends Transport {
  readonly requests: CanonicalRequest[];
  readonly times: number[];
}

/** Letters-only suffixes keep fake request ids free of digits. */
export function letters(n: number): string {
  let s = "";
  let x = n;
  do {
    s = String.fromCharCode(97 + (x % 26)) + s;
    x = Math.floor(x / 26) - 1;
  } while (x >= 0);
  return s;
}

const encoder = new TextEncoder();

/**
 * A transport answering from `reply(request, attempt)`; the default answers every request with a
 * valid synthetic body and healthy rate-limit headers.
 */
export function fakeTransport(
  reply: (request: CanonicalRequest, attempt: number) => FakeReply | Promise<FakeReply> = () => ({}),
  clock?: FakeClock,
): FakeTransport {
  const requests: CanonicalRequest[] = [];
  const times: number[] = [];
  const transport = async (request: CanonicalRequest, signal?: AbortSignal): Promise<TransportResponse> => {
    const attempt = requests.length;
    requests.push(request);
    times.push(clock?.now() ?? 0);
    const r = await reply(request, attempt);
    if (r.gate) await r.gate;
    signal?.throwIfAborted();
    if (r.error !== undefined) throw r.error;
    const body = r.body === undefined ? bodyFor(request) : r.body;
    return {
      status: r.status ?? 200,
      body: encoder.encode(typeof body === "string" ? body : JSON.stringify(body)),
      headers: {
        requestId: `req-${letters(attempt)}`,
        monthLimit: 50_000,
        monthRemaining: 45_000,
        monthReset: 3_600,
        secondLimit: 10,
        secondRemaining: 9,
        secondReset: null,
        ...r.headers,
      },
      ms: 5,
    };
  };
  return Object.assign(transport, { requests, times });
}

/** A valid synthetic body for any request, shaped like the contracts schemas. */
export function bodyFor(request: CanonicalRequest): unknown {
  const entity = { entity_id: "ent-alpha-01", name: "Brand Alpha", types: ["urn:entity:brand"], popularity: 0.5 };
  switch (request.path) {
    case "/search":
    case "/entities":
      return { results: [entity] };
    case "/v2/tags":
      return { success: true, results: { tags: [{ id: "urn:tag:genre:brand:fixture", name: "Fixture", type: "urn:tag:genre:brand" }] } };
    case "/v2/audiences":
      return { success: true, results: { audiences: [{ id: "urn:audience:leisure:fixture", name: "Fixture Fans", type: "urn:audience" }] } };
    case "/v2/trending":
      return { success: true, results: { trending: [] } };
    case "/v2/insights":
      switch (request.filterType) {
        case "urn:heatmap":
          return { success: true, results: { heatmap: [] } };
        case "urn:tag":
          return { success: true, results: { tags: [{ tag_id: "urn:tag:genre:place:fixture", name: "Fixture" }] } };
        case "urn:demographics":
          return { success: true, results: { demographics: [] } };
        default:
          return { success: true, results: { entities: [{ ...entity, query: { affinity: 0.7 } }, { ...entity, entity_id: "ent-beta-02", name: "Brand Beta" }] } };
      }
  }
}

export function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function runScope(over: Partial<RunScope> = {}): RunScope {
  return {
    runId: "run-alpha",
    lane: "public",
    pillar: "investment",
    limits: DEFAULT_RUN_LIMITS,
    phase: () => "wave1",
    ...over,
  };
}

export interface Harness {
  client: ReturnType<typeof createQlooClient>;
  clock: FakeClock;
  store: MemoryQlooStore;
  transport: FakeTransport;
}

/** A client on a fake clock and a memory store; fast pacing unless the test sets rps. */
export function harness(
  over: Partial<QlooClientOptions> & { transport?: FakeTransport; store?: MemoryQlooStore; clock?: FakeClock } = {},
): Harness {
  const clock = over.clock ?? new FakeClock();
  const store = over.store ?? createMemoryQlooStore();
  const transport = over.transport ?? fakeTransport(undefined, clock);
  const client = createQlooClient({
    env: "dev",
    baseUrl: "https://hackathon.api.qloo.com",
    tag: "test-agent",
    tagCap: null,
    rps: 100,
    now: clock.now,
    sleep: clock.sleep,
    random: () => 0.5,
    ...over,
    transport,
    store,
  });
  return { client, clock, store, transport };
}

export const BRAND_PARAMS: QlooParams = { "signal.interests.entities": ["ent-alpha-01"], take: 10 };
export const SEARCH_PARAMS: QlooParams = { query: "Brand Alpha", types: "urn:entity:brand", take: 5 };
