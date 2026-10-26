// tools/dev/ghost.ts attach against a real Postgres in a throwaway database: a completed run seeded with
// its events, GHOST answered by a scripted fake Anthropic (no LLM call), its picks looked up through the
// mock Qloo transport over a memory store (no network). Checks the ghost event lands after run.end and
// the reducer applies it, the row and the stored report carry GHOST, the spend tally, and every refusal.
// Skips when no database is reachable. Runs, names and numbers are invented (D29).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { GHOST_EARLIER_MAX } from "@ct/agent";
import { DEFAULT_RUN_LIMITS, Report, reduceRunEvents, type DatasetEnvelope, type EventInput, type GhostAnswer } from "@ct/contracts";
import { appendEvents, createRun, getRun, insertLedgerSnapshot, updateRun, type NewRun } from "@ct/db";
import { createMemoryQlooStore, createQlooClient, qlooClientOptionsFromEnv } from "@ct/qloo";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { subsMap } from "../../packages/agent/test/ghost/support";
import { FakeAnthropic, fakeGaMessage } from "../../packages/agent/test/support/fake-anthropic";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "../../packages/db/test/support/testDb";
import { syntheticReport } from "./cli/fixtures";
import { memoryIo } from "./cli/io";
import { earlierQuestions, readRunEvents, runGhostCommand, type GhostCliDeps } from "./ghost";

const probe = await probeTestDatabase();

const ENV = { ANTHROPIC_API_KEY: "test-anthropic-key-not-real", QLOO_MOCK: "1", QLOO_RPS: "10" };
const D1: DatasetEnvelope = subsMap("D1", ["R1", "Brand Alpha"], [
  ["R2", "Brand Beta", 0.8],
  ["R3", "Brand Gamma", 0.6],
  ["R4", "Brand Delta", 0.4],
]);
const ANSWER: GhostAnswer = {
  headline: "Brand Alpha competes with Brand Beta for about 70% of its audience.",
  picks: { competitors: ["Brand Beta", "Brand Omega"], markets: [], neighbourhoods: [], tenants: [], partners: [] },
  numeric_claims: ["about 70%"],
};

const ghostMessage = (answer: GhostAnswer = ANSWER, stop: "end_turn" | "max_tokens" = "end_turn") =>
  fakeGaMessage({ model: "claude-sonnet-5-5", stop_reason: stop, content: [{ type: "text", text: JSON.stringify(answer), citations: null }] });

/** The brief GHOST is diffed against: the synthetic report showing the Substitution Map D1. */
function reportFor(runId: string, over: Partial<Report> = {}): Report {
  const exhibit = { datasetId: D1.id, kind: D1.kind, viz: "MatrixGrid" as const, title: D1.title, caption: "Where Brand Alpha sits.", badges: [], sourceLine: "Source: Qloo /v2/insights · Culture Terminal analysis", evidenceIds: ["E1" as const] };
  return Report.parse({ ...syntheticReport(runId), question: "Is the Brand Alpha audience a moat or a niche?", exhibits: [exhibit], ...over });
}

describe.skipIf(!probe.ok)("GHOST attach against Postgres", () => {
  let t: TestDatabase | undefined;
  const dirs: string[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function spendFile(): string {
    const dir = mkdtempSync(path.join(tmpdir(), "ct-ghost-"));
    dirs.push(dir);
    return path.join(dir, "spend.json");
  }

  let n = 0;
  /** A finished run: its row and its events, run.end last; D1 streamed inline unless the ledger holds it. */
  async function seed(over: Partial<NewRun> = {}, options: { inline?: boolean; ledger?: boolean; report?: Report | null } = {}): Promise<string> {
    const id = `ghost-test-${String(++n).padStart(4, "0")}`;
    const report = options.report === undefined ? reportFor(id) : options.report;
    await createRun(t!.db, { id, question: "Is the Brand Alpha audience a moat or a niche?", questionHash: `q1:ghost-${n}`, status: "completed", model: "claude-sonnet-5-5", report, ...over });
    const events: EventInput[] = [
      { type: "run.created", question: "Is the Brand Alpha audience a moat or a niche?", mode: "live", lane: "public", limits: DEFAULT_RUN_LIMITS, parentRunId: null, model: "claude-sonnet-5-5" },
      { type: "dataset.ready", datasetId: D1.id, kind: D1.kind, title: D1.title, bytes: 100, inline: options.inline === false ? null : D1 },
      ...(report === null ? [] : [{ type: "report.final" as const, report }]),
      { type: "run.end", status: over.status === undefined || over.status === "completed" ? "completed" : "failed", elapsedMs: 42_000, reason: null },
    ];
    await appendEvents(t!.db, id, events.map((e, i) => {
      const { type, ...payload } = e;
      return { seq: i + 1, type, payload };
    }));
    if (options.ledger) await insertLedgerSnapshot(t!.db, id, { evidence: [], metrics: [], datasets: [D1], findings: [] });
    return id;
  }

  function deps(fake: FakeAnthropic, over: Partial<Omit<GhostCliDeps, "io">> = {}): GhostCliDeps & { io: ReturnType<typeof memoryIo> } {
    return {
      env: ENV,
      io: memoryIo(),
      db: () => t!.db,
      where: "test database",
      createAnthropic: () => fake,
      openQloo: async () => {
        const client = createQlooClient(qlooClientOptionsFromEnv({ QLOO_MOCK: "1", QLOO_RPS: "10" }, { store: createMemoryQlooStore() }));
        return { client, close: () => client.flush() };
      },
      spendFile: null,
      now: () => new Date("2026-10-23T12:00:00.000Z"),
      ...over,
    };
  }

  async function attach(argv: string[], fake: FakeAnthropic, over: Partial<Omit<GhostCliDeps, "io">> = {}) {
    const d = deps(fake, over);
    const code = await runGhostCommand(argv, d);
    return { code, out: d.io.stdout.join("\n"), err: d.io.stderr.join("\n") };
  }

  it("appends the ghost event after run.end, and stores GHOST on the row and the stored report", async () => {
    const runId = await seed();
    const fake = new FakeAnthropic({ create: [ghostMessage()] });
    const tally = spendFile();
    const { code, out, err } = await attach(["attach", runId, "--yes"], fake, { spendFile: tally });

    expect(err).toBe("");
    expect(code).toBe(0);
    expect(out).toMatch(new RegExp(`ghost attach · run ${runId} · brand_health · 1 dataset\\(s\\) · GHOST claude-sonnet-5-5 \\(the run's ANALYST\\) · worst case \\$0\\.\\d+`));
    expect(out).toContain("diff · 1 both · 2 only Qloo · 1 LLM only (1 resolve in Qloo, 0 do not, 0 not checked) · overlap@5 20% · resolvability 100% · 1 number(s) with no source");
    expect(out).toContain(`stored as event 5 of run ${runId}`);
    // One request: the run's ANALYST model, no tools, the run's question.
    expect(fake.createRequests).toHaveLength(1);
    const request = fake.createRequests[0]!;
    expect(request.model).toBe("claude-sonnet-5-5");
    expect(request).not.toHaveProperty("tools");
    expect(JSON.stringify(request.messages)).toContain("Is the Brand Alpha audience a moat or a niche?");

    // The event comes after run.end, and the reducer applies it: the brief pages read state.ghost.
    const events = await readRunEvents(t!.db, runId);
    expect(events.map((e) => e.type)).toEqual(["run.created", "dataset.ready", "report.final", "run.end", "ghost"]);
    const state = reduceRunEvents(runId, events);
    expect(state.ended?.status).toBe("completed");
    expect(state.ghost?.answer).toEqual(ANSWER);
    expect(state.ghost?.diff.items.map((i) => [i.name, i.status])).toEqual([
      ["Brand Beta", "both"],
      ["Brand Gamma", "qloo_only"],
      ["Brand Delta", "qloo_only"],
      ["Brand Omega", "llm_only"],
    ]);
    const row = await getRun(t!.db, runId);
    expect(row?.ghost).toEqual(state.ghost);
    const stored = Report.parse(row?.report);
    expect(stored.ghost).toEqual(state.ghost);
    expect(stored.receipt.models).toEqual({ clerk: "claude-haiku-5-5", analyst: "claude-sonnet-5-5", ghost: "claude-sonnet-5-5" });
    // The tally holds what the answer cost: its worst case was booked, then settled.
    const spent = JSON.parse(readFileSync(tally, "utf8"));
    expect(spent.runs).toBe(1);
    expect(spent.usd).toBeGreaterThan(0);
    expect(spent.usd).toBeLessThan(0.02);
    expect(out).toMatch(/run-agent spend now \$0\.\d+ over 1 run\(s\) of LLM_DEV_USD_CAP \$15\.00/);
  });

  it("gives a follow-up's GHOST the earlier questions of its chain, never their answers", async () => {
    const first = await seed({ question: "Which brands fit Band Zeta's tour?" });
    const second = await seed({ question: "Which Lantern Row block fits the after-party?", parentRunId: first });
    const third = await seed({ parentRunId: second });
    const fake = new FakeAnthropic({ create: [ghostMessage()] });
    const { code, out } = await attach(["attach", third, "--yes"], fake);
    expect(code).toBe(0);
    expect(out).toContain(`ghost attach · run ${third} · brand_health · 1 dataset(s) · after 2 earlier question(s) of its chain · GHOST`);
    const content = String(fake.createRequests[0]?.messages[0]?.content);
    expect(content).toContain(
      "EARLIER QUESTIONS (oldest first):\n- Which brands fit Band Zeta's tour?\n- Which Lantern Row block fits the after-party?\n\n" +
        "<user_question>Is the Brand Alpha audience a moat or a niche?</user_question>",
    );
    // A brand_health brief ranks markets: GHOST chooses from the catalogue, as the ANALYST's MARKETS.
    expect(content).toMatch(/\n\nMARKETS: [^\n]+, [A-Z]{2}; /);
    expect(content).not.toContain("Verdict");
  });

  it("walks a chain no further than a loop or GHOST_EARLIER_MAX", async () => {
    const a = await seed({ question: "Question A?" });
    const b = await seed({ question: "Question B?", parentRunId: a });
    await updateRun(t!.db, a, { parentRunId: b });
    expect(await earlierQuestions(t!.db, { id: b, parentRunId: a })).toEqual(["Question A?"]);
    let parent: string | null = null;
    for (let i = 0; i < GHOST_EARLIER_MAX + 2; i += 1) parent = await seed({ question: `Step ${i + 1}?`, parentRunId: parent });
    const last = await seed({ parentRunId: parent });
    const steps = Array.from({ length: GHOST_EARLIER_MAX }, (_, i) => `Step ${i + 3}?`);
    expect(await earlierQuestions(t!.db, { id: last, parentRunId: parent })).toEqual(steps);
  });

  it("reads the datasets from the ledger when the events did not stream them", async () => {
    const runId = await seed({}, { inline: false, ledger: true });
    const { code, out } = await attach(["attach", runId, "--yes"], new FakeAnthropic({ create: [ghostMessage()] }));
    expect(code).toBe(0);
    expect(out).toContain("1 both · 2 only Qloo");
  });

  it("refuses a run that already has GHOST, and --replace appends a new one", async () => {
    const runId = await seed();
    expect((await attach(["attach", runId, "--yes"], new FakeAnthropic({ create: [ghostMessage()] }))).code).toBe(0);
    const again = new FakeAnthropic({ create: [ghostMessage()] });
    const refused = await attach(["attach", runId, "--yes"], again);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain(`Refusing to attach GHOST to run ${runId}: it already has a GHOST column; --replace attaches a new one.`);
    expect(again.createRequests).toHaveLength(0);

    const other: GhostAnswer = { ...ANSWER, picks: { ...ANSWER.picks, competitors: ["Brand Gamma"] }, numeric_claims: [] };
    const replaced = await attach(["attach", runId, "--yes", "--replace", "--model", "claude-haiku-5-5"], new FakeAnthropic({ create: [ghostMessage(other)] }));
    expect(replaced.code).toBe(0);
    expect(replaced.out).toContain("GHOST claude-haiku-5-5 (not the run's ANALYST claude-sonnet-5-5; D23 keeps them the same)");
    const events = await readRunEvents(t!.db, runId);
    expect(events.map((e) => e.type).slice(-2)).toEqual(["ghost", "ghost"]);
    expect(reduceRunEvents(runId, events).ghost?.answer.picks.competitors).toEqual(["Brand Gamma"]);
    expect(Report.parse((await getRun(t!.db, runId))?.report).receipt.models.ghost).toBe("claude-haiku-5-5");
  });

  it.each([
    ["a failed run", { status: "failed" as const }, {}, "it ended failed; GHOST is attached to completed briefs only"],
    ["a running run", { status: "running" as const }, {}, "it is still running"],
    ["a run with no report", { report: null }, { report: null }, "it stored no report"],
    ["a report without a job", { report: { ...syntheticReport("x"), job: undefined } }, {}, "its report has no job"],
  ])("refuses %s and sends nothing", async (_name, over, options, why) => {
    const runId = await seed(over as Partial<NewRun>, options);
    const fake = new FakeAnthropic({ create: [ghostMessage()] });
    const { code, err } = await attach(["attach", runId, "--yes"], fake);
    expect(code).toBe(1);
    expect(err).toContain(why);
    expect(fake.createRequests).toHaveLength(0);
    expect((await readRunEvents(t!.db, runId)).some((e) => e.type === "ghost")).toBe(false);
  });

  it("refuses a missing run, and sends nothing without --yes or past LLM_DEV_USD_CAP", async () => {
    const fake = new FakeAnthropic({ create: [ghostMessage()] });
    expect((await attach(["attach", "no-such-run-0001", "--yes"], fake)).err).toContain("there is no such run in test database");
    const runId = await seed();
    const unconfirmed = await attach(["attach", runId], fake);
    expect(unconfirmed.code).toBe(2);
    expect(unconfirmed.err).toContain("Nothing was sent; add --yes to start.");
    const capped = await attach(["attach", runId, "--yes"], fake, { env: { ...ENV, LLM_DEV_USD_CAP: "0.01" } });
    expect(capped.code).toBe(1);
    expect(capped.err).toMatch(/would pass LLM_DEV_USD_CAP \(\$0\.010\)/);
    expect(fake.createRequests).toHaveLength(0);
    expect((await getRun(t!.db, runId))?.ghost).toBeNull();
  });

  it("leaves the run as it was when GHOST gives no answer, and books what the response cost", async () => {
    const runId = await seed();
    const tally = spendFile();
    const { code, err } = await attach(["attach", runId, "--yes"], new FakeAnthropic({ create: [ghostMessage(ANSWER, "max_tokens")] }), { spendFile: tally });
    expect(code).toBe(1);
    expect(err).toMatch(/GHOST failed: the answer was cut off at 8000 tokens \(it spent \$0\.\d+\)/);
    expect((await readRunEvents(t!.db, runId)).map((e) => e.type).at(-1)).toBe("run.end");
    expect((await getRun(t!.db, runId))?.ghost).toBeNull();
    expect(JSON.parse(readFileSync(tally, "utf8")).usd).toBeLessThan(0.02);
  });
});
