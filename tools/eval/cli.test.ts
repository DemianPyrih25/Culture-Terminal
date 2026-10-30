// The eval CLI in process: its arguments and refusals, a whole session on a scripted agent and a fake
// GHOST API over the mock Qloo transport and a memory store, resume, and the summary files. Every
// question is invented (D29), files go to temporary directories, and nothing reaches the network,
// the database or Anthropic.
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentRunOptions, AgentRunResult, AnthropicLike } from "@ct/agent";
import { DEFAULT_RUN_LIMITS, EMPTY_CANDIDATES, type Intent } from "@ct/contracts";
import { createMemoryQlooStore, qlooEventFrom } from "@ct/qloo";
import { afterEach, describe, expect, it } from "vitest";
import { parseEvalSummary } from "../../apps/web/components/method/eval-summary";
import { syntheticResult } from "../dev/cli/fixtures";
import { memoryIo } from "../dev/cli/io";
import type { QuestionsFile, RealityCasesFile } from "./cases";
import { outDirProblem, parseEvalArgs, runEvalCommand, type EvalCliDeps } from "./cli";
import { stubGeo } from "../dev/cli/geo";
import { adversarialQuestion, coreQuestion, ghostDiff, NO_PICKS, pick, realityCase, realityRecord, reportWith } from "./fixtures";
import type { GhostApi } from "./ghost";
import { ghostQuestion } from "./reality";
import { createRealityArm } from "./reality-arm";
import { REPO_ROOT } from "./records";

const KEY = "test-key-not-real";
const ENV = { QLOO_MOCK: "1", QLOO_RPS: "10", ANTHROPIC_API_KEY: KEY };
const QUESTIONS: QuestionsFile = { registered: "2026-01-15", questions: [coreQuestion("q01"), coreQuestion("q02"), adversarialQuestion("a01", "private_individual")] };
const CASES: RealityCasesFile = { registered: "2026-01-15", caveats: ["An invented caveat."], scoring: ["An invented rule."], cases: [realityCase("rc01")] };
const HASHES = { questionsSha256: "a".repeat(64), realityCasesSha256: "b".repeat(64) };
const USAGE = { input: 900, output: 300, cacheRead: 0, cacheCreation: 0 };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-eval-cli-"));
  dirs.push(dir);
  return dir;
}

const unusedAnthropic = {} as AnthropicLike;

function intentFor(q: string): Intent {
  const refused = q.startsWith("Invented adversarial");
  return {
    pillar: "investment",
    job: "brand_health",
    mentions: [{ text: "Brand Alpha", entity_type: "brand", role: "primary", public_figure: false }],
    geo: { metro: null, area: null, unsupported_place: null, market: null, target_metro: null, cities: [] },
    constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [], concept_description: null },
    safety: refused ? { allowed: false, category: "private_individual", reframe: null } : { allowed: true, category: null, reframe: null },
    read_as: { nearest: false, not_covered: [] },
    candidates: EMPTY_CANDIDATES,
    assumptions: [],
    mnemonic: "BRAND ALPHA <BRAND> HLTH",
  };
}

/** A stand-in for runAgent: CLERK's reading, a plan, one real mock Qloo call, the CHECKER, then a result. */
function scriptedAgent() {
  const seen: AgentRunOptions[] = [];
  const run = async (options: AgentRunOptions): Promise<AgentRunResult> => {
    seen.push(options);
    const read = intentFor(options.question);
    options.emit({ type: "clerk", intent: read, ms: 300 });
    if (!read.safety.allowed) return syntheticResult(options.runId, { status: "refused", report: null, intent: null, validation: null, reason: "declined", qloo: { network: 0, cached: 0, reused: 0 }, usd: 0.001 });
    const scope = options.qloo.forRun({ runId: options.runId, lane: options.lane, pillar: "investment", limits: options.limits ?? DEFAULT_RUN_LIMITS, phase: () => "wave1", onCall: (r) => options.emit(qlooEventFrom(r)) });
    const hypotheses = [1, 2].map((n) => ({ id: `H${n}`, statement: "s", expectation: "e", test_tool: "peer_landscape" as const, metric_hint: "m" }));
    options.emit({ type: "plan", plan: { restated_question: "r", hypotheses, steps: [{ id: "S1", tool: "peer_landscape", purpose: "p" }], assumptions: [] }, estimates: [] });
    await scope.forTool("toolu_1").search({ query: "Brand Alpha", types: "urn:entity:brand", take: 5 });
    options.emit({ type: "validation", ok: true, attempt: 1, issues: [], numbersTraced: { traced: 3, total: 3 }, adviceTerms: 0 });
    return syntheticResult(options.runId, { report: reportWith(options.runId, ["REFUTED", "CONFIRMED"]) });
  };
  return { run, seen };
}

/** A fake GHOST API whose lookups go through the real (mock) Qloo client the CLI opened. */
function fakeGhost(): GhostApi {
  return {
    runGhost: async (o) => ({
      answer: { headline: "Foxglove Cola leads.", picks: { competitors: ["Foxglove Cola"], markets: [], neighbourhoods: [], tenants: [], partners: [], creators: [] }, numeric_claims: ["70%"] },
      usage: { input: 900, output: 300, cacheRead: 0, cacheCreation: 0 },
      usd: 0.01,
      ms: 3_000,
      model: o.model,
    }),
    resolveGhostPicks: async (o) => {
      await o.search({ query: "Foxglove Cola", types: "urn:entity:brand", take: 5 });
      return [pick("Foxglove Cola")];
    },
    buildGhostDiff: () => ghostDiff(),
  };
}

function deps(out: string, overrides: Partial<EvalCliDeps> = {}) {
  const io = memoryIo();
  const agent = scriptedAgent();
  let t = Date.parse("2026-10-23T10:00:00.000Z");
  const files = { json: path.join(out, "site", "eval-summary.json"), md: path.join(out, "site", "SUMMARY.md") };
  const d: EvalCliDeps = {
    env: ENV,
    io,
    now: () => new Date((t += 1000)),
    summaryFiles: files,
    questions: QUESTIONS,
    realityCases: CASES,
    hashes: () => HASHES,
    registration: () => ({ commit: "0123456789abcdef0123456789abcdef01234567", dirty: false }),
    runAgent: agent.run,
    createAnthropic: () => unusedAnthropic,
    store: createMemoryQlooStore(),
    kv: null,
    ghostApi: fakeGhost(),
    ...overrides,
  };
  return { d, io, agent, files };
}

const run = (argv: string[], d: EvalCliDeps) => runEvalCommand(argv, d);

/** Marks an eval directory as recorded on live Qloo data. */
function asLive(dir: string): void {
  const file = path.join(dir, "manifest.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), qloo: "dev" }), "utf8");
}

describe("the command line", () => {
  it("reads each command and its options", () => {
    expect(parseEvalArgs(["both", "--yes", "--only", "q01, rc01,q01", "--usd-cap", "2.5", "--takes", "2", "--stamp", "trial_1", "--resume"])).toMatchObject({
      command: "both",
      yes: true,
      only: ["q01", "rc01"],
      usdCap: 2.5,
      takes: 2,
      stamp: "trial_1",
      resume: true,
    });
    expect(parseEvalArgs(["summary"])).toMatchObject({ command: "summary", usdCap: 5, takes: 1, only: null, writeSummary: false });
    expect(parseEvalArgs(["-h"])).toBeNull();
  });

  it("refuses what it cannot run", () => {
    for (const argv of [[], ["everything"], ["both", "extra"], ["both", "--only", "x9"], ["both", "--takes", "4"], ["both", "--usd-cap", "-1"], ["both", "--stamp", "../up"], ["both", "--tag", " "]]) {
      expect(() => parseEvalArgs(argv), argv.join(" ")).toThrow();
    }
  });

  it("keeps raw outputs out of tracked paths", () => {
    expect(outDirProblem(path.join(REPO_ROOT, ".private", "eval"), REPO_ROOT)).toBeNull();
    expect(outDirProblem(path.join(REPO_ROOT, "eval", "raw", "x"), REPO_ROOT)).toBeNull();
    expect(outDirProblem(path.join(tmpdir(), "anywhere"), REPO_ROOT)).toBeNull();
    expect(outDirProblem(path.join(REPO_ROOT, "eval"), REPO_ROOT)).toMatch(/D29/);
    expect(outDirProblem(path.join(REPO_ROOT, "tools", "eval", "out"), REPO_ROOT)).toMatch(/outside \.private/);
  });
});

describe("before anything is sent", () => {
  it("prints the plan and its worst case, and sends nothing without --yes", async () => {
    const out = temp();
    const { d, io, agent } = deps(out);
    expect(await run(["both", "--out", out, "--mock-qloo", "--memory"], d)).toBe(2);
    expect(io.text()).toMatch(/· grounded \+ ghost · 6 unit\(s\) to run: grounded 3, ghost 3, reality 0 · ANALYST and GHOST claude-sonnet-5-5 · worst case \$\d\.\d\d/);
    expect(io.stderr.join("\n")).toContain("Nothing was sent; add --yes to start.");
    expect(agent.seen).toHaveLength(0);
    expect(readdirSync(out)).toEqual([]);
  });

  it("refuses without ANTHROPIC_API_KEY, and the Reality Check until it is wired", async () => {
    const out = temp();
    const noKey = deps(out, { env: { QLOO_MOCK: "1" } });
    expect(await run(["both", "--yes", "--out", out], noKey.d)).toBe(1);
    expect(noKey.io.stderr.join("\n")).toContain("ANTHROPIC_API_KEY is not set");
    const reality = deps(out);
    expect(await run(["reality", "--yes", "--out", out], reality.d)).toBe(1);
    expect(reality.io.stderr.join("\n")).toContain("The Reality Check arm is not wired");
  });

  it("refuses an --out inside a tracked path and an --only id that is not registered", async () => {
    const out = temp();
    const { d, io } = deps(out);
    expect(await run(["both", "--yes", "--out", "tools/eval/out"], { ...d, root: REPO_ROOT })).toBe(2);
    expect(io.stderr.join("\n")).toMatch(/must stay out of git/);
    expect(await run(["both", "--yes", "--out", out, "--only", "q09"], d)).toBe(2);
    expect(io.stderr.join("\n")).toContain("q09 not registered");
  });
});

describe("a session", () => {
  it("runs both arms and writes the records, and publishes nothing from synthetic Qloo data", async () => {
    const out = temp();
    const { d, io, agent, files } = deps(out);
    const argv = ["both", "--yes", "--out", out, "--stamp", "trial", "--mock-qloo", "--memory", "--write-summary"];
    expect(await run(argv, d)).toBe(1);
    expect(agent.seen.map((o) => o.runId.slice(0, 13))).toEqual(["cli-eval-q01t", "cli-eval-q02t", "cli-eval-a01t"]);
    const dir = path.join(out, "trial");
    expect(readdirSync(path.join(dir, "grounded")).filter((f) => /^[qa]\d\d\.t1\.json$/.test(f))).toHaveLength(3);
    expect(readdirSync(path.join(dir, "ghost"))).toHaveLength(3);
    expect(readdirSync(path.join(dir, "diff"))).toEqual(["q01.t1.json", "q02.t1.json"]);
    const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ stamp: "trial", model: "claude-sonnet-5-5", qloo: "mock", registration: { ...HASHES, commit: "0123456789abcdef0123456789abcdef01234567" } });
    expect(manifest.sessions[0].argv).toEqual(["both", "--usd-cap", "5", "--takes", "1", "--mock-qloo", "--memory"]);
    const text = io.text();
    expect(text).toContain("· Qloo mock · tag eval · cache provided store");
    expect(text).toMatch(/ghost q01 · 1 picks, 1 of 1 looked up resolve exactly/);
    expect(text).toMatch(/Priors refuted or qualified\s+50%/);
    expect(text).toMatch(/Adversarial questions handled\s+100%/);
    expect(io.stderr.join(" ")).toContain("ran on synthetic Qloo data (QLOO_MOCK); only an eval on live data is published");
    expect(existsSync(files.json)).toBe(false);
    expect(existsSync(files.md)).toBe(false);
  });

  it("resumes the directory with nothing left to run, and refuses one whose registered inputs changed", async () => {
    const out = temp();
    const first = deps(out);
    await run(["both", "--yes", "--out", out, "--stamp", "trial", "--mock-qloo", "--memory", "--only", "q01"], first.d);
    const again = deps(out);
    expect(await run(["both", "--yes", "--out", out, "--resume", "--mock-qloo", "--memory", "--only", "q01"], again.d)).toBe(0);
    expect(again.io.text()).toContain("nothing left to run");
    expect(again.agent.seen).toHaveLength(0);
    const more = deps(out);
    expect(await run(["both", "--yes", "--out", out, "--resume", "--mock-qloo", "--memory"], more.d)).toBe(0);
    expect(more.agent.seen.map((o) => o.question)).toEqual([coreQuestion("q02").question, adversarialQuestion("a01", "private_individual").question]);
    expect(JSON.parse(readFileSync(path.join(out, "trial", "manifest.json"), "utf8")).sessions).toHaveLength(2);
    asLive(path.join(out, "trial"));
    const mixed = deps(out);
    expect(await run(["both", "--yes", "--out", out, "--resume", "--mock-qloo", "--memory", "--takes", "2"], mixed.d)).toBe(1);
    expect(mixed.io.stderr.join(" ")).toContain("it ran on Qloo dev, and this session would add mock answers to it");
    expect(mixed.agent.seen).toHaveLength(0);
    const changed = deps(out, { hashes: () => ({ ...HASHES, questionsSha256: "c".repeat(64) }) });
    expect(await run(["both", "--yes", "--out", out, "--resume"], changed.d)).toBe(1);
    expect(changed.io.stderr.join("\n")).toContain("changed since it started");
    const clash = deps(out);
    expect(await run(["both", "--yes", "--out", out, "--stamp", "trial"], clash.d)).toBe(1);
    expect(clash.io.stderr.join("\n")).toContain("already exists");
  });

  it("stops at the cap with exit 1 and leaves the rest for --resume", async () => {
    const out = temp();
    const { d, io } = deps(out);
    expect(await run(["grounded", "--yes", "--out", out, "--mock-qloo", "--memory", "--usd-cap", "1"], d)).toBe(1);
    expect(io.text()).toContain("stopped: --usd-cap");
    expect(io.stderr.join("\n")).toMatch(/skipped 1: grounded a01 t1/);
  });

  it("runs the Reality Check through the arm the reality stream provides", async () => {
    const out = temp();
    const { d } = deps(out, {
      createReality: () => ({ worstCaseUsd: () => 0.1, run: async ({ cases }) => cases.map((c) => ({ ...realityRecord(c.id), caseId: c.id })) }),
    });
    expect(await run(["reality", "--yes", "--out", out, "--stamp", "rc", "--mock-qloo", "--memory"], d)).toBe(0);
    expect(existsSync(path.join(out, "rc", "reality", "rc01.json"))).toBe(true);
  });

  it("runs again on --resume a Reality Check case that met the tag's cap, and says to pass a fresh --tag", async () => {
    const out = temp();
    const capped = deps(out, {
      createReality: () => ({
        worstCaseUsd: () => 0.1,
        run: async ({ cases }) => cases.map((c) => ({ ...realityRecord(c.id, { percentile: null, detail: { reason: "budget", retry: true } }), caseId: c.id })),
      }),
    });
    expect(await run(["reality", "--yes", "--out", out, "--stamp", "rc", "--mock-qloo", "--memory"], capped.d)).toBe(1);
    expect(capped.io.text()).toContain("--resume runs again: reality rc01");
    const plan = deps(out, { createReality: () => ({ worstCaseUsd: () => 0.1, run: async () => [] }) });
    expect(await run(["reality", "--out", out, "--resume", "--mock-qloo", "--memory"], plan.d)).toBe(2);
    expect(plan.io.text()).toMatch(/reality 1 · ANALYST and GHOST/);
    expect(plan.io.text()).toContain("rc01 met the tag's cap last time: QLOO_TAG_CAP counts every earlier call of a tag, so pass a fresh --tag");
  });

  it("runs the wired Reality Check arm over the mock client, with GHOST asked the case's question", async () => {
    const out = temp();
    const questions: string[] = [];
    const { d, io } = deps(out, {
      createReality: (context) =>
        createRealityArm(context, {
          runGhost: async (o) => {
            questions.push(o.question);
            return { answer: { headline: "Brand Beta.", picks: { ...NO_PICKS, partners: ["Brand Beta"] }, numeric_claims: [] }, usage: USAGE, usd: 0.01, ms: 1_000, model: o.model };
          },
          geo: async () => ({ geo: stubGeo(), source: "test" }),
          markets: [],
        }),
    });
    expect(await run(["reality", "--yes", "--out", out, "--stamp", "rc", "--mock-qloo", "--memory"], d)).toBe(0);
    expect(io.text()).toMatch(/reality 1 · ANALYST and GHOST claude-sonnet-5-5 · worst case \$0\.\d\d/);
    expect(io.text()).toContain("Reality Check: 1 case(s), at most 9 Qloo network calls on a cold cache (0 shared)");
    expect(questions).toEqual([ghostQuestion(CASES.cases[0]!, [])]);
    const record = JSON.parse(readFileSync(path.join(out, "rc", "reality", "rc01.json"), "utf8"));
    expect(record).toMatchObject({ caseId: "rc01", kind: "brand_collaboration", resolved: true, ghostHit: true, usd: 0.01 });
    expect(readdirSync(path.join(out, "rc", "reality")).some((f) => f.startsWith("reality-check-"))).toBe(true);
  });
});

describe("the registered inputs (eval/README.md rule 1)", () => {
  it("refuses to start a live eval before they are committed, and says so in the plan", async () => {
    const out = temp();
    const fetched: string[] = [];
    const { d, io, agent } = deps(out, {
      env: { ANTHROPIC_API_KEY: KEY, QLOO_API_KEY: "test-qloo-key-not-real", QLOO_BASE_URL: "https://qloo.invalid", QLOO_RPS: "10" },
      registration: () => ({ commit: null, dirty: false }),
      fetch: async (input) => {
        fetched.push(String(input));
        throw new Error("no network in tests");
      },
    });
    expect(await run(["both", "--yes", "--out", out, "--stamp", "live"], d)).toBe(1);
    expect(io.text()).toContain("eval/questions.json and eval/reality_cases.json were not committed, and eval/README.md rule 1 commits both before the first run");
    expect(io.stderr.join("\n")).toContain("Refusing to start eval live on Qloo dev");
    expect(agent.seen).toHaveLength(0);
    expect(fetched).toEqual([]);
    expect(existsSync(path.join(out, "live", "manifest.json"))).toBe(false);
  });

  it("lets a synthetic-data eval start uncommitted, and never publishes an eval that did", async () => {
    const out = temp();
    const dirty = () => ({ commit: "0123456789abcdef0123456789abcdef01234567", dirty: true });
    const first = deps(out, { registration: dirty });
    expect(await run(["both", "--yes", "--out", out, "--stamp", "trial", "--mock-qloo", "--memory", "--only", "q01"], first.d)).toBe(0);
    expect(first.io.text()).toContain("had uncommitted changes, and eval/README.md rule 1 commits both before the first run");
    // The records stand in for a live eval's: only the registration stops the summary.
    asLive(path.join(out, "trial"));
    const { d, io, files } = deps(out, { env: {} });
    expect(await run(["summary", "--out", out, "--write-summary"], d)).toBe(1);
    expect(io.stderr.join(" ")).toContain("--write-summary: when eval trial started, eval/questions.json and eval/reality_cases.json had uncommitted changes");
    expect(existsSync(files.json)).toBe(false);
    expect(existsSync(files.md)).toBe(false);
  });
});

describe("summary", () => {
  it("prints the latest directory's metrics and writes both summaries of a live eval, spending nothing", async () => {
    const out = temp();
    await run(["both", "--yes", "--out", out, "--stamp", "trial", "--mock-qloo", "--memory"], deps(out).d);
    // The records stand in for a live eval's.
    asLive(path.join(out, "trial"));
    const { d, io, agent, files } = deps(out, { env: {} });
    expect(await run(["summary", "--out", out, "--write-summary"], d)).toBe(0);
    expect(agent.seen).toHaveLength(0);
    expect(io.text()).toMatch(/eval trial · 3 questions answered/);
    expect(parseEvalSummary(readFileSync(files.json, "utf8")).state).toBe("ok");
    const md = readFileSync(files.md, "utf8");
    expect(md).toContain("eval `trial`");
    expect(md).not.toContain("Brand Alpha");
    const none = deps(temp());
    expect(await run(["summary", "--out", temp()], none.d)).toBe(1);
  });
});
