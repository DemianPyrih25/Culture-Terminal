// Kit parity without the kit: the kit CLI is replaced by a runner that answers from the synthetic
// mock transport (the same data our side gets with QLOO_MOCK=1), or by canned output. No process is
// spawned, nothing touches the network, and the entity ids involved never appear in the output.
import { createMemoryQlooStore, canonicalize, createMockTransport } from "@ct/qloo";
import { searchParams } from "@ct/quant";
import { describe, expect, it } from "vitest";
import { stubGeo } from "../dev/cli/geo";
import { memoryIo } from "../dev/cli/io";
import { cmdQuote, displayCommand, kitArgs, type KitRun, type KitRunner, type KitSearch } from "./kit";
import {
  compareSides,
  errorSide,
  KitOutputError,
  kitCallRow,
  kitRefusal,
  kitSearchFor,
  kitSide,
  parseKitSearch,
  parseParityArgs,
  renderParity,
  runKitParityCommand,
  type KitSide,
  type SideMatch,
} from "./parity";

// Invented entities only (D29).
const SEARCH: KitSearch = { query: "Brand Alpha", types: "urn:entity:brand", take: 5 };
const ALPHA = { entity_id: "ent-invented-alpha", name: "Brand Alpha", types: ["urn:entity:brand"], popularity: 0.5 };
const ALPHA_CLASSIC = { entity_id: "ent-invented-alpha-classic", name: "Brand Alpha Classic", types: ["urn:entity:brand"], popularity: 0.3 };

describe("parseKitSearch", () => {
  it.each([
    ["a top-level array", [ALPHA]],
    ["a results list", { results: [ALPHA] }],
    ["an entities list inside results", { results: { entities: [ALPHA] } }],
    ["a data wrapper", { data: { results: [ALPHA] } }],
  ])("reads %s", (_label, json) => {
    expect(parseKitSearch(JSON.stringify(json))).toEqual([{ ...ALPHA, disambiguation: null }]);
  });

  it("skips a status line before the JSON and reads id, type and subtype variants", () => {
    const out = `searching…\n${JSON.stringify({ results: [{ id: "ent-invented-x", name: "Brand X", type: "urn:entity:brand" }, { name: "no id" }] })}`;
    expect(parseKitSearch(out)).toEqual([{ entity_id: "ent-invented-x", name: "Brand X", types: ["urn:entity:brand"], popularity: undefined, disambiguation: null }]);
  });

  it("refuses output that is not JSON or has no result list", () => {
    expect(() => parseKitSearch("Error: not logged in")).toThrow(KitOutputError);
    expect(() => parseKitSearch(JSON.stringify({ ok: true }))).toThrow(/no result list/);
  });
});

describe("kitSide", () => {
  it("applies the D20 rule to the kit's results", () => {
    expect(kitSide("Brand Alpha", "brand", [ALPHA_CLASSIC, ALPHA])).toMatchObject({ match: "exact", entityId: ALPHA.entity_id, popularity: 0.5, candidates: 1 });
    expect(kitSide("Brand Alpha", "artist", [ALPHA])).toMatchObject({ match: "not_found", entityId: null });
    expect(kitSide("Brand Alpha", "brand", [ALPHA, { ...ALPHA, entity_id: "ent-invented-alpha-2" }])).toMatchObject({ match: "ambiguous", entityId: null });
  });
});

describe("compareSides", () => {
  const exact = (entityId: string, popularity: number | null = 0.5): SideMatch => ({
    match: "exact",
    entityId,
    types: ["urn:entity:brand"],
    popularity,
    candidates: 2,
    error: null,
  });
  const open = (match: SideMatch["match"]): SideMatch => ({ match, entityId: null, types: [], popularity: null, candidates: 3, error: null });

  it("passes the same exact entity with agreeing popularity", () => {
    const row = compareSides("Brand Alpha", "brand", exact("ent-a", 0.5), exact("ent-a", 0.505));
    expect(row).toMatchObject({ verdict: "PASS", sameEntity: true, sameType: true, note: "" });
    expect(row.popularityDelta).toBeCloseTo(0.005);
  });

  it("fails different entities, drifting popularity and one-sided matches", () => {
    expect(compareSides("Brand Alpha", "brand", exact("ent-a"), exact("ent-b"))).toMatchObject({ verdict: "FAIL", sameEntity: false, note: "different entities" });
    expect(compareSides("Brand Alpha", "brand", exact("ent-a", 0.5), exact("ent-a", 0.6))).toMatchObject({ verdict: "FAIL", note: "popularity differs" });
    expect(compareSides("Brand Alpha", "brand", exact("ent-a"), open("ambiguous"))).toMatchObject({ verdict: "FAIL", note: "ours exact, kit ambiguous" });
  });

  it("leaves the same entity UNVERIFIED when popularity is missing on a side", () => {
    expect(compareSides("Brand Alpha", "brand", exact("ent-a", 0.5), exact("ent-a", null))).toMatchObject({
      verdict: "UNVERIFIED",
      sameEntity: true,
      popularityDelta: null,
      note: "popularity missing on the kit side",
    });
    expect(compareSides("Brand Alpha", "brand", exact("ent-a", null), exact("ent-a", null))).toMatchObject({ verdict: "UNVERIFIED", note: "popularity missing on both sides" });
    // A different entity fails whatever the popularity.
    expect(compareSides("Brand Alpha", "brand", exact("ent-a", null), exact("ent-b", 0.5)).verdict).toBe("FAIL");
  });

  it("passes when neither side picks an entity: both would ask", () => {
    expect(compareSides("Brand Alpha", "brand", open("not_found"), open("ambiguous"))).toMatchObject({ verdict: "PASS", note: "both ask (ours not_found, kit ambiguous)" });
  });

  it("fails a side that errored", () => {
    expect(compareSides("Brand Alpha", "brand", exact("ent-a"), errorSide("exit 1"))).toMatchObject({ verdict: "FAIL", note: "kit failed: exit 1" });
  });

  it("renders the table without any entity id", () => {
    const text = renderParity([
      compareSides("Brand Alpha", "brand", exact("ent-invented-a"), exact("ent-invented-a")),
      compareSides("Brand Beta", "brand", exact("ent-invented-b"), exact("ent-invented-c")),
    ]).join("\n");
    expect(text).toMatch(/Brand Alpha\s+exact · pop 0\.50\s+exact · pop 0\.50\s+same\s+✓\s+0\.00\s+PASS/);
    expect(text).toMatch(/Brand Beta\s+.+DIFFERENT\s+✓\s+0\.00\s+FAIL\s+different entities/);
    expect(text).not.toContain("ent-invented");
  });
});

describe("the kit command line", () => {
  it("asks the kit for the same /search our side sends, as JSON", () => {
    expect(kitArgs(SEARCH)).toEqual(["api", "search", "--query", "Brand Alpha", "--type", "urn:entity:brand", "--take", "5", "--json"]);
    expect(displayCommand("qloo", SEARCH)).toBe('qloo api search --query "Brand Alpha" --type urn:entity:brand --take 5 --json');
    for (const type of ["brand", "artist", "movie"] as const) {
      expect(kitSearchFor(" Brand Alpha ", type)).toEqual(searchParams({ text: "Brand Alpha", type, metro: null }));
    }
  });

  it("quotes for cmd.exe and refuses what cmd.exe would expand or split", () => {
    expect(cmdQuote("Ben & Jerry's")).toBe('"Ben & Jerry\'s"');
    expect(() => cmdQuote("100%")).toThrow(/cmd\.exe/);
    expect(() => cmdQuote('say "hi"')).toThrow(/cmd\.exe/);
  });
});

describe("parseParityArgs", () => {
  it("keeps each name once and defaults to a dry run on brands", () => {
    expect(parseParityArgs(["Brand Alpha", "brand alpha", "Brand Beta"])).toMatchObject({ names: ["Brand Alpha", "Brand Beta"], type: "brand", liveKit: false, kitBin: "qloo" });
  });

  it("refuses no names, place types, too many names and names resolve_entities would reject", () => {
    expect(() => parseParityArgs([])).toThrow(/at least one/);
    expect(() => parseParityArgs(["Some Cafe", "--type", "place"])).toThrow(/--type must be one of/);
    expect(() => parseParityArgs(Array.from({ length: 9 }, (_, i) => `Brand ${i}`))).toThrow(/at most 8/);
    expect(() => parseParityArgs(["A".repeat(81)])).toThrow(/81 characters; resolve_entities takes at most 80/);
    expect(() => parseParityArgs(["--mock", "Brand Alpha"])).toThrow(/Unknown option/);
  });

  it("has no --memory: the kit is always live, and live calls go through the shared Postgres cache", () => {
    expect(() => parseParityArgs(["Brand Alpha", "--live-kit", "--memory"])).toThrow(/Unknown option/);
  });
});

describe("kitRefusal", () => {
  const budget = { calls: 2, monthRemaining: 40_000, monthFloor: 38_000, tag: "dev-tools", tagCap: 200, tagUsed: 10 };

  it("lets the kit run while the month and the tag have room", () => {
    expect(kitRefusal(budget)).toBeNull();
    expect(kitRefusal({ ...budget, monthRemaining: 38_002 })).toBeNull();
    // An unknown month count passes, as in the client; so does a tag without a cap.
    expect(kitRefusal({ ...budget, monthRemaining: null, tagCap: null, tagUsed: null })).toBeNull();
    expect(kitRefusal({ ...budget, calls: 0, monthRemaining: 0 })).toBeNull();
  });

  it("refuses calls that would take the month below the dev floor", () => {
    expect(kitRefusal({ ...budget, monthRemaining: 38_001 })).toBe("38,001 monthly Qloo calls remain and 2 kit call(s) would go below the 38,000 floor");
  });

  it("refuses calls the tag has no room for, or when its count is unknown", () => {
    expect(kitRefusal({ ...budget, tagUsed: 199 })).toBe('QLOO_TAG "dev-tools" has 1 of its 200 network calls left and the kit needs 2');
    expect(kitRefusal({ ...budget, tagUsed: null })).toMatch(/could not be read/);
  });
});

describe("kitCallRow", () => {
  const run: KitRun = { command: displayCommand("qloo", SEARCH), spawned: true, status: 0, stdout: "[]", stderr: "", error: null, ms: 812.4 };
  const at = { env: "dev" as const, tag: "dev-tools", runId: "cli-20261022T031522123Z", ts: new Date("2026-10-22T03:15:22.123Z") };

  it("logs a kit call as a network call under the tag, outside our cache keys", () => {
    const row = kitCallRow(run, SEARCH, at);
    expect(row).toMatchObject({
      env: "dev",
      tag: "dev-tools",
      runId: at.runId,
      path: "/search",
      params: { query: "Brand Alpha", take: "5", types: "urn:entity:brand" },
      cacheStatus: "miss",
      httpStatus: null,
      ms: 812,
      requestId: null,
      error: null,
    });
    expect(row.id).toMatch(/^kit-/);
    expect(row.cacheKey).toBe(`kit:${canonicalize("/search", { query: "Brand Alpha", types: "urn:entity:brand", take: 5 }).key}`);
  });

  it("records a kit that failed", () => {
    expect(kitCallRow({ ...run, status: 3 }, SEARCH, at).error).toBe("kit exit 3");
    expect(kitCallRow({ ...run, status: null, error: "killed by SIGTERM" }, SEARCH, at).error).toBe("killed by SIGTERM");
  });
});

/** A kit that answers from the mock transport, as the real kit answers from live Qloo. */
function mockKit(): KitRunner & { names: string[] } {
  const transport = createMockTransport();
  const names: string[] = [];
  const kit = async (search: KitSearch): Promise<KitRun> => {
    names.push(search.query);
    const response = await transport(canonicalize("/search", { query: search.query, types: search.types, take: search.take }, "mock-v1"));
    return { command: displayCommand("qloo", search), spawned: true, status: 0, stdout: new TextDecoder().decode(response.body), stderr: "", error: null, ms: 5 };
  };
  return Object.assign(kit, { names });
}

const canned =
  (stdout: string, extra: Partial<KitRun> = {}): KitRunner =>
  async (search) => ({ command: displayCommand("qloo", search), spawned: true, status: 0, stdout, stderr: "", error: null, ms: 5, ...extra });

/** Our side on the mock transport; the kit answers locally unless `live` says otherwise. */
async function parity(argv: string[], run: KitRunner, live = false) {
  const io = memoryIo();
  const store = createMemoryQlooStore();
  const kit: KitSide = { run, live };
  const code = await runKitParityCommand(argv, { env: { QLOO_MOCK: "1", QLOO_RPS: "10" }, io, store, geo: stubGeo(), kit, rawDir: null });
  return { code, io, text: io.text(), err: io.stderr.join("\n"), store };
}

describe("runKitParityCommand", () => {
  it("prints the plan and calls nothing without --live-kit", async () => {
    const kit = mockKit();
    const { code, text, store } = await parity(["Brand Alpha", "Brand Beta"], kit);
    expect(code).toBe(0);
    expect(text).toContain("dry run");
    expect(text).toContain('kit:  qloo api search --query "Brand Alpha" --type urn:entity:brand --take 5 --json');
    expect(text).toContain("ours: GET /search query=Brand Alpha types=urn:entity:brand take=5");
    expect(kit.names).toEqual([]);
    expect(store.calls).toHaveLength(0);
  });

  it("finds parity when both sides read the same data, including names neither side can pick", async () => {
    const kit = mockKit();
    const { code, text } = await parity(["Brand Alpha", "Brand notfound", "--live-kit"], kit);
    expect(code).toBe(0);
    expect(kit.names).toEqual(["Brand Alpha", "Brand notfound"]);
    expect(text).toMatch(/Brand Alpha\s+exact · pop \d\.\d\d\s+exact · pop \d\.\d\d\s+same\s+✓\s+0\.00\s+PASS/);
    expect(text).toMatch(/Brand notfound\s+not_found \(\d\)\s+not_found \(\d\)\s+—\s+—\s+—\s+PASS\s+both ask/);
    expect(text).toContain("2 of 2 at parity");
    expect(text).toContain("QLOO CALLS (2)");
    expect(text).not.toMatch(/"entity_id"/);
  });

  it("fails when the kit picks another entity or cannot run", async () => {
    const other = canned(JSON.stringify([{ entity_id: "ent-invented-other", name: "Brand Alpha", types: ["urn:entity:brand"], popularity: 0.1 }]));
    const mismatch = await parity(["Brand Alpha", "--live-kit"], other);
    expect(mismatch.code).toBe(1);
    expect(mismatch.text).toMatch(/DIFFERENT.+FAIL/);
    expect(mismatch.text).toContain("0 of 1 at parity · 1 FAIL");
    expect(mismatch.text).not.toContain("ent-invented-other");

    const failed = await parity(["Brand Alpha", "--live-kit"], canned("", { spawned: false, status: null, error: "spawn qloo ENOENT" }));
    expect(failed.code).toBe(1);
    expect(failed.text).toContain("kit failed: spawn qloo ENOENT");
  });

  it("exits 1 for a row whose popularity could not be compared", async () => {
    const kit = mockKit();
    // The kit's answer for the same search, with popularity left out.
    const bare: KitRunner = async (search) => {
      const run = await kit(search);
      const results = (JSON.parse(run.stdout) as { results: Record<string, unknown>[] }).results;
      return { ...run, stdout: JSON.stringify(results.map((r) => ({ ...r, popularity: undefined }))) };
    };
    const { code, text } = await parity(["Brand Alpha", "--live-kit"], bare);
    expect(code).toBe(1);
    expect(text).toMatch(/Brand Alpha\s+exact · pop \d\.\d\d\s+exact\s+same\s+✓\s+—\s+UNVERIFIED\s+popularity missing on the kit side/);
    expect(text).toContain("0 of 1 at parity · 1 UNVERIFIED (popularity not compared)");
  });

  it("refuses to run a live kit against a mock side, before the kit is called", async () => {
    const kit = mockKit();
    const { code, err, store } = await parity(["Brand Alpha", "--live-kit"], kit, true);
    expect(code).toBe(1);
    expect(err).toContain("needs our side on live Qloo");
    expect(kit.names).toEqual([]);
    expect(store.calls).toHaveLength(0);
  });

  it("keeps escape sequences in names away from the terminal", async () => {
    const { code, text } = await parity(["Brand \u001b[31mRed\u001b]52;c;eA==\u0007", "--live-kit"], mockKit());
    expect(code).toBe(0);
    expect(text).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
    expect(text).toContain("Brand [31mRed]52;c;eA==");
  });

  it("answers a name longer than resolve_entities takes with exit code 2, before opening anything", async () => {
    const kit = mockKit();
    const { code, err, store } = await parity(["B".repeat(90), "--live-kit"], kit);
    expect(code).toBe(2);
    expect(err).toContain("90 characters; resolve_entities takes at most 80");
    expect(kit.names).toEqual([]);
    expect(store.calls).toHaveLength(0);
  });
});
