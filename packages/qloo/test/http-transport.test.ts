import { describe, expect, it } from "vitest";
import { canonicalize } from "../src/canonical";
import { QlooNetworkError } from "../src/errors";
import { createHttpTransport, normaliseBaseUrl } from "../src/http-transport";

const KEY = "test-key-not-real";
const REQUEST_ID_HEADER = "x-qloo-request-id";
const request = canonicalize("/v2/insights", { "filter.type": "urn:entity:brand", "signal.interests.entities": "ent-alpha-01" });

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("createHttpTransport", () => {
  it("sends one GET with the key header and reads the rate-limit headers", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const transport = createHttpTransport({
      baseUrl: "https://hackathon.api.qloo.com/",
      apiKey: KEY,
      fetch: async (url, init) => {
        seen.push({ url: String(url), init: init ?? {} });
        return new Response('{"results":[]}', {
          status: 200,
          headers: {
            [REQUEST_ID_HEADER]: "req-alpha",
            "x-month-ratelimit-limit": "50000",
            "x-month-ratelimit-remaining": "41000",
            "x-month-ratelimit-reset": "86400",
            "x-second-ratelimit-limit": "10",
            "x-second-ratelimit-remaining": "9",
            "x-second-ratelimit-reset": "1",
          },
        });
      },
    });
    const res = await transport(request);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(`https://hackathon.api.qloo.com/v2/insights?${request.qs}`);
    expect(seen[0]?.init.method).toBe("GET");
    expect(seen[0]?.init.redirect).toBe("manual");
    expect((seen[0]?.init.headers as Record<string, string>)["X-Api-Key"]).toBe(KEY);
    expect(res.status).toBe(200);
    expect(new TextDecoder().decode(res.body)).toBe('{"results":[]}');
    expect(res.headers).toEqual({
      requestId: "req-alpha",
      monthLimit: 50000,
      monthRemaining: 41000,
      monthReset: 86400,
      secondLimit: 10,
      secondRemaining: 9,
      secondReset: 1,
    });
  });

  it("reports absent headers as null", async () => {
    const transport = createHttpTransport({ baseUrl: "https://hackathon.api.qloo.com", apiKey: KEY, fetch: async () => new Response("{}") });
    const res = await transport(request);
    expect(res.headers.requestId).toBeNull();
    expect(res.headers.monthRemaining).toBeNull();
  });

  it("turns a timeout into QlooNetworkError(timeout)", async () => {
    const transport = createHttpTransport({
      baseUrl: "https://hackathon.api.qloo.com",
      apiKey: KEY,
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    const err = await transport(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooNetworkError);
    expect((err as QlooNetworkError).reason).toBe("timeout");
  });

  it("passes a caller abort through instead of calling it a network error", async () => {
    const controller = new AbortController();
    const transport = createHttpTransport({
      baseUrl: "https://hackathon.api.qloo.com",
      apiKey: KEY,
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    });
    const pending = transport(request, controller.signal).catch((e: unknown) => e);
    controller.abort();
    const err = await pending;
    expect(err).not.toBeInstanceOf(QlooNetworkError);
    expect((err as Error).name).toBe("AbortError");
  });

  it("enforces the size cap while streaming and from content-length", async () => {
    const chunk = new Uint8Array(400).fill(32);
    const streaming = createHttpTransport({
      baseUrl: "https://hackathon.api.qloo.com",
      apiKey: KEY,
      maxBytes: 1000,
      fetch: async () => new Response(streamOf([chunk, chunk, chunk])),
    });
    const err = await streaming(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooNetworkError);
    expect((err as QlooNetworkError).reason).toBe("too_large");

    const declared = createHttpTransport({
      baseUrl: "https://hackathon.api.qloo.com",
      apiKey: KEY,
      maxBytes: 1000,
      fetch: async () => new Response(streamOf([chunk]), { headers: { "content-length": "5000" } }),
    });
    await expect(declared(request)).rejects.toMatchObject({ reason: "too_large" });

    const fits = createHttpTransport({
      baseUrl: "https://hackathon.api.qloo.com",
      apiKey: KEY,
      maxBytes: 1000,
      fetch: async () => new Response(streamOf([chunk, chunk])),
    });
    expect((await fits(request)).body.byteLength).toBe(800);
  });

  it("wraps connection failures without echoing the key", async () => {
    const transport = createHttpTransport({
      baseUrl: "https://hackathon.api.qloo.com",
      apiKey: KEY,
      fetch: async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      },
    });
    const err = await transport(request).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(QlooNetworkError);
    expect((err as QlooNetworkError).reason).toBe("network");
    expect((err as Error).message).toContain("ECONNREFUSED");
    expect((err as Error).message).not.toContain(KEY);
  });

  it("refuses an empty key and a non-https base URL", () => {
    expect(() => createHttpTransport({ baseUrl: "https://hackathon.api.qloo.com", apiKey: " " })).toThrow(/key is empty/);
    expect(() => normaliseBaseUrl("http://hackathon.api.qloo.com")).toThrow(/https/);
    expect(normaliseBaseUrl("http://127.0.0.1:4010/")).toBe("http://127.0.0.1:4010");
    expect(normaliseBaseUrl("https://hackathon.api.qloo.com/")).toBe("https://hackathon.api.qloo.com");
    expect(() => normaliseBaseUrl("https://hackathon.api.qloo.com/?x=1")).toThrow(/query/);
  });
});
