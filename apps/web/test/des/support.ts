// Stand-ins for the DES service: a Qloo client on the mock transport and a memory store (no key, no
// network, no database), whose lane scopes are recorded, and a clock tests move by hand. The mock
// echoes any name as an exact match, offers twins for a name with "twin" and no exact match for one
// with "notfound", so every entity here is invented (D29).
import type { GeoApi } from "@ct/contracts";
import { createGeo } from "@ct/geo";
import { BudgetError, createMemoryQlooStore, createMockTransport, createQlooClient, type BudgetGate, type QlooClient, type RunScope } from "@ct/qloo";
import type { DesQuery } from "../../components/des/des-href";
import type { DesDeps, DesMode, DesRequest, DesServiceOptions } from "../../server/des/service";

export const START = Date.parse("2026-10-23T09:00:00.000Z");

/** A clock tests move by hand. */
export function clock(at = START) {
  const c = { ms: at, now: () => c.ms };
  return c;
}

/** A mock-transport client with no rate limit to wait on, and every lane scope it opened. */
export function mockQloo(): { client: QlooClient; scopes: RunScope[] } {
  const client = createQlooClient({
    transport: createMockTransport(),
    env: "mock",
    baseUrl: "https://mock.invalid",
    tag: "des-test",
    tagCap: null,
    rps: 1000,
    store: createMemoryQlooStore(),
  });
  const scopes: RunScope[] = [];
  const forRun = client.forRun.bind(client);
  client.forRun = (scope) => {
    scopes.push(scope);
    return forRun(scope);
  };
  return { client, scopes };
}

/** A client whose every lane scope is refused by a budget gate (the day's lane cap by default), as the gates refuse it. */
export function cappedQloo(gate: BudgetGate = "daily_lane_cap"): QlooClient {
  const { client } = mockQloo();
  const forRun = client.forRun.bind(client);
  client.forRun = (scope) => {
    const run = forRun(scope);
    return {
      ...run,
      forTool: (id) => {
        const tool = run.forTool(id);
        return { ...tool, search: () => Promise.reject(new BudgetError(gate, `lane "${scope.lane}" was refused by ${gate}`)) };
      },
    };
  };
  return client;
}

let sharedGeo: GeoApi | null = null;
const geo = (): GeoApi => (sharedGeo ??= createGeo());

export const LIVE: DesMode = { mode: "live", breaker: null, reason: null, until: null };

export interface TestDeps extends DesDeps {
  scopes: RunScope[];
  client: QlooClient;
}

/** Deps on a fresh mock client: Qloo on, every lane live. */
export function desDeps(overrides: Partial<DesDeps> = {}): TestDeps {
  const { client, scopes } = mockQloo();
  return {
    qloo: () => client,
    qlooEnabled: true,
    mode: async () => LIVE,
    geo,
    client,
    scopes,
    ...overrides,
  };
}

/** Generous limits, so only the tests about limits meet them. */
export const OPEN_LIMITS: Required<DesServiceOptions>["limits"] = {
  visitorPerMinute: 100,
  visitorPerHour: 1000,
  globalPerHour: 1000,
  dailyNetworkCalls: 10_000,
};

export function request(name: string, over: Partial<DesQuery> = {}, who: Partial<Omit<DesRequest, "query">> = {}): DesRequest {
  return { query: { name, type: "brand", pick: null, ...over }, lane: "public", visitor: null, ...who };
}
