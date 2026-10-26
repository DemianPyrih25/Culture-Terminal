// The showcase tool's commands against a real Postgres in a throwaway database: list, pin, unpin, pins
// and prewarm. prewarm runs through run-agent with a scripted agent in place of runAgent (no Anthropic
// call) and GHOST through a scripted fake Anthropic, and `pins` and GHOST's lookups read a
// mock-transport Qloo client over a memory store, so nothing leaves the process. Skips when no database is reachable. Questions, runs and entity ids are invented (D29).
import { usdFor, type AgentRunOptions, type AgentRunResult, type AnthropicLike } from "@ct/agent";
import { DEFAULT_RUN_LIMITS, Report, type EventInput, type GhostAnswer, type ResolvedMention } from "@ct/contracts";
import { appendEvents, createRun, getQlooUsage, getRun, listShowcasePins, pinShowcaseRun, replaceShowcasePins, type NewRun, type RunStatus } from "@ct/db";
import { createMemoryQlooStore, createQlooClient, qlooClientOptionsFromEnv, type QlooClient } from "@ct/qloo";
import { classifyMatches, searchParams } from "@ct/quant";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FakeAnthropic, fakeGaMessage } from "../../packages/agent/test/support/fake-anthropic";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "../../packages/db/test/support/testDb";
import { syntheticResult } from "./cli/fixtures";
import { memoryIo } from "./cli/io";
import { readRunEvents } from "./ghost";
import { LLM_USD_METRIC, runShowcasesCommand, webQuestionHash, type ShowcaseConfig, type ShowcasesDeps } from "./showcases";

const probe = await probeTestDatabase();

const CONFIG: ShowcaseConfig = {
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
const [S1, S2, STEP2, STEP3, TRUST] = [
  CONFIG.showcases[0]!.question,
  CONFIG.showcases[1]!.question,
  CONFIG.chain.steps[1]!.question,
  CONFIG.chain.steps[2]!.question,
  CONFIG.trust.question,
];
const LIVE = { QLOO_API_KEY: "test-qloo-key-not-real", ANTHROPIC_API_KEY: "test-anthropic-key-not-real", QLOO_RPS: "10" };

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

function resolved(mention: string, name: string, ref: `R${number}`, over: Partial<ResolvedMention> = {}): ResolvedMention {
  return { mention, role: "primary", entityType: "brand", match: "exact", ref, name, popularity: 0.5, disambiguation: null, alternatives: [], source: "gate", ...over };
}

/** A mock-transport Qloo client over a memory store: what `pins` reads the /search cache through. */
function mockQloo(): QlooClient {
  return createQlooClient(qlooClientOptionsFromEnv({ QLOO_MOCK: "1", QLOO_RPS: "10" }, { store: createMemoryQlooStore() }));
}

/** Searches the mention once, so its answer is cached, and returns the exact match's name and id. */
async function warm(client: QlooClient, mention: string): Promise<{ name: string; entityId: string }> {
  const params = searchParams({ text: mention, type: "brand", metro: null });
  if (params === null) throw new Error("no search params");
  const reply = await client.standalone().forTool(null).search(params);
  const exact = classifyMatches({ text: mention, type: "brand" }, reply.data.results).exact[0];
  if (!exact) throw new Error(`the mock has no exact match for ${mention}`);
  return { name: exact.name, entityId: exact.entity_id };
}

/** A stand-in for runAgent: run.created, one resolution, then the result the test asks for. */
function scriptedAgent(result: (options: AgentRunOptions) => Partial<AgentRunResult> = () => ({}), entities: ResolvedMention[] = []) {
  const seen: AgentRunOptions[] = [];
  const run = async (options: AgentRunOptions): Promise<AgentRunResult> => {
    seen.push(options);
    options.emit({
      type: "run.created",
      question: options.question,
      mode: options.mode,
      lane: options.lane,
      limits: options.limits ?? DEFAULT_RUN_LIMITS,
      parentRunId: options.parent?.runId ?? null,
      model: "claude-sonnet-5-5",
    });
    if (entities.length > 0) options.emit({ type: "resolve", entities });
    return syntheticResult(options.runId, result(options));
  };
  return { run, seen };
}

describe.skipIf(!probe.ok)("the showcase tool against Postgres", () => {
  let t: TestDatabase | undefined;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  // Every run-agent run reads the clock several times; a second per read keeps the CLI run ids distinct.
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 9, 22, 3, 0, 0) + ++tick * 1000);

  function deps(over: Partial<Omit<ShowcasesDeps, "io">> = {}): ShowcasesDeps & { io: ReturnType<typeof memoryIo> } {
    return { env: LIVE, io: memoryIo(), db: () => t!.db, where: "test database", config: CONFIG, ...over };
  }

  async function cli(argv: string[], over: Partial<Omit<ShowcasesDeps, "io">> = {}) {
    const d = deps(over);
    const code = await runShowcasesCommand(argv, d);
    return { code, out: d.io.stdout.join("\n"), err: d.io.stderr.join("\n") };
  }

  let n = 0;
  async function seed(question: string, over: Partial<NewRun> = {}): Promise<string> {
    const run = await createRun(t!.db, { question, questionHash: `q1:seed-${++n}`, status: "completed", ...over });
    return run.id;
  }

  /** Stores events for a seeded run, numbered from 1. */
  async function events(runId: string, list: EventInput[]): Promise<void> {
    await appendEvents(
      t!.db,
      runId,
      list.map((e, i) => {
        const { type, ...payload } = e;
        return { seq: i + 1, type, payload };
      }),
    );
  }

  const agentDeps = (agent: ReturnType<typeof scriptedAgent>, anthropic: AnthropicLike = unusedAnthropic): ShowcasesDeps["agent"] => ({
    runAgent: agent.run,
    createAnthropic: () => anthropic,
    store: createMemoryQlooStore(),
    spendFile: null,
    now,
  });

  describe("pin", () => {
    it("pins a finished agent run that asks the showcase question, and lists it", async () => {
      const before = await cli(["list"]);
      expect(before.code).toBe(0);
      expect(before.out).toMatch(/1\s+S1\s+juniper-moat\s+investment\s+—\s+—/);

      const runId = await seed(S1);
      const pinned = await cli(["pin", "juniper-moat", runId]);
      expect(pinned.code).toBe(0);
      expect(pinned.out).toContain(`pinned run ${runId} as S1 juniper-moat (order 1)`);
      expect(pinned.out).toContain("pinned 0 of the 0 cached Qloo answers it used");
      expect(pinned.out).toContain("next: `pins juniper-moat`");
      expect(await getRun(t!.db, runId)).toMatchObject({ isShowcase: true, showcaseSlug: "juniper-moat", showcaseOrder: 1, questionHash: expect.stringMatching(/^q1:seed-/) });

      const after = await cli(["list"]);
      expect(after.out).toMatch(new RegExp(`S1\\s+juniper-moat\\s+investment\\s+${runId}\\s+completed\\s+\\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\s+0`));
      expect(after.out).toContain("of 4 pinned");
    });

    it.each([
      ["a test run", { questionHash: "fake:1" }, S1, "it is a test run"],
      ["a run-agent run", { questionHash: "cli:cli-20261022T000000000Z" }, S1, "run-agent stored it"],
      ["a failed run", { status: "failed" as RunStatus }, S1, "it ended failed"],
      ["another question", {}, "Is the Juniper Cola audience growing?", "its question is not the showcase's"],
    ])("refuses %s and leaves the slug as it was", async (_name, over, question, why) => {
      const runId = await seed(question, over);
      const { code, err } = await cli(["pin", "juniper-moat", runId]);
      expect(code).toBe(1);
      expect(err).toContain(`Refusing to pin run ${runId} as juniper-moat: ${why}`);
      expect(await getRun(t!.db, runId)).toMatchObject({ isShowcase: false, showcaseSlug: null });
    });

    it("refuses a missing run and a slug the config does not list", async () => {
      expect((await cli(["pin", "juniper-moat", "no-such-run-0001"])).err).toContain("There is no run no-such-run-0001 in test database.");
      const runId = await seed(S1);
      const unknown = await cli(["pin", "other-slug", runId]);
      expect(unknown.code).toBe(1);
      expect(unknown.err).toContain('"other-slug" is not a slug of config/showcases.json');
    });

    it("pins the trust example only as a refusal", async () => {
      const done = await seed(TRUST);
      expect((await cli(["pin", "trust-check", done])).err).toContain("it ended completed, and this showcase needs a refused run");
      const refused = await seed(TRUST, { status: "refused" });
      expect((await cli(["pin", "trust-check", refused])).code).toBe(0);
    });

    it("pins the chain on its last step, once every step before it is its ancestor", async () => {
      const first = await seed(S2);
      const second = await seed(STEP2, { parentRunId: first });
      const third = await seed(STEP3, { parentRunId: second });
      const orphan = await seed(STEP3);
      expect((await cli(["pin", "alpha-chain", orphan])).err).toContain("step 3 has no parent run");
      const skipped = await seed(STEP3, { parentRunId: first });
      expect((await cli(["pin", "alpha-chain", skipped])).err).toContain(`step 2 (run ${first}): its question is not the showcase's`);
      const ok = await cli(["pin", "alpha-chain", third]);
      expect(ok.code).toBe(0);
      expect(ok.out).toContain(`pinned run ${third} as CHAIN alpha-chain (order 3)`);
    });

    it("unpins a slug, and notes a pinned slug the config no longer lists", async () => {
      const runId = await seed(S2);
      await pinShowcaseRun(t!.db, { slug: "retired-slug", runId, order: null });
      expect((await cli(["list"])).out).toContain(`note: run ${runId} is pinned as "retired-slug", which config/showcases.json no longer lists`);
      const unpinned = await cli(["unpin", "retired-slug"]);
      expect(unpinned.out).toBe(`unpinned retired-slug: run ${runId}`);
      expect((await cli(["unpin", "retired-slug"])).out).toBe("nothing was pinned as retired-slug");
    });
  });

  describe("pins", () => {
    it("stores the run's exact resolutions: its own pins as given, the rest from the cached /search answer", async () => {
      const client = mockQloo();
      const juniper = await warm(client, "Juniper Cola");
      const runId = await seed(S1, { pins: { "brand alpha": "synthetic-alpha-pinned" } });
      await events(runId, [
        { type: "run.created", question: S1, mode: "live", lane: "public", limits: DEFAULT_RUN_LIMITS, parentRunId: null, model: "claude-sonnet-5-5" },
        {
          type: "resolve",
          entities: [
            resolved("Juniper Cola", juniper.name, "R1"),
            resolved("Brand Alpha", "Brand Alpha", "R2", { role: "peer" }),
            resolved("Brand Omega", "Brand Omega", "R3", { role: "peer", match: "ambiguous", ref: null }),
          ],
        },
        // resolve_entities' own resolutions are no pins: only the gate reads them.
        { type: "resolve", entities: [resolved("juniper cola", juniper.name, "R4", { source: "tool" })] },
      ]);
      await pinShowcaseRun(t!.db, { slug: "juniper-moat", runId, order: 1 });
      const { code, out } = await cli(["pins", "juniper-moat"], { openQloo: async () => ({ client, close: () => client.flush() }) });

      expect(code).toBe(0);
      expect(out).toContain(`stored 2 pin(s) for juniper-moat from run ${runId}`);
      expect((await listShowcasePins(t!.db, "juniper-moat")).map((p) => [p.mention, p.entityId, p.name, p.type])).toEqual([
        ["Brand Alpha", "synthetic-alpha-pinned", "Brand Alpha", "brand"],
        ["Juniper Cola", juniper.entityId, juniper.name, "brand"],
      ]);
      expect(out).toMatch(/Brand Alpha\s+Brand Alpha\s+brand\s+synthetic-alpha-pinned\s+run pin/);
      expect(out).toMatch(/Juniper Cola\s+.+\s+brand\s+\S+\s+cache/);
    });

    it("stores nothing when an entity's /search answer is not cached, and keeps the pins it had", async () => {
      await replaceShowcasePins(t!.db, "alpha-sponsors", [{ mention: "Brand Alpha", entityId: "synthetic-alpha-old", name: "Brand Alpha", type: "brand" }]);
      const runId = await seed(S2);
      await events(runId, [{ type: "resolve", entities: [resolved("Brand Delta", "Brand Delta", "R1")] }]);
      const client = mockQloo();
      const { code, err } = await cli(["pins", "alpha-sponsors", runId], { openQloo: async () => ({ client, close: () => client.flush() }) });
      expect(code).toBe(1);
      expect(err).toContain(`Nothing stored for alpha-sponsors: 1 of the 1 entities run ${runId} resolved could not be read.`);
      expect(err).toMatch(/Brand Delta\s+brand\s+its \/search answer is not in the Qloo cache/);
      expect((await listShowcasePins(t!.db, "alpha-sponsors")).map((p) => p.entityId)).toEqual(["synthetic-alpha-old"]);
    });

    it("leaves out what resolve_entities resolved, such as a place in a metro the question never named", async () => {
      const client = mockQloo();
      const juniper = await warm(client, "Juniper Cola");
      const runId = await seed(S1);
      // No CLERK intent, so no metro: the gate could not have searched a place, and the tool's metro is not recorded.
      await events(runId, [
        { type: "resolve", entities: [resolved("Juniper Cola", juniper.name, "R1")] },
        { type: "resolve", entities: [resolved("Riverside Hall", "Riverside Hall", "R2", { role: "peer", entityType: "place", source: "tool" })] },
      ]);
      const { code, out, err } = await cli(["pins", "juniper-moat", runId], { openQloo: async () => ({ client, close: () => client.flush() }) });
      expect(err).toBe("");
      expect(code).toBe(0);
      expect(out).toContain(`stored 1 pin(s) for juniper-moat from run ${runId}`);
      expect((await listShowcasePins(t!.db, "juniper-moat")).map((p) => [p.mention, p.entityId, p.type])).toEqual([["Juniper Cola", juniper.entityId, "brand"]]);
    });

    it("stores one pin for a name the gate resolved under two types: run-agent keys pins by the mention alone", async () => {
      const runId = await seed(S2, { pins: { "brand alpha": "synthetic-alpha-3" } });
      await events(runId, [
        {
          type: "resolve",
          entities: [resolved("Brand Alpha", "Brand Alpha", "R1"), resolved("brand alpha", "Brand Alpha", "R2", { role: "peer", entityType: "artist" })],
        },
      ]);
      const { code, out } = await cli(["pins", "alpha-sponsors", runId], { openQloo: async () => Promise.reject(new Error("not needed")) });
      expect(code).toBe(0);
      expect(out).toContain(`stored 1 pin(s) for alpha-sponsors from run ${runId}`);
      expect((await listShowcasePins(t!.db, "alpha-sponsors")).map((p) => [p.mention, p.entityId, p.type])).toEqual([["Brand Alpha", "synthetic-alpha-3", "brand"]]);
    });

    it("needs a pinned run or a run id, and never opens Qloo for a run whose entities it pinned itself", async () => {
      await cli(["unpin", "trust-check"]);
      expect((await cli(["pins", "trust-check"])).err).toContain("No run is pinned as trust-check");
      const runId = await seed(S2, { pins: { "brand alpha": "synthetic-alpha-2" } });
      await events(runId, [{ type: "resolve", entities: [resolved("Brand Alpha", "Brand Alpha", "R1")] }]);
      const opened: string[] = [];
      const { code } = await cli(["pins", "alpha-sponsors", runId], {
        openQloo: async () => {
          opened.push("qloo");
          throw new Error("not needed");
        },
      });
      expect(code).toBe(0);
      expect(opened).toEqual([]);
      expect((await listShowcasePins(t!.db, "alpha-sponsors")).map((p) => p.entityId)).toEqual(["synthetic-alpha-2"]);
    });
  });

  describe("prewarm", () => {
    it("records the showcase through run-agent with its pins, gives it the web's key, and pins it", async () => {
      const spent = () => getQlooUsage(t!.db, { day: "2026-10-22", lane: "all", metric: LLM_USD_METRIC });
      const before = { all: await spent(), public: await getQlooUsage(t!.db, { day: "2026-10-22", lane: "public", metric: LLM_USD_METRIC }) };
      await replaceShowcasePins(t!.db, "juniper-moat", [{ mention: "Juniper Cola", entityId: "synthetic-juniper-9", name: "Juniper Cola", type: "brand" }]);
      const agent = scriptedAgent(() => ({}), [resolved("Juniper Cola", "Juniper Cola", "R1")]);
      const { code, out } = await cli(["prewarm", "juniper-moat", "--yes", "--no-ghost"], { agent: agentDeps(agent) });

      expect(code).toBe(0);
      expect(out).toContain("prewarm · juniper-moat · up to 1 live run(s) · worst case $0.60");
      expect(agent.seen).toHaveLength(1);
      const options = agent.seen[0]!;
      expect(options.question).toBe(S1);
      expect(options.pins).toEqual({ "juniper cola": "synthetic-juniper-9" });
      expect(options.parent ?? null).toBeNull();
      const run = await getRun(t!.db, options.runId);
      expect(run).toMatchObject({
        status: "completed",
        isShowcase: true,
        showcaseSlug: "juniper-moat",
        showcaseOrder: 1,
        // The key a visitor typing the question gets, so the answer cache serves this run; its pins stay on the row.
        questionHash: webQuestionHash(S1, undefined, "live"),
        pins: { "juniper cola": "synthetic-juniper-9" },
      });
      // The run used its pin, so the entities are stored again from it, with no Qloo client.
      expect(out).toContain(`stored 1 pin(s) for juniper-moat from run ${options.runId}`);
      expect(out).toMatch(/✓\s+juniper-moat\s+cli-\S+\s+pinned, entities stored/);
      // Its spend counts toward the web's daily LLM budget, in its lane and overall.
      expect(run?.llmUsd).toBeGreaterThan(0);
      expect(await spent()).toBeCloseTo(before.all + run!.llmUsd, 9);
      expect(await getQlooUsage(t!.db, { day: "2026-10-22", lane: "public", metric: LLM_USD_METRIC })).toBeCloseTo(before.public + run!.llmUsd, 9);
    });

    it("passes run-agent one pin per mention when stored pins normalise alike", async () => {
      await replaceShowcasePins(t!.db, "alpha-sponsors", [
        { mention: "Brand Alpha", entityId: "synthetic-alpha-a", name: "Brand Alpha", type: "brand" },
        { mention: "The Brand Alpha", entityId: "synthetic-alpha-b", name: "Brand Alpha", type: "artist" },
      ]);
      const agent = scriptedAgent();
      const { code, err } = await cli(["prewarm", "alpha-sponsors", "--yes", "--no-ghost"], { agent: agentDeps(agent), openQloo: async () => ({ client: mockQloo(), close: async () => undefined }) });
      expect(code).toBe(0);
      expect(agent.seen).toHaveLength(1);
      expect(agent.seen[0]?.pins).toEqual({ "brand alpha": "synthetic-alpha-a" });
      expect(err).toContain('note: pin "The Brand Alpha" of alpha-sponsors is the same mention as "Brand Alpha" to run-agent; it is left out');
    });

    it("pins the trust example's refusal, and pins nothing when a run fails", async () => {
      const refusal = scriptedAgent(() => ({ status: "refused", report: null, reason: "Political targeting of residents." }));
      const trust = await cli(["prewarm", "trust-check", "--yes"], { agent: agentDeps(refusal) });
      expect(trust.code).toBe(0);
      // A refusal has no brief to diff: no GHOST is planned or attempted.
      expect(trust.out).not.toContain("GHOST");
      expect(await getRun(t!.db, refusal.seen[0]!.runId)).toMatchObject({ status: "refused", isShowcase: true, showcaseSlug: "trust-check" });

      const failing = scriptedAgent(() => ({ status: "failed", report: null, reason: "The analysis hit an internal error." }));
      const failed = await cli(["prewarm", "alpha-sponsors", "--yes"], { agent: agentDeps(failing) });
      expect(failed.code).toBe(1);
      const runId = failing.seen[0]!.runId;
      expect(failed.out).toMatch(new RegExp(`✗\\s+alpha-sponsors\\s+${runId}\\s+run ${runId} ended failed; not pinned`));
      expect(await getRun(t!.db, runId)).toMatchObject({ status: "failed", isShowcase: false, questionHash: `cli:${runId}` });
    });

    it("prewarms everything in order: the chain follows up the showcase it starts from, step by step, and GHOST goes on each pinned note", async () => {
      const spent = () => getQlooUsage(t!.db, { day: "2026-10-22", lane: "all", metric: LLM_USD_METRIC });
      const before = await spent();
      // The trust question is refused, as CLERK refuses it; every other one completes.
      const agent = scriptedAgent((o) => (o.question === TRUST ? { status: "refused", report: null, reason: "Political targeting." } : {}));
      const answer: GhostAnswer = {
        headline: "Brand Alpha fits Brand Beta.",
        picks: { competitors: ["Brand Beta"], markets: [], neighbourhoods: [], tenants: [], partners: [] },
        numeric_claims: [],
      };
      const reply = fakeGaMessage({ model: "claude-sonnet-5-5", content: [{ type: "text", text: JSON.stringify(answer), citations: null }] });
      const ghost = new FakeAnthropic({ create: [reply, reply, reply] });
      const { code, out } = await cli(["prewarm", "--all", "--yes", "--tag", "showcase-test"], {
        agent: agentDeps(agent, ghost),
        openQloo: async () => ({ client: mockQloo(), close: async () => undefined }),
      });

      expect(code).toBe(0);
      expect(out).toContain("up to 6 live run(s) and 3 GHOST answer(s)");
      // S1, S2, then the chain's steps 2 and 3 (step 1 is S2's run), then the trust example.
      expect(agent.seen.map((o) => o.question)).toEqual([S1, S2, STEP2, STEP3, TRUST]);
      const [, s2, step2, step3] = agent.seen.map((o) => o.runId);
      expect(out).toContain(`step 1 · reusing S2's pinned run ${s2}`);
      expect(agent.seen[2]?.parent?.runId).toBe(s2);
      expect(agent.seen[2]?.parent?.caseSummary).toContain("Brand Alpha");
      expect(agent.seen[3]?.parent?.runId).toBe(step2);

      const middle = await getRun(t!.db, step2!);
      expect(middle).toMatchObject({ parentRunId: s2, isShowcase: false, questionHash: webQuestionHash(STEP2, undefined, "live") });
      const last = await getRun(t!.db, step3!);
      expect(last).toMatchObject({ parentRunId: step2, isShowcase: true, showcaseSlug: "alpha-chain", showcaseOrder: 3, questionHash: webQuestionHash(STEP3, undefined, "live") });
      for (const slug of ["juniper-moat", "alpha-sponsors", "alpha-chain", "trust-check"]) expect(out).toMatch(new RegExp(`✓\\s+${slug}\\s`));
      const listed = await cli(["list"]);
      expect(listed.out).toContain("4 of 4 pinned");

      // GHOST on the three pinned notes, after pinning, as the last event of each; none on the refusal or the chain's middle step.
      expect(ghost.createRequests).toHaveLength(3);
      for (const slug of ["juniper-moat", "alpha-sponsors", "alpha-chain"]) expect(out).toMatch(new RegExp(`✓\\s+${slug}\\s+\\S+\\s+pinned.*; GHOST attached`));
      const [s1, , , , trust] = agent.seen.map((o) => o.runId);
      for (const id of [s1!, s2!, step3!]) {
        const row = await getRun(t!.db, id);
        expect(row?.ghost, id).not.toBeNull();
        expect(Report.parse(row?.report).receipt.models.ghost).toBe("claude-sonnet-5-5");
        expect((await readRunEvents(t!.db, id)).map((e) => e.type).slice(-2)).toEqual(["run.end", "ghost"]);
      }
      for (const id of [step2!, trust!]) expect((await getRun(t!.db, id))?.ghost, id).toBeNull();
      // The chain's last step is a follow-up: its GHOST gets the chain's earlier questions, never their answers.
      const message = (i: number) => String(ghost.createRequests[i]?.messages[0]?.content);
      expect(message(2)).toContain(`\n\nEARLIER QUESTIONS (oldest first):\n- ${S2}\n- ${STEP2}\n\n<user_question>`);
      expect(message(2)).not.toContain("CASE SUMMARY");
      expect(message(0)).not.toContain("EARLIER QUESTIONS");
      // GHOST's spend joins the runs' in today's LLM spend.
      const runs = await Promise.all(agent.seen.map((o) => getRun(t!.db, o.runId)));
      const runUsd = runs.reduce((n, r) => n + (r?.llmUsd ?? 0), 0);
      expect(await spent()).toBeCloseTo(before + runUsd + 3 * usdFor("claude-sonnet-5-5", reply.usage), 9);
    });

    it("stops before the next showcase once cancelled", async () => {
      const controller = new AbortController();
      const agent = scriptedAgent(() => {
        controller.abort(new Error("cancelled from the test"));
        return {};
      });
      const { code, out } = await cli(["prewarm", "--all", "--yes"], { agent: agentDeps(agent), signal: controller.signal, openQloo: async () => ({ client: mockQloo(), close: async () => undefined }) });
      expect(code).toBe(1);
      expect(agent.seen).toHaveLength(1);
      expect(out).toMatch(/✗\s+alpha-sponsors\s+—\s+cancelled before it started/);
    });
  });
});
