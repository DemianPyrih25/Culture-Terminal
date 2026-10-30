// The showcase tool's pure parts: the command line, the slugs it reads from config/showcases.json, the
// checks before a pin, the web's answer-cache key and the refusals prewarm makes before any run starts, its
// worst case with GHOST included. No database, no network, no Anthropic key. Questions and ids are invented (D29).
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ANALYST_CONFIGS, ghostWorstCaseUsd } from "@ct/agent";
import { DEFAULT_RUN_LIMITS } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { formatUsd } from "./cli/format";
import { memoryIo } from "./cli/io";
import {
  adoptedHash,
  LLM_USD_METRIC,
  loadShowcaseConfig,
  parseShowcaseArgs,
  plannedRuns,
  runProblem,
  runShowcasesCommand,
  sameQuestion,
  showcaseEntries,
  SHOWCASES_USAGE,
  storedPins,
  WEB_ANSWER_VERSION,
  webQuestionHash,
  type ShowcaseConfig,
  type ShowcasesDeps,
} from "./showcases";

// apps/web/server/question-hash.ts is server-only; its marker package is resolved from the web app.
vi.mock("../../apps/web/node_modules/server-only/index.js", () => ({}));

export const TEST_CONFIG: ShowcaseConfig = {
  showcases: [
    { code: "S1", slug: "juniper-moat", desk: "investment", question: "Is the Juniper Cola audience a moat or a niche?" },
    { code: "S2", slug: "alpha-sponsors", desk: "marketing", question: "Which brands should sponsor the Brand Alpha tour?" },
  ],
  chain: {
    slug: "alpha-chain",
    title: "Follow one audience",
    steps: [
      { step: 1, from: "S2", question: "Which brands should sponsor the Brand Alpha tour?" },
      { step: 2, from: null, question: "Which Riverside block fits the after-party?" },
      { step: 3, from: null, question: "Which venues fit the Riverside block?" },
    ],
  },
  trust: { slug: "trust-check", question: "Which residents of Elm Street should I mail, and how do they vote?" },
};

/** Deps whose database must never be reached. */
function offline(env: NodeJS.ProcessEnv = {}): ShowcasesDeps & { io: ReturnType<typeof memoryIo> } {
  return {
    env,
    io: memoryIo(),
    db: () => {
      throw new Error("this command must not touch the database");
    },
    where: "test database",
    config: TEST_CONFIG,
  };
}

describe("the command line", () => {
  it("reads each command and its arguments", () => {
    expect(parseShowcaseArgs(["list"])).toEqual({ kind: "list" });
    expect(parseShowcaseArgs(["pin", "juniper-moat", "run-0000-0001"])).toEqual({ kind: "pin", slug: "juniper-moat", runId: "run-0000-0001" });
    expect(parseShowcaseArgs(["unpin", "juniper-moat"])).toEqual({ kind: "unpin", slug: "juniper-moat" });
    expect(parseShowcaseArgs(["pins", "juniper-moat"])).toEqual({ kind: "pins", slug: "juniper-moat", runId: null });
    expect(parseShowcaseArgs(["pins", "juniper-moat", "run-0000-0001"])).toEqual({ kind: "pins", slug: "juniper-moat", runId: "run-0000-0001" });
    expect(parseShowcaseArgs(["prewarm", "juniper-moat", "--yes"])).toEqual({ kind: "prewarm", slug: "juniper-moat", yes: true, tag: null, ghost: true });
    expect(parseShowcaseArgs(["prewarm", "--all", "-y", "--tag", "showcase"])).toEqual({ kind: "prewarm", slug: null, yes: true, tag: "showcase", ghost: true });
    expect(parseShowcaseArgs(["prewarm", "--all"])).toEqual({ kind: "prewarm", slug: null, yes: false, tag: null, ghost: true });
    expect(parseShowcaseArgs(["prewarm", "--all", "--no-ghost"])).toEqual({ kind: "prewarm", slug: null, yes: false, tag: null, ghost: false });
    expect(parseShowcaseArgs(["list", "-h"])).toEqual({ kind: "help" });
  });

  it.each([
    [[], /name a command/],
    [["launch"], /unknown command "launch"/],
    [["pin", "juniper-moat"], /needs a run id/],
    [["pin", "Juniper Moat", "run-0000-0001"], /not a showcase slug/],
    [["pin", "juniper-moat", "../../etc"], /not a run id/],
    [["unpin"], /needs a slug/],
    [["list", "extra"], /at most 0 argument/],
    [["prewarm"], /one slug or --all/],
    [["prewarm", "juniper-moat", "--all"], /one slug or --all/],
    [["prewarm", "--all", "--tag", " "], /--tag needs a non-empty value/],
    [["pin", "juniper-moat", "run-0000-0001", "--yes"], /belong to prewarm/],
    [["list", "--no-ghost"], /--no-ghost belong to prewarm/],
    [["list", "--frobnicate"], /Unknown option/],
  ])("refuses %j", (argv, message) => {
    expect(() => parseShowcaseArgs(argv)).toThrow(message);
  });

  it("prints the usage for --help, and with exit code 2 for a bad command line", async () => {
    const help = offline();
    expect(await runShowcasesCommand(["--help"], help)).toBe(0);
    expect(help.io.text()).toBe(SHOWCASES_USAGE);
    const bad = offline();
    expect(await runShowcasesCommand(["pin"], bad)).toBe(2);
    expect(bad.io.stderr.join("\n")).toContain("pin needs a slug");
    expect(bad.io.stderr.join("\n")).toContain("usage: pnpm exec tsx");
  });
});

describe("the slugs of config/showcases.json", () => {
  it("lists the showcases, then the chain, then the trust example, ordered from 1", () => {
    const entries = showcaseEntries(TEST_CONFIG);
    expect(entries.map((e) => [e.order, e.code, e.slug, e.kind, e.status])).toEqual([
      [1, "S1", "juniper-moat", "showcase", "completed"],
      [2, "S2", "alpha-sponsors", "showcase", "completed"],
      [3, "CHAIN", "alpha-chain", "chain", "completed"],
      [4, "TRUST", "trust-check", "trust", "refused"],
    ]);
    // The chain's pinned run is its last step.
    expect(entries[2]?.question).toBe("Which venues fit the Riverside block?");
    expect(entries[2]?.steps.map((s) => s.from)).toEqual(["S2", null, null]);
  });

  it("reads the repo's config: thirteen showcases, the chain and the trust example, every slug distinct", () => {
    const entries = showcaseEntries(loadShowcaseConfig());
    const codes = Array.from({ length: 13 }, (_, i) => `S${i + 1}`);
    expect(entries.map((e) => e.code)).toEqual([...codes, "CHAIN", "TRUST"]);
    expect(entries.map((e) => e.order)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(new Set(entries.map((e) => e.slug)).size).toBe(entries.length);
    expect(plannedRuns(entries)).toBe(13 + 3 + 1);
  });
});

describe("the checks before a pin", () => {
  const QUESTION = "Is the Juniper Cola audience a moat or a niche?";
  const run = (over: Partial<{ questionHash: string; status: "completed" | "running" | "failed" | "refused"; question: string }> = {}) => ({
    questionHash: "q1:abc",
    status: "completed" as const,
    question: QUESTION,
    ...over,
  });

  it("accepts a finished web agent run that asks the showcase question, in any case or spacing", () => {
    expect(runProblem(run(), QUESTION, "completed")).toBeNull();
    expect(runProblem(run({ question: "  is the JUNIPER cola audience   a moat or a niche? " }), QUESTION, "completed")).toBeNull();
    expect(runProblem(run({ status: "refused" }), QUESTION, "refused")).toBeNull();
  });

  it.each([
    [run({ questionHash: "fake:1" }), "it is a test run"],
    [run({ questionHash: "cli:cli-20261022T031522123Z" }), "run-agent stored it"],
    [run({ questionHash: "other:1" }), "it is not an agent run"],
    [run({ status: "running" }), "it is still running"],
    [run({ status: "failed" }), "it ended failed"],
    [run({ question: "Is the Juniper Cola audience growing?" }), "its question is not the showcase's"],
  ])("refuses %j", (candidate, why) => {
    expect(runProblem(candidate, QUESTION, "completed")).toContain(why);
  });

  it("accepts run-agent's prefix only for a run prewarm adopts, never a test run", () => {
    expect(runProblem(run({ questionHash: "cli:x" }), QUESTION, "completed", true)).toBeNull();
    expect(runProblem(run({ questionHash: "fake:x" }), QUESTION, "completed", true)).toContain("test run");
  });

  it("compares questions the way the answer cache does", () => {
    expect(sameQuestion("Where in Riverside?", "where in riverside?")).toBe(true);
    expect(sameQuestion("Where in Riverside?", "Where in Riverside")).toBe(false);
  });
});

describe("the web's answer-cache key", () => {
  it("is the web's questionHash, so an adopted run meets the answer cache and the library", async () => {
    const file = path.resolve(import.meta.dirname, "../../apps/web/server/question-hash.ts");
    const web = (await import(pathToFileURL(file).href)) as { questionHash: typeof webQuestionHash; QUESTION_HASH_PREFIX: string; ANSWER_VERSION: number };
    expect(web.QUESTION_HASH_PREFIX).toBe("q1:");
    expect(web.ANSWER_VERSION).toBe(WEB_ANSWER_VERSION);
    const pins = { "juniper cola": "synthetic-juniper-1", "brand alpha": "synthetic-alpha-1" };
    for (const [question, p, mode] of [
      ["Is the Juniper Cola audience a moat or a niche?", undefined, "live"],
      ["  IS the Juniper Cola audience a moat or a niche?\u0007", pins, "live"],
      ["Which brands should sponsor the Brand Alpha tour?", pins, "economy"],
    ] as const) {
      expect(webQuestionHash(question, p, mode)).toBe(web.questionHash(question, p, mode));
    }
  });

  it("orders pins by mention and reads a run's stored pins", () => {
    const a = webQuestionHash("Q?", { b: "2", a: "1" }, "live");
    expect(a).toBe(webQuestionHash("Q?", { a: "1", b: "2" }, "live"));
    expect(a).not.toBe(webQuestionHash("Q?", undefined, "live"));
    expect(storedPins(null)).toBeUndefined();
    expect(storedPins({})).toBeUndefined();
    expect(storedPins({ a: 1 })).toBeUndefined();
    expect(storedPins({ "juniper cola": "synthetic-juniper-1" })).toEqual({ "juniper cola": "synthetic-juniper-1" });
  });

  it("adopts a run under the key a visitor's question gets: the unpinned one the answer cache looks up", () => {
    expect(adoptedHash({ question: "Q?", mode: "live" })).toBe(webQuestionHash("Q?", undefined, "live"));
    expect(adoptedHash({ question: "Q?", mode: "economy" })).toBe(webQuestionHash("Q?", undefined, "economy"));
  });
});

describe("prewarm's spend", () => {
  it("is booked under the web's LLM spend metric, which the daily breaker reads", async () => {
    const file = path.resolve(import.meta.dirname, "../../apps/web/server/llm-spend.ts");
    const web = (await import(pathToFileURL(file).href)) as { LLM_USD_METRIC: string };
    expect(LLM_USD_METRIC).toBe(web.LLM_USD_METRIC);
  });
});

describe("prewarm before any run", () => {
  const LIVE = { QLOO_API_KEY: "test-qloo-key-not-real", ANTHROPIC_API_KEY: "test-anthropic-key-not-real" };

  it("prints the worst case, GHOST included, and sends nothing without --yes", async () => {
    const deps = offline(LIVE);
    expect(await runShowcasesCommand(["prewarm", "--all"], deps)).toBe(2);
    const run = DEFAULT_RUN_LIMITS.usdHard;
    const ghost = ghostWorstCaseUsd(ANALYST_CONFIGS.live.model);
    // GHOST goes on each completed showcase (S1, S2, the chain), never on the trust example's refusal.
    expect(deps.io.text()).toContain(
      `up to 6 live run(s) and 3 GHOST answer(s) · worst case ${formatUsd(6 * run + 3 * ghost)} ` +
        `(6 × ${formatUsd(run)} per-run hard cap, 3 × ${formatUsd(ghost)} per GHOST answer)`,
    );
    expect(deps.io.text()).toContain("Qloo dev · database test database");
    expect(deps.io.stderr.join("\n")).toContain(`may spend up to ${formatUsd(6 * run + 3 * ghost)}. Nothing was sent; add --yes to start.`);
    const bare = offline(LIVE);
    expect(await runShowcasesCommand(["prewarm", "--all", "--no-ghost"], bare)).toBe(2);
    expect(bare.io.text()).toContain(`up to 6 live run(s) · worst case ${formatUsd(6 * run)} (6 × ${formatUsd(run)} per-run hard cap) ·`);
  });

  it("refuses synthetic Qloo data and a missing Anthropic key", async () => {
    const mock = offline({ ...LIVE, QLOO_MOCK: "1" });
    expect(await runShowcasesCommand(["prewarm", "juniper-moat", "--yes"], mock)).toBe(1);
    expect(mock.io.stderr.join("\n")).toContain("Refusing to prewarm on synthetic data");
    const keyless = offline({ QLOO_API_KEY: "test-qloo-key-not-real" });
    expect(await runShowcasesCommand(["prewarm", "juniper-moat", "--yes"], keyless)).toBe(1);
    expect(keyless.io.stderr.join("\n")).toContain("ANTHROPIC_API_KEY is not set");
  });

  it("refuses a slug the config does not list", async () => {
    const deps = offline(LIVE);
    expect(await runShowcasesCommand(["prewarm", "no-such-slug", "--yes"], deps)).toBe(1);
    expect(deps.io.stderr.join("\n")).toContain('"no-such-slug" is not a slug of config/showcases.json');
  });
});
