// The browser's human check (components/protection): its states from GET /api/access, tokens from
// the widget handed out once, and humanFetch adding them to request bodies and answering the
// server's request for a new check. No browser, no Cloudflare: the widget's callbacks are called by
// hand. Invented keys and tokens only.
import { describe, expect, it, vi } from "vitest";
import { ACCESS_TTL_MS, AccessStore, readAccess, type Access } from "../../components/protection/access-client";
import {
  HUMAN_CHECK_HEADER,
  HUMAN_LOADING,
  HumanCheck,
  humanFetch,
  SCRIPT_ERROR,
  UNSUPPORTED_ERROR,
} from "../../components/protection/human-check";

vi.mock("server-only", () => ({}));
const { HUMAN_CHECK_HEADER: SERVER_HEADER } = await import("../../server/access");

const SITE_KEY = ["site", "key", "for", "tests"].join("-");

const access = (partial: Partial<Access> = {}): Access => ({
  lane: "public",
  mode: "live",
  message: null,
  until: null,
  turnstile: { siteKey: SITE_KEY },
  verified: false,
  ...partial,
});

/** A check whose access read answers `answers` in turn (the last one again after that). */
function checkWith(...answers: (Access | null)[]) {
  const read = vi.fn(async () => (answers.length > 1 ? answers.shift()! : answers[0]!));
  return { check: new HumanCheck(read), read };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
/** An answer whose request the server says passed the check. */
const passedJson = (status: number, body: unknown) => json(status, body, { [HUMAN_CHECK_HEADER]: "passed" });
const bodyOf = (init: RequestInit | undefined) => JSON.parse(String(init?.body)) as Record<string, unknown>;

describe("readAccess", () => {
  it("reads GET /api/access, and nothing else", () => {
    expect(readAccess(access())).toEqual(access());
    expect(readAccess({ ...access(), mode: null, turnstile: null })).toMatchObject({ mode: null, turnstile: null });
    expect(readAccess({ ...access(), lane: "vip" })).toBeNull();
    expect(readAccess({ ...access(), turnstile: { siteKey: "" } })).toBeNull();
    expect(readAccess(null)).toBeNull();
  });
});

describe("HumanCheck", () => {
  it("starts loading, then needs no token while the check is off or the cookie is valid", async () => {
    for (const answer of [access({ turnstile: null }), access({ verified: true }), null]) {
      const { check, read } = checkWith(answer);
      expect(check.getSnapshot()).toBe(HUMAN_LOADING);
      expect(await check.take()).toBeNull();
      expect(read).toHaveBeenCalledTimes(1);
      expect(["off", "verified"]).toContain(check.getSnapshot().status);
    }
  });

  it("waits for the widget's token, hands it out once, and asks the widget for the next", async () => {
    const { check } = checkWith(access());
    const reset = vi.fn();
    const detach = check.attach(reset);
    await check.load();
    expect(check.getSnapshot()).toEqual({ status: "checking", siteKey: SITE_KEY, error: null });

    // A token that arrives before anyone asks waits for the first request.
    check.onToken("token-1");
    expect(await check.take()).toBe("token-1");
    // Two requests waiting: the widget is reset for the first, which takes the next token, and
    // reset again for the second.
    const a = check.take();
    const b = check.take();
    await Promise.resolve();
    await Promise.resolve();
    expect(reset).toHaveBeenCalledTimes(1);
    check.onToken("token-2");
    expect(await a).toBe("token-2");
    expect(reset).toHaveBeenCalledTimes(2);
    check.onToken("token-3");
    expect(await b).toBe("token-3");
    detach();
  });

  it("asks the widget for a new token once its last one went to a request", async () => {
    const { check } = checkWith(access());
    const reset = vi.fn();
    check.attach(reset);
    await check.load();
    check.onToken("token-1");
    expect(await check.take()).toBe("token-1");
    expect(reset).not.toHaveBeenCalled();
    const next = check.take();
    await Promise.resolve();
    await Promise.resolve();
    expect(reset).toHaveBeenCalledTimes(1);
    check.onToken("token-2");
    expect(await next).toBe("token-2");
  });

  it("keeps a token that was never sent for the next request", async () => {
    const { check } = checkWith(access());
    await check.load();
    check.onToken("token-1");
    const controller = new AbortController();
    const base = vi.fn<typeof fetch>(async (_input, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      return json(200, {});
    });
    controller.abort();
    await expect(humanFetch(check, base)("/api/preview", { method: "POST", body: "{}", signal: controller.signal })).rejects.toThrow("aborted");
    await humanFetch(check, base)("/api/preview", { method: "POST", body: "{}" });
    expect(bodyOf(base.mock.calls[1]?.[1])).toEqual({ turnstileToken: "token-1" });
  });

  it("goes without a token when none comes in time, or when the token expired", async () => {
    vi.useFakeTimers();
    try {
      const { check } = checkWith(access());
      await check.load();
      const waiting = check.take(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await waiting).toBeNull();
      check.onToken("token-1");
      check.onExpire();
      const again = check.take(10);
      await vi.advanceTimersByTimeAsync(10);
      expect(await again).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows itself when Cloudflare asks the visitor, and recovers from an error with Try again", async () => {
    const { check } = checkWith(access());
    const reset = vi.fn();
    check.attach(reset);
    const seen: string[] = [];
    check.subscribe(() => seen.push(check.getSnapshot().status));
    await check.load();
    check.onInteractive();
    const waiting = check.take();
    check.onError("110200");
    expect(await waiting).toBeNull();
    expect(check.getSnapshot()).toEqual({ status: "error", siteKey: SITE_KEY, error: "110200" });
    check.retry();
    expect(reset).toHaveBeenCalledTimes(1);
    check.onInteractive();
    check.onToken("token-1");
    expect(seen).toEqual(["checking", "interactive", "error", "checking", "interactive", "checking"]);
  });

  it("is verified once a request with its token passes, and checks again when the server asks", async () => {
    const { check } = checkWith(access());
    const reset = vi.fn();
    check.attach(reset);
    await check.load();
    check.passed();
    expect(check.getSnapshot().status).toBe("verified");
    expect(await check.take()).toBeNull();
    check.required();
    expect(check.getSnapshot().status).toBe("checking");
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("reads access again when the server asks for a check it never heard of", async () => {
    const { check, read } = checkWith(access({ turnstile: null }), access());
    await check.load();
    expect(check.getSnapshot().status).toBe("off");
    check.required();
    await check.load();
    expect(read).toHaveBeenLastCalledWith(true);
    expect(check.getSnapshot()).toMatchObject({ status: "checking", siteKey: SITE_KEY });
  });

  it("stops waiting at once when Cloudflare's script cannot load, and keeps the error when the server asks again", async () => {
    vi.useFakeTimers();
    try {
      const { check } = checkWith(access());
      const reset = vi.fn();
      check.attach(reset);
      await check.load();
      const waiting = check.take();
      check.onScriptError();
      // Released at once, not after TOKEN_WAIT_MS.
      expect(await waiting).toBeNull();
      expect(check.getSnapshot()).toEqual({ status: "error", siteKey: SITE_KEY, error: SCRIPT_ERROR });
      // The 403 that follows changes nothing: no reset can bring a token from a widget that never loaded.
      check.required();
      expect(check.getSnapshot().status).toBe("error");
      expect(reset).not.toHaveBeenCalled();
      expect(await check.take()).toBeNull();
      // Try again mounts the widget afresh (the panel does): no reset of the old one.
      check.retry();
      expect(check.getSnapshot()).toEqual({ status: "checking", siteKey: SITE_KEY, error: null });
      expect(reset).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops waiting at once in a browser Turnstile does not support", async () => {
    const { check } = checkWith(access());
    await check.load();
    const waiting = check.take();
    check.onUnsupported();
    expect(await waiting).toBeNull();
    expect(check.getSnapshot()).toMatchObject({ status: "error", error: UNSUPPORTED_ERROR });
  });

  it("keeps waiting for as long as the visitor takes to solve the challenge", async () => {
    vi.useFakeTimers();
    try {
      const { check } = checkWith(access());
      const reset = vi.fn();
      check.attach(reset);
      await check.load();
      const waiting = check.take(30_000);
      check.onInteractive();
      let settled = false;
      void waiting.then(() => (settled = true));
      await vi.advanceTimersByTimeAsync(31_000);
      expect(settled).toBe(false);
      // A server asking for a check meanwhile does not reset the challenge under the visitor.
      check.required();
      expect(reset).not.toHaveBeenCalled();
      expect(check.getSnapshot().status).toBe("interactive");
      await vi.advanceTimersByTimeAsync(60_000);
      check.onToken("token-1");
      expect(await waiting).toBe("token-1");
      expect(check.getSnapshot().status).toBe("checking");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("AccessStore", () => {
  it("shares one read, reads again once it is a minute old or when asked, and tells its listeners", async () => {
    const clock = { ms: 0 };
    let mode: Access["mode"] = "live";
    const fetchFn = vi.fn(async () => access({ mode }));
    const store = new AccessStore(fetchFn, () => clock.ms);
    const heard: (Access["mode"] | undefined)[] = [];
    store.subscribe(() => heard.push(store.getSnapshot()?.mode));
    expect(store.getSnapshot()).toBeNull();
    await Promise.all([store.load(), store.load()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(store.getSnapshot()?.mode).toBe("live");

    mode = "replay_only";
    clock.ms += ACCESS_TTL_MS - 1;
    await store.load();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    clock.ms += 1;
    await store.load();
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(store.getSnapshot()?.mode).toBe("replay_only");

    mode = "live";
    await store.load(true);
    expect(fetchFn).toHaveBeenCalledTimes(3);
    expect(heard).toEqual(["live", "replay_only", "live"]);
  });

  it("lets only the newest of two reads in flight speak", async () => {
    const answers: ((a: Access | null) => void)[] = [];
    const store = new AccessStore(() => new Promise((resolve) => answers.push(resolve)));
    const older = store.load();
    const newer = store.load(true);
    answers[1]?.(access({ mode: "economy" }));
    await newer;
    answers[0]?.(access({ mode: "live" }));
    await older;
    expect(store.getSnapshot()?.mode).toBe("economy");
  });
});

describe("humanFetch", () => {
  it("reads the header the server sets on a passed check", () => {
    expect(HUMAN_CHECK_HEADER).toBe(SERVER_HEADER);
  });

  it("adds the token to a JSON body and marks the browser verified when the server says the request passed", async () => {
    const { check } = checkWith(access());
    await check.load();
    check.onToken("token-1");
    const base = vi.fn<typeof fetch>(async () => passedJson(200, { ok: true }));
    const res = await humanFetch(check, base)("/api/preview", { method: "POST", body: JSON.stringify({ question: "Q" }) });
    expect(res.status).toBe(200);
    expect(bodyOf(base.mock.calls[0]?.[1])).toEqual({ question: "Q", turnstileToken: "token-1" });
    expect(check.getSnapshot().status).toBe("verified");
    // Verified: the next request goes as it is.
    await humanFetch(check, base)("/api/runs", { method: "POST", body: JSON.stringify({ question: "Q" }) });
    expect(bodyOf(base.mock.calls[1]?.[1])).toEqual({ question: "Q" });
  });

  it("sends the request once more with a new token when the server asks for a check", async () => {
    const { check } = checkWith(access({ verified: true }));
    const reset = vi.fn(() => queueMicrotask(() => check.onToken("token-2")));
    check.attach(reset);
    const base = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(403, { error: "Confirm you are a person.", turnstile: true }))
      .mockResolvedValueOnce(passedJson(201, { runId: "run-0001" }));
    const res = await humanFetch(check, base)("/api/runs", { method: "POST", body: JSON.stringify({ question: "Q" }) });
    expect(res.status).toBe(201);
    expect(bodyOf(base.mock.calls[0]?.[1])).toEqual({ question: "Q" });
    expect(bodyOf(base.mock.calls[1]?.[1])).toEqual({ question: "Q", turnstileToken: "token-2" });
    expect(check.getSnapshot().status).toBe("verified");
  });

  it("stays unverified when the answer did not pass the check: Cloudflare unreachable, a cached brief, a pause", async () => {
    for (const answer of [
      json(503, { error: "The check that you are a person could not be completed. Try again shortly.", retry: true }, { "retry-after": "5" }),
      json(200, { runId: "run-cached-0001", cached: true }),
      json(503, { error: "Live analysis is paused.", retry: false }),
    ]) {
      const { check } = checkWith(access());
      const reset = vi.fn(() => queueMicrotask(() => check.onToken("token-2")));
      check.attach(reset);
      await check.load();
      check.onToken("token-1");
      const base = vi.fn<typeof fetch>(async () => answer);
      expect(await humanFetch(check, base)("/api/runs", { method: "POST", body: JSON.stringify({ question: "Q" }) })).toBe(answer);
      expect(check.getSnapshot().status).toBe("checking");
      // The token went with that request: the next one asks the widget for a fresh one.
      const next = vi.fn<typeof fetch>(async () => passedJson(201, { runId: "run-0002" }));
      await humanFetch(check, next)("/api/runs", { method: "POST", body: JSON.stringify({ question: "Q" }) });
      expect(reset).toHaveBeenCalledTimes(1);
      expect(bodyOf(next.mock.calls[0]?.[1])).toEqual({ question: "Q", turnstileToken: "token-2" });
      expect(check.getSnapshot().status).toBe("verified");
    }
  });

  it("passes any other 403 through, and leaves bodies that are not JSON objects alone", async () => {
    const { check } = checkWith(access());
    await check.load();
    check.onToken("token-1");
    const crossSite = json(403, { error: "Runs can only be started from this site." });
    const base = vi.fn<typeof fetch>(async () => crossSite);
    expect(await humanFetch(check, base)("/api/runs", { method: "POST", body: "[1]" })).toBe(crossSite);
    expect(base.mock.calls[0]?.[1]?.body).toBe("[1]");
    expect(base).toHaveBeenCalledTimes(1);
  });
});
