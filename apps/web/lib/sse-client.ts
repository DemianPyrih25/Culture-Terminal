import {
  applyEvent,
  initialRunState,
  safeParseRunEvent,
  type RunEventType,
  type RunState,
} from "@ct/contracts";
import { summarizeEvent } from "./event-summary";

/**
 * Browser side of the run stream. EventSource reconnects by itself after a network blip and sends
 * Last-Event-ID, so the server resumes where we stopped. When the browser gives up (a non-200
 * answer), we check the run and reopen with ?after=<last seq>. A page refresh starts a new client,
 * which replays from seq 0 and then continues live.
 */

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting" | "ended" | "not_found" | "failed";

export interface LogEntry {
  seq: number;
  ts: string;
  type: RunEventType;
  summary: string;
}

export interface RunStreamSnapshot {
  runId: string;
  state: RunState;
  connection: ConnectionStatus;
  /** Connections opened after the first one: automatic resumes, forced drops and gap repairs. */
  reconnects: number;
  /** Events that skipped ahead of the last seq and forced a resume. Stays 0 when the server is right. */
  gaps: number;
  /** Events at or below the last seq, ignored. Also 0 when the server is right. */
  duplicates: number;
  /** Messages that failed the contracts schema. */
  invalid: number;
  log: LogEntry[];
}

/** The part of EventSource the client uses, so tests can pass a fake. */
export interface EventSourceLike {
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close(): void;
}

export interface RunProbe {
  status: number;
  ended: boolean;
  lastSeq: number | null;
}

export interface RunStreamClientOptions {
  createEventSource?: (url: string) => EventSourceLike;
  /** Looks the run up after the browser gives up on the stream. */
  probeRun?: (runId: string) => Promise<RunProbe>;
  retryDelayMs?: number;
  maxManualRetries?: number;
}

const CONNECTING = 0;

export function streamUrl(runId: string, afterSeq: number): string {
  const base = `/api/runs/${encodeURIComponent(runId)}/stream`;
  return afterSeq > 0 ? `${base}?after=${afterSeq}` : base;
}

async function defaultProbe(runId: string): Promise<RunProbe> {
  const res = await fetch(`/api/runs/${encodeURIComponent(runId)}`, { cache: "no-store" });
  if (!res.ok) return { status: res.status, ended: false, lastSeq: null };
  const body = (await res.json()) as { state?: { lastSeq?: number; ended?: unknown } };
  return { status: res.status, ended: Boolean(body.state?.ended), lastSeq: body.state?.lastSeq ?? null };
}

export function initialSnapshot(runId: string): RunStreamSnapshot {
  return {
    runId,
    state: initialRunState(runId),
    connection: "idle",
    reconnects: 0,
    gaps: 0,
    duplicates: 0,
    invalid: 0,
    log: [],
  };
}

const FINAL: readonly ConnectionStatus[] = ["ended", "not_found", "failed"];

export class RunStreamClient {
  private snapshot: RunStreamSnapshot;
  private readonly listeners = new Set<() => void>();
  private source: EventSourceLike | null = null;
  /** Bumped by every open and stop, so a recovery that started earlier can tell it is stale. */
  private generation = 0;
  private opens = 0;
  private stopped = true;
  private manualRetries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly createEventSource: (url: string) => EventSourceLike;
  private readonly probeRun: (runId: string) => Promise<RunProbe>;
  private readonly retryDelayMs: number;
  private readonly maxManualRetries: number;

  constructor(
    readonly runId: string,
    options: RunStreamClientOptions = {},
  ) {
    this.snapshot = initialSnapshot(runId);
    this.createEventSource = options.createEventSource ?? ((url) => new EventSource(url));
    this.probeRun = options.probeRun ?? defaultProbe;
    this.retryDelayMs = options.retryDelayMs ?? 2000;
    this.maxManualRetries = options.maxManualRetries ?? 10;
  }

  // Arrow properties so React's useSyncExternalStore can take them unbound.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RunStreamSnapshot => this.snapshot;

  /** Opens the stream; after stop(), resumes from the last seq it has. */
  start(): void {
    if (!this.stopped || FINAL.includes(this.snapshot.connection)) return;
    this.stopped = false;
    // A restart (React remounting the viewer) is a fresh connection, not a reconnect.
    this.opens = 0;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    this.generation += 1;
    this.clearRetry();
    this.closeSource();
  }

  /** Drops the connection on purpose and resumes from the last seq, like a network blip. */
  forceReconnect(): void {
    if (this.stopped || FINAL.includes(this.snapshot.connection)) return;
    this.clearRetry();
    this.closeSource();
    this.open();
  }

  private update(patch: Partial<RunStreamSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private open(): void {
    // Never two sources at once: one left open would stream the same run a second time.
    this.closeSource();
    this.generation += 1;
    this.update({ connection: this.opens === 0 ? "connecting" : "reconnecting" });
    const source = this.createEventSource(streamUrl(this.runId, this.snapshot.state.lastSeq));
    this.source = source;
    source.onopen = () => {
      if (this.source !== source) return;
      this.opens += 1;
      this.manualRetries = 0;
      this.update({ connection: "open", reconnects: this.snapshot.reconnects + (this.opens > 1 ? 1 : 0) });
    };
    source.onmessage = (message: MessageEvent) => {
      if (this.source === source) this.receive(message.data);
    };
    source.onerror = () => {
      if (this.source !== source) return;
      if (source.readyState === CONNECTING) {
        // The browser is already retrying and will send Last-Event-ID.
        this.update({ connection: "reconnecting" });
        return;
      }
      this.closeSource();
      void this.recover();
    };
  }

  private receive(data: unknown): void {
    const parsed = safeParseRunEvent(data);
    if (!parsed.success) {
      this.update({ invalid: this.snapshot.invalid + 1 });
      return;
    }
    const event = parsed.data;
    if (event.runId !== this.runId) return;
    const state = this.snapshot.state;
    if (event.seq <= state.lastSeq) {
      this.update({ duplicates: this.snapshot.duplicates + 1 });
      return;
    }
    if (event.seq !== state.lastSeq + 1) {
      this.update({ gaps: this.snapshot.gaps + 1 });
      this.forceReconnect();
      return;
    }
    const entry: LogEntry = { seq: event.seq, ts: event.ts, type: event.type, summary: summarizeEvent(event, state.metrics) };
    this.update({ state: applyEvent(state, event), log: [...this.snapshot.log, entry] });
    if (event.type === "run.end") {
      this.closeSource();
      this.update({ connection: "ended" });
    }
  }

  private async recover(): Promise<void> {
    const generation = this.generation;
    let probe: RunProbe | null = null;
    try {
      probe = await this.probeRun(this.runId);
    } catch {
      probe = null;
    }
    // A forced drop or a stop and start during the probe already opened a newer connection.
    if (this.stopped || generation !== this.generation || this.source !== null) return;
    if (probe?.status === 404) {
      this.update({ connection: "not_found" });
      return;
    }
    if (probe?.ended && (probe.lastSeq ?? 0) <= this.snapshot.state.lastSeq) {
      this.update({ connection: "ended" });
      return;
    }
    if (this.manualRetries >= this.maxManualRetries) {
      this.update({ connection: "failed" });
      return;
    }
    this.manualRetries += 1;
    this.update({ connection: "reconnecting" });
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (!this.stopped && this.source === null) this.open();
    }, this.retryDelayMs);
  }

  private closeSource(): void {
    const source = this.source;
    this.source = null;
    source?.close();
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }
}
