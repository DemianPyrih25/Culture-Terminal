import "server-only";
import type { RunEvent } from "@ct/contracts";
import { log } from "./log";

export interface RunSubscriber {
  onEvent(event: RunEvent): void;
  /** The producer is done with the run in this process (after run.end, or after a crash). */
  onClose?(): void;
}

/**
 * In-process fan-out of run events, per run. It carries only events that are already stored in
 * run_events, so a subscriber that misses one can always recover it from the database.
 */
export class EventBus {
  private readonly subscribers = new Map<string, Set<RunSubscriber>>();

  subscribe(runId: string, subscriber: RunSubscriber): () => void {
    let set = this.subscribers.get(runId);
    if (!set) {
      set = new Set();
      this.subscribers.set(runId, set);
    }
    set.add(subscriber);
    return () => {
      const current = this.subscribers.get(runId);
      if (!current) return;
      current.delete(subscriber);
      if (current.size === 0) this.subscribers.delete(runId);
    };
  }

  publish(event: RunEvent): void {
    for (const subscriber of this.snapshot(event.runId)) {
      try {
        subscriber.onEvent(event);
      } catch (err) {
        log.error({ err, runId: event.runId, seq: event.seq }, "event bus subscriber failed");
      }
    }
  }

  close(runId: string): void {
    for (const subscriber of this.snapshot(runId)) {
      try {
        subscriber.onClose?.();
      } catch (err) {
        log.error({ err, runId }, "event bus close handler failed");
      }
    }
  }

  subscriberCount(runId: string): number {
    return this.subscribers.get(runId)?.size ?? 0;
  }

  // Handlers may unsubscribe while we iterate.
  private snapshot(runId: string): RunSubscriber[] {
    return [...(this.subscribers.get(runId) ?? [])];
  }
}
