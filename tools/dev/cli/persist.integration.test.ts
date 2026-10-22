// run-agent --persist against a real Postgres, in a throwaway database. Skips when none is reachable.
// The runs, events and entity ids are synthetic (D29); the Qloo side runs on the mock transport.
import type { AgentRunOptions, AgentRunResult, AnthropicLike } from "@ct/agent";
import { DEFAULT_RUN_LIMITS, RunEvent, type EventInput } from "@ct/contracts";
import { appendEvents, getRun, listEvents, listLedgerRows, setStatus, type RunEventRow } from "@ct/db";
import { createMemoryQlooStore } from "@ct/qloo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "../../../packages/db/test/support/testDb";
import { runAgentCommand } from "./agent-cli";
import { syntheticResult } from "./fixtures";
import { memoryIo } from "./io";
import { CLI_HASH_PREFIX, createRunPersistence, SeqTakenError, UNSAVED_REASON, type RunStart } from "./persist";

const probe = await probeTestDatabase();
const NOW = new Date("2026-10-22T03:15:22.123Z");
const QUESTION = "How healthy is Brand Alpha?";
const START: RunStart = { question: QUESTION, mode: "live", lane: "public", model: "claude-sonnet-5-5", effort: "medium", limits: DEFAULT_RUN_LIMITS, pins: undefined };
const CREATED: EventInput = { type: "run.created", question: QUESTION, mode: "live", lane: "public", limits: DEFAULT_RUN_LIMITS, parentRunId: null, model: "claude-sonnet-5-5" };

let counter = 0;
const nextRunId = (): string => `cli-20261022T0315221${String(++counter).padStart(2, "0")}Z`;

/** A stored row rebuilt the way the SSE route reads it back. */
function rebuild(row: RunEventRow): RunEvent {
  const payload = typeof row.payload === "object" && row.payload !== null ? row.payload : {};
  return RunEvent.parse({ ...payload, type: row.type, seq: row.seq, ts: row.ts.toISOString(), runId: row.runId });
}

describe.skipIf(!probe.ok)("run-agent --persist against Postgres", () => {
  let t: TestDatabase | undefined;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  const persistence = (runId: string, warnings: string[] = []) => createRunPersistence(t!.db, runId, () => NOW, (line) => warnings.push(line));

  it("stores the run row, its events and its ledger the way the web run manager does", async () => {
    const db = t!.db;
    const runId = nextRunId();
    const p = persistence(runId);
    await p.start({ ...START, question: `  ${QUESTION}\u0007 `, pins: { "brand alpha": "ent-invented-alpha" } });
    p.event(CREATED);
    p.event({ type: "note", text: "Mapping the peers first." });
    await p.finish(syntheticResult(runId));

    expect(await getRun(db, runId)).toMatchObject({
      status: "completed",
      question: QUESTION,
      questionHash: `${CLI_HASH_PREFIX}${runId}`,
      model: "claude-sonnet-5-5",
      effort: "medium",
      pins: { "brand alpha": "ent-invented-alpha" },
      wallMs: 42_000,
      llmUsd: 0.31,
      // Every token kind, as the web counts them.
      tokens: 30_000 + 4_000 + 20_000 + 8_000,
      qlooNetwork: 6,
      qlooCached: 3,
      error: null,
    });
    const rows = await listEvents(db, runId);
    expect(rows.map((r) => [r.seq, r.type])).toEqual([
      [1, "run.created"],
      [2, "note"],
      [3, "run.end"],
    ]);
    expect(rebuild(rows[2]!)).toMatchObject({ type: "run.end", status: "completed", reason: null, elapsedMs: 42_000 });
    for (const r of rows) expect(() => rebuild(r)).not.toThrow();
    const ledger = await listLedgerRows(db, runId);
    expect(ledger.evidence.map((e) => e.id)).toEqual(["E1"]);
    expect(ledger.metrics.map((m) => m.id)).toEqual(["M1", "M2"]);
  });

  it("sets error only for failed and incomplete runs", async () => {
    const db = t!.db;
    const cases = [
      { status: "needs_input", reason: "'Brand Twin' needs a choice", error: null },
      { status: "cancelled", reason: "Cancelled from the terminal.", error: null },
      { status: "refused", reason: "Out of scope.", error: null },
      { status: "incomplete", reason: "hard time limit", error: { reason: "hard time limit" } },
    ] as const;
    for (const c of cases) {
      const runId = nextRunId();
      const p = persistence(runId);
      await p.start(START);
      p.event(CREATED);
      await p.finish(syntheticResult(runId, { status: c.status, reason: c.reason, report: null }));
      expect(await getRun(db, runId)).toMatchObject({ status: c.status, error: c.error });
    }
  });

  it("drops events that break the contracts and a run.end from the agent, without spending a seq", async () => {
    const db = t!.db;
    const runId = nextRunId();
    const warnings: string[] = [];
    const p = persistence(runId, warnings);
    await p.start(START);
    p.event(CREATED);
    p.event({ type: "note", text: 42 } as unknown as EventInput);
    p.event({ type: "run.end", status: "completed", elapsedMs: 1, reason: null });
    p.event({ type: "note", text: "still going" });
    await p.finish(syntheticResult(runId));
    expect((await listEvents(db, runId)).map((r) => [r.seq, r.type])).toEqual([
      [1, "run.created"],
      [2, "note"],
      [3, "run.end"],
    ]);
    expect(warnings).toEqual([expect.stringContaining("a note event breaks the contracts"), "--persist: the agent emitted run.end; not stored"]);
  });

  it("leaves the end standing when another writer took a seq", async () => {
    const db = t!.db;
    const runId = nextRunId();
    const p = persistence(runId);
    await p.start(START);
    // The web's orphan finalizer ends the run while the CLI is stalled.
    await appendEvents(db, runId, [{ seq: 2, type: "run.end", payload: { status: "incomplete", elapsedMs: 5, reason: "orphaned" }, ts: NOW }]);
    await setStatus(db, runId, "incomplete", { patch: { error: { reason: "orphaned" } } });
    p.event(CREATED);
    p.event({ type: "note", text: "too late" });
    p.event({ type: "note", text: "never written" });
    await expect(p.finish(syntheticResult(runId))).rejects.toThrow(SeqTakenError);
    expect(await getRun(db, runId)).toMatchObject({ status: "incomplete", error: { reason: "orphaned" } });
    expect((await listEvents(db, runId)).map((r) => r.seq)).toEqual([1, 2]);
  });

  it("marks a run whose agent threw before its first event as failed, opening the stream with run.created", async () => {
    const db = t!.db;
    const runId = nextRunId();
    const p = persistence(runId);
    await p.start({ ...START, mode: "economy", lane: "judge", model: "claude-haiku-5-5" });
    await p.fail("boom", 1_500);
    expect(await getRun(db, runId)).toMatchObject({ status: "failed", mode: "economy", lane: "judge", wallMs: 1_500, error: { reason: "boom" } });
    const rows = await listEvents(db, runId);
    expect(rows.map((r) => r.type)).toEqual(["run.created", "run.end"]);
    expect(rebuild(rows[0]!)).toMatchObject({ mode: "economy", lane: "judge", model: "claude-haiku-5-5" });
  });

  it("ends a run whose events could not all be stored as failed and unsaved, with no gap in the stream", async () => {
    const db = t!.db;
    const runId = nextRunId();
    const p = persistence(runId);
    await p.start(START);
    p.event(CREATED);
    // Valid for the contracts, refused by Postgres (jsonb holds no NUL): a failed write.
    p.event({ type: "note", text: "nul \u0000 inside" });
    p.event({ type: "note", text: "never written" });
    await expect(p.finish(syntheticResult(runId))).rejects.toThrow();
    expect(await getRun(db, runId)).toMatchObject({ status: "failed", error: { reason: UNSAVED_REASON }, tokens: 62_000 });
    const rows = await listEvents(db, runId);
    expect(rows.map((r) => [r.seq, r.type])).toEqual([
      [1, "run.created"],
      [2, "run.end"],
    ]);
    expect(rebuild(rows[1]!)).toMatchObject({ status: "failed", reason: UNSAVED_REASON });
  });

  it("persists a whole run-agent command and closes the database it opened", async () => {
    const db = t!.db;
    const io = memoryIo();
    let closed = 0;
    const unusedAnthropic = { beta: { messages: { stream: () => undefined } }, messages: { create: () => undefined } } as unknown as AnthropicLike;
    let seen: AgentRunOptions | undefined;
    const runAgent = async (options: AgentRunOptions): Promise<AgentRunResult> => {
      seen = options;
      options.emit({ ...CREATED, type: "run.created" });
      options.emit({ type: "note", text: "Mapping the peers first." });
      options.emit({ type: "usage", llmUsd: 0.2, tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0 }, qloo: { network: 0, cached: 0, reused: 0 }, elapsedMs: 10 });
      return syntheticResult(options.runId);
    };
    const code = await runAgentCommand([QUESTION, "--yes", "--persist", "--pins", "Brand Alpha=ent-invented-alpha"], {
      env: { QLOO_MOCK: "1", QLOO_RPS: "10", ANTHROPIC_API_KEY: "test-key-not-real" },
      io,
      store: createMemoryQlooStore(),
      openDb: () => ({
        db,
        close: async () => {
          closed += 1;
        },
      }),
      spendFile: null,
      runAgent,
      createAnthropic: () => unusedAnthropic,
      now: () => new Date("2026-10-22T03:16:00.000Z"),
    });
    expect(code).toBe(0);
    const runId = seen!.runId;
    expect(io.stdout.join("\n")).toContain(`persisted run ${runId}`);
    expect(await getRun(db, runId)).toMatchObject({ status: "completed", pins: { "brand alpha": "ent-invented-alpha" }, tokens: 62_000 });
    expect((await listEvents(db, runId)).map((r) => r.type)).toEqual(["run.created", "note", "usage", "run.end"]);
    expect(closed).toBe(1);
  });
});
