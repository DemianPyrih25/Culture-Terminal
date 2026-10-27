// The end of an agent run when the database fails right then. The run manager retries the ledger
// and status writes; a run.end that is stored while its row still says running is honoured by
// pickers and follow-ups, and the next replay rebuilds the row and the ledger from the stored events.
// Real Postgres in a throwaway database, a scripted runAgent and injected write failures; skips only
// when no database is reachable.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { pickerKey } from "@ct/agent";
import { reduceRunEvents, type Intent, type RunEvent } from "@ct/contracts";
import { getRun, listLedgerRows } from "@ct/db";
import type { QlooClient } from "@ct/qloo";
import { searchParams } from "@ct/quant";
import { EventBus } from "../server/event-bus";
import { readAllEvents } from "../server/event-store";
import { RunManager, type RunManagerOptions } from "../server/run-manager";
import { runEventStream, type RunStreamDeps } from "../server/stream";
import { agentDeps, completedAgent, mockQlooClient, needsInputAgent, SPENT_USD } from "./support/agent";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "./support/test-db";

vi.mock("server-only", () => ({}));

/** Calls to fail before they reach the database: each count fails that many calls in a row. */
const faults = vi.hoisted(() => ({ setStatus: 0, insertLedgerSnapshot: 0 }));

vi.mock("@ct/db", async (importOriginal) => {
  const real = await importOriginal<typeof import("@ct/db")>();
  function flaky<A extends unknown[], R>(key: keyof typeof faults, write: (...args: A) => Promise<R>) {
    return async (...args: A): Promise<R> => {
      if (faults[key] > 0) {
        faults[key] -= 1;
        throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
      }
      return write(...args);
    };
  }
  return {
    ...real,
    setStatus: flaky("setStatus", real.setStatus),
    insertLedgerSnapshot: flaky("insertLedgerSnapshot", real.insertLedgerSnapshot),
  };
});

const available = await databaseAvailable();

const QUESTION = "Is the Juniper Cola audience a moat or a niche?";
// The mock transport answers a "twin" query with two exact matches: the ambiguous picker.
const TWIN_MENTION = "Twin Cola";
const TWIN_QUESTION = "Is the Twin Cola audience a moat or a niche?";
const TWIN_INTENT: Intent = {
  pillar: "investment",
  job: "brand_health",
  mentions: [{ text: TWIN_MENTION, entity_type: "brand", role: "primary", public_figure: false }],
  geo: { metro: null, area: null, unsupported_place: null, market: null },
  constraints: { concepts: [], sponsor_categories: [], domains: [], ages: [], notes: [] },
  safety: { allowed: true, category: null, reframe: null },
  assumptions: [],
  mnemonic: "TWIN COLA <BRAND> HLTH",
};

async function twinSearch(qloo: QlooClient) {
  const params = searchParams({ text: TWIN_MENTION, type: "brand", metro: null });
  if (params === null) throw new Error("no search params for the mention");
  return (await qloo.standalone().forTool(null).search(params)).data.results;
}

async function collect(deps: RunStreamDeps, runId: string, repairAfterMs: number): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  const stream = runEventStream(deps, runId, 0, new AbortController().signal, { tailIntervalMs: 20, statusCheckMs: 20, repairAfterMs });
  for await (const event of stream) out.push(event);
  return out;
}

describe.skipIf(!available)("the end of an agent run when the database fails", () => {
  let t: TestDatabase | undefined;
  const managers: RunManager[] = [];

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await Promise.all(managers.map((m) => m.drain(0)));
    await t?.dispose();
  }, 60_000);

  beforeEach(() => {
    faults.setStatus = 0;
    faults.insertLedgerSnapshot = 0;
  });

  function setup(options: Partial<Omit<RunManagerOptions, "db" | "bus">> = {}) {
    const db = t!.db;
    const bus = new EventBus();
    const runs = new RunManager({
      db,
      bus,
      cancelPollMs: 50,
      agent: agentDeps(),
      runAgent: completedAgent(),
      agentHourlyCap: 10_000,
      llmDailyUsdCap: 10_000,
      ...options,
    });
    managers.push(runs);
    const viewer: RunStreamDeps = { db, bus, isLive: (id) => runs.isLive(id), finalizeOrphan: (id) => runs.finalizeOrphan(id) };
    return { db, runs, viewer };
  }

  it("retries the ledger and status writes at the end of a run", async () => {
    faults.setStatus = 2;
    faults.insertLedgerSnapshot = 2;
    const { db, runs } = setup();
    const { runId } = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await runs.whenDone(runId);

    expect(faults).toEqual({ setStatus: 0, insertLedgerSnapshot: 0 });
    const state = reduceRunEvents(runId, await readAllEvents(db, runId));
    expect(await getRun(db, runId)).toMatchObject({ status: "completed", report: state.report, error: null });
    expect((await listLedgerRows(db, runId)).evidence).toHaveLength(Object.keys(state.evidence).length);
  }, 30_000);

  it("takes a lagging parent's note from its stored events, and the next replay rebuilds the row and the ledger", async () => {
    faults.setStatus = 3;
    faults.insertLedgerSnapshot = 3;
    const { db, runs, viewer } = setup();
    const { runId } = await runs.startAgentRun({ question: QUESTION, lane: "public" });
    await runs.whenDone(runId);

    const events = await readAllEvents(db, runId);
    expect(events.at(-1)).toMatchObject({ type: "run.end", status: "completed" });
    expect(await getRun(db, runId)).toMatchObject({ status: "running", report: null, llmUsd: 0, tokens: 0 });
    expect(await listLedgerRows(db, runId)).toEqual({ evidence: [], metrics: [], datasets: [], findings: [] });

    // The stored run.end and report.final stand for the row, so the note can be followed up at once.
    const child = await runs.startAgentRun({ question: "Where does that audience travel?", lane: "public", parentRunId: runId });
    await runs.whenDone(child.runId);
    expect(await getRun(db, child.runId)).toMatchObject({ status: "completed", parentRunId: runId });

    // A refresh replays from seq 0 and stops at run.end; repairAfterMs 0 since no driver is writing.
    expect(await collect(viewer, runId, 0)).toEqual(events);
    const state = reduceRunEvents(runId, events);
    expect(await getRun(db, runId)).toMatchObject({
      status: "completed",
      report: state.report,
      validation: { issues: state.validation?.issues, numbersTraced: state.validation?.numbersTraced },
      // The last usage event: input 1000 + output 200 + cache read 500, and 3 cached + 1 reused calls.
      llmUsd: SPENT_USD,
      tokens: 1700,
      qlooNetwork: 5,
      qlooCached: 4,
      error: null,
    });
    const ledger = await listLedgerRows(db, runId);
    expect(ledger.evidence.map((e) => e.id).sort()).toEqual(Object.keys(state.evidence).sort());
    expect(ledger.metrics.map((m) => m.id).sort()).toEqual(Object.keys(state.metrics).sort());
    expect(ledger.findings.map((f) => f.id).sort()).toEqual(state.findings.map((f) => f.id).sort());
    expect(await runs.finalizeOrphan(runId)).toBe(false);
  }, 30_000);

  it("answers the picker of a needs_input run whose row still says running", async () => {
    const qloo = mockQlooClient();
    const results = await twinSearch(qloo);
    expect(results.length).toBeGreaterThanOrEqual(2);
    const candidates = results.slice(0, 2).map((r) => ({ key: pickerKey(r.entity_id), name: r.name, disambiguation: null, popularity: null }));
    faults.setStatus = 3;
    const { db, runs } = setup({
      agent: agentDeps({ qloo: () => qloo }),
      runAgent: needsInputAgent(TWIN_INTENT, { mention: TWIN_MENTION, entityType: "brand", reason: "ambiguous", candidates }),
    });
    const waiting = await runs.startAgentRun({ question: TWIN_QUESTION, lane: "public" });
    await runs.whenDone(waiting.runId);
    expect((await getRun(db, waiting.runId))?.status).toBe("running");
    expect((await readAllEvents(db, waiting.runId)).at(-1)).toMatchObject({ type: "run.end", status: "needs_input" });

    const picked = setup({ agent: agentDeps({ qloo: () => qloo }) });
    const { runId } = await picked.runs.answerPicker({ runId: waiting.runId, key: candidates[1]!.key, lane: "public" });
    await picked.runs.whenDone(runId);
    expect(await getRun(db, runId)).toMatchObject({ status: "completed", pins: { "twin cola": results[1]!.entity_id } });
  }, 30_000);
});
