// The GHOST arm over a fake GHOST API: what it passes on, what it counts, and how a refusal and a failed
// answer are booked. No model and no Qloo (D29: invented names only).
import { GHOST_MARKETS, GHOST_MAX_TOKENS, GhostError, PRICING, type ResolvedGhostPick as AgentResolvedGhostPick } from "@ct/agent";
import type { GhostAnswer, Report } from "@ct/contracts";
import { describe, expect, expectTypeOf, it } from "vitest";
import { syntheticReport } from "../dev/cli/fixtures";
import { ghostDiff, NO_PICKS, pick } from "./fixtures";
import { createGhostArm, ghostWorstCaseUsd, type GhostApi } from "./ghost";
import type { ResolvedGhostPick } from "./records";
import { SpentError } from "./runner";

const ANSWER: GhostAnswer = { headline: "Foxglove Cola leads.", picks: { ...NO_PICKS, competitors: ["Foxglove Cola"] }, numeric_claims: [] };
const USAGE = { input: 1_000, output: 400, cacheRead: 0, cacheCreation: 0 };
const signal = new AbortController().signal;

function fakeApi(overrides: Partial<GhostApi> = {}) {
  const calls: { run: unknown[]; resolve: unknown[]; diff: unknown[] } = { run: [], resolve: [], diff: [] };
  const api: GhostApi = {
    runGhost: async (options) => {
      calls.run.push(options);
      return { answer: ANSWER, usage: USAGE, usd: 0.012, ms: 4_000, model: options.model };
    },
    resolveGhostPicks: async (options) => {
      calls.resolve.push(options);
      await options.search({ query: "Foxglove Cola" });
      await options.search({ query: "Foxglove Cola" });
      return [pick("Foxglove Cola")];
    },
    buildGhostDiff: (input) => {
      calls.diff.push(input);
      return ghostDiff();
    },
    ...overrides,
  };
  return { api, calls };
}

function arm(api: GhostApi) {
  return createGhostArm(
    {
      api,
      anthropic: {} as never,
      openSearch: () => {
        let calls = 0;
        return {
          search: async () => {
            calls += 1;
            return { data: { results: [] } } as never;
          },
          calls: () => calls,
        };
      },
    },
    "claude-sonnet-5-5",
  );
}

describe("the GHOST arm", () => {
  it("answers on the given model and job, looks the picks up through one counted search, at most ten", async () => {
    const { api, calls } = fakeApi();
    const out = await arm(api).answer({ question: "Is Brand Alpha a moat?", job: "brand_health", model: "claude-haiku-5-5", metro: "austin", signal });
    expect(calls.run[0]).toMatchObject({ question: "Is Brand Alpha a moat?", job: "brand_health", model: "claude-haiku-5-5", markets: GHOST_MARKETS, metro: "austin", signal });
    expect(calls.resolve[0]).toMatchObject({ answer: ANSWER, max: 10, metro: "austin" });
    expect(out).toMatchObject({ answer: ANSWER, refusal: null, model: "claude-haiku-5-5", tokens: USAGE, usd: 0.012, ms: 4_000, lookups: 2 });
    expect(out.resolved.map((p) => p.name)).toEqual(["Foxglove Cola"]);
  });

  it("diffs against a brief with its datasets", () => {
    const { api, calls } = fakeApi();
    const report: Report = syntheticReport("cli-eval-q01t1-x");
    arm(api).diff({ answer: ANSWER, resolved: [pick("Foxglove Cola")], report, datasets: [] });
    expect(calls.diff[0]).toMatchObject({ answer: ANSWER, report, datasets: [] });
  });

  it("records the API's refusal as GHOST's outcome, with what it cost", async () => {
    const refusal = new GhostError("refusal", "the model refused", {
      retryable: false,
      usage: USAGE,
      usd: 0.004,
      model: "claude-sonnet-5-5",
      refusal: { category: "cyber", explanation: null, partialOutput: false },
    });
    const { api } = fakeApi({ runGhost: async () => Promise.reject(refusal) });
    const out = await arm(api).answer({ question: "q", job: "brand_health", model: "claude-sonnet-5-5", metro: null, signal });
    expect(out).toMatchObject({ answer: null, refusal: "cyber", resolved: [], usd: 0.004, lookups: 0 });
  });

  it("books a failed answer at what it spent when a response arrived, and leaves the worst case when none did", async () => {
    const cut = new GhostError("max_tokens", "cut off", { retryable: true, usage: USAGE, usd: 0.08, model: "claude-sonnet-5-5" });
    const spent = arm(fakeApi({ runGhost: async () => Promise.reject(cut) }).api);
    await expect(spent.answer({ question: "q", job: "brand_health", model: "claude-sonnet-5-5", metro: null, signal })).rejects.toMatchObject({ name: "SpentError", usd: 0.08 });
    const lost = new GhostError("api_error", "overloaded", { retryable: true, model: "claude-sonnet-5-5" });
    const unknown = arm(fakeApi({ runGhost: async () => Promise.reject(lost) }).api);
    await expect(unknown.answer({ question: "q", job: "brand_health", model: "claude-sonnet-5-5", metro: null, signal })).rejects.toBe(lost);
    const lookups = arm(fakeApi({ resolveGhostPicks: async () => Promise.reject(new Error("aborted")) }).api);
    const failed = lookups.answer({ question: "q", job: "brand_health", model: "claude-sonnet-5-5", metro: null, signal });
    await expect(failed).rejects.toBeInstanceOf(SpentError);
    await expect(failed).rejects.toMatchObject({ usd: 0.012 });
  });

  it("keeps no answer whose searches a cancel cut short, and books what the answer cost", async () => {
    const controller = new AbortController();
    const api = fakeApi({
      resolveGhostPicks: async () => {
        controller.abort();
        return [pick("Foxglove Cola", { lookup: "failed", exact: false, entityId: null, matchedName: null, popularity: null })];
      },
    }).api;
    const out = arm(api).answer({ question: "q", job: "brand_health", model: "claude-sonnet-5-5", metro: null, signal: controller.signal });
    await expect(out).rejects.toMatchObject({ name: "SpentError", usd: 0.012 });
  });

  it("runs only on the ANALYST's models (D23)", async () => {
    await expect(arm(fakeApi().api).answer({ question: "q", job: "brand_health", model: "claude-unknown-model", metro: null, signal })).rejects.toThrow(/D23/);
  });
});

describe("looking failed picks up again", () => {
  const answer: GhostAnswer = { headline: "Foxglove Cola leads.", picks: { ...NO_PICKS, competitors: ["Foxglove Cola", "Crestline Cola", "Harbor Seltzer"] }, numeric_claims: [] };
  const unmatched = { exact: false, entityId: null, matchedName: null, popularity: null };
  const resolved = [pick("Foxglove Cola"), pick("Crestline Cola", { rank: 2, lookup: "failed", ...unmatched }), pick("Harbor Seltzer", { rank: 3, lookup: "skipped", ...unmatched })];

  function relookupApi() {
    const seen: Parameters<GhostApi["resolveGhostPicks"]>[0][] = [];
    const { api } = fakeApi({
      resolveGhostPicks: async (options) => {
        seen.push(options);
        await options.search({ query: "Crestline Cola" });
        return [pick("Crestline Cola")];
      },
    });
    return { api, seen };
  }

  it("searches only the failed picks, through one counted search, and keeps every other pick and each rank", async () => {
    const { api, seen } = relookupApi();
    const out = await arm(api).lookUpAgain({ answer, resolved, metro: "austin", signal });
    expect(seen[0]).toMatchObject({ answer: { headline: answer.headline, picks: { ...NO_PICKS, competitors: ["Crestline Cola"] } }, max: 1, metro: "austin" });
    expect(out.lookups).toBe(1);
    expect(out.resolved.map((p) => [p.name, p.rank, p.lookup, p.exact])).toEqual([
      ["Foxglove Cola", 1, "search", true],
      ["Crestline Cola", 2, "search", true],
      ["Harbor Seltzer", 3, "skipped", false],
    ]);
  });

  it("searches nothing when no lookup failed, and keeps nothing a cancel cut short", async () => {
    const { api, seen } = relookupApi();
    const done = [pick("Foxglove Cola")];
    expect(await arm(api).lookUpAgain({ answer, resolved: done, metro: null, signal })).toEqual({ resolved: done, lookups: 0 });
    expect(seen).toHaveLength(0);
    const controller = new AbortController();
    controller.abort();
    await expect(arm(api).lookUpAgain({ answer, resolved, metro: null, signal: controller.signal })).rejects.toThrow();
  });
});

describe("the GHOST worst case", () => {
  it("bills the longest request with all of GHOST_MAX_TOKENS as output", () => {
    const sonnet = ghostWorstCaseUsd("claude-sonnet-5-5");
    const outputOnly = (GHOST_MAX_TOKENS * PRICING["claude-sonnet-5-5"].base.output) / 1_000_000;
    expect(sonnet).toBeGreaterThan(outputOnly);
    expect(sonnet).toBeLessThan(outputOnly + 0.05);
    expect(ghostWorstCaseUsd("claude-haiku-5-5")).toBeLessThan(sonnet);
    expect(arm(fakeApi().api).worstCaseUsd).toBe(sonnet);
  });
});

describe("the stored pick", () => {
  it("keeps every field of @ct/agent's ResolvedGhostPick", () => {
    expectTypeOf<ResolvedGhostPick>().toEqualTypeOf<AgentResolvedGhostPick>();
  });
});
