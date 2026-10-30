// run-agent in process with a scripted agent in place of runAgent: the CLI's guards, its live trace
// and the final note. The scripted agent makes one real call through the Qloo client the CLI built
// (mock transport, memory store). No network, no database, no Anthropic key.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pickerKey, type AgentRunOptions, type AgentRunResult, type AnthropicLike } from "@ct/agent";
import { DEFAULT_RUN_LIMITS } from "@ct/contracts";
import { createMemoryQlooStore, qlooEventFrom } from "@ct/qloo";
import { normaliseName, searchParams } from "@ct/quant";
import { afterEach, describe, expect, it } from "vitest";
import { runAgentCommand, type AgentCliDeps } from "./cli/agent-cli";
import { memoryKv } from "./cli/localities";
import { syntheticResult } from "./cli/fixtures";
import { memoryIo } from "./cli/io";

const KEY = "test-key-not-real";
// Control characters other than the line feeds the CLIs print themselves.
const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
const ENV = { QLOO_MOCK: "1", QLOO_RPS: "10", ANTHROPIC_API_KEY: KEY };
const QUESTION = "How healthy is Brand Alpha's taste signal?";

const unusedAnthropic: AnthropicLike = {
  beta: {
    messages: {
      stream: () => {
        throw new Error("the scripted agent never calls Anthropic");
      },
    },
  },
  messages: {
    create: () => {
      throw new Error("the scripted agent never calls Anthropic");
    },
  },
};

/** A stand-in for runAgent: a short trace with one real mock Qloo call, then the given result. */
function scriptedAgent(result: (options: AgentRunOptions) => AgentRunResult | Promise<AgentRunResult>) {
  const seen: AgentRunOptions[] = [];
  const run = async (options: AgentRunOptions): Promise<AgentRunResult> => {
    seen.push(options);
    const { emit } = options;
    emit({ type: "run.created", question: options.question, mode: options.mode, lane: options.lane, limits: options.limits ?? DEFAULT_RUN_LIMITS, parentRunId: null, model: "claude-sonnet-5-5" });
    emit({ type: "tool.start", toolCallId: "toolu_1", tool: "resolve_entities", phase: "wave1", args: {}, stepId: "S1", triggerFindingId: null, estimatedCalls: 1 });
    const scope = options.qloo.forRun({
      runId: options.runId,
      lane: options.lane,
      pillar: "investment",
      limits: options.limits ?? DEFAULT_RUN_LIMITS,
      phase: () => "wave1",
      onCall: (record) => emit(qlooEventFrom(record)),
    });
    await scope.forTool("toolu_1").search({ query: "Brand Alpha", types: "urn:entity:brand", take: 5 });
    emit({ type: "validation", ok: true, attempt: 1, issues: [], numbersTraced: { traced: 3, total: 3 }, adviceTerms: 0 });
    return result(options);
  };
  return { run, seen };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function spendFile(usd?: number): string {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-run-agent-"));
  dirs.push(dir);
  const file = path.join(dir, "spend.json");
  if (usd !== undefined) writeFileSync(file, JSON.stringify({ usd, runs: 3, updatedAt: null }), "utf8");
  return file;
}

async function cli(argv: string[], overrides: Partial<AgentCliDeps> = {}) {
  const io = memoryIo();
  const keys: string[] = [];
  const deps: AgentCliDeps = {
    env: ENV,
    io,
    store: createMemoryQlooStore(),
    spendFile: null,
    createAnthropic: (key) => {
      keys.push(key);
      return unusedAnthropic;
    },
    now: () => new Date("2026-10-22T03:15:22.123Z"),
    ...overrides,
  };
  const code = await runAgentCommand(argv, deps);
  return { code, io, out: io.stdout.join("\n"), err: io.stderr.join("\n"), keys };
}

describe("run-agent", () => {
  it("prints the live trace and the finished note", async () => {
    const agent = scriptedAgent((o) => syntheticResult(o.runId));
    const { code, out, keys } = await cli([QUESTION, "--yes"], { runAgent: agent.run });
    expect(code).toBe(0);
    // The ANALYST's hard stop ($0.60) plus both side calls at their caps ($0.02 + $0.08).
    expect(out).toContain("side calls: AI context on, web on");
    expect(out).toContain("worst case $0.70 (per-run hard cap)");
    expect(out).toContain("run cli-20261022T031522123Z · Qloo mock");
    expect(out).toMatch(/RUN {6}claude-sonnet-5-5 · live · lane public/);
    expect(out).toMatch(/▶ resolve_entities S1 \[wave1\] · est 1 calls/);
    expect(out).toMatch(/qloo \[resolve_entities\] \/search MISS \d+ ms req mock-[0-9a-f]{16} · \d+ rows/);
    expect(out).toContain("CHECKER  ✓ 3/3 numbers traced");
    expect(out).toContain("headline   Brand Alpha stands apart at 1 of 5 (DERIVED)");
    expect(out).toContain("RUN completed");
    // The key reaches the SDK factory and is never printed.
    expect(keys).toEqual([KEY]);
    expect(out).not.toContain(KEY);
  });

  it("passes the question, mode, lane, normalised pins and limits to runAgent", async () => {
    const agent = scriptedAgent((o) => syntheticResult(o.runId));
    await cli(["How", "healthy", "is", "Brand Alpha?", "-y", "--economy", "--lane", "judge", "--pins", "The Brand Alpha=ent-alpha-1"], { runAgent: agent.run });
    const options = agent.seen[0];
    expect(options?.question).toBe("How healthy is Brand Alpha?");
    expect(options?.mode).toBe("economy");
    expect(options?.lane).toBe("judge");
    expect(options?.pins).toEqual({ "brand alpha": "ent-alpha-1" });
    expect(options?.limits).toEqual(DEFAULT_RUN_LIMITS);
    expect(options?.runId).toBe("cli-20261022T031522123Z");
  });

  it("hands runAgent the pinned market localities from kv, and none without kv", async () => {
    const agent = scriptedAgent((o) => syntheticResult(o.runId));
    const kv = memoryKv({ "metro_localities.mock": { nashville: { entityId: "loc-nashville-mock", label: "Nashville" } } });
    await cli([QUESTION, "--yes"], { runAgent: agent.run, kv });
    expect(await agent.seen[0]?.localities?.market("nashville")).toEqual({ entityId: "loc-nashville-mock", label: "Nashville" });
    expect(await agent.seen[0]?.localities?.market("austin")).toBeNull();
    await cli([QUESTION, "--yes"], { runAgent: agent.run, kv: null });
    expect(agent.seen[1]?.localities).toBeNull();
  });

  it("refuses to start without ANTHROPIC_API_KEY", async () => {
    const agent = scriptedAgent((o) => syntheticResult(o.runId));
    const { code, err } = await cli([QUESTION, "--yes"], { runAgent: agent.run, env: { QLOO_MOCK: "1" } });
    expect(code).toBe(1);
    expect(err).toContain("ANTHROPIC_API_KEY is not set");
    expect(agent.seen).toHaveLength(0);
  });

  it("sends nothing without --yes", async () => {
    const agent = scriptedAgent((o) => syntheticResult(o.runId));
    const { code, err } = await cli([QUESTION], { runAgent: agent.run });
    expect(code).toBe(2);
    expect(err).toContain("Nothing was sent; add --yes to start.");
    expect(agent.seen).toHaveLength(0);
  });

  it("refuses a run whose worst case would pass LLM_DEV_USD_CAP", async () => {
    const agent = scriptedAgent((o) => syntheticResult(o.runId));
    const { code, err } = await cli([QUESTION, "--yes"], { runAgent: agent.run, spendFile: spendFile(44.9) });
    expect(code).toBe(1);
    expect(err).toContain("Refusing to start: $44.90 spent plus up to $0.70 for this run would pass LLM_DEV_USD_CAP ($45.00).");
    expect(agent.seen).toHaveLength(0);
  });

  it("turns the side context calls off with --no-ai-context and --no-web, and books only what may run", async () => {
    const agent = scriptedAgent((o) => syntheticResult(o.runId));
    const { out } = await cli([QUESTION, "--yes", "--no-ai-context", "--no-web"], { runAgent: agent.run });
    expect(out).toContain("side calls: AI context off, web off");
    expect(out).toContain("worst case $0.60 (per-run hard cap)");
    const seen = agent.seen[0] as unknown as { sideConfig?: { aiEnabled: boolean; webEnabled: boolean; webMaxUses: number } };
    expect(seen.sideConfig).toMatchObject({ aiEnabled: false, webEnabled: false, webMaxUses: 3 });
    // The environment can turn one off too, and economy runs no web search.
    const env = await cli([QUESTION, "--yes", "--economy"], { runAgent: agent.run, env: { ...ENV, AI_CONTEXT_ENABLED: "0", WEB_SEARCH_MAX_USES: "9" } });
    expect(env.out).toContain("side calls: AI context off, web off");
    expect((agent.seen[1] as unknown as { sideConfig?: { webMaxUses: number } }).sideConfig?.webMaxUses).toBe(5);
  });

  it("adds the run's spend to the local tally", async () => {
    const file = spendFile(1);
    const agent = scriptedAgent((o) => syntheticResult(o.runId, { usd: 0.25 }));
    const { code, out } = await cli([QUESTION, "--yes"], { runAgent: agent.run, spendFile: file, env: { ...ENV, LLM_DEV_USD_CAP: "5" } });
    expect(code).toBe(0);
    expect(out).toContain("run-agent spend so far $1.00 of LLM_DEV_USD_CAP $5.00");
    expect(out).toContain("run-agent spend now $1.25 over 4 run(s)");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ usd: 1.25, runs: 4 });
  });

  it("shows the picker and exits 3 for needs_input", async () => {
    const agent = scriptedAgent((o) => {
      o.emit({ type: "needs_input", mention: "Brand Twin", entityType: "brand", reason: "ambiguous", candidates: [{ key: "c1", name: "Brand Twin", disambiguation: "2004", popularity: null }] });
      return syntheticResult(o.runId, { status: "needs_input", report: null, reason: "'Brand Twin' needs a choice" });
    });
    const { code, out } = await cli([QUESTION, "--yes"], { runAgent: agent.run });
    expect(code).toBe(3);
    expect(out).toContain("NEEDS A CHOICE: 'Brand Twin' (brand) is ambiguous");
    // The gate's /search was never cached here, so no id is known: the hint points at run-skill.
    expect(out).toContain('pnpm run-skill resolve_entities "brand twin" --type brand and pass one as --pins');
  });

  it("answers the picker with a --pins flag per candidate, read back from the cached /search", async () => {
    const ids: string[] = [];
    const agent = scriptedAgent(async (o) => {
      // The resolution gate's search, then its picker with opaque keys (D20).
      const params = searchParams({ text: "Brand Twin", type: "brand", metro: null });
      if (params === null) throw new Error("no params");
      const search = await o.qloo.standalone().forTool(null).search(params);
      const twins = search.data.results.filter((r) => normaliseName(r.name) === "brand twin");
      ids.push(...twins.map((r) => r.entity_id));
      o.emit({
        type: "needs_input",
        mention: "Brand Twin",
        entityType: "brand",
        reason: "ambiguous",
        candidates: twins.map((r) => ({ key: pickerKey(r.entity_id), name: r.name, disambiguation: r.disambiguation ?? null, popularity: r.popularity ?? null })),
      });
      return syntheticResult(o.runId, { status: "needs_input", report: null, reason: "'Brand Twin' needs a choice" });
    });
    const { code, out } = await cli([QUESTION, "--yes"], { runAgent: agent.run });
    expect(code).toBe(3);
    expect(ids).toHaveLength(2);
    for (const id of ids) expect(out).toContain(`     --pins "brand twin=${id}"`);
    expect(out).toContain("Run the same question again with one of the --pins above");
  });

  it("exits 1 for a run that did not complete or that threw", async () => {
    const incomplete = scriptedAgent((o) => syntheticResult(o.runId, { status: "incomplete", reason: "hard time limit" }));
    expect((await cli([QUESTION, "--yes"], { runAgent: incomplete.run })).code).toBe(1);
    const failing = async (): Promise<AgentRunResult> => {
      throw new Error("boom");
    };
    const file = spendFile(1);
    const { code, err } = await cli([QUESTION, "--yes"], { runAgent: failing, spendFile: file });
    expect(code).toBe(1);
    expect(err).toContain("run-agent failed: boom");
    // Its spend is unknown, so the tally takes the run's worst case.
    expect(err).toContain("counted at its worst case $0.70; run-agent spend now $1.70 over 4 run(s)");
  });

  it("books the run's worst case before it starts and settles a cancelled run to its measured spend", async () => {
    const file = spendFile(1);
    const controller = new AbortController();
    let duringRun: unknown = null;
    const agent = scriptedAgent((o) => {
      duringRun = JSON.parse(readFileSync(file, "utf8"));
      // Ctrl+C in the entry script aborts this signal; runAgent stops and reports a cancelled run.
      controller.abort();
      expect(o.signal.aborted).toBe(true);
      return syntheticResult(o.runId, { status: "cancelled", report: null, reason: "Cancelled from the terminal.", usd: 0.12 });
    });
    const { code, out } = await cli([QUESTION, "--yes"], { runAgent: agent.run, spendFile: file, signal: controller.signal });
    expect(agent.seen[0]?.signal).toBe(controller.signal);
    expect(duringRun).toMatchObject({ usd: 1.7, runs: 4 });
    expect(code).toBe(1);
    expect(out).toContain("RUN cancelled: Cancelled from the terminal.");
    expect(out).toContain("run-agent spend now $1.12 over 4 run(s)");
    expect(JSON.parse(readFileSync(file, "utf8")).usd).toBeCloseTo(1.12);
  });

  it("starts nothing when cancelled before the run", async () => {
    const file = spendFile(1);
    const controller = new AbortController();
    controller.abort();
    const agent = scriptedAgent((o) => syntheticResult(o.runId));
    const { code, err } = await cli([QUESTION, "--yes"], { runAgent: agent.run, spendFile: file, signal: controller.signal });
    expect(code).toBe(1);
    expect(err).toContain("cancelled before the run started; nothing was sent");
    expect(agent.seen).toHaveLength(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ usd: 1, runs: 3 });
  });

  it("refuses to start when the spend tally cannot be read, rather than count from $0", async () => {
    const file = spendFile();
    writeFileSync(file, "{torn", "utf8");
    const agent = scriptedAgent((o) => syntheticResult(o.runId));
    const { code, err } = await cli([QUESTION, "--yes"], { runAgent: agent.run, spendFile: file });
    expect(code).toBe(1);
    expect(err).toContain("Refusing to start: the spend tally");
    expect(err).toContain("is not a valid tally");
    expect(agent.seen).toHaveLength(0);
  });

  it("keeps escape sequences in LLM and Qloo text away from the terminal", async () => {
    const agent = scriptedAgent((o) => {
      o.emit({ type: "note", text: "thinking \u001b]52;c;ZXZpbA==\u0007 about \u001b[2Jpeers" });
      const result = syntheticResult(o.runId);
      const report = result.report!;
      return { ...result, report: { ...report, verdict: { ...report.verdict, headline: "Brand \u001b[31mAlpha\u001b[0m stands apart at {{M1}}" } } };
    });
    const { code, io } = await cli([QUESTION, "--yes"], { runAgent: agent.run });
    expect(code).toBe(0);
    const all = [...io.stdout, ...io.stderr].join("\n");
    expect(all).not.toMatch(CONTROL);
    expect(all).toContain("note     thinking ]52;c;ZXZpbA== about [2Jpeers");
    expect(all).toContain("headline   Brand [31mAlpha[0m stands apart at 1 of 5 (DERIVED)");
  });

  it("refuses --memory on live Qloo before the run, and books no spend", async () => {
    const file = spendFile(1);
    const agent = scriptedAgent((o) => syntheticResult(o.runId));
    const live = { ANTHROPIC_API_KEY: KEY, QLOO_API_KEY: "test-key-not-real", QLOO_TAG_CAP: "200" };
    const { code, err } = await cli([QUESTION, "--yes", "--memory"], { runAgent: agent.run, env: live, store: undefined, spendFile: file });
    expect(code).toBe(1);
    expect(err).toContain("--memory works only on synthetic Qloo data");
    expect(agent.seen).toHaveLength(0);
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ usd: 1, runs: 3 });
  });

  it("caches in memory with --mock-qloo", async () => {
    const agent = scriptedAgent((o) => syntheticResult(o.runId));
    const { code, out } = await cli([QUESTION, "--yes", "--memory", "--mock-qloo"], { runAgent: agent.run, env: { ANTHROPIC_API_KEY: KEY, QLOO_RPS: "10" }, store: undefined });
    expect(code).toBe(0);
    expect(out).toContain("Qloo mock · tag dev · cache memory (nothing persists)");
  });

  it("answers bad arguments with exit code 2", async () => {
    expect((await cli(["--yes"])).code).toBe(2);
    expect((await cli([QUESTION, "--pins", "nope"])).code).toBe(2);
    expect((await cli([QUESTION, "--lane", "vip"])).code).toBe(2);
    expect((await cli(["--help"])).out).toContain("usage: pnpm run-agent");
  });
});
