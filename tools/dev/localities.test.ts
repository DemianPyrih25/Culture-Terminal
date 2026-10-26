// tools/dev/localities.ts end to end, in process: the real Qloo client on the synthetic mock
// transport (QLOO_MOCK=1) or on a fake live fetch with invented localities, over a memory store and
// a memory kv. No network, no database, no key; no locality id may reach the terminal.
import { createMemoryQlooStore, type MemoryQlooStore } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { memoryIo } from "./cli/io";
import { LOCALITIES_KV_KEY, memoryKv, MOCK_LOCALITIES_KV_KEY, StoredLocalities } from "./cli/localities";
import { parseLocalitiesArgs, runLocalitiesCommand } from "./cli/localities-cli";
import { loadMarkets, type Market } from "./cli/markets";
import { UsageError } from "./cli/args";

const ENV = { QLOO_MOCK: "1", QLOO_RPS: "10" };
const NOW = () => new Date("2026-10-23T03:15:22.123Z");
const MARKETS = loadMarkets();
const AUTO = MARKETS.filter((m) => !m.deliberate);

/** Any id the mock or the fake live answers issue. */
const ID = /mock-ent-|loc-fake-/;

type Kv = ReturnType<typeof memoryKv>;

async function run(argv: string[], opts: { store?: MemoryQlooStore; kv?: Kv; markets?: readonly Market[]; env?: NodeJS.ProcessEnv; fetch?: typeof fetch } = {}) {
  const io = memoryIo();
  const store = opts.store ?? createMemoryQlooStore();
  const kv = opts.kv ?? memoryKv();
  const code = await runLocalitiesCommand(argv, { env: opts.env ?? ENV, io, store, kv, markets: opts.markets, fetch: opts.fetch, now: NOW });
  const all = [...io.stdout, ...io.stderr].join("\n");
  return { code, io, text: io.stdout.join("\n"), err: io.stderr.join("\n"), all, store, kv };
}

const pinsIn = (kv: Kv, key = MOCK_LOCALITIES_KV_KEY) => StoredLocalities.parse(kv.values.get(key) ?? {});

/** The lines of the section whose heading starts with `title`, up to the next blank line. */
function section(text: string, title: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(title));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.trim() === "");
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

const market = (id: string, query: string, stateName: string, extra: Partial<Market> = {}): Market => ({
  id,
  label: query,
  state: "XX",
  stateName,
  query,
  deliberate: false,
  center: null,
  ...extra,
});

describe("localities list", () => {
  it("lists every market with its rule, pin and cache state, and makes no Qloo call", async () => {
    const kv = memoryKv({ [MOCK_LOCALITIES_KV_KEY]: { nashville: { entityId: "mock-ent-900000000001", label: "Nashville" }, old_market: { entityId: "mock-ent-900000000002", label: "Old" } } });
    const { code, text, store, all } = await run(["list"], { kv });
    expect(code).toBe(0);
    expect(text).toContain(`MARKETS (${MARKETS.length}) · kv metro_localities.mock`);
    expect(text).toMatch(/nashville\s+Nashville\s+Nashville\s+TN\s+auto\s+pinned\s+not cached/);
    expect(text).toMatch(/austin\s+Austin\s+Austin\s+TX\s+deliberate\s+—\s+not cached/);
    expect(text).toContain("kv also pins old_market (not in config/metros.json)");
    expect(text).toContain(`pin --all would search ${MARKETS.length - 1} markets: 0 cached, ${MARKETS.length - 1} network calls to Qloo mock`);
    expect(store.calls).toHaveLength(0);
    expect(text).not.toContain("QLOO CALLS");
    expect(all).not.toMatch(ID);
  });
});

describe("localities pin", () => {
  it("prints the plan and makes no call without --yes", async () => {
    const { code, text, store, kv } = await run(["pin", "--all"]);
    expect(code).toBe(3);
    expect(text).toContain(`PLAN (${MARKETS.length} markets to resolve · 0 cached · ${MARKETS.length} network calls)`);
    expect(text).toContain(`pin would make ${MARKETS.length} network calls to Qloo mock under tag dev`);
    expect(text).toContain("Run it again with --yes.");
    expect(store.calls).toHaveLength(0);
    expect(kv.values.size).toBe(0);
  });

  it("pins every market with one exact name in its state, leaves the deliberate one to a person, and prints no id", async () => {
    const { code, text, all, kv, store } = await run(["pin", "--all", "--yes"]);
    expect(code).toBe(3);
    const pins = pinsIn(kv);
    expect(Object.keys(pins)).toEqual(AUTO.map((m) => m.id));
    for (const m of AUTO) expect(pins[m.id]?.label).toBe(m.label);
    expect(pins.nyc?.label).toBe("New York City");
    expect(Object.values(pins).every((p) => /^mock-ent-[0-9a-f]{12}$/.test(p.entityId))).toBe(true);
    // Synthetic ids never land under the live key.
    expect(kv.values.has(LOCALITIES_KV_KEY)).toBe(false);

    expect(text).toMatch(/nashville\s+pinned\s+Nashville \(Tennessee, United States · pop \d\.\d\d · at 36\.16,-86\.78 · 0 km from centre\)\s+Nashville/);
    expect(text).toContain("austin 'Austin' (Texas): config/metros.json marks it pin: deliberate, so a person chooses; exact matches:");
    expect(text).toMatch(/1\. Austin \(Texas, United States · pop \d\.\d\d · at 30\.27,-97\.74 · 0 km from centre\)/);
    expect(text).toContain("to pin one: pnpm exec tsx tools/dev/localities.ts pin austin --pick <n> --yes");
    expect(text).toContain(`kv metro_localities.mock: wrote ${AUTO.length} pins; ${AUTO.length} of ${MARKETS.length} markets pinned`);
    expect(section(text, "QLOO CALLS").slice(1)).toHaveLength(MARKETS.length);
    expect(text).toContain(`this run      ${MARKETS.length} network · 0 cached`);
    expect(store.calls.every((c) => c.path === "/search")).toBe(true);
    expect(all).not.toMatch(ID);
  });

  it("pins a deliberate market by its number in the listing, from the cache", async () => {
    const store = createMemoryQlooStore();
    const kv = memoryKv();
    await run(["pin", "--all", "--yes"], { store, kv });
    const picked = await run(["pin", "austin", "--pick", "1", "--yes"], { store, kv });
    expect(picked.code).toBe(0);
    expect(picked.text).toMatch(/austin\s+pinned\s+Austin \(Texas, United States/);
    expect(picked.text).toContain("this run      0 network · 1 cached");
    expect(pinsIn(kv).austin?.label).toBe("Austin");
    expect(Object.keys(pinsIn(kv))).toEqual(MARKETS.map((m) => m.id));
    expect(picked.all).not.toMatch(ID);

    // Everything pinned: nothing to search, nothing written, no call.
    const again = await run(["pin", "--all", "--yes"], { store, kv });
    expect(again.code).toBe(0);
    expect(again.text).toContain("nothing to pin: every selected market is pinned");
    expect(again.text).not.toContain("QLOO CALLS");
  });

  it("resolves pinned markets again with --replace, answered from the cache", async () => {
    const store = createMemoryQlooStore();
    const kv = memoryKv();
    await run(["pin", "nashville", "memphis", "--yes"], { store, kv });
    const before = pinsIn(kv);
    const replaced = await run(["pin", "nashville", "memphis", "--replace", "--yes"], { store, kv });
    expect(replaced.code).toBe(0);
    expect(replaced.text).toMatch(/now\s+search/);
    expect(replaced.text).toMatch(/nashville\s+replaced\s+Nashville/);
    expect(replaced.text).toContain("this run      0 network · 2 cached");
    expect(pinsIn(kv)).toEqual(before);
  });

  it("keeps the pins kv already holds, other markets included", async () => {
    const kv = memoryKv({ [MOCK_LOCALITIES_KV_KEY]: { old_market: { entityId: "mock-ent-900000000002", label: "Old" } } });
    const { code } = await run(["pin", "memphis", "--yes"], { kv });
    expect(code).toBe(0);
    expect(Object.keys(pinsIn(kv))).toEqual(["memphis", "old_market"]);
  });

  it("offers exact names outside the state as a choice, and pins the one picked", async () => {
    // The mock answers a "twin" query with two exact names told apart by year, not by state.
    const markets = [market("twin_harbor", "Twin Harbor", "Oregon")];
    const store = createMemoryQlooStore();
    const kv = memoryKv();
    const open = await run(["pin", "--all", "--yes"], { markets, store, kv });
    expect(open.code).toBe(3);
    expect(open.text).toContain("twin_harbor 'Twin Harbor' (Oregon): no exact match names Oregon; exact matches:");
    expect(open.text).toMatch(/1\. Twin Harbor \(2004 · pop/);
    expect(open.text).toMatch(/2\. Twin Harbor \(2019 · pop/);
    expect(open.text).toContain("kv metro_localities.mock: nothing written");
    expect(kv.values.size).toBe(0);

    const outOfRange = await run(["pin", "twin_harbor", "--pick", "3", "--yes"], { markets, store, kv });
    expect(outOfRange.code).toBe(3);
    expect(outOfRange.text).toContain("--pick 3 is out of range; exact matches:");
    expect(kv.values.size).toBe(0);

    const picked = await run(["pin", "twin_harbor", "--pick", "2", "--yes"], { markets, store, kv });
    expect(picked.code).toBe(0);
    expect(picked.text).toMatch(/twin_harbor\s+pinned\s+Twin Harbor \(2019/);
    expect(pinsIn(kv).twin_harbor?.label).toBe("Twin Harbor");
    expect(picked.all).not.toMatch(ID);
  });

  it("fails a market with no exact name and writes nothing for it", async () => {
    const markets = [market("lost_creek", "Lost Creek notfound", "Oregon"), market("memphis", "Memphis", "Tennessee")];
    const { code, text, kv, all } = await run(["pin", "--all", "--yes"], { markets });
    expect(code).toBe(1);
    expect(text).toMatch(/lost_creek\s+not found\s+no locality named 'Lost Creek notfound'/);
    expect(text).toContain("NOT FOUND (no exact name; check the query in config/metros.json)");
    expect(text).toMatch(/lost_creek 'Lost Creek notfound': other results: Lost Creek notfound Classic/);
    expect(Object.keys(pinsIn(kv))).toEqual(["memphis"]);
    expect(all).not.toMatch(ID);
  });

  it("refuses to write over a malformed kv value, before any call", async () => {
    const kv = memoryKv({ [MOCK_LOCALITIES_KV_KEY]: ["not", "pins"] });
    const { code, err, store } = await run(["pin", "memphis", "--yes"], { kv });
    expect(code).toBe(1);
    expect(err).toContain('kv "metro_localities.mock" is malformed');
    expect(store.calls).toHaveLength(0);
    expect(kv.values.get(MOCK_LOCALITIES_KV_KEY)).toEqual(["not", "pins"]);
  });
});

/** A live-mode fetch with invented localities: two Rivertons in Oregon, one in Idaho, one Lakeside. */
function fakeLive() {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    const query = url.searchParams.get("query") ?? "";
    const row = (id: string, name: string, disambiguation: string) => ({ entity_id: id, name, types: ["urn:entity:locality"], popularity: 0.5, disambiguation });
    const results =
      query === "Lakeside"
        ? [row("loc-fake-lakeside", "Lakeside", "Oregon, United States"), row("loc-fake-lakeside-id", "Lakeside", "Idaho, United States")]
        : [row("loc-fake-riverton-1", "Riverton", "Oregon, United States"), row("loc-fake-riverton-2", "Riverton", "Oregon, United States")];
    return new Response(JSON.stringify({ results }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, requests };
}

describe("localities pin on live Qloo (a fake fetch)", () => {
  const LIVE_ENV = { QLOO_API_KEY: "test-key-not-real", QLOO_TAG: "dev-tools-test", QLOO_TAG_CAP: "200", QLOO_RPS: "10" };
  const markets = [market("lakeside", "Lakeside", "Oregon"), market("riverton", "Riverton", "Oregon")];

  it("writes live pins under metro_localities, asks for a choice between two exact names in the state, and prints no id", async () => {
    const live = fakeLive();
    const { code, text, all, kv } = await run(["pin", "--all", "--yes"], { env: LIVE_ENV, fetch: live.fetch, markets });
    expect(code).toBe(3);
    expect(live.requests).toEqual(["/search", "/search"]);
    expect(text).toContain("localities pin · Qloo dev · tag dev-tools-test");
    expect(text).toContain("riverton 'Riverton' (Oregon): 2 exact matches in Oregon; exact matches:");
    expect(pinsIn(kv, LOCALITIES_KV_KEY)).toEqual({ lakeside: { entityId: "loc-fake-lakeside", label: "Lakeside" } });
    expect(kv.values.has(MOCK_LOCALITIES_KV_KEY)).toBe(false);
    expect(text).toContain("tag           dev-tools-test: 2 of 200 network calls used");
    expect(all).not.toMatch(ID);
  });

  it("stops at the tag cap: nothing searched, nothing written, no request sent", async () => {
    const live = fakeLive();
    const { code, text, err, kv } = await run(["pin", "lakeside", "--yes"], { env: { ...LIVE_ENV, QLOO_TAG_CAP: "0" }, fetch: live.fetch, markets });
    expect(code).toBe(1);
    expect(text).toMatch(/lakeside\s+not searched\s+a Qloo budget gate refused the call/);
    expect(err).toContain("qloo budget gate refused a network call");
    expect(text).toContain("kv metro_localities: nothing written");
    expect(live.requests).toEqual([]);
    expect(kv.values.size).toBe(0);
  });

  it("refuses --memory on live Qloo before opening anything", async () => {
    const io = memoryIo();
    const code = await runLocalitiesCommand(["list", "--memory"], { env: LIVE_ENV, io, markets });
    expect(code).toBe(1);
    expect(io.stderr.join("\n")).toContain("--memory works only on synthetic Qloo data");
  });
});

describe("localities arguments", () => {
  it.each([
    [[], /name a command/],
    [["unpin"], /unknown command "unpin"/],
    [["list", "nashville"], /list takes no market ids/],
    [["list", "--yes"], /--yes applies to pin only/],
    [["pin"], /needs --all or at least one market id/],
    [["pin", "--all", "nashville"], /--all or market ids, not both/],
    [["pin", "atlantis"], /unknown market "atlantis"/],
    [["pin", "--all", "--pick", "1"], /--pick chooses for one market/],
    [["pin", "nashville", "memphis", "--pick", "1"], /--pick chooses for one market/],
    [["pin", "austin", "--pick", "0"], /--pick must be an integer from 1 to 10/],
    [["pin", "austin", "--tag", " "], /--tag needs a non-empty value/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseLocalitiesArgs(argv, MARKETS)).toThrow(UsageError);
    expect(() => parseLocalitiesArgs(argv, MARKETS)).toThrow(message);
  });

  it("selects markets in config order, each once", () => {
    expect(parseLocalitiesArgs(["pin", "memphis", "nashville", "memphis"], MARKETS)?.ids).toEqual(["nashville", "memphis"]);
    expect(parseLocalitiesArgs(["pin", "--all"], MARKETS)?.ids).toHaveLength(MARKETS.length);
  });

  it("answers a bad command with exit code 2 and the usage, without touching Qloo or kv", async () => {
    const { code, err, store, kv } = await run(["pin", "atlantis", "--yes"]);
    expect(code).toBe(2);
    expect(err).toContain("usage: pnpm exec tsx tools/dev/localities.ts");
    expect(store.calls).toHaveLength(0);
    expect(kv.values.size).toBe(0);
  });

  it("prints the usage for --help", async () => {
    const { code, text } = await run(["--help"]);
    expect(code).toBe(0);
    expect(text).toContain("Locality ids are written to the database kv only, never printed.");
  });
});
