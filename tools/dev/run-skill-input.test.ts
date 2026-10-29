// run-skill's generic mode end to end, in process: any skill from its tool input, on the synthetic
// mock transport (QLOO_MOCK=1) over a memory store, with names resolved to R# refs, tag URNs
// registered as T# refs and the market localities pinned by tools/dev/localities.ts in a memory kv.
// No network, no database, no key.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GeoApi } from "@ct/contracts";
import { createMemoryQlooStore, type MemoryQlooStore } from "@ct/qloo";
import { beforeAll, describe, expect, it } from "vitest";
import { UsageError } from "./cli/args";
import { loadGeo, stubGeo } from "./cli/geo";
import { memoryIo } from "./cli/io";
import { memoryKv } from "./cli/localities";
import { runLocalitiesCommand } from "./cli/localities-cli";
import { parseSkillArgs, runSkillCommand } from "./cli/skill-cli";

const ENV = { QLOO_MOCK: "1", QLOO_RPS: "10" };
const NOW = () => new Date("2026-10-23T03:15:22.123Z");

type Kv = ReturnType<typeof memoryKv>;

async function run(argv: string[], opts: { store?: MemoryQlooStore; kv?: Kv; geo?: GeoApi } = {}) {
  const io = memoryIo();
  const store = opts.store ?? createMemoryQlooStore();
  const code = await runSkillCommand(argv, { env: ENV, io, store, kv: opts.kv, geo: opts.geo ?? stubGeo(), now: NOW });
  return { code, io, text: io.stdout.join("\n"), err: io.stderr.join("\n"), store };
}

/** Pins the markets' localities into `kv` with the locality tool, over the same synthetic Qloo store. */
async function pinned(store: MemoryQlooStore, kv: Kv, ...markets: string[]): Promise<void> {
  for (const id of markets) {
    const argv = id === "austin" ? ["pin", "austin", "--pick", "1", "--yes"] : ["pin", id, "--yes"];
    const code = await runLocalitiesCommand(argv, { env: ENV, io: memoryIo(), store, kv, now: NOW });
    expect(code, id).toBe(0);
  }
}

/** The lines of the section whose heading starts with `title`, up to the next blank line. */
function section(text: string, title: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(title));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.trim() === "");
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** The tool column of the QLOO CALLS table. */
const callTools = (text: string): string[] => section(text, "QLOO CALLS").slice(1).map((l) => l.trim().split(/\s+/)[1] ?? "");

const SHARE = (metros: string[]) => JSON.stringify({ type: "brand", set: ["R1", "R2", "R3"], ages: ["25_to_29"], audiences: [], metros });

describe("run-skill <skill> --input", () => {
  it("resolves --names to R refs, runs the skill and prints the registry, digest, datasets, metrics, findings, calls and quota", async () => {
    const { code, text } = await run(["share_of_taste", "--names", "Brand Alpha,Brand Beta,Brand Gamma", "--input", SHARE([])]);
    expect(code).toBe(0);
    expect(text).toContain("run-skill share_of_taste · Qloo mock");
    expect(text).toContain("localities none (no kv: metro, city and market contexts unavailable)");
    expect(text).toContain("resolve_entities: 3 name(s) as brand, estimated 3 network call(s)");
    expect(section(text, "REGISTRY")).toEqual(expect.arrayContaining([expect.stringMatching(/R1\s+brand\s+Brand Alpha/), expect.stringMatching(/R3\s+brand\s+Brand Gamma/)]));
    expect(text).toContain("share_of_taste: estimated 1 network call(s)");
    expect(text).toMatch(/SHARE_OF_TASTE · status ok · flags none/);
    expect(text).toMatch(/DIGEST \(what the model reads\)\n {2}~\d+ tokens · 3 top row\(s\)/);
    expect(section(text, "DATASETS")[1]).toMatch(/D1\s+Matrix\s+Share of Taste · Brand Alpha\s+1×3 share\s+share\.pct/);
    // Metrics carry their badge, key, FORMULAS id and sample size.
    expect(section(text, "METRICS")[0]).toMatch(/id\s+value\s+badge\s+key\s+formula\s+n\s+evidence\s+label/);
    expect(text).toMatch(/M4\s+.+\s+DERIVED\s+share\.pct\s+share\.pct\s+3\s+E4/);
    expect(text).toContain("FINDINGS");
    expect(callTools(text)).toEqual(["cli-resolve", "cli-resolve", "cli-resolve", "cli-share_of_taste"]);
    expect(text).toContain("this run      4 network · 0 cached");
  });

  it("measures metro contexts with the localities pinned in kv", async () => {
    const store = createMemoryQlooStore();
    const kv = memoryKv();
    const without = await run(["share_of_taste", "--names", "Brand Alpha,Brand Beta,Brand Gamma", "--input", SHARE(["nashville"])], { store });
    expect(without.text).toContain("Nashville: no market locality is available to this build, so the context was not called.");

    await pinned(store, kv, "nashville");
    const { code, text } = await run(["share_of_taste", "--names", "Brand Alpha,Brand Beta,Brand Gamma", "--input", SHARE(["nashville"])], { store, kv });
    expect(code).toBe(0);
    expect(text).toContain("localities kv metro_localities.mock (1 pinned)");
    expect(text).not.toContain("no market locality is available");
    expect(callTools(text).filter((t) => t === "cli-share_of_taste")).toHaveLength(2);
    expect(text).toMatch(/Share-of-Taste percentile of Brand Alpha, metro Nashville/);
    expect(text).not.toMatch(/metro Nashville.*UNAVAILABLE|UNAVAILABLE.*metro Nashville/);
  });

  it("gives a name its own type with a type: prefix", async () => {
    const { code, text } = await run([
      "audience_dna",
      "--names",
      "artist:Artist Nova,Brand Alpha",
      "--input",
      JSON.stringify({ set: ["R1", "R2"], compare_with: null }),
    ]);
    expect(code).toBe(0);
    expect(text).toContain("resolve_entities: 2 name(s) as artist, brand");
    expect(text).toMatch(/R1\s+artist\s+Artist Nova/);
    expect(text).toMatch(/R2\s+brand\s+Brand Alpha/);
    expect(text).toContain("AUDIENCE_DNA · status");
  });

  it("resolves more names than one resolve_entities call takes, in calls of 8", async () => {
    const names = Array.from({ length: 10 }, (_, i) => `Brand Number ${i + 1}`);
    const input = { type: "brand", candidates: names.map((_, i) => `R${i + 1}`), signal_entities: [], signal_tags: [], contexts: [{ kind: "age", age: "25_to_29" }] };
    const { code, text } = await run(["rank_candidates", "--names", names.join(","), "--input", JSON.stringify(input)]);
    expect(code).toBe(0);
    expect(text).toContain("resolve_entities: 8 name(s) as brand, estimated 8 network call(s)");
    expect(text).toContain("resolve_entities: 2 name(s) as brand, estimated 2 network call(s)");
    expect(text).toMatch(/R10\s+brand\s+Brand Number 10/);
    expect(text).toContain("RANK_CANDIDATES · status");
  });

  it("stops before the skill when a name has no exact match", async () => {
    const { code, text } = await run(["share_of_taste", "--names", "Brand Alpha,Brand notfound,Brand Gamma", "--input", SHARE([])]);
    expect(code).toBe(3);
    expect(text).toContain("NEEDS A CHOICE (nothing was substituted)");
    expect(text).not.toContain("SHARE_OF_TASTE ·");
    expect(callTools(text)).not.toContain("cli-share_of_taste");
  });

  it("runs a skill that takes no refs, and reads the input from a file", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ct-run-skill-"));
    const file = path.join(dir, "input.json");
    writeFileSync(file, JSON.stringify({ concepts: [{ text: "coffee shop", scope: "place" }] }));
    const { code, text } = await run(["find_tags", "--input", `@${file}`]);
    expect(code).toBe(0);
    expect(text).not.toContain("resolve_entities:");
    expect(text).toContain("FIND_TAGS · status");
    expect(text).toMatch(/· [1-9]\d* registered/);
    // The tags find_tags registers, with the URNs a later run takes with --tags.
    const registered = section(text, "REGISTERED BY FIND_TAGS");
    expect(registered).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/T\d+\s+urn:tag:genre:place\s+Coffee shop\s+urn:tag:genre:place:restaurant:coffee_shop\s/),
        expect.stringMatching(/T\d+\s+urn:tag:category:place\s+Cafe\s+urn:tag:category:place:cafe\s/),
      ]),
    );
  });

  it("says (none) when the skill registered nothing", async () => {
    const { text } = await run(["share_of_taste", "--names", "Brand Alpha,Brand Beta,Brand Gamma", "--input", SHARE([])]);
    expect(section(text, "REGISTERED BY SHARE_OF_TASTE (0)")).toEqual(["  (none)"]);
  });
});

describe("run-skill location skills over pinned localities and the gazetteer", () => {
  let geo: GeoApi;
  beforeAll(async () => {
    const loaded = await loadGeo();
    expect(loaded.source).toBe("@ct/geo");
    geo = loaded.geo;
  });

  it("maps a concept's lift with --tags registered as T refs", async () => {
    const store = createMemoryQlooStore();
    const kv = memoryKv();
    await pinned(store, kv, "austin");
    const input = { metro: "austin", concept_tags: ["T1", "T2"], concept_entities: [], supply: true };
    const { code, text } = await run(
      ["geo_lift", "--tags", "urn:tag:genre:place:restaurant:coffee_shop,urn:tag:category:place:cafe", "--input", JSON.stringify(input)],
      { store, kv, geo },
    );
    expect(code).toBe(0);
    expect(text).toMatch(/T1\s+urn:tag:genre:place\s+Coffee shop\s+urn:tag:genre:place:restaurant:coffee_shop/);
    expect(text).toMatch(/T2\s+urn:tag:category:place\s+Cafe\s+urn:tag:category:place:cafe/);
    expect(section(text, "DATASETS")[1]).toMatch(/D1\s+GeoLift\s+.+austin gh\d+ · \d+ cells · \d+ areas/);
    expect(text).toMatch(/GEO_LIFT · status (ok|partial)/);
  });

  const blockInput = (): string => {
    const area = geo.neighbourhoods("nashville")[0];
    expect(area).toBeDefined();
    return JSON.stringify({ area: { kind: "nbhd", ref: area?.id, metro: "nashville" }, include_brands: true });
  };

  it("reads a block's taste against its pinned city", async () => {
    const store = createMemoryQlooStore();
    const kv = memoryKv();
    // Without a pin the city side is not measured.
    const without = await run(["block_dna", "--input", blockInput()], { store, kv, geo });
    expect(without.text).toContain("BLOCK_DNA · status partial");
    expect(without.text).toContain("No Qloo locality is pinned for Nashville yet; the city side is not measured.");

    await pinned(store, kv, "nashville");
    const { code, text } = await run(["block_dna", "--input", blockInput()], { store, kv, geo });
    expect(code).toBe(0);
    expect(text).toContain("BLOCK_DNA · status ok");
    expect(text).not.toContain("No Qloo locality is pinned");
    expect(text).toContain("city side: Qloo's Nashville locality");
    expect(section(text, "EVIDENCE").some((l) => l.includes("City tag fingerprint of Nashville (Qloo locality)"))).toBe(true);
    const datasets = section(text, "DATASETS");
    expect(datasets.some((l) => /D1\s+Bars\s+Block DNA · .+ vs Nashville/.test(l))).toBe(true);
    expect(datasets.some((l) => /D2\s+Ranked\s+Brands favoured in .+ · vs Nas/.test(l))).toBe(true);
  });

  it("lists every ref the skill registered after the digest, which may list fewer", async () => {
    const store = createMemoryQlooStore();
    const kv = memoryKv();
    await pinned(store, kv, "nashville");
    const { code, text } = await run(["block_dna", "--input", blockInput()], { store, kv, geo });
    expect(code).toBe(0);
    expect(section(text, "REGISTRY")).toEqual(["  (empty)"]);
    const digested = Number(/· (\d+) registered/.exec(text)?.[1]);
    const count = Number(/REGISTERED BY BLOCK_DNA \((\d+)\)/.exec(text)?.[1]);
    expect(count).toBeGreaterThan(digested);
    const rows = section(text, "REGISTERED BY BLOCK_DNA").slice(1);
    expect(rows).toHaveLength(count);
    expect(rows.some((l) => /^ {2}R1\s+brand\s/.test(l))).toBe(true);
    // Whole URNs, descriptive tags marked.
    expect(rows.some((l) => /^ {2}T\d+\s+\S+\s+.+\surn:tag:\S+ \(descriptive: no signal\)/.test(l))).toBe(true);
    expect(rows.some((l) => /^ {2}T\d+\s+urn:tag:genre:place\s+.+\surn:tag:genre:place:\S+\s+—$/.test(l))).toBe(true);
  });
});

describe("run-skill --input arguments", () => {
  const share = ["share_of_taste", "--names", "Brand Alpha,Brand Beta,Brand Gamma"];
  it.each([
    [[...share, "--input", "{not json"], /--input is not JSON/],
    [[...share, "--input", "[1]"], /--input must be a JSON object/],
    [[...share, "--input", JSON.stringify({ type: "brand", set: ["R1"], ages: [], audiences: [], metros: [] })], /not a valid share_of_taste input:\n {2}set: /],
    [["share_of_taste", "--names", "Brand Alpha,Brand Beta", "--input", SHARE([])], /--input uses R3, but --names gives 2 name\(s\) \(R1–R2\)/],
    [["geo_lift", "--input", JSON.stringify({ metro: "austin", concept_tags: ["T1"], concept_entities: [], supply: false })], /--input uses T1, but --tags gives 0 tag\(s\)$/],
    [["share_of_taste", "Brand Alpha", "--input", SHARE([])], /give names with --names, not as arguments/],
    [["peer_landscape", "--k", "5", "--names", "Brand Alpha", "--input", "{}"], /--k does not go with --input/],
    [[...share, "--metro", "nashville", "--input", SHARE([])], /--metro applies to place names only/],
    [["rank_candidates", "--names", "place:Cafe Alpha,place:Cafe Beta", "--input", "{}"], /a place name needs --metro/],
    [["find_tags", "--type", "artist", "--input", "{}"], /--type applies to --names/],
    [["geo_lift", "--tags", "coffee shop", "--input", "{}"], /--tags takes tag URNs/],
    [["find_tags", "--input", "@"], /--input @ needs a file path/],
    [["find_tags", "--input", "@no-such-dir/input.json"], /cannot read --input file/],
    [["find_tags", "--names", "Brand Alpha"], /--names goes with --input/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseSkillArgs(argv)).toThrow(UsageError);
    expect(() => parseSkillArgs(argv)).toThrow(message);
  });

  it("fills trigger_finding_id and step_id with null and keeps the place metro per name", () => {
    const args = parseSkillArgs([
      "rank_candidates",
      "--names",
      "place:Cafe Alpha,place:Cafe Beta,Brand Alpha",
      "--metro",
      "nashville",
      "--input",
      JSON.stringify({ type: "place", candidates: ["R1", "R2"], signal_entities: [], signal_tags: [], contexts: [{ kind: "city", metro: "nashville" }] }),
    ]);
    expect(args?.mode).toBe("input");
    if (args?.mode !== "input") return;
    expect(args.mentions).toEqual([
      { text: "Cafe Alpha", type: "place", metro: "nashville" },
      { text: "Cafe Beta", type: "place", metro: "nashville" },
      { text: "Brand Alpha", type: "brand", metro: null },
    ]);
    expect(args.input).toMatchObject({ trigger_finding_id: null, step_id: null });
  });

  it("answers a bad input with exit code 2 before any Qloo call", async () => {
    const { code, err, store } = await run(["share_of_taste", "--names", "Brand Alpha", "--input", SHARE([])]);
    expect(code).toBe(2);
    expect(err).toContain("--input uses R3, but --names gives 1 name(s) (R1–R1)");
    // The message says what to fix; the whole usage would bury it.
    expect(err).toContain("(pnpm run-skill --help lists the options)");
    expect(err).not.toContain("usage: pnpm run-skill");
    expect(store.calls).toHaveLength(0);
  });
});
