// POST /api/screener (PLAN §5.5, §10.3): the body checked (CSRF, JSON, the contract, known markets), a
// screen in the answer cache served without the human check or a Qloo call, and a new screen run only
// after Turnstile passes. Turnstile is a fake verifier; Qloo is the mock transport. Invented entities.
import { describe, expect, it, vi } from "vitest";
import { LIVE, mockQloo } from "../des/support";
import { GOOD_TOKEN, testAccess } from "../support/protection";

vi.mock("server-only", () => ({}));
const access = testAccess();
vi.mock("../../server/access", async (orig) => ({ ...(await orig<typeof import("../../server/access")>()), getAccessService: () => access }));
vi.mock("../../server/screener/wiring", () => ({ getScreenerService: () => null }));

const { postScreener } = await import("../../server/screener/http");
const { ScreenerService } = await import("../../server/screener/service");

const OPEN = { visitorPerMinute: 100, visitorPerHour: 1000, globalPerHour: 1000, dailyNetworkCalls: 10_000 };

function setup() {
  const mock = mockQloo();
  const svc = new ScreenerService({ qloo: () => mock.client, qlooEnabled: true, mode: async () => LIVE, localities: () => null }, { limits: OPEN });
  return { svc, scopes: mock.scopes };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("http://localhost/api/screener", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

const SEED = { seed: { by: "tag", query: "Energy Drinks" } };

describe("POST /api/screener", () => {
  it("refuses a bad body, another site and an unknown market before anything else", async () => {
    const { svc, scopes } = setup();
    expect((await postScreener(post({ seed: { by: "tag", query: "" } }), svc)).status).toBe(400);
    expect((await postScreener(post({ ...SEED, markets: ["atlantis_bay"] }), svc)).status).toBe(400);
    expect((await postScreener(post({ ...SEED, markets: ["a", "b", "c", "d", "e"] }), svc)).status).toBe(400);
    expect((await postScreener(post(SEED, { "sec-fetch-site": "cross-site" }), svc)).status).toBe(403);
    const text = new Request("http://localhost/api/screener", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect((await postScreener(text, svc)).status).toBe(415);
    expect(scopes).toHaveLength(0);
  });

  it("asks for the human check before a new screen, runs it with a token, then serves the repeat from the cache", async () => {
    const { svc, scopes } = setup();
    const denied = await postScreener(post(SEED), svc);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ turnstile: true });
    expect(scopes).toHaveLength(0);

    const res = await postScreener(post({ ...SEED, turnstileToken: GOOD_TOKEN }), svc);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-human-check")).toBe("passed");
    expect(res.headers.get("set-cookie")).toMatch(/ct_human=/);
    const first = await res.json();
    expect(first.kind).toBe("ok");
    expect(scopes).toHaveLength(1);

    // No token and no cookie: the answer cache still answers, with no Qloo call.
    const again = await postScreener(post(SEED), svc);
    expect(again.status).toBe(200);
    expect((await again.json()).screen.qloo.network).toBe(0);
    expect(scopes).toHaveLength(1);
  });
});
