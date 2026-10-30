// run-skill end to end, in process: the real Qloo client on the synthetic mock transport (QLOO_MOCK=1)
// over a memory store, the real registry, ledger and skills. No network, no database, no key.
import { createMemoryQlooStore, type MemoryQlooStore } from "@ct/qloo";
import { describe, expect, it } from "vitest";
import { stubGeo } from "./cli/geo";
import { memoryIo } from "./cli/io";
import { cliRunId, parseSkillArgs, runSkillCommand } from "./cli/skill-cli";
import { UsageError } from "./cli/args";

// The mock answers every allowlisted request; QLOO_RPS=10 keeps the limiter out of the way.
const ENV = { QLOO_MOCK: "1", QLOO_RPS: "10" };
const NOW = () => new Date("2026-10-22T03:15:22.123Z");

async function run(argv: string[], store: MemoryQlooStore = createMemoryQlooStore()) {
  const io = memoryIo();
  const code = await runSkillCommand(argv, { env: ENV, io, store, geo: stubGeo(), now: NOW });
  return { code, io, text: io.text(), store };
}

/** The lines of the section whose heading starts with `title`, up to the next blank line. */
function section(text: string, title: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith(title));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && l.trim() === "");
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

/** The cache column of the QLOO CALLS table. */
function cacheColumn(text: string): string[] {
  const lines = text.split("\n");
  const start = lines.findIndex((l) => l.startsWith("QLOO CALLS"));
  const header = lines[start + 1] ?? "";
  const at = header.indexOf("cache");
  const rows: string[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!/^\s+\d+\s/.test(line)) break;
    rows.push(line.slice(at).split(/\s+/)[0] ?? "");
  }
  return rows;
}

describe("run-skill peer_landscape", () => {
  it("prints the map, metrics, findings, every call and the quota meter", async () => {
    const { code, text } = await run(["peer_landscape", "Brand Alpha", "--k", "5"]);
    expect(code).toBe(0);
    expect(text).toContain("run-skill peer_landscape · Qloo mock");
    expect(text).toContain(`run ${cliRunId(NOW())}`);
    expect(text).toMatch(/Brand Alpha\s+brand\s+exact\s+R1/);
    expect(text).toContain("SUBSTITUTION MAP · BRAND ALPHA · D1");
    expect(text).toMatch(/▸ R1 Brand Alpha/);
    expect(text).toMatch(/hub score\s+distinct/);
    expect(text).toMatch(/DATASETS \(2\)\n.+\n {2}D1\s+Matrix\s+Substitution Map · Brand Alpha\s+5×5 similarity/);
    // The Category Taste Map from the same matrix: no extra Qloo call.
    expect(text).toMatch(/ {2}D2\s+TasteMap\s+Category Taste Map · Brand Alpha\s+5 points · stress/);
    expect(text).toContain("METRICS");
    expect(text).toMatch(/M\d+\s+.+\s+DERIVED\s+subs\.distinctiveness\s+subs\.\w+/);
    expect(text).toContain("FINDINGS");
    expect(text).toContain("QUOTA");
    expect(text).toContain("month left    49,000 of 50,000");
    expect(text).toContain("dev floor     stops at 32,000");
    // One resolve search, two discovery calls, k−1 = 4 scoring calls.
    expect(cacheColumn(text)).toEqual(Array(7).fill("MISS"));
    expect(text).toContain("this run      7 network · 0 cached");
  });

  it("traces every number to the x-qloo-request-ids behind it", async () => {
    const { text } = await run(["peer_landscape", "Brand Alpha", "--k", "5"]);
    const metrics = section(text, "METRICS").slice(1);
    const evidence = section(text, "EVIDENCE");
    const calls = section(text, "QLOO CALLS").slice(1);
    expect(metrics.length).toBeGreaterThan(0);
    // The request id of each call, by its number in QLOO CALLS.
    const requestOf = new Map(calls.map((l) => [l.trim().split(/\s+/)[0], l.match(/mock-[0-9a-f]{16}/)?.[0]]));
    for (const metric of metrics) {
      const ids = metric.match(/\bE\d+\b/g) ?? [];
      expect(ids.length, metric).toBeGreaterThan(0);
      for (const id of ids) {
        const row = evidence.findIndex((l) => l.trim().startsWith(`${id} `));
        expect(row, `${id} in EVIDENCE`).toBeGreaterThanOrEqual(0);
        const next = evidence.findIndex((l, i) => i > row && /^\s+E\d+\s/.test(l));
        const block = evidence.slice(row + 1, next < 0 ? undefined : next).join(" ");
        const requests = [...block.matchAll(/#(\d+) (mock-[0-9a-f]{16})/g)];
        // One request id per call in the bundle (the "calls" column).
        expect(requests.length, `${id} request ids`).toBe(Number(evidence[row]?.trim().split(/\s+/)[4]));
        // Each listed request id is the one its numbered call carried, and that call names the bundle.
        for (const [, n, requestId] of requests) {
          expect(requestOf.get(n)).toBe(requestId);
          expect(calls.find((l) => l.trim().startsWith(`${n} `))).toMatch(new RegExp(`\\b${id}\\b`));
        }
      }
    }
    // The scoring bundle lists all four scoring calls.
    expect(evidence.join("\n")).toMatch(/E3\s+peer_landscape\s+ok\s+network\s+4\s+Triangular similarity/);
  });

  it("serves every call of a repeated command from the cache as HIT", async () => {
    const store = createMemoryQlooStore();
    const first = await run(["peer_landscape", "Brand Alpha", "--k", "5"], store);
    const second = await run(["peer_landscape", "Brand Alpha", "--k", "5"], store);
    expect(second.code).toBe(0);
    expect(cacheColumn(second.text)).toEqual(Array(7).fill("HIT"));
    expect(second.text).toContain("this run      0 network · 7 cached");
    // The same answers, so the same request ids. Calls run in parallel, so rows print in finishing order.
    const ids = (text: string) => (text.match(/mock-[0-9a-f]{16}/g) ?? []).sort();
    expect(ids(second.text)).toEqual(ids(first.text));
    expect(store.calls.filter((c) => c.cacheStatus === "miss")).toHaveLength(7);
    expect(store.calls.filter((c) => c.cacheStatus === "hit")).toHaveLength(7);
  });

  it("maps named peers without discovery", async () => {
    const { code, text } = await run(["peer_landscape", "Brand Alpha", "--peers", "Brand Beta,Brand Gamma,Brand Delta", "--no-discover", "--k", "4"]);
    expect(code).toBe(0);
    expect(text).toContain("discovery off");
    // Four searches and k−1 = 3 scoring calls.
    expect(cacheColumn(text)).toHaveLength(7);
    expect(text).toMatch(/R4 Brand Delta/);
  });

  it("stops before the map when a peer has no exact match, and substitutes nothing", async () => {
    const { code, text } = await run(["peer_landscape", "Brand Alpha", "--peers", "Brand notfound"]);
    expect(code).toBe(3);
    expect(text).toContain("NEEDS A CHOICE (nothing was substituted)");
    expect(text).toContain("'Brand notfound' (brand): not found; candidates:");
    expect(text).toMatch(/1\. Brand notfound \w+ \(pop \d\.\d\d\) {2}id mock-ent-1[0-9a-f]{11}/);
    expect(text).toContain('to use one in run-agent: --pins "brand notfound=<id>"');
    expect(text).not.toContain("SUBSTITUTION MAP");
    // The two searches, then the candidates' ids read back from the cache, free.
    expect(cacheColumn(text)).toEqual(["MISS", "MISS", "HIT"]);
    expect(text).toContain("this run      2 network · 1 cached");
  });
});

describe("run-skill resolve_entities", () => {
  it("resolves exact names and offers candidates for ambiguous ones", async () => {
    const { code, text } = await run(["resolve_entities", "Brand Alpha", "Brand Twin"]);
    expect(code).toBe(3);
    expect(text).toMatch(/Brand Alpha\s+brand\s+exact\s+R1\s+Brand Alpha/);
    expect(text).toMatch(/Brand Twin\s+brand\s+ambiguous\s+—/);
    expect(text).toContain("'Brand Twin' (brand): ambiguous; candidates:");
    expect(text).toMatch(/1\. Brand Twin \(2004, pop \d\.\d\d\) {2}id mock-ent-1[0-9a-f]{11}/);
    expect(text).toMatch(/2\. Brand Twin \(2019, pop \d\.\d\d\) {2}id mock-ent-1[0-9a-f]{11}/);
    expect(text).toMatch(/popularity Brand Alpha/);
  });

  it("keeps escape sequences in names away from the terminal", async () => {
    // The mock echoes the query as the entity name, as an untrusted Qloo name would arrive.
    const { code, io } = await run(["resolve_entities", "Brand \u001b[31mRed\u001b]8;;x\u0007"]);
    expect(code).toBe(0);
    const all = [...io.stdout, ...io.stderr].join("\n");
    expect(all).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/);
    expect(all).toMatch(/Brand \[31mRed\]8;;x\s+brand\s+exact\s+R1/);
  });

  it("exits 0 when every name resolves", async () => {
    const { code, text } = await run(["resolve_entities", "Brand Alpha", "--type", "artist"]);
    expect(code).toBe(0);
    expect(text).toMatch(/Brand Alpha\s+artist\s+exact\s+R1/);
  });
});

/** A live-mode fetch that records every request and answers none: these tests must not reach the network. */
function noNetwork() {
  const requests: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    requests.push(String(input));
    throw new Error("unexpected network call in a test");
  };
  return { fetch, requests };
}

describe("run-skill when a budget gate refuses the search", () => {
  // Live dev mode with no tag allowance left: the tag-cap gate refuses before any request is sent.
  const LIVE_ENV = { QLOO_API_KEY: "test-key-not-real", QLOO_TAG: "dev-tools-test", QLOO_TAG_CAP: "0", QLOO_RPS: "10" };

  async function refused(argv: string[]) {
    const io = memoryIo();
    const network = noNetwork();
    const code = await runSkillCommand(argv, { env: LIVE_ENV, io, store: createMemoryQlooStore(), fetch: network.fetch, geo: stubGeo(), now: NOW });
    return { code, text: io.stdout.join("\n"), err: io.stderr.join("\n"), requests: network.requests };
  }

  it("fails resolve_entities with exit 1, not 3: an unsearched name has nothing to choose from", async () => {
    const { code, text, err, requests } = await refused(["resolve_entities", "Brand Alpha"]);
    expect(code).toBe(1);
    expect(text).toContain("NOT SEARCHED (nothing was substituted)");
    expect(text).toContain("'Brand Alpha': not searched (a Qloo budget gate refused the call");
    expect(text).not.toContain("NEEDS A CHOICE");
    expect(err).toContain("qloo budget gate refused a network call");
    expect(requests).toEqual([]);
  });

  it("fails peer_landscape with exit 1 before the map", async () => {
    const { code, text, requests } = await refused(["peer_landscape", "Brand Alpha"]);
    expect(code).toBe(1);
    expect(text).toContain("NOT SEARCHED (nothing was substituted)");
    expect(text).not.toContain("NEEDS A CHOICE");
    expect(text).not.toContain("SUBSTITUTION MAP");
    expect(requests).toEqual([]);
  });
});

describe("run-skill --memory", () => {
  async function withoutStore(argv: string[], env: NodeJS.ProcessEnv) {
    const io = memoryIo();
    const network = noNetwork();
    const code = await runSkillCommand(argv, { env, io, fetch: network.fetch, geo: stubGeo(), now: NOW });
    return { code, text: io.stdout.join("\n"), err: io.stderr.join("\n"), requests: network.requests };
  }

  it("is refused on live Qloo before anything opens: the tag cap and the cache live in Postgres", async () => {
    const { code, text, err, requests } = await withoutStore(["resolve_entities", "Brand Alpha", "--memory"], { QLOO_API_KEY: "test-key-not-real", QLOO_TAG_CAP: "200" });
    expect(code).toBe(1);
    expect(err).toContain("--memory works only on synthetic Qloo data");
    expect(text).not.toContain("run-skill resolve_entities ·");
    expect(requests).toEqual([]);
  });

  it("runs on synthetic data, from --mock or QLOO_MOCK=1", async () => {
    for (const [argv, env] of [
      [["resolve_entities", "Brand Alpha", "--memory", "--mock"], { QLOO_RPS: "10" }],
      [["resolve_entities", "Brand Alpha", "--memory"], ENV],
    ] as const) {
      const { code, text } = await withoutStore([...argv], env);
      expect(code).toBe(0);
      expect(text).toContain("Qloo mock · tag dev · cache memory (nothing persists)");
    }
  });
});

describe("run-skill arguments", () => {
  it.each([
    [["peer_landscape", "Brand Alpha", "--k", "9"], /--k must be an integer from 4 to 7/],
    [["peer_landscape", "Brand Alpha", "--type", "artist"], /maps brands only/],
    [["peer_landscape", "Brand Alpha", "--no-discover", "--peers", "Brand Beta"], /at least 3 --peers/],
    [["peer_landscape", "Brand Alpha", "--peers", "brand alpha"], /must not include the target/],
    [["peer_landscape", "Brand Alpha", "Brand Beta"], /takes one brand/],
    [["resolve_entities", "Brand Alpha", "--k", "5"], /applies to peer_landscape only/],
    [["resolve_entities", "Some Cafe", "--type", "place"], /needs --metro/],
    [["resolve_entities", "A".repeat(81)], /81 characters; resolve_entities takes at most 80/],
    [["peer_landscape", "Brand Alpha", "--peers", `Brand Beta,${"B".repeat(90)}`], /a --peers name is 90 characters/],
    [["find_tags", "x"], /find_tags runs from its tool input/],
    [["no_such_skill", "x"], /unknown skill/],
    [[], /name a skill/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseSkillArgs(argv)).toThrow(UsageError);
    expect(() => parseSkillArgs(argv)).toThrow(message);
  });

  it("answers a bad command with exit code 2 and the usage, without touching Qloo", async () => {
    const { code, io, store } = await run(["peer_landscape"]);
    expect(code).toBe(2);
    expect(io.stderr.join("\n")).toContain("usage: pnpm run-skill");
    expect(store.calls).toHaveLength(0);
  });

  it("answers a name longer than resolve_entities takes with exit code 2, not a schema dump", async () => {
    const { code, io, store } = await run(["resolve_entities", "A".repeat(90)]);
    expect(code).toBe(2);
    expect(io.stderr[0]).toBe("a name is 90 characters; resolve_entities takes at most 80");
    expect(io.stderr.join("\n")).not.toContain("too_big");
    expect(store.calls).toHaveLength(0);
  });

  it("prints the usage for --help", async () => {
    const { code, text } = await run(["--help"]);
    expect(code).toBe(0);
    expect(text).toContain("usage: pnpm run-skill");
  });
});
