import { describe, expect, it, vi } from "vitest";
import { qlooClientOptionsFromEnv, resolveQlooEnv } from "../src/env";
import { createMemoryQlooStore } from "../src/store";

// The synthetic transport belongs to the mock workstream; here it only needs to be the one chosen.
const mockTransport = vi.hoisted(() => Object.assign(async () => Promise.reject(new Error("unused")), { synthetic: true }));
vi.mock("../src/mock", () => ({ createMockTransport: () => mockTransport }));

const deps = { store: createMemoryQlooStore() };
const LIVE = { QLOO_API_KEY: "test-key-not-real" };

describe("qlooClientOptionsFromEnv", () => {
  it("uses the documented defaults", () => {
    const o = qlooClientOptionsFromEnv({ ...LIVE }, deps);
    expect(o).toMatchObject({
      env: "dev",
      baseUrl: "https://hackathon.api.qloo.com",
      tag: "dev",
      tagCap: 200,
      rps: 1.5,
      dailyFreshCap: 1900,
    });
    expect(o.transport).not.toBe(mockTransport);
    expect(o.store).toBe(deps.store);
  });

  it("selects the mock transport with QLOO_MOCK=1 and needs no key", () => {
    const o = qlooClientOptionsFromEnv({ QLOO_MOCK: "1" }, deps);
    expect(o.env).toBe("mock");
    expect(o.transport).toBe(mockTransport);
  });

  it("explains a missing key", () => {
    expect(() => qlooClientOptionsFromEnv({}, deps)).toThrow(/QLOO_API_KEY is not set.*QLOO_MOCK=1/);
    expect(() => qlooClientOptionsFromEnv({ QLOO_MOCK: "0", QLOO_API_KEY: " " }, deps)).toThrow(/QLOO_API_KEY/);
  });

  it("reads tag, caps, rps and base URL", () => {
    const o = qlooClientOptionsFromEnv(
      { ...LIVE, QLOO_TAG: "qloo-client", QLOO_TAG_CAP: "50", QLOO_RPS: "1", QLOO_BASE_URL: "https://hackathon.api.qloo.com/" },
      deps,
    );
    expect(o).toMatchObject({ tag: "qloo-client", tagCap: 50, rps: 1, baseUrl: "https://hackathon.api.qloo.com" });
  });

  it("detects prod from NODE_ENV unless QLOO_ENV=dev", () => {
    expect(resolveQlooEnv({ NODE_ENV: "production" })).toBe("prod");
    expect(resolveQlooEnv({ NODE_ENV: "production", QLOO_ENV: "dev" })).toBe("dev");
    expect(resolveQlooEnv({ NODE_ENV: "development" })).toBe("dev");
    expect(resolveQlooEnv({ NODE_ENV: "production", QLOO_MOCK: "1" })).toBe("mock");
  });

  it("keeps the tag cap a dev cap: on in dev, off in prod unless set to a number, never in mock mode", () => {
    const tagCap = (env: NodeJS.ProcessEnv) => qlooClientOptionsFromEnv(env, deps).tagCap;
    expect(tagCap({ ...LIVE })).toBe(200);
    expect(tagCap({ ...LIVE, QLOO_TAG_CAP: "" })).toBe(200);
    expect(() => tagCap({ ...LIVE, QLOO_TAG_CAP: "off" })).toThrow(/only in production or mock mode/);

    const prod = { ...LIVE, NODE_ENV: "production" };
    expect(tagCap({ ...prod })).toBeNull();
    expect(tagCap({ ...prod, QLOO_TAG_CAP: "" })).toBeNull();
    expect(tagCap({ ...prod, QLOO_TAG_CAP: "off" })).toBeNull();
    expect(tagCap({ ...prod, QLOO_TAG_CAP: "500" })).toBe(500);

    expect(tagCap({ QLOO_MOCK: "1", QLOO_TAG_CAP: "200" })).toBeNull();
    expect(tagCap({ QLOO_MOCK: "1", QLOO_TAG_CAP: "off" })).toBeNull();
    expect(() => tagCap({ QLOO_MOCK: "1", QLOO_TAG_CAP: "many" })).toThrow(/QLOO_TAG_CAP/);
  });

  it("rejects malformed values", () => {
    expect(() => qlooClientOptionsFromEnv({ ...LIVE, QLOO_TAG_CAP: "many" }, deps)).toThrow(/QLOO_TAG_CAP/);
    expect(() => qlooClientOptionsFromEnv({ ...LIVE, QLOO_RPS: "0" }, deps)).toThrow(/QLOO_RPS/);
    expect(() => qlooClientOptionsFromEnv({ ...LIVE, QLOO_RPS: "50" }, deps)).toThrow(/QLOO_RPS/);
    expect(() => qlooClientOptionsFromEnv({ ...LIVE, QLOO_MOCK: "yes" }, deps)).toThrow(/QLOO_MOCK/);
    expect(() => qlooClientOptionsFromEnv({ ...LIVE, QLOO_DAILY_FRESH_CAP: "-3" }, deps)).toThrow(/QLOO_DAILY_FRESH_CAP/);
    expect(() => qlooClientOptionsFromEnv({ ...LIVE, QLOO_BASE_URL: "http://hackathon.api.qloo.com" }, deps)).toThrow(/https/);
  });
});
