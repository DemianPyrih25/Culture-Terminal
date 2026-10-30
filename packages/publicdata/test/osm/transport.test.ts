import { publicDataErrorCode } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import type { PublicRequest } from "../../src/api";
import { createPublicDataClient } from "../../src/client";
import { osmDailyMaxFromEnv, publicDataOptionsFromEnv } from "../../src/env";
import { createPublicHttpTransport, parseRetryAfter } from "../../src/http-transport";
import { osmCountsSpec, overpassTarget } from "../../src/osm/client";
import { secFactsRequest } from "../../src/sec";
import { createMemoryPublicStore } from "../../src/store";
import { CAFE, CIRCLE } from "./support";

const UA = "Culture Terminal test (ops@example.org)";

interface Seen {
  url: string;
  init: RequestInit;
}

function fakeFetch(status = 200, body = '{"elements":[]}', headers: Record<string, string> = {}): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const impl = async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    seen.push({ url: String(input), init: init ?? {} });
    return new Response(body, { status, headers });
  };
  return { fetch: impl as typeof fetch, seen };
}

const countsRequest = (url?: string): PublicRequest => osmCountsSpec(overpassTarget(url), { shapes: [CIRCLE], types: [CAFE] }).request;

describe("live transport for Overpass", () => {
  it("POSTs the query as a form body with OSM_USER_AGENT, to the configured endpoint only", async () => {
    const f = fakeFetch(200, '{"elements":[]}', { "retry-after": "3" });
    const transport = createPublicHttpTransport({ secUserAgent: null, censusApiKey: null, osmUserAgent: UA, fetch: f.fetch });
    const request = countsRequest();
    const res = await transport(request);
    expect(res).toMatchObject({ status: 200, retryAfterS: 3 });
    const [call] = f.seen;
    expect(call?.url).toBe("https://overpass-api.de/api/interpreter");
    expect(call?.init.method).toBe("POST");
    expect(call?.init.redirect).toBe("manual");
    expect(call?.init.headers).toMatchObject({ "User-Agent": UA, Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" });
    expect(call?.init.body).toBe(`data=${encodeURIComponent(request.body ?? "")}`);
  });

  it("refuses without a User-Agent, to another host, and a GET or a POST where it does not belong", async () => {
    const f = fakeFetch();
    const noUa = createPublicHttpTransport({ secUserAgent: UA, censusApiKey: null, fetch: f.fetch });
    expect(publicDataErrorCode(await noUa(countsRequest()).catch((e: unknown) => e))).toBe("not_configured");
    const transport = createPublicHttpTransport({ secUserAgent: UA, censusApiKey: null, osmUserAgent: UA, fetch: f.fetch });
    expect(publicDataErrorCode(await transport(countsRequest("https://overpass.example.org/api/interpreter")).catch((e: unknown) => e))).toBe("bad_request");
    expect(publicDataErrorCode(await transport({ ...countsRequest(), method: "GET" }).catch((e: unknown) => e))).toBe("bad_request");
    expect(publicDataErrorCode(await transport({ ...secFactsRequest("42"), method: "POST", body: "x" }).catch((e: unknown) => e))).toBe("bad_request");
    expect(f.seen).toHaveLength(0);
    expect(() => createPublicHttpTransport({ secUserAgent: null, censusApiKey: null, osmUserAgent: "bad\nagent" })).toThrow(/OSM_USER_AGENT/);
  });

  it("reads Retry-After as seconds or an HTTP date", () => {
    expect(parseRetryAfter(null, 0)).toBeNull();
    expect(parseRetryAfter("7", 0)).toBe(7);
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6);
    expect(parseRetryAfter("soon", 0)).toBeNull();
  });
});

describe("environment", () => {
  const deps = { store: createMemoryPublicStore() };

  it("configures OpenStreetMap only with OSM_USER_AGENT, and validates it", () => {
    const off = createPublicDataClient(publicDataOptionsFromEnv({} as NodeJS.ProcessEnv, deps));
    expect(off.configured.osm).toBe(false);
    const on = publicDataOptionsFromEnv({ OSM_USER_AGENT: ` ${UA} ` }, deps);
    expect(on.osmUserAgent).toBe(UA);
    expect(on.osmOverpassUrl).toBe("https://overpass-api.de/api/interpreter");
    expect(on.osmDailyMax).toBe(2000);
    expect(createPublicDataClient(on).configured.osm).toBe(true);
    expect(() => publicDataOptionsFromEnv({ OSM_USER_AGENT: `Culture Terminal ${String.fromCharCode(233)}` }, deps)).toThrow(/OSM_USER_AGENT/);
    expect(createPublicDataClient(publicDataOptionsFromEnv({ QLOO_MOCK: "1" }, deps)).configured.osm).toBe(true);
  });

  it("checks OSM_OVERPASS_URL and OSM_DAILY_MAX", () => {
    const custom = publicDataOptionsFromEnv({ OSM_OVERPASS_URL: "https://overpass.example.org/api/interpreter" }, deps);
    expect(custom.osmOverpassUrl).toBe("https://overpass.example.org/api/interpreter");
    expect(() => publicDataOptionsFromEnv({ OSM_OVERPASS_URL: "ftp://example.org/x" }, deps)).toThrow(/OSM_OVERPASS_URL/);
    expect(() => publicDataOptionsFromEnv({ OSM_OVERPASS_URL: "https://user:pw@example.org/api" }, deps)).toThrow(/OSM_OVERPASS_URL/);
    expect(osmDailyMaxFromEnv({ OSM_DAILY_MAX: "500" })).toBe(500);
    expect(osmDailyMaxFromEnv({ OSM_DAILY_MAX: "" })).toBe(2000);
    expect(() => osmDailyMaxFromEnv({ OSM_DAILY_MAX: "-3" })).toThrow(/OSM_DAILY_MAX/);
    expect(() => osmDailyMaxFromEnv({ OSM_DAILY_MAX: "lots" })).toThrow(/OSM_DAILY_MAX/);
  });
});
