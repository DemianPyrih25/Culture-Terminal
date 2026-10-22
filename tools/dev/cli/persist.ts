// `run-agent --persist`: the run row and its events in Postgres, by the web run manager's rules, so
// the run can be opened and replayed like any other. Each event is validated against the contracts
// and gets the next seq; nothing is stored after a failed write, so the stored events have no gap; the
// run manager's own run.end and runs row (agentRunPatch) close the run, after the ledger snapshot;
// and a seq another writer took (the web's orphan finalizer) leaves that writer's end standing. The
// question hash is namespaced, so a CLI run never answers a web question from the answer cache (D26).
import { sanitizeQuestion, type AgentRunResult, type AnalystMode } from "@ct/agent";
import { RunEvent, stampEvent, unstampEvent, type EventInput, type Lane, type RunLimits, type TerminalRunStatus, type TokenUsage } from "@ct/contracts";
import { appendEvents, createRun, insertLedgerSnapshot, setStatus, type Queryable, type RunPatch } from "@ct/db";

export interface RunStart {
  question: string;
  mode: AnalystMode;
  lane: Lane;
  model: string;
  effort: string;
  limits: RunLimits;
  /** Keyed by normalised mention, as runAgent receives them. */
  pins: Readonly<Record<string, string>> | undefined;
}

export interface RunPersistence {
  start(run: RunStart): Promise<void>;
  /** Validates and queues one event; writes happen in order in the background. */
  event(event: EventInput): void;
  /** Writes the ledger, run.end and the final row; rejects with the first write that failed. */
  finish(result: AgentRunResult): Promise<void>;
  /** Ends a run whose agent threw: run.end and status failed. */
  fail(reason: string, elapsedMs: number): Promise<void>;
}

export const CLI_HASH_PREFIX = "cli:";

/** The run manager's reason for a run whose events could not all be stored. */
export const UNSAVED_REASON = "The run could not be saved.";

const ACTIVE = ["queued", "running"] as const;

/** Another writer stored an event at the seq this run was about to write. */
export class SeqTakenError extends Error {
  override readonly name = "SeqTakenError";
  constructor(readonly runId: string, readonly seq: number) {
    super(`seq ${seq} of run ${runId} is already taken by another writer; its stored end stands`);
  }
}

const totalTokens = (u: TokenUsage): number => u.input + u.output + u.cacheRead + u.cacheCreation;

/**
 * The runs row at the end, as the web run manager's agentRunPatch writes it. `recordedUsd`: the last
 * spend the event stream reported, for a run that returned no result.
 */
export function runPatch(
  result: AgentRunResult | null,
  outcome: { status: TerminalRunStatus; reason: string | null },
  elapsedMs: number,
  recordedUsd: number,
): RunPatch {
  const patch: RunPatch = {
    wallMs: Math.round(elapsedMs),
    llmUsd: result?.usd ?? recordedUsd,
    error: outcome.status === "failed" || outcome.status === "incomplete" ? { reason: outcome.reason } : null,
  };
  if (result === null) return patch;
  return {
    ...patch,
    report: result.report,
    validation: result.validation,
    tokens: totalTokens(result.usage),
    qlooNetwork: result.qloo.network,
    // qloo_cached counts every call served without the network, reuses included.
    qlooCached: result.qloo.cached + result.qloo.reused,
    ...(result.model ? { model: result.model } : {}),
    ...(result.intent ? { intent: result.intent, pillar: result.intent.pillar, job: result.intent.job } : {}),
  };
}

/** `warn` receives what --persist could not store but did not stop for: dropped events, the ledger. */
export function createRunPersistence(db: Queryable, runId: string, now: () => Date, warn: (line: string) => void): RunPersistence {
  let run: RunStart | null = null;
  let assigned = 0;
  let stored = 0;
  let writes: Promise<void> = Promise.resolve();
  let failure: unknown = null;
  let recordedUsd = 0;

  const stamp = (input: EventInput, seq: number): RunEvent => stampEvent(input, { seq, ts: now().toISOString(), runId });
  const store = async (event: RunEvent): Promise<void> => {
    const { type, ...payload } = unstampEvent(event).input;
    const written = await appendEvents(db, runId, [{ seq: event.seq, type, payload, ts: new Date(event.ts) }]);
    if (written !== 1) throw new SeqTakenError(runId, event.seq);
    stored = event.seq;
  };
  /** After the queue drains: one more event at the next stored seq. */
  const append = async (input: EventInput): Promise<void> => {
    await store(RunEvent.parse(stamp(input, stored + 1)));
  };

  const end = async (result: AgentRunResult | null, status: TerminalRunStatus, reason: string | null, elapsedMs: number): Promise<void> => {
    await writes;
    if (failure instanceof SeqTakenError) throw failure;
    const unsaved = failure !== null;
    const outcome = unsaved ? { status: "failed" as const, reason: UNSAVED_REASON } : { status, reason };
    if (result !== null) {
      await insertLedgerSnapshot(db, runId, result.ledger).catch((err: unknown) => {
        warn(`--persist: could not store the ledger: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    // An agent that failed before its first event: the stream still opens with run.created.
    if (stored === 0 && run !== null) {
      await append({ type: "run.created", question: run.question, mode: run.mode, lane: run.lane, limits: run.limits, parentRunId: null, model: run.model });
    }
    await append({ type: "run.end", status: outcome.status, elapsedMs, reason: outcome.reason });
    if (!(await setStatus(db, runId, outcome.status, { from: ACTIVE, patch: runPatch(result, outcome, elapsedMs, recordedUsd) }))) {
      throw new Error(`run ${runId} was already ended by another writer`);
    }
    if (unsaved) throw failure;
  };

  return {
    async start(start) {
      run = start;
      await createRun(db, {
        id: runId,
        question: sanitizeQuestion(start.question),
        questionHash: `${CLI_HASH_PREFIX}${runId}`,
        status: "running",
        mode: start.mode,
        lane: start.lane,
        model: start.model,
        effort: start.effort,
        pins: start.pins ?? null,
      });
    },
    event(input) {
      if (failure !== null) return;
      // runAgent leaves run.end to its caller, which writes it from the returned status.
      if (input.type === "run.end") {
        warn("--persist: the agent emitted run.end; not stored");
        return;
      }
      const parsed = RunEvent.safeParse(stamp(input, assigned + 1));
      if (!parsed.success) {
        warn(`--persist: a ${input.type} event breaks the contracts; not stored (${parsed.error.issues[0]?.message ?? "invalid"})`);
        return;
      }
      const event = parsed.data;
      assigned = event.seq;
      if (event.type === "usage") recordedUsd = event.llmUsd;
      writes = writes.then(async () => {
        if (failure !== null) return;
        try {
          await store(event);
        } catch (err) {
          failure = err;
        }
      });
    },
    finish: (result) => end(result, result.status, result.reason, result.elapsedMs),
    fail: (reason, elapsedMs) => end(null, "failed", reason, elapsedMs),
  };
}
