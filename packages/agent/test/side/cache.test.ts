import { describe, expect, it } from "vitest";
import { contextCacheKey, normaliseContextQuestion, readContext, writeContext } from "../../src/side/cache";
import type { ContextCache } from "../../src/side";
import { intentFixture, memoryCache } from "./support";

const base = {
  kind: "ai" as const,
  model: "claude-sonnet-5-5",
  question: "How healthy is Brightwave Soda in Austin?",
  intent: intentFixture(),
  subjectName: "Brightwave Soda",
};

describe("contextCacheKey", () => {
  it("is a sha256 hex digest, stable for the same inputs", () => {
    expect(contextCacheKey(base)).toMatch(/^[0-9a-f]{64}$/);
    expect(contextCacheKey(base)).toBe(contextCacheKey({ ...base }));
  });

  it("normalises the question as the answer cache does (case, spacing, invisible characters)", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    expect(contextCacheKey({ ...base, question: `  how HEALTHY is  Brightwave${zeroWidth} Soda in Austin?` })).toBe(contextCacheKey(base));
    expect(normaliseContextQuestion("A\tB")).toBe("a b");
  });

  it("changes with the kind, model, job, subject and place", () => {
    const key = contextCacheKey(base);
    expect(contextCacheKey({ ...base, kind: "web" })).not.toBe(key);
    expect(contextCacheKey({ ...base, model: "claude-haiku-5-5" })).not.toBe(key);
    expect(contextCacheKey({ ...base, intent: intentFixture({ job: "head_to_head" }) })).not.toBe(key);
    expect(contextCacheKey({ ...base, subjectName: null })).not.toBe(key);
    const elsewhere = intentFixture({ geo: { ...intentFixture().geo, metro: null, market: "portland" } });
    expect(contextCacheKey({ ...base, intent: elsewhere })).not.toBe(key);
  });
});

describe("readContext / writeContext", () => {
  it("round-trips through the cache with the kind's TTL", async () => {
    const cache = memoryCache();
    await writeContext(cache, { key: "k", kind: "web", model: "m", body: { a: 1 }, usd: 0.02 });
    expect(cache.rows.get("k")?.ttlMs).toBe(24 * 60 * 60 * 1000);
    expect((await readContext(cache, "k"))?.body).toEqual({ a: 1 });
  });

  it("never fails a run: a broken cache reads as a miss and a failed write is ignored", async () => {
    const broken: ContextCache = {
      get: () => Promise.reject(new Error("db down")),
      put: () => Promise.reject(new Error("db down")),
    };
    await expect(readContext(broken, "k")).resolves.toBeNull();
    await expect(writeContext(broken, { key: "k", kind: "ai", model: "m", body: {}, usd: 0 })).resolves.toBeUndefined();
    await expect(readContext(null, "k")).resolves.toBeNull();
  });
});
