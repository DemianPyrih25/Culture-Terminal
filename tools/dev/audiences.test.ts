// tools/dev/audiences.ts end to end, in process: the real Qloo client on the synthetic mock transport
// (QLOO_MOCK=1) or on a fake live fetch with invented segments, over a memory store that also holds
// kv. No network, no database, no key; no entity id may reach the terminal or kv.
import { createMemoryQlooStore, MOCK_AUDIENCE_CATALOGUE_KV_KEY, AUDIENCE_CATALOGUE_KV_KEY, readAudienceCatalogue, StoredAudienceCatalogue } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { parseAudiencesArgs, runAudiencesCommand } from "./audiences-cli";
import { UsageError } from "./cli/args";
import { memoryIo } from "./cli/io";

const ENV = { QLOO_MOCK: "1", QLOO_RPS: "10" };
const NOW = () => new Date("2026-10-27T03:30:00.000Z");

async function run(argv: string[], opts: { store?: ReturnType<typeof createMemoryQlooStore>; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
  const io = memoryIo();
  const store = opts.store ?? createMemoryQlooStore();
  const code = await runAudiencesCommand(argv, { env: opts.env ?? ENV, io, store, fetch: opts.fetch, now: NOW });
  return { code, io, text: io.stdout.join("\n"), err: io.stderr.join("\n"), all: [...io.stdout, ...io.stderr].join("\n"), store };
}

describe("audiences args", () => {
  it("takes list or pin, with --yes for pin only", () => {
    expect(parseAudiencesArgs(["pin", "--yes", "--mock"])).toEqual({ command: "pin", yes: true, mock: true, tag: null, memory: false });
    expect(parseAudiencesArgs(["--help"])).toBeNull();
    expect(() => parseAudiencesArgs([])).toThrow(UsageError);
    expect(() => parseAudiencesArgs(["list", "--yes"])).toThrow(/pin only/);
    expect(() => parseAudiencesArgs(["pin", "leisure"])).toThrow(/no arguments/);
    expect(() => parseAudiencesArgs(["pin", "--tag", " "])).toThrow(/non-empty/);
  });
});

describe("audiences pin --mock", () => {
  it("prints the plan without --yes and writes nothing", async () => {
    const { code, text, store } = await run(["pin", "--mock"]);
    expect(code).toBe(3);
    expect(text).toContain("PLAN (6 families · 0 cached · 6 network calls)");
    expect(text).toContain("Run it again with --yes.");
    expect(await store.getKv(MOCK_AUDIENCE_CATALOGUE_KV_KEY)).toBeUndefined();
  });

  it("reads the six families, drops the denied ones and writes keys and names only under the mock key", async () => {
    const { code, text, all, store } = await run(["pin", "--mock", "--yes"]);
    expect(code).toBe(0);
    const value = StoredAudienceCatalogue.parse(await store.getKv(MOCK_AUDIENCE_CATALOGUE_KV_KEY));
    expect(Object.keys(value.families)).toEqual(["hobbies_and_interests", "leisure", "spending_habits", "professional_area", "life_stage", "investing_interests"]);
    expect(value.fetchedAt).toBe("2026-10-27T03:30:00.000Z");
    const read = readAudienceCatalogue(value);
    expect(read.segments.length).toBeGreaterThan(20);
    expect(read.segments.every((s) => /^urn:audience:[a-z_]+:mock_/.test(s.key))).toBe(true);
    expect(await store.getKv(AUDIENCE_CATALOGUE_KV_KEY)).toBeUndefined();
    expect(text).toMatch(/kv audience_catalogue\.mock: wrote \d+ segments in 6 families/);
    // Qloo's entity ids never reach kv or the terminal.
    expect(JSON.stringify(value)).not.toMatch(/mock-aud-|entity_id/);
    expect(all).not.toMatch(/mock-aud-/);
  });

  it("pins every answer in the cache, so a second pin makes no network call", async () => {
    const first = await run(["pin", "--mock", "--yes"]);
    const second = await run(["pin", "--mock", "--yes"], { store: first.store });
    expect(second.code).toBe(0);
    expect(second.text).toContain("PLAN (6 families · 6 cached · 0 network calls)");
    const list = await run(["list", "--mock"], { store: first.store });
    expect(list.code).toBe(0);
    expect(list.text).toMatch(/AUDIENCE CATALOGUE · kv audience_catalogue\.mock · pinned/);
    expect(list.text).toMatch(/leisure\s+\d+\s+cached/);
  });
});

describe("audiences pin over a fake live answer", () => {
  // Invented segments in Qloo's answer shape, with an entity id the CLI must never store.
  const fakeFetch: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const family = (url.searchParams.get("filter.parents.types") ?? "").replace("urn:audience:", "");
    const audiences = [
      { id: `urn:audience:${family}:test_segment_one`, entity_id: "ent-fake-0001", name: "Test Segment One", type: `urn:audience:${family}` },
      ...(family === "leisure" ? [{ id: "urn:audience:leisure:political_junkie", entity_id: "ent-fake-0002", name: "Denied", type: "urn:audience:leisure" }] : []),
    ];
    return new Response(JSON.stringify({ success: true, results: { audiences } }), { status: 200, headers: { "content-type": "application/json" } });
  };

  it("writes the live key and leaves out the D21-denied segment", async () => {
    const env = { QLOO_API_KEY: "test-key-not-real", QLOO_TAG: "audiences-test", QLOO_TAG_CAP: "200", QLOO_RPS: "10" };
    const { code, store, all } = await run(["pin", "--yes"], { env, fetch: fakeFetch });
    expect(code, all).toBe(0);
    const read = readAudienceCatalogue(await store.getKv(AUDIENCE_CATALOGUE_KV_KEY));
    expect(read.segments).toHaveLength(6);
    expect(read.segments.map((s) => s.key)).not.toContain("urn:audience:leisure:political_junkie");
    expect(all).toMatch(/leisure\s+2\s+1\s+1\s+0/);
    expect(all).not.toContain("ent-fake-");
  });
});
