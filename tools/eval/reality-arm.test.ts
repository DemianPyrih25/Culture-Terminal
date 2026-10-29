// The Reality Check arm the eval runs: GHOST asked each case's registered question under the kind's
// job, the real runRealityCheck over an invented world behind the real Qloo client, and one eval record
// per case, whose detail tells runner.ts realityRetry whether --resume runs it again. No network, no
// database, no LLM: runGhost is a fake of its signature (D29: every name, id and value is invented).
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GhostError, type GhostOptions, type GhostResult } from "@ct/agent";
import type { GhostAnswer, LocalityApi } from "@ct/contracts";
import type { QlooClient } from "@ct/qloo";
import { afterEach, describe, expect, it } from "vitest";
import type { RealityCase, RealityCasesFile } from "./cases";
import type { RealityContext } from "./cli";
import { realityCase } from "./fixtures";
import { ghostWorstCaseUsd } from "./ghost";
import { ghostQuestion, REALITY_GHOST } from "./reality";
import { createRealityArm, realityRecords, type RealityArmOverrides } from "./reality-arm";
import { areaCells, gridGeo, worldClient, type World } from "./reality-fixtures";
import type { SecondaryMarket } from "./reality-location";
import { realityRetry, SpentError } from "./runner";

const brand = (id: string, name: string, popularity: number) => ({ id, name, type: "brand" as const, popularity });
const BASELINE_TAG = "urn:tag:genre:place:restaurant";
const AREAS = ["Old Mill", "Juniper Row", "Kestrel Park", "Linden Cross", "Pine Hollow", "Marten Bluff", "Nettle Green"].map((name) => ({
  id: name.toLowerCase().replace(/ /g, "_"),
  name,
}));
// Concept and baseline affinity per area: Old Mill's lift leads.
const HEAT = [0.9, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2];

const WORLD: World = {
  entities: [
    brand("brand-alpha", "Brand Alpha", 0.8),
    brand("brand-beta", "Brand Beta", 0.6),
    brand("brand-gamma", "Brand Gamma", 0.7),
    brand("brand-delta", "Brand Delta", 0.5),
    ...["a", "b", "c", "d", "e", "f"].map((x, i) => brand(`brand-pool-${x}`, `Pool Brand ${x.toUpperCase()}`, 0.55 + i * 0.02)),
  ],
  // The choice's look-alikes, the seed among them.
  pools: { "brand-beta": ["brand-alpha", "brand-gamma", ...["a", "b", "c", "d", "e", "f"].map((x) => `brand-pool-${x}`)] },
  affinity: {
    "brand-alpha": {
      "brand-beta": 0.9,
      "brand-gamma": 0.7,
      ...Object.fromEntries(["a", "b", "c", "d", "e", "f"].map((x, i) => [`brand-pool-${x}`, 0.2 + i * 0.1])),
    },
  },
  localities: {},
  heatmaps: {
    "loc-austin|brand-delta": HEAT.flatMap((a, i) => areaCells(i, 6, a)),
    [`loc-austin|${BASELINE_TAG}`]: HEAT.flatMap((_, i) => areaCells(i, 6, 0.4, 0.5 + i * 0.01)),
  },
};

const MARKETS: SecondaryMarket[] = [
  { id: "riverton", label: "Riverton", state: "WY", stateName: "Wyoming" },
  { id: "osprey_bay", label: "Osprey Bay", state: "FL", stateName: "Florida" },
] as unknown as SecondaryMarket[];
const LOCALITIES: LocalityApi = { market: async (id) => (id === "austin" ? { entityId: "loc-austin", label: "Austin" } : null) };
const ENTITY = realityCase("rc01");
const STORE = realityCase("rc10", "dtc_neighbourhood");
const FILE: RealityCasesFile = { registered: "2026-01-15", caveats: ["An invented caveat."], scoring: ["An invented rule."], cases: [ENTITY, STORE] };
const NO_PICKS: GhostAnswer["picks"] = { competitors: [], markets: [], neighbourhoods: [], tenants: [], partners: [], creators: [] };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-reality-arm-"));
  dirs.push(dir);
  return dir;
}

const usage = { input: 900, output: 300, cacheRead: 0, cacheCreation: 0 };

/** A runGhost fake: the kind's list from `picks`, per case seed; every call recorded. */
function fakeGhost(picks: Partial<Record<RealityCase["kind"], string[]>>, fail?: (o: GhostOptions) => GhostError | null) {
  const calls: GhostOptions[] = [];
  const run = async (o: GhostOptions): Promise<GhostResult> => {
    calls.push(o);
    const error = fail?.(o) ?? null;
    if (error !== null) throw error;
    const kind = (Object.keys(REALITY_GHOST) as RealityCase["kind"][]).find((k) => REALITY_GHOST[k].job === o.job) ?? "brand_collaboration";
    const answer: GhostAnswer = { headline: "An invented headline.", picks: { ...NO_PICKS, [REALITY_GHOST[kind].category]: picks[kind] ?? [] }, numeric_claims: [] };
    return { answer, usage, usd: 0.01, ms: 2_000, model: o.model };
  };
  return { run, calls };
}

function context(client: QlooClient, rawDir: string, lines: string[]): RealityContext {
  return {
    anthropic: {} as RealityContext["anthropic"],
    qloo: client,
    localities: LOCALITIES,
    model: "claude-sonnet-5-5",
    file: FILE,
    rawDir,
    log: (line) => lines.push(line),
    now: () => new Date("2026-01-20T12:00:00.000Z"),
    signal: new AbortController().signal,
  };
}

function arm(client: QlooClient, rawDir: string, ghost: ReturnType<typeof fakeGhost>, lines: string[] = [], over: RealityArmOverrides = {}) {
  return createRealityArm(context(client, rawDir, lines), {
    runGhost: ghost.run,
    geo: async () => ({ geo: gridGeo("austin", AREAS), source: "test" }),
    markets: MARKETS,
    ...over,
  });
}

describe("the Reality Check arm", () => {
  it("asks GHOST each case's question under the kind's job on the ANALYST model, and records each case", async () => {
    const { client } = worldClient(WORLD);
    const raw = temp();
    const ghost = fakeGhost({ brand_collaboration: ["Brand Gamma", "Brand Beta"], dtc_neighbourhood: ["Juniper Row"] });
    const records = await arm(client, raw, ghost).run({ cases: [ENTITY, STORE], signal: new AbortController().signal });
    await client.flush();

    expect(ghost.calls.map((o) => [o.question, o.job, o.model])).toEqual([
      [ghostQuestion(ENTITY, MARKETS), "brand_collab", "claude-sonnet-5-5"],
      [ghostQuestion(STORE, MARKETS), "site_selection", "claude-sonnet-5-5"],
    ]);
    // Only the store case names a metro, so only its GHOST message lists that metro's gazetteer areas.
    expect(ghost.calls.map((o) => o.metro)).toEqual([null, "austin"]);
    expect(ghost.calls[1]?.geo?.neighbourhoods("austin").map((a) => a.name)).toEqual(AREAS.map((a) => a.name));
    const entity = records.find((r) => r.caseId === "rc01");
    expect(entity).toMatchObject({ resolved: true, ghostHit: true, chanceHit: null, usd: 0.01, ms: 2_000, note: null });
    // The choice leads the one scoring call.
    expect(entity?.percentile).toBe(1);
    const store = records.find((r) => r.caseId === "rc10");
    expect(store).toMatchObject({ resolved: true, ghostHit: false, usd: 0.01 });
    expect(store?.percentile).not.toBeNull();
    expect(store?.note).toMatch(/includes the 1 Qloo calls the cases share/);
    // The raw run, scores included, goes to the folder it is given and nowhere else.
    expect(readdirSync(raw)).toEqual([expect.stringMatching(/^reality-check-\d{8}T\d{9}Z\.json$/)]);
  });

  it("keeps a case whose GHOST answer failed, with the hit unknown and what the response cost", async () => {
    const { client } = worldClient(WORLD);
    const failed = new GhostError("max_tokens", "the answer was cut off", { retryable: true, usage, usd: 0.02, model: "claude-sonnet-5-5" });
    const ghost = fakeGhost({}, () => failed);
    const [record] = await arm(client, temp(), ghost).run({ cases: [ENTITY], signal: new AbortController().signal });
    expect(record).toMatchObject({ caseId: "rc01", ghostHit: null, usd: 0.02, resolved: true });
    expect(record?.note).toContain("GHOST: the answer was cut off");
    // A cut-off answer may come back whole on a rerun: --resume runs the case again.
    expect(record?.detail).toMatchObject({ retry: false, ghost: { retryable: true } });
    expect(record === undefined ? null : realityRetry(record)).toBe("GHOST: the answer was cut off");
  });

  it("takes the API's refusal as GHOST's answer, which --resume does not ask again", async () => {
    const { client } = worldClient(WORLD);
    const refused = new GhostError("refusal", "the model refused", { retryable: false, usage, usd: 0.004, model: "claude-sonnet-5-5" });
    const [record] = await arm(client, temp(), fakeGhost({}, () => refused)).run({ cases: [ENTITY], signal: new AbortController().signal });
    expect(record).toMatchObject({ ghostHit: null, usd: 0.004, detail: { retry: false, ghost: { retryable: false } } });
    expect(record === undefined ? undefined : realityRetry(record)).toBeNull();
  });

  it("marks a case whose Qloo call failed for a retry, and leaves a final one alone", async () => {
    const { client } = worldClient(WORLD);
    const failing: QlooClient = {
      ...client,
      standalone: (options) => {
        const scope = client.standalone(options);
        return {
          ...scope,
          forTool: (id) => {
            const tool = scope.forTool(id);
            return {
              search: (p) => tool.search(p),
              entities: (ids) => tool.entities(ids),
              tags: (p) => tool.tags(p),
              audiences: (p) => tool.audiences(p),
              trending: (p) => tool.trending(p),
              has: (path, p) => tool.has(path, p),
              insights: async (type, params) => {
                if (type === "urn:entity:brand") throw new Error("Qloo answered 503 three times");
                return tool.insights(type, params);
              },
            };
          },
        };
      },
    };
    const records = await arm(failing, temp(), fakeGhost({})).run({ cases: [ENTITY, STORE], signal: new AbortController().signal });
    const entity = records.find((r) => r.caseId === "rc01");
    const store = records.find((r) => r.caseId === "rc10");
    expect(entity).toMatchObject({ percentile: null, detail: { reason: "call_failed", retry: true } });
    expect(entity === undefined ? null : realityRetry(entity)).toBe("call_failed");
    expect(store === undefined ? undefined : realityRetry(store)).toBeNull();
  });

  it("records nothing when the check is cancelled, and says what GHOST spent", async () => {
    const { client } = worldClient(WORLD);
    const raw = temp();
    const cancel = new AbortController();
    let answered = false;
    const ghost = fakeGhost({ brand_collaboration: ["Brand Beta"] }, () => {
      // The first answer arrives as Ctrl+C is pressed; the next request is cancelled before a response.
      if (!answered) {
        answered = true;
        cancel.abort();
        return null;
      }
      return new GhostError("cancelled", "the GHOST request was cancelled", { retryable: false, model: "claude-sonnet-5-5" });
    });
    const run = arm(client, raw, ghost).run({ cases: [ENTITY, STORE], signal: cancel.signal });
    await expect(run).rejects.toBeInstanceOf(SpentError);
    await expect(run).rejects.toMatchObject({ usd: 0.01, message: expect.stringContaining("cancelled; no case was recorded") });
    expect(readdirSync(raw)).toEqual([]);
  });

  it("reports what GHOST spent when the check itself throws", async () => {
    const { client } = worldClient(WORLD);
    const ghost = fakeGhost({});
    const run = arm(client, temp(), ghost, [], {
      runRealityCheck: async (_file, deps) => {
        await deps.ghostTop5(ENTITY);
        throw new Error("an invented bug");
      },
    }).run({ cases: [ENTITY], signal: new AbortController().signal });
    await expect(run).rejects.toMatchObject({ name: "SpentError", usd: 0.01, message: expect.stringContaining("an invented bug") });
  });

  it("scores against the panel of every registered comedian, whichever cases run", async () => {
    const { client } = worldClient(WORLD);
    const comedian = realityCase("rc07", "comedian_market");
    const second = { ...realityCase("rc08", "comedian_market"), seed: { name: "Comedian Lyra", entity_type: "person" } } as RealityCase;
    const file: RealityCasesFile = { ...FILE, cases: [ENTITY, comedian, second] };
    let seen: { run: string[]; registered: string[] } | null = null;
    await createRealityArm(
      { ...context(client, temp(), []), file },
      {
        runGhost: fakeGhost({}).run,
        geo: async () => ({ geo: gridGeo("austin", AREAS), source: "test" }),
        markets: MARKETS,
        runRealityCheck: async (f, deps) => {
          seen = { run: f.cases.map((c) => c.id), registered: (deps.registered ?? []).map((c) => c.id) };
          const { runRealityCheck } = await import("./reality");
          return runRealityCheck(f, deps);
        },
      },
    ).run({ cases: [comedian], signal: new AbortController().signal });
    expect(seen).toEqual({ run: ["rc07"], registered: ["rc01", "rc07", "rc08"] });
  });

  it("stops before anything is sent when a case points at a market this build does not have", async () => {
    const { client, requests } = worldClient(WORLD);
    const comedian = { ...realityCase("rc07", "comedian_market"), choice: { entity_type: "locality", tour: "Invented Tour", markets: ["lakeside"] } } as RealityCase;
    const ghost = fakeGhost({});
    const run = arm(client, temp(), ghost).run({ cases: [comedian], signal: new AbortController().signal });
    await expect(run).rejects.toBeInstanceOf(SpentError);
    await expect(run).rejects.toMatchObject({ usd: 0, message: expect.stringContaining("lakeside not among the secondary markets") });
    expect(ghost.calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it("refuses a neighbourhood case when the gazetteer did not load", async () => {
    const { client } = worldClient(WORLD);
    const run = arm(client, temp(), fakeGhost({}), [], { geo: async () => ({ geo: gridGeo("austin", AREAS), source: "stub" }) }).run({
      cases: [STORE],
      signal: new AbortController().signal,
    });
    await expect(run).rejects.toMatchObject({ usd: 0, message: expect.stringContaining("gazetteer") });
  });

  it("books one GHOST answer per case as its worst case", () => {
    const { client } = worldClient(WORLD);
    expect(arm(client, temp(), fakeGhost({})).worstCaseUsd([ENTITY, STORE])).toBeCloseTo(2 * ghostWorstCaseUsd("claude-sonnet-5-5"), 9);
  });
});

describe("the records", () => {
  it("count every call the check made, the shared ones on the first case that uses them", async () => {
    const { client } = worldClient(WORLD);
    let run: Parameters<typeof realityRecords>[0] | null = null;
    const ghost = fakeGhost({});
    await arm(client, temp(), ghost, [], {
      runRealityCheck: async (file, deps) => {
        const { runRealityCheck } = await import("./reality");
        run = await runRealityCheck(file, deps);
        return run;
      },
    }).run({ cases: [ENTITY, STORE], signal: new AbortController().signal });
    if (run === null) throw new Error("the check did not run");
    const done: Parameters<typeof realityRecords>[0] = run;
    const records = realityRecords(done, new Map());
    expect(records.reduce((n, r) => n + r.qlooCalls, 0)).toBe(done.calls.network + done.calls.cached);
    expect(records.map((r) => r.usd)).toEqual([0, 0]);
  });
});
