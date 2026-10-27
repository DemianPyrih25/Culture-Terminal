// tools/dev/warm-metros.ts in process: the city-side requests, the real Qloo client on the synthetic
// mock transport (QLOO_MOCK=1) or on a fake live fetch, over a memory store and a memory kv. No
// network, no database, no key; locality ids are the mock's or invented, and none may reach the terminal.
import type { MarketLocality } from "@ct/contracts";
import { SKILLS } from "@ct/quant";
import { createEntityRegistry } from "@ct/agent";
import {
  canonicalize,
  createMemoryQlooStore,
  createQlooClient,
  isPinnedRequest,
  PROBE_FACTS,
  qlooClientOptionsFromEnv,
  type MemoryQlooStore,
} from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { UsageError } from "./args";
import { memoryIo } from "./io";
import { kvLocalityApi, LOCALITIES_KV_KEY, memoryKv, MOCK_LOCALITIES_KV_KEY, StoredLocalities } from "./localities";
import { runLocalitiesCommand } from "./localities-cli";
import { citySideKey, citySideRequests, rowsOf, withFilterType } from "./warm-metros";
import { parseWarmArgs, runWarmCommand } from "./warm-metros-cli";

const ENV = { QLOO_MOCK: "1", QLOO_RPS: "10" };
const NOW = () => new Date("2026-10-27T03:15:22.123Z");
/** Any id the mock or the fake live answers issue. */
const ID = /mock-ent-|loc-fake-|loc-fixture-/;
const FIXTURE: MarketLocality = { entityId: "loc-fixture-city", label: "Fixture City" };

type Kv = ReturnType<typeof memoryKv>;

async function warm(argv: string[], opts: { store: MemoryQlooStore; kv: Kv; env?: NodeJS.ProcessEnv; fetch?: typeof fetch }) {
  const io = memoryIo();
  const code = await runWarmCommand(argv, { env: opts.env ?? ENV, io, store: opts.store, kv: opts.kv, fetch: opts.fetch, now: NOW });
  return { code, text: io.stdout.join("\n"), err: io.stderr.join("\n"), all: [...io.stdout, ...io.stderr].join("\n") };
}

/** A memory store and kv with mock locality pins for `ids` (one mock /search each). */
async function pinned(ids: string[]): Promise<{ store: MemoryQlooStore; kv: Kv }> {
  const store = createMemoryQlooStore();
  const kv = memoryKv();
  const code = await runLocalitiesCommand(["pin", ...ids, "--yes"], { env: ENV, io: memoryIo(), store, kv, now: NOW });
  expect(code).toBe(0);
  return { store, kv };
}

const pinsIn = (kv: Kv) => StoredLocalities.parse(kv.values.get(MOCK_LOCALITIES_KV_KEY) ?? {});
const networkCalls = (store: MemoryQlooStore) => store.calls.filter((c) => c.cacheStatus === "miss").length;

describe("parseWarmArgs", () => {
  it("takes --all or a comma list of map cities, in MetroId order", () => {
    expect(parseWarmArgs(["--all"])?.metros).toHaveLength(13);
    expect(parseWarmArgs(["--metro", "chicago, nashville", "--yes", "--mock"])).toEqual({
      metros: ["nashville", "chicago"],
      yes: true,
      mock: true,
      tag: null,
      memory: false,
    });
    expect(parseWarmArgs(["--help"])).toBeNull();
  });

  it("refuses unknown cities, markets that are no map city, both or neither selector, and positionals", () => {
    expect(() => parseWarmArgs(["--metro", "gotham"])).toThrow(UsageError);
    expect(() => parseWarmArgs(["--metro", "memphis"])).toThrow(/unknown map city "memphis"/);
    expect(() => parseWarmArgs(["--all", "--metro", "austin"])).toThrow(/not both/);
    expect(() => parseWarmArgs([])).toThrow(/--all or --metro/);
    expect(() => parseWarmArgs(["nashville"])).toThrow(/unexpected argument/);
    expect(() => parseWarmArgs(["--all", "--tag", " "])).toThrow(/--tag/);
  });
});

describe("citySideRequests", () => {
  const requests = citySideRequests(FIXTURE);

  it("builds the skills' four city requests on the locality", () => {
    expect(requests.map((r) => [r.kind, r.filterType])).toEqual([
      ["baseline", "urn:heatmap"],
      ["fingerprint", "urn:tag"],
      ["music", "urn:tag"],
      ["brands", "urn:entity:brand"],
    ]);
    expect(requests[0]?.params).toEqual({ "filter.location": "loc-fixture-city", "signal.interests.tags": [PROBE_FACTS.heatmapBaselineTag] });
    expect(requests[1]?.params).toEqual({ "signal.location": "loc-fixture-city", take: 50 });
    expect(requests[2]?.params).toEqual({ "signal.location": "loc-fixture-city", "filter.tag.types": ["urn:tag:genre:music"], take: 50 });
    expect(requests[3]?.params).toEqual({ "signal.location": "loc-fixture-city", "filter.popularity.max": 0.9, take: 30 });
  });

  it("is pinned by the D25 TTL rule, so a run that fetches it first pins it too", () => {
    for (const r of requests) expect(isPinnedRequest(canonicalize("/v2/insights", withFilterType(r))), r.kind).toBe(true);
  });

  it("keys mock and live answers apart", () => {
    const [baseline] = requests;
    if (baseline === undefined) throw new Error("no baseline");
    expect(citySideKey(baseline, "mock")).not.toBe(citySideKey(baseline, "dev"));
    expect(citySideKey(baseline, "dev")).toBe(citySideKey(baseline, "prod"));
  });

  it("counts the rows of each answer shape", () => {
    expect(rowsOf({ results: { heatmap: [{}, {}] } })).toBe(2);
    expect(rowsOf({ results: { tags: [{}] } })).toBe(1);
    expect(rowsOf({ results: { entities: [] } })).toBe(0);
    expect(rowsOf(null)).toBe(0);
  });
});

describe("warm-metros on mock Qloo", () => {
  it("prints the plan and makes no call without --yes", async () => {
    const { store, kv } = await pinned(["nashville", "chicago"]);
    const before = store.calls.length;
    const { code, text, all } = await warm(["--metro", "nashville,chicago"], { store, kv });
    expect(code).toBe(3);
    expect(text).toContain("PLAN (2 map cities · 8 requests · 0 cached · 8 network calls · 0 pinned)");
    expect(text).toMatch(/nashville\s+Nashville\s+pinned\s+network\s+network\s+network\s+network/);
    expect(text).toContain("warm would make 8 network calls to Qloo mock under tag dev (0 answered from the cache) and pin 8 cache entries.");
    expect(store.calls).toHaveLength(before);
    expect(all).not.toMatch(ID);
  });

  it("warms four requests per city, pins each entry for good, and a second run is all cache hits", async () => {
    const { store, kv } = await pinned(["nashville", "chicago"]);
    const searches = networkCalls(store);
    const first = await warm(["--metro", "nashville,chicago", "--yes"], { store, kv });
    expect(first.code).toBe(0);
    expect(first.text).toContain("city side: 8 of 8 entries pinned in the cache");
    expect(first.text).toContain("this run      8 network · 0 cached");
    expect(networkCalls(store)).toBe(searches + 8);
    const pins = pinsIn(kv);
    for (const metro of ["nashville", "chicago"] as const) {
      const locality = pins[metro];
      if (locality === undefined) throw new Error(`no pin for ${metro}`);
      for (const r of citySideRequests(locality)) {
        expect(await store.getEntry(citySideKey(r, "mock"))).toMatchObject({ status: 200, pinned: true, expiresAt: null });
      }
    }
    expect(first.all).not.toMatch(ID);

    const plan = await warm(["--metro", "nashville,chicago"], { store, kv });
    expect(plan.code).toBe(0);
    expect(plan.text).toContain("PLAN (2 map cities · 8 requests · 8 cached · 0 network calls · 8 pinned)");
    expect(plan.text).toContain("nothing to warm: every request is cached and pinned");

    const again = await warm(["--metro", "nashville,chicago", "--yes"], { store, kv });
    expect(again.code).toBe(0);
    expect(again.text).toContain("this run      0 network · 8 cached");
    expect(again.text.match(/pinned \(already\)/g)).toHaveLength(8);
    expect(networkCalls(store)).toBe(searches + 8);
  });

  it("warms the very keys the skills ask for: geo_lift and block_dna estimates drop by the city side", async () => {
    const { store, kv } = await pinned(["nashville"]);
    const localities = kvLocalityApi(kv, MOCK_LOCALITIES_KV_KEY);
    const registry = createEntityRegistry();
    const bar = registry.registerTag({ tagId: "urn:tag:genre:place:bar", name: "Bar", type: "urn:tag:genre:place", signalCapable: true });
    const lift = SKILLS.geo_lift.input.parse({ metro: "nashville", concept_tags: [bar.ref], concept_entities: [], supply: false, trigger_finding_id: null, step_id: null });
    const block = SKILLS.block_dna.input.parse({ area: { kind: "point", ref: "-86.7816,36.1627", metro: "nashville" }, include_brands: true, trigger_finding_id: null, step_id: null });
    const estimate = async () => {
      const probe = createQlooClient(qlooClientOptionsFromEnv(ENV, { store })).standalone().forTool(null);
      return {
        lift: await SKILLS.geo_lift.estimateCalls(lift, probe, registry, { localities, geo: null }),
        block: await SKILLS.block_dna.estimateCalls(block, probe, registry, { localities, geo: null }),
      };
    };
    // Cold: the concept map and the baseline; the area's and the city's three lists each.
    expect(await estimate()).toEqual({ lift: 2, block: 6 });
    expect((await warm(["--metro", "nashville", "--yes"], { store, kv })).code).toBe(0);
    // Warm: only the question's own calls are left.
    expect(await estimate()).toEqual({ lift: 1, block: 3 });
  });

  it("pins a city-side entry that was cached with an expiry, from the cache", async () => {
    const source = await pinned(["nashville"]);
    expect((await warm(["--metro", "nashville", "--yes"], source)).code).toBe(0);
    const locality = pinsIn(source.kv).nashville;
    if (locality === undefined) throw new Error("no pin");
    const fingerprint = citySideRequests(locality).find((r) => r.kind === "fingerprint");
    if (fingerprint === undefined) throw new Error("no fingerprint");
    const key = citySideKey(fingerprint, "mock");
    const entry = await source.store.getEntry(key);
    if (entry === null) throw new Error("not cached");

    // A store holding that one answer as an entry that expires (as one fetched before the D25 rule would be).
    const store = createMemoryQlooStore();
    await store.putEntry({ ...entry, pinned: false, expiresAt: new Date(NOW().getTime() + 86_400_000) });
    const kv = memoryKv({ [MOCK_LOCALITIES_KV_KEY]: source.kv.values.get(MOCK_LOCALITIES_KV_KEY) });
    const plan = await warm(["--metro", "nashville"], { store, kv });
    expect(plan.text).toMatch(/nashville\s+Nashville\s+pinned\s+network\s+cached\s+network\s+network/);
    const run = await warm(["--metro", "nashville", "--yes"], { store, kv });
    expect(run.code).toBe(0);
    expect(run.text).toMatch(/nashville\s+fingerprint\s+HIT\s+50\s+pinned\s+pinned/);
    expect(await store.getEntry(key)).toMatchObject({ pinned: true, expiresAt: null });
  });

  it("skips a map city with no locality pin and fails, after warming the others", async () => {
    const { store, kv } = await pinned(["nashville"]);
    const { code, text } = await warm(["--metro", "nashville,dallas", "--yes"], { store, kv });
    expect(code).toBe(1);
    expect(text).toMatch(/dallas\s+Dallas\s+not pinned\s+—\s+—\s+—\s+—/);
    expect(text).toContain("no locality pin in kv metro_localities.mock (skipped; pin with tools/dev/localities.ts pin <id> first): dallas");
    expect(text).toContain("city side: 4 of 4 entries pinned");
  });

  it("refuses a malformed kv value before any call", async () => {
    const store = createMemoryQlooStore();
    const kv = memoryKv({ [MOCK_LOCALITIES_KV_KEY]: ["not", "pins"] });
    const { code, err } = await warm(["--all", "--yes"], { store, kv });
    expect(code).toBe(1);
    expect(err).toContain('kv "metro_localities.mock" is malformed');
    expect(store.calls).toHaveLength(0);
  });

  it("prints the usage on bad arguments", async () => {
    const { code, err } = await warm(["--metro", "gotham"], { store: createMemoryQlooStore(), kv: memoryKv() });
    expect(code).toBe(2);
    expect(err).toContain("usage: pnpm exec tsx tools/dev/warm-metros.ts");
  });
});

describe("warm-metros on live Qloo (a fake fetch)", () => {
  const LIVE_ENV = { QLOO_API_KEY: "test-key-not-real", QLOO_TAG: "dev-tools-test", QLOO_TAG_CAP: "200", QLOO_RPS: "10" };
  const kv = () => memoryKv({ [LOCALITIES_KV_KEY]: { nashville: { entityId: "loc-fake-nashville", label: "Nashville" } } });

  /** Answers every insights call with no rows. */
  const emptyFetch: typeof fetch = async (input) => {
    const type = new URL(String(input)).searchParams.get("filter.type");
    const results = type === "urn:heatmap" ? { heatmap: [] } : type === "urn:tag" ? { tags: [] } : { entities: [] };
    return new Response(JSON.stringify({ success: true, results }), { status: 200, headers: { "content-type": "application/json" } });
  };

  it("reports an empty city side and fails, though the D25 rule stored it pinned", async () => {
    const store = createMemoryQlooStore();
    const { code, text, all } = await warm(["--metro", "nashville", "--yes"], { store, kv: kv(), env: LIVE_ENV, fetch: emptyFetch });
    expect(code).toBe(1);
    expect(text).toContain("warm-metros · Qloo dev · tag dev-tools-test");
    expect(text.match(/empty answer: check the locality pin/g)).toHaveLength(4);
    expect(text).toContain("4 empty answers: a run would read no city there.");
    expect([...store.entries.values()].every((e) => e.pinned && e.status === 200)).toBe(true);
    expect(all).not.toMatch(ID);
  });

  it("stops at the tag cap: nothing fetched, nothing pinned", async () => {
    const store = createMemoryQlooStore();
    const { code, text } = await warm(["--metro", "nashville", "--yes"], { store, kv: kv(), env: { ...LIVE_ENV, QLOO_TAG_CAP: "0" }, fetch: emptyFetch });
    expect(code).toBe(1);
    expect(text.match(/not fetched: a Qloo budget gate refused the call/g)).toHaveLength(4);
    expect(text).toMatch(/nashville\s+baseline\s+—\s+—\s+not fetched/);
    expect(text).toContain("city side: 0 of 4 entries pinned");
    expect(store.entries.size).toBe(0);
  });
});
