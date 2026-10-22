import "server-only";
import type { RunEvent } from "@ct/contracts";
import { getRun, type Queryable } from "@ct/db";
import type { EventBus } from "./event-bus";
import { EVENT_PAGE, readEventsAfter, readLastEvent } from "./event-store";
import { isActiveStatus } from "./run-manager";

export interface RunStreamDeps {
  db: Queryable;
  bus: EventBus;
  /** Whether this process is producing the run's events. */
  isLive(runId: string): boolean;
  /** Ends a run nobody is driving; see RunManager.finalizeOrphan. */
  finalizeOrphan?(runId: string): Promise<boolean>;
  /** Reads stored events after a seq. Defaults to run_events; tests use it to time the replay. */
  readEventsAfter?(runId: string, afterSeq: number, limit: number): Promise<RunEvent[]>;
}

export interface RunStreamOptions {
  /** Database polling interval when the run is not live in this process. */
  tailIntervalMs?: number;
  /** A non-terminal run with no new event for this long is treated as orphaned. */
  orphanAfterMs?: number;
  /** How often the tail rereads the run row (status and orphan checks). */
  statusCheckMs?: number;
  pageSize?: number;
}

const DEFAULTS = {
  tailIntervalMs: 1000,
  // Fake runs emit every few seconds and real runs stop at 180 s; two silent minutes means no driver.
  orphanAfterMs: 120_000,
  statusCheckMs: 5000,
  pageSize: EVENT_PAGE,
} satisfies Required<RunStreamOptions>;

/**
 * The events of one run after `afterSeq`, in seq order with no gaps and no duplicates, ending after
 * run.end (or when `signal` aborts).
 *
 * It subscribes to the bus before reading the database. The run manager stores each event before
 * publishing it, so every event is either already in the database when the replay reads it or is
 * published after the subscription and lands in the buffer. Buffered events at or below the last
 * sent seq are dropped; a jump past it is filled from the database. When the run is not live in
 * this process (another instance, or a restart), it tails the database instead.
 */
export async function* runEventStream(
  deps: RunStreamDeps,
  runId: string,
  afterSeq: number,
  signal: AbortSignal,
  options: RunStreamOptions = {},
): AsyncGenerator<RunEvent, void, undefined> {
  const opts = { ...DEFAULTS, ...options };
  const readAfter: NonNullable<RunStreamDeps["readEventsAfter"]> =
    deps.readEventsAfter ?? ((id, after, limit) => readEventsAfter(deps.db, id, after, limit));
  const buffer: RunEvent[] = [];
  let busClosed = false;
  let wake: (() => void) | null = null;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  const unsubscribe = deps.bus.subscribe(runId, {
    onEvent: (event) => {
      buffer.push(event);
      notify();
    },
    onClose: () => {
      busClosed = true;
      notify();
    },
  });
  signal.addEventListener("abort", notify);
  // Asked after subscribing: a run that ends in between closes the bus, which sends us to the tail.
  const live = deps.isLive(runId);

  let last = afterSeq;
  let ended = false;

  const waitFor = (ms: number | null) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) return resolve();
      let timer: ReturnType<typeof setTimeout> | undefined;
      wake = () => {
        if (timer) clearTimeout(timer);
        resolve();
      };
      if (ms !== null) {
        timer = setTimeout(() => {
          wake = null;
          resolve();
        }, ms);
      }
    });

  // Everything stored after `last`, page by page.
  async function* catchUp(): AsyncGenerator<RunEvent, void, undefined> {
    for (;;) {
      const page = await readAfter(runId, last, opts.pageSize);
      for (const event of page) {
        if (signal.aborted) return;
        last = event.seq;
        yield event;
        if (event.type === "run.end") {
          ended = true;
          return;
        }
      }
      if (page.length < opts.pageSize) return;
    }
  }

  let lastStatusCheck = 0;
  // Tail mode only: stop when the run is over, and end runs whose driver died.
  async function shouldStop(): Promise<boolean> {
    if (Date.now() - lastStatusCheck < opts.statusCheckMs) return false;
    lastStatusCheck = Date.now();
    const run = await getRun(deps.db, runId);
    if (!run) return true;
    if (!isActiveStatus(run.status)) return true;
    if (!deps.finalizeOrphan || deps.isLive(runId)) return false;
    const lastEvent = await readLastEvent(deps.db, runId);
    const lastActivity = lastEvent ? Date.parse(lastEvent.ts) : run.updatedAt.getTime();
    if (Date.now() - lastActivity > opts.orphanAfterMs) {
      await deps.finalizeOrphan(runId);
      lastStatusCheck = 0;
    }
    return false;
  }

  try {
    yield* catchUp();

    while (!ended && !signal.aborted) {
      if (live && (!busClosed || buffer.length > 0)) {
        const next = buffer.shift();
        if (!next) {
          await waitFor(null);
          continue;
        }
        if (next.seq <= last) continue;
        if (next.seq > last + 1) {
          // Missed something between the replay and the buffer: the database has it.
          buffer.unshift(next);
          const before = last;
          yield* catchUp();
          if (last === before) await waitFor(opts.tailIntervalMs);
          continue;
        }
        last = next.seq;
        yield next;
        if (next.type === "run.end") ended = true;
      } else {
        // Not live here: nothing will be published for this run in this process.
        buffer.length = 0;
        yield* catchUp();
        if (ended || signal.aborted) break;
        if (await shouldStop()) {
          // The run ended (or vanished) without our seeing run.end: one last read, then stop.
          yield* catchUp();
          break;
        }
        await waitFor(opts.tailIntervalMs);
      }
    }
  } finally {
    unsubscribe();
    signal.removeEventListener("abort", notify);
  }
}
