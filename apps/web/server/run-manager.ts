import "server-only";
import { randomUUID } from "node:crypto";
import { RunEvent, stampEvent, type EventInput, type TerminalRunStatus } from "@ct/contracts";
import {
  countRunsSince,
  createRun,
  isCancelRequested,
  lockRun,
  purgeRuns,
  setStatus,
  type Queryable,
  type RunStatus,
} from "@ct/db";
import type { EventBus } from "./event-bus";
import { appendRunEvent, readEventAt, readLastEvent, sameEvent } from "./event-store";
import { buildFakeScript, FAKE_MODEL, FAKE_QUESTION } from "./fake-script";
import { log } from "./log";

export type RunManagerErrorCode = "not_accepting" | "busy";

export class RunManagerError extends Error {
  readonly code: RunManagerErrorCode;
  constructor(code: RunManagerErrorCode, message: string) {
    super(message);
    this.name = "RunManagerError";
    this.code = code;
  }
}

/**
 * Reads the code by name rather than `instanceof`: Next.js may bundle this module once per route,
 * so the class that threw is not always the class the caller imported.
 */
export function runManagerErrorCode(err: unknown): RunManagerErrorCode | null {
  if (typeof err !== "object" || err === null || (err as { name?: unknown }).name !== "RunManagerError") return null;
  const code = (err as { code?: unknown }).code;
  return code === "not_accepting" || code === "busy" ? code : null;
}

export const ACTIVE_STATUSES = ["queued", "running"] as const satisfies readonly RunStatus[];

export function isActiveStatus(status: string): boolean {
  return (ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** Every fake run's question_hash starts with this, so they can be counted and purged together. */
export const FAKE_HASH_PREFIX = "fake:";
const HOUR_MS = 3_600_000;
// startFakeRun purges old fake runs at most this often.
const PURGE_EVERY_MS = 10 * 60_000;

/** Another writer stored a different event at the seq a run loop was about to write. */
class SeqTakenError extends Error {
  constructor(readonly runId: string, readonly seq: number) {
    super(`seq ${seq} of run ${runId} is already taken by another writer`);
    this.name = "SeqTakenError";
  }
}

export const ORPHAN_REASON = "The server stopped before this run finished.";
const STOPS = {
  cancelled: { status: "cancelled", reason: "Cancelled by the viewer." },
  aborted: { status: "incomplete", reason: "The server shut down before this run finished." },
} as const satisfies Record<string, { status: TerminalRunStatus; reason: string }>;

export interface RunManagerOptions {
  db: Queryable;
  bus: EventBus;
  /** Default length of a fake run. */
  fakeRunSeconds?: number;
  /** Concurrent runs this process will hold. */
  maxActive?: number;
  /** Fake runs any process may start per rolling hour, counted in the database. */
  hourlyCap?: number;
  /** Finished fake runs older than this are purged. */
  retentionMs?: number;
  /** How often a run polls the database cancel flag. */
  cancelPollMs?: number;
}

export interface DrainResult {
  /** Runs that ended on their own within the grace period. */
  finished: number;
  /** Runs stopped at the deadline and marked incomplete. */
  stopped: number;
}

interface ActiveRun {
  controller: AbortController;
  done: Promise<void>;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Owns the runs this process is executing. Each event is validated against the contracts, given the
 * next seq, appended to run_events and only then published on the bus, so the database is always at
 * least as far along as any live subscriber.
 */
export class RunManager {
  private readonly db: Queryable;
  private readonly bus: EventBus;
  private readonly fakeRunSeconds: number;
  private readonly maxActive: number;
  private readonly hourlyCap: number;
  private readonly retentionMs: number;
  private readonly cancelPollMs: number;
  private readonly active = new Map<string, ActiveRun>();
  /** Orphan finalizations in flight, so viewers of one run in this process share one attempt. */
  private readonly finalizing = new Map<string, Promise<boolean>>();
  /** Tail of the admission queue: the hourly count and the insert run one start at a time. */
  private admission: Promise<unknown> = Promise.resolve();
  private lastPurgeAt = 0;
  private accepting = true;

  constructor(options: RunManagerOptions) {
    this.db = options.db;
    this.bus = options.bus;
    this.fakeRunSeconds = options.fakeRunSeconds ?? 200;
    this.maxActive = options.maxActive ?? 20;
    this.hourlyCap = options.hourlyCap ?? 60;
    this.retentionMs = options.retentionMs ?? 6 * HOUR_MS;
    this.cancelPollMs = options.cancelPollMs ?? 1000;
  }

  isAccepting(): boolean {
    return this.accepting;
  }

  isLive(runId: string): boolean {
    return this.active.has(runId);
  }

  activeCount(): number {
    return this.active.size;
  }

  /** Resolves once the run's loop has written run.end (or immediately when it is not active here). */
  async whenDone(runId: string): Promise<void> {
    await this.active.get(runId)?.done;
  }

  async startFakeRun(options: { seconds?: number } = {}): Promise<{ runId: string }> {
    if (!this.accepting) throw new RunManagerError("not_accepting", "The server is restarting. Try again in a moment.");
    if (this.active.size >= this.maxActive) {
      throw new RunManagerError("busy", "Too many test runs are active. Try again shortly.");
    }
    const seconds = options.seconds ?? this.fakeRunSeconds;
    const runId = randomUUID();
    const controller = new AbortController();
    let release: () => void = () => {};
    const done = new Promise<void>((resolve) => (release = resolve));
    // Reserve the slot before the first await so concurrent starts respect maxActive and drain sees it.
    this.active.set(runId, { controller, done });
    try {
      await this.admit(async () => {
        // Counted in the database, so started-then-cancelled runs count too: every run leaves rows.
        const lastHour = await countRunsSince(this.db, { hashPrefix: FAKE_HASH_PREFIX, sinceMs: HOUR_MS });
        if (lastHour >= this.hourlyCap) {
          throw new RunManagerError("busy", "The hourly limit for test runs is reached. Try again later.");
        }
        await createRun(this.db, {
          id: runId,
          question: FAKE_QUESTION,
          // Namespaced so a fake run can never answer a real question from the answer cache (D26).
          questionHash: `${FAKE_HASH_PREFIX}${runId}`,
          status: "running",
          pillar: "investment",
          job: "brand_health",
          mode: "live",
          lane: "public",
          model: FAKE_MODEL,
        });
      });
    } catch (err) {
      this.active.delete(runId);
      release();
      throw err;
    }
    this.purgeSoon();
    void this.runFake(runId, seconds * 1000, controller.signal).finally(() => {
      this.active.delete(runId);
      this.bus.close(runId);
      release();
    });
    log.info({ runId, seconds }, "fake run started");
    return { runId };
  }

  /** Deletes finished fake runs older than the retention, with their events. Returns how many. */
  async purgeFakeRuns(): Promise<number> {
    this.lastPurgeAt = Date.now();
    const purged = await purgeRuns(this.db, {
      hashPrefix: FAKE_HASH_PREFIX,
      olderThanMs: this.retentionMs,
      keepStatuses: ACTIVE_STATUSES,
    });
    if (purged > 0) log.info({ purged }, "old fake runs purged");
    return purged;
  }

  private purgeSoon(): void {
    if (Date.now() - this.lastPurgeAt < PURGE_EVERY_MS) return;
    this.lastPurgeAt = Date.now();
    void this.purgeFakeRuns().catch((err: unknown) => log.warn({ err }, "fake run purge failed"));
  }

  // One admission at a time in this process, so concurrent starts cannot all pass the same count.
  private admit<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.admission.then(fn, fn);
    this.admission = next.catch(() => undefined);
    return next;
  }

  /** SIGTERM step one: refuse new runs. */
  beginShutdown(): void {
    this.accepting = false;
  }

  /**
   * Waits up to `graceMs` for active runs to end, then stops the rest, which end as incomplete.
   * There is no event buffer to flush: every event is stored before it is published.
   */
  async drain(graceMs: number): Promise<DrainResult> {
    this.beginShutdown();
    const pending = [...this.active.values()];
    if (pending.length === 0) return { finished: 0, stopped: 0 };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"deadline">((resolve) => {
      timer = setTimeout(() => resolve("deadline"), graceMs);
    });
    const all = Promise.all(pending.map((r) => r.done)).then(() => "done" as const);
    const outcome = await Promise.race([all, deadline]);
    clearTimeout(timer);
    let stopped = 0;
    if (outcome === "deadline") {
      const left = [...this.active.values()];
      stopped = left.length;
      for (const run of left) run.controller.abort();
      await Promise.all(left.map((r) => r.done));
    }
    return { finished: pending.length - stopped, stopped };
  }

  /**
   * Ends a run that no process is driving any more (its server crashed or was killed) with an
   * incomplete run.end. When run.end is already stored (the driver wrote it but not the status), it
   * only repairs the status from it. Safe to race: it holds the run's row lock throughout, so a run
   * gets at most one run.end. True when this call changed the run.
   */
  async finalizeOrphan(runId: string, reason: string = ORPHAN_REASON): Promise<boolean> {
    if (this.active.has(runId)) return false;
    const pending = this.finalizing.get(runId);
    if (pending) return pending;
    const attempt = this.finalizeLocked(runId, reason).finally(() => this.finalizing.delete(runId));
    this.finalizing.set(runId, attempt);
    return attempt;
  }

  private async finalizeLocked(runId: string, reason: string): Promise<boolean> {
    const outcome = await this.db.transaction(async (tx) => {
      const run = await lockRun(tx, runId);
      if (!run || !isActiveStatus(run.status)) return null;
      const last = await readLastEvent(tx, runId);
      if (last?.type === "run.end") {
        const error = last.status === "failed" || last.status === "incomplete" ? { reason: last.reason } : null;
        await setStatus(tx, runId, last.status, {
          from: ACTIVE_STATUSES,
          patch: { wallMs: Math.round(last.elapsedMs), error },
        });
        return { seq: last.seq, repaired: true };
      }
      const seq = (last?.seq ?? 0) + 1;
      const elapsedMs = Math.max(0, Date.now() - run.createdAt.getTime());
      const event = RunEvent.parse(
        stampEvent({ type: "run.end", status: "incomplete", elapsedMs, reason }, { seq, ts: new Date().toISOString(), runId }),
      );
      // A driver in another process wrote this seq after our read: the run is not orphaned.
      if (!(await appendRunEvent(tx, event))) return null;
      await setStatus(tx, runId, "incomplete", {
        from: ACTIVE_STATUSES,
        patch: { wallMs: elapsedMs, error: { reason } },
      });
      return { seq, repaired: false };
    });
    if (!outcome) return false;
    if (outcome.repaired) log.warn({ runId, seq: outcome.seq }, "run status repaired from its stored run.end");
    else log.warn({ runId, seq: outcome.seq }, "orphaned run marked incomplete");
    return true;
  }

  private async runFake(runId: string, durationMs: number, signal: AbortSignal): Promise<void> {
    const startedAt = Date.now();
    const script = buildFakeScript({ runId, startedAt, durationMs });
    let seq = 0;

    const emit = async (input: EventInput): Promise<void> => {
      const event = RunEvent.parse(stampEvent(input, { seq: seq + 1, ts: new Date().toISOString(), runId }));
      await this.persist(event);
      // Only advance after the write: a failed write must not leave a hole in the sequence.
      seq = event.seq;
      this.bus.publish(event);
    };

    let lastCancelCheck = 0;
    const waitUntil = async (due: number): Promise<keyof typeof STOPS | null> => {
      for (;;) {
        if (signal.aborted) return "aborted";
        if (Date.now() - lastCancelCheck >= this.cancelPollMs) {
          lastCancelCheck = Date.now();
          try {
            if (await isCancelRequested(this.db, runId)) return "cancelled";
          } catch (err) {
            log.warn({ err, runId }, "cancel flag check failed; continuing");
          }
        }
        const remaining = due - Date.now();
        if (remaining <= 0) return null;
        await sleep(Math.min(remaining, this.cancelPollMs), signal);
      }
    };

    let status: TerminalRunStatus = "completed";
    let reason: string | null = null;
    try {
      for (const step of script.steps) {
        const stop = await waitUntil(startedAt + step.at * durationMs);
        if (stop) {
          ({ status, reason } = STOPS[stop]);
          break;
        }
        await emit(step.input);
      }
      if (status === "completed") {
        const stop = await waitUntil(startedAt + durationMs);
        if (stop) ({ status, reason } = STOPS[stop]);
      }
    } catch (err) {
      if (err instanceof SeqTakenError) {
        // An orphan finalizer ended this run while it was stalled. The stored run.end stands.
        log.warn({ runId, seq: err.seq }, "fake run was ended by another writer; stopping");
        return;
      }
      status = "failed";
      reason = "The test run hit an internal error.";
      log.error({ err, runId, seq }, "fake run failed");
    }

    const elapsedMs = Date.now() - startedAt;
    try {
      await emit({ type: "run.end", status, elapsedMs, reason });
      await setStatus(this.db, runId, status, {
        from: ACTIVE_STATUSES,
        patch: {
          wallMs: elapsedMs,
          report: status === "completed" ? script.report : null,
          error: status === "failed" ? { reason } : null,
        },
      });
      log.info({ runId, status, events: seq, elapsedMs }, "fake run ended");
    } catch (err) {
      // The run stays active in the database. finalizeOrphan, called by a viewer tailing from past
      // the last stored event, repairs the status from a stored run.end or ends the run incomplete.
      log.error({ err, runId, seq }, "could not record the end of a fake run");
    }
  }

  private async persist(event: RunEvent): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        if (await appendRunEvent(this.db, event)) return;
        // The seq is taken: by our own earlier attempt whose reply was lost (fine), or by another
        // writer, in which case this event must not be published.
        const stored = await readEventAt(this.db, event.runId, event.seq);
        if (stored && sameEvent(stored, event)) return;
        throw new SeqTakenError(event.runId, event.seq);
      } catch (err) {
        if (err instanceof SeqTakenError || attempt >= 3) throw err;
        log.warn({ err, runId: event.runId, seq: event.seq, attempt }, "event write failed; retrying");
        await sleep(250 * 2 ** (attempt - 1));
      }
    }
  }
}
