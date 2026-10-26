// Lanes and the human check (access.ts, turnstile.ts): signed cookies, the judge link, Turnstile
// verification on an injected verifier and an injected fetch, on a clock the tests move. No call
// to Cloudflare. Every key and token here is invented.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  AccessService,
  accessOptionsFromEnv,
  clientIp,
  HUMAN_COOKIE,
  HUMAN_TTL_S,
  isAdmin,
  JUDGE_COOKIE,
  JUDGE_MISSES_PER_MINUTE,
  JUDGE_TTL_S,
  judgeTokenFromEnv,
  readCookies,
  sameSecret,
  signedValue,
  verifySigned,
} = await import("../server/access");
const { log } = await import("../server/log");
const { visitorAddress } = await import("../server/client-ip");
const { createSiteverify, SITEVERIFY_URL, turnstileKeysFromEnv } = await import("../server/turnstile");
const { BREAKER_NOW, cookiePair, fakeVerifier, GOOD_TOKEN, TEST_JUDGE_TOKEN, TEST_SECRET, TEST_SITE_KEY, testAccess } = await import(
  "./support/protection"
);

const KEY = Buffer.alloc(32, 7);
const NOW_S = Math.floor(BREAKER_NOW / 1000);
const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });

const withCookie = (cookie: string) => new Request("http://test.local/api/runs", { headers: { cookie } });

describe("signed values and cookies", () => {
  it("verifies its own value until it expires, and nothing else", () => {
    const value = signedValue(KEY, "human", NOW_S + 60);
    expect(verifySigned(KEY, "human", value, NOW_S)).toBe(true);
    expect(verifySigned(KEY, "human", value, NOW_S + 60)).toBe(false);
    expect(verifySigned(KEY, "judge", value, NOW_S)).toBe(false);
    expect(verifySigned(Buffer.alloc(32, 8), "human", value, NOW_S)).toBe(false);
    // A later expiry with the old signature, a flipped character, junk and nothing.
    const [, sig] = value.split(".");
    expect(verifySigned(KEY, "human", `${NOW_S + 9_999}.${sig}`, NOW_S)).toBe(false);
    expect(verifySigned(KEY, "human", `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`, NOW_S)).toBe(false);
    for (const junk of ["", "x", "1.2", `${NOW_S + 60}`, undefined]) expect(verifySigned(KEY, "human", junk, NOW_S)).toBe(false);
  });

  it("reads a Cookie header, the first of a repeated name winning", () => {
    expect(readCookies("a=1; b = two ;a=3; =x; c")).toEqual(new Map([["a", "1"], ["b", "two"]]));
    expect(readCookies(null).size).toBe(0);
  });

  it("compares secrets in full", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abcd")).toBe(false);
    expect(sameSecret("", "abc")).toBe(false);
  });

  it("takes the right-most X-Forwarded-For entry as the visitor's address", () => {
    const req = new Request("http://test.local/", { headers: { "x-forwarded-for": "198.51.100.7, 203.0.113.9" } });
    expect(clientIp(req)).toBe("203.0.113.9");
    expect(clientIp(new Request("http://test.local/"))).toBeNull();
    expect(clientIp(undefined)).toBeNull();
  });

  it("keys the visitor by a salted hash of that address, the same in every process with the same salt", () => {
    const from = (ip: string) => new Request("http://test.local/", { headers: { "x-forwarded-for": ip } });
    const salted = testAccess({ ipSalt: "salt-for-tests" });
    const key = salted.clientKey(from("203.0.113.9"));
    expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(testAccess({ ipSalt: "salt-for-tests" }).clientKey(from("198.51.100.7, 203.0.113.9"))).toBe(key);
    expect(testAccess({ ipSalt: "another-salt" }).clientKey(from("203.0.113.9"))).not.toBe(key);
    expect(salted.clientKey(from("203.0.113.10"))).not.toBe(key);
    expect(salted.clientKey(new Request("http://test.local/"))).toBeNull();
    // Without a salt, one made at startup: stable in the process, different in the next.
    const unsalted = testAccess();
    expect(unsalted.clientKey(from("203.0.113.9"))).toBe(unsalted.clientKey(from("203.0.113.9")));
    expect(testAccess().clientKey(from("203.0.113.9"))).not.toBe(unsalted.clientKey(from("203.0.113.9")));
  });

  it("keys an IPv6 visitor by its /64, which one subscriber can rotate through, and a mapped IPv4 as the IPv4", () => {
    const from = (ip: string) => new Request("http://test.local/", { headers: { "x-forwarded-for": ip } });
    const access = testAccess({ ipSalt: "salt-for-tests" });
    const key = (ip: string) => access.clientKey(from(ip));
    // Documentation prefixes only (RFC 3849, RFC 5737).
    const home = key("2001:db8:1:2::1");
    expect(key("2001:db8:1:2:a:b:c:d")).toBe(home);
    expect(key("2001:0DB8:0001:0002:ffff:0:0:9")).toBe(home);
    expect(key("2001:db8:1:3::1")).not.toBe(home);
    expect(key("2001:db8:2:2::1")).not.toBe(home);
    expect(key("::ffff:203.0.113.9")).toBe(key("203.0.113.9"));
    expect(key("::ffff:cb00:7109")).toBe(key("203.0.113.9"));
    expect(key("fe80::1%eth0")).toBe(key("fe80::2"));
    expect(visitorAddress("2001:db8:1:2::1")).toBe("2001:db8:1:2::/64");
    expect(visitorAddress("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(visitorAddress("1:2:3:4:5:6:198.51.100.7")).toBe("1:2:3:4::/64");
    expect(visitorAddress("::ffff:203.0.113.9")).toBe("203.0.113.9");
    expect(visitorAddress(" 203.0.113.9 ")).toBe("203.0.113.9");
    expect(visitorAddress("not-an-address")).toBe("not-an-address");
  });

  it("warns in production that the per-visitor limits start over on a restart without IP_HASH_SALT", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    const saltWarning = expect.stringContaining("IP_HASH_SALT is not set");
    try {
      testAccess({ secureCookies: true });
      expect(warn).toHaveBeenCalledWith(saltWarning);
      warn.mockClear();
      testAccess({ secureCookies: true, ipSalt: "salt-for-tests" });
      testAccess({ secureCookies: false });
      expect(warn).not.toHaveBeenCalledWith(saltWarning);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("the judge lane", () => {
  it("opens with the judge token's cookie, httpOnly and for the judging period", () => {
    const access = testAccess();
    const cookie = access.judgeCookie(TEST_JUDGE_TOKEN);
    expect(cookie).toMatch(new RegExp(`^${JUDGE_COOKIE}=\\d+\\.[A-Za-z0-9_-]{43}; Path=/; Max-Age=${JUDGE_TTL_S}; HttpOnly; SameSite=Lax$`));
    expect(access.laneOf(withCookie(cookiePair(cookie)))).toBe("judge");
  });

  it("stays public without the cookie, with a wrong token, an expired cookie or a rotated token", () => {
    const clock = { ms: BREAKER_NOW };
    const access = testAccess({ clock });
    expect(access.judgeCookie("not-the-token")).toBeNull();
    expect(access.judgeCookie("")).toBeNull();
    expect(access.judgeCookie(null)).toBeNull();
    expect(access.laneOf(undefined)).toBe("public");
    expect(access.laneOf(withCookie("ct_judge=forged.value"))).toBe("public");
    const pair = cookiePair(access.judgeCookie(TEST_JUDGE_TOKEN));
    clock.ms += JUDGE_TTL_S * 1000;
    expect(access.laneOf(withCookie(pair))).toBe("public");
    clock.ms = BREAKER_NOW;
    expect(access.laneOf(withCookie(pair))).toBe("judge");
    // JUDGE_TOKEN rotated: every cookie of the old one stops working.
    expect(testAccess({ clock, judgeToken: `${TEST_JUDGE_TOKEN}-rotated` }).laneOf(withCookie(pair))).toBe("public");
  });

  it("is closed while JUDGE_TOKEN is unset", () => {
    const access = testAccess({ judgeToken: null });
    expect(access.judgeLaneOpen).toBe(false);
    expect(access.judgeCookie(TEST_JUDGE_TOKEN)).toBeNull();
    expect(access.judgeCookie("")).toBeNull();
  });

  it("reads JUDGE_TOKEN, or JUDGE_CODE as the plan first named it", () => {
    expect(judgeTokenFromEnv(env({ JUDGE_TOKEN: " t1 ", JUDGE_CODE: "t2" }))).toBe("t1");
    expect(judgeTokenFromEnv(env({ JUDGE_CODE: "t2" }))).toBe("t2");
    expect(judgeTokenFromEnv(env({ JUDGE_TOKEN: " " }))).toBeNull();
  });

  it("warns at startup about a judge token short enough to guess", () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      testAccess({ judgeToken: "XK42" });
      expect(warn).toHaveBeenCalledWith(expect.objectContaining({ length: 4 }), expect.stringContaining("JUDGE_TOKEN is short"));
      warn.mockClear();
      testAccess({ judgeToken: "a".repeat(32) });
      expect(warn).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining("JUDGE_TOKEN"));
    } finally {
      warn.mockRestore();
    }
  });

  it("refuses every judge link for the rest of a minute with too many wrong tokens, and never opens a closed lane", () => {
    const clock = { ms: BREAKER_NOW };
    const access = testAccess({ clock });
    for (let i = 0; i < JUDGE_MISSES_PER_MINUTE - 1; i++) expect(access.openJudgeLane(`guess-${i}`)).toEqual({ kind: "wrong" });
    // The right token still opens it below the limit, and does not count as a miss.
    expect(access.openJudgeLane(TEST_JUDGE_TOKEN)).toMatchObject({ kind: "open" });
    expect(access.openJudgeLane(null)).toEqual({ kind: "wrong" });
    expect(access.openJudgeLane(TEST_JUDGE_TOKEN)).toEqual({ kind: "locked", retryAfterS: 60 });
    clock.ms += 60_000;
    expect(access.openJudgeLane(TEST_JUDGE_TOKEN)).toMatchObject({ kind: "open" });
    expect(testAccess({ judgeToken: null }).openJudgeLane(TEST_JUDGE_TOKEN)).toEqual({ kind: "wrong" });
  });
});

describe("the human check", () => {
  it("is skipped while Turnstile is not configured", async () => {
    const verify = fakeVerifier();
    const access = testAccess({ turnstile: null, verify });
    expect(await access.checkHuman(undefined, null)).toEqual({ ok: true, via: "off", setCookie: null });
    expect(access.isVerified(undefined)).toBe(true);
    expect(access.siteKey).toBeNull();
    expect(verify).not.toHaveBeenCalled();
  });

  it("asks for a token, verifies it once with the visitor's address, and mints a two-hour cookie", async () => {
    const verify = fakeVerifier();
    const clock = { ms: BREAKER_NOW };
    const access = testAccess({ verify, clock });
    expect(access.siteKey).toBe(TEST_SITE_KEY);
    expect(await access.checkHuman(withCookie(""), null)).toEqual({ ok: false, kind: "missing" });
    expect(await access.checkHuman(undefined, "a-bad-token")).toEqual({ ok: false, kind: "rejected" });

    const request = new Request("http://test.local/api/runs", { headers: { "x-forwarded-for": "203.0.113.9" } });
    const passed = await access.checkHuman(request, GOOD_TOKEN);
    expect(passed).toMatchObject({ ok: true, via: "token" });
    expect(verify).toHaveBeenLastCalledWith(GOOD_TOKEN, "203.0.113.9");
    const setCookie = passed.ok ? passed.setCookie : null;
    expect(setCookie).toMatch(new RegExp(`^${HUMAN_COOKIE}=.+; Path=/; Max-Age=${HUMAN_TTL_S}; HttpOnly; SameSite=Lax$`));

    // The cookie stands in for a token, with no further call, until it lapses two hours on.
    const calls = verify.mock.calls.length;
    const back = withCookie(cookiePair(setCookie));
    expect(await access.checkHuman(back, null)).toEqual({ ok: true, via: "cookie", setCookie: null });
    expect(access.isVerified(back)).toBe(true);
    expect(verify.mock.calls.length).toBe(calls);
    clock.ms += HUMAN_TTL_S * 1000;
    expect(access.isVerified(back)).toBe(false);
    expect(await access.checkHuman(back, null)).toEqual({ ok: false, kind: "missing" });
  });

  it("refuses when Cloudflare cannot be asked, and marks cookies Secure in production", async () => {
    const down = testAccess({ verify: fakeVerifier(() => ({ ok: false, kind: "unavailable", error: "timeout" })) });
    expect(await down.checkHuman(undefined, GOOD_TOKEN)).toEqual({ ok: false, kind: "unavailable" });
    const secure = testAccess({ secureCookies: true });
    const passed = await secure.checkHuman(undefined, GOOD_TOKEN);
    expect(passed.ok && passed.setCookie).toMatch(/; Secure$/);
  });

  it("does not take one process's cookie in another without SESSION_HMAC_SECRET", async () => {
    const a = testAccess({ sessionSecret: null });
    const b = testAccess({ sessionSecret: null });
    const passed = await a.checkHuman(undefined, GOOD_TOKEN);
    const back = withCookie(cookiePair(passed.ok ? passed.setCookie : null));
    expect(a.isVerified(back)).toBe(true);
    expect(b.isVerified(back)).toBe(false);
    // With the shared secret, any process takes it.
    const c = testAccess();
    const d = testAccess();
    const shared = await c.checkHuman(undefined, GOOD_TOKEN);
    expect(d.isVerified(withCookie(cookiePair(shared.ok ? shared.setCookie : null)))).toBe(true);
  });
});

describe("Turnstile's siteverify", () => {
  const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("posts the secret, the token and the address, and reads success", async () => {
    const fetchFn = vi.fn<typeof fetch>(async () => answer({ success: true, hostname: "test.local" }));
    const verify = createSiteverify(TEST_SECRET, fetchFn);
    expect(await verify(GOOD_TOKEN, "203.0.113.9")).toEqual({ ok: true });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(SITEVERIFY_URL);
    expect(init?.method).toBe("POST");
    const form = init?.body as URLSearchParams;
    expect(Object.fromEntries(form)).toEqual({ secret: TEST_SECRET, response: GOOD_TOKEN, remoteip: "203.0.113.9" });
    await verify(GOOD_TOKEN, null);
    expect(Object.fromEntries(fetchFn.mock.calls[1]?.[1]?.body as URLSearchParams)).not.toHaveProperty("remoteip");
  });

  it("tells a rejected token from a Cloudflare it could not ask", async () => {
    const rejected = createSiteverify(TEST_SECRET, async () => answer({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    expect(await rejected("t", null)).toEqual({ ok: false, kind: "rejected", codes: ["timeout-or-duplicate"] });
    const httpError = createSiteverify(TEST_SECRET, async () => answer({}, 500));
    expect(await httpError("t", null)).toMatchObject({ ok: false, kind: "unavailable" });
    const unreadable = createSiteverify(TEST_SECRET, async () => answer({ ok: "yes" }));
    expect(await unreadable("t", null)).toMatchObject({ ok: false, kind: "unavailable" });
    const network = createSiteverify(TEST_SECRET, async () => Promise.reject(new TypeError("fetch failed")));
    expect(await network("t", null)).toEqual({ ok: false, kind: "unavailable", error: "fetch failed" });
  });
});

describe("configuration", () => {
  it("turns the check on only with both Turnstile keys", () => {
    expect(turnstileKeysFromEnv(env())).toBeNull();
    expect(turnstileKeysFromEnv(env({ TURNSTILE_SITE_KEY: "s" }))).toBeNull();
    expect(turnstileKeysFromEnv(env({ TURNSTILE_SITE_KEY: " s ", TURNSTILE_SECRET_KEY: " k " }))).toEqual({ siteKey: "s", secretKey: "k" });
    expect(accessOptionsFromEnv(env({ NODE_ENV: "production" })).secureCookies).toBe(true);
    expect(accessOptionsFromEnv(env()).turnstile).toBeNull();
    expect(new AccessService(accessOptionsFromEnv(env())).siteKey).toBeNull();
  });

  it("fails closed in production without both keys, unless TURNSTILE_DISABLED=1 says to skip the check", async () => {
    const partial: Record<string, string>[] = [{}, { TURNSTILE_SITE_KEY: "s" }, { TURNSTILE_SECRET_KEY: "k" }];
    for (const vars of partial) {
      const options = accessOptionsFromEnv(env({ NODE_ENV: "production", ...vars }));
      expect(options).toMatchObject({ turnstile: null, required: true });
      const access = new AccessService(options);
      expect(access.humanCheck).toBe("unconfigured");
      expect(access.isVerified(undefined)).toBe(false);
      expect(await access.checkHuman(undefined, GOOD_TOKEN)).toEqual({ ok: false, kind: "unconfigured" });
    }
    const both = { NODE_ENV: "production", TURNSTILE_SITE_KEY: "s", TURNSTILE_SECRET_KEY: "k" };
    expect(new AccessService(accessOptionsFromEnv(env(both))).humanCheck).toBe("on");
    // The opt-out, even with keys set; and outside production missing keys skip the check as before.
    const disabled = new AccessService(accessOptionsFromEnv(env({ ...both, TURNSTILE_DISABLED: "1" })));
    expect(disabled.humanCheck).toBe("off");
    expect(await disabled.checkHuman(undefined, null)).toEqual({ ok: true, via: "off", setCookie: null });
    expect(accessOptionsFromEnv(env()).required).toBe(false);
    expect(new AccessService(accessOptionsFromEnv(env())).humanCheck).toBe("off");
    expect(accessOptionsFromEnv(env({ IP_HASH_SALT: " salt " })).ipSalt).toBe("salt");
  });

  it("takes the admin bearer token only while ADMIN_TOKEN is set", () => {
    const bearer = (value: string) => new Request("http://test.local/api/admin/mode", { headers: { authorization: value } });
    expect(isAdmin(bearer("Bearer admin-token-for-tests"), "admin-token-for-tests")).toBe(true);
    expect(isAdmin(bearer("bearer  admin-token-for-tests"), "admin-token-for-tests")).toBe(true);
    expect(isAdmin(bearer("Bearer other"), "admin-token-for-tests")).toBe(false);
    expect(isAdmin(bearer("admin-token-for-tests"), "admin-token-for-tests")).toBe(false);
    expect(isAdmin(bearer("Bearer "), "")).toBe(false);
    expect(isAdmin(bearer("Bearer x"), null)).toBe(false);
  });
});
