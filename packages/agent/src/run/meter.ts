import type { Emit, EventInput, EventInputOf, TokenUsage } from "@ct/contracts";
import type { PublicCallRecord } from "@ct/publicdata";
import { scrubEntityIds, type QlooCallRecord } from "@ct/qloo";
import { addTokenUsage, emptyTokenUsage } from "../pricing";
import { QLOO_CALL_BUCKET, type ReceiptPublicCall, type ReceiptQlooCall } from "../report/receipt";

/**
 * Run plumbing shared by every stage: the guarded event sink and the run's meters (LLM spend,
 * tokens and the Qloo call log), from which the `usage` events, the receipt and the result's
 * counts are all derived, so they cannot disagree.
 */

/** The events that carry Qloo request parameters or provenance, where entity ids live (R8). */
const SCRUBBED_EVENTS: ReadonlySet<EventInput["type"]> = new Set(["qloo", "evidence"]);

/**
 * The caller's emit, made safe for the run: an exception from persistence or publishing never
 * breaks the run (events are observability, like the loop's observers), and nothing is emitted
 * once runAgent has returned, since the caller then writes run.end.
 */
export class RunEvents {
  #closed = false;
  #fallbacks = 0;
  #nameOf: ((id: string) => string | null) | null = null;

  constructor(private readonly sink: Emit) {}

  /**
   * R8 (D51): Qloo entity ids stay on the server. From here on the `qloo` and `evidence` events reach the
   * sink with every entity id replaced by the entity's name (or «entity»), so stored events and the
   * browser never carry one; the request id still identifies each call.
   */
  scrubWith(nameOf: (id: string) => string | null): void {
    this.#nameOf = nameOf;
  }

  readonly emit: Emit = (event: EventInput): void => {
    if (this.#closed) return;
    if (event.type === "fallback") this.#fallbacks += 1;
    try {
      const nameOf = this.#nameOf;
      const out = nameOf !== null && SCRUBBED_EVENTS.has(event.type) ? (scrubEntityIds(event, nameOf) as EventInput) : event;
      this.sink(out);
    } catch {
      // The run manager owns delivery; a failed write must not fail the analysis.
    }
  };

  /** CODE FALLBACK events seen so far (§6.4 charges each). */
  get fallbacks(): number {
    return this.#fallbacks;
  }

  close(): void {
    this.#closed = true;
  }
}

export interface QlooCounts {
  network: number;
  cached: number;
  reused: number;
}

export class RunMeter {
  readonly #calls = new Map<string, QlooCallRecord>();
  readonly #publicCalls = new Map<string, PublicCallRecord>();
  #usd = 0;
  #unmeteredUsd = 0;
  #tokens: TokenUsage = emptyTokenUsage();

  constructor(
    private readonly now: () => number,
    private readonly startedAt: number,
  ) {}

  recordCall(record: QlooCallRecord): void {
    this.#calls.set(record.qlooCallId, record);
  }

  /** One SEC or Census call: it costs no Qloo call, so it never counts in qloo(); the receipt lists it apart. */
  recordPublicCall(record: PublicCallRecord): void {
    this.#publicCalls.set(record.publicCallId, record);
  }

  /** One LLM response (or the CLERK request): measured USD and its tokens. */
  addLlm(usage: TokenUsage | null, usd: number): void {
    this.#usd += usd;
    if (usage !== null) this.#tokens = addTokenUsage(this.#tokens, usage);
  }

  /** Worst-case spend for requests that may be billed without a usage report. */
  addUnmetered(usd: number): void {
    this.#unmeteredUsd += usd;
  }

  /** Measured plus unmetered USD: what counts against the caps and the daily spend. */
  usd(): number {
    return this.#usd + this.#unmeteredUsd;
  }

  tokens(): TokenUsage {
    return { ...this.#tokens };
  }

  elapsedMs(): number {
    return Math.max(0, this.now() - this.startedAt);
  }

  qloo(): QlooCounts {
    const counts: QlooCounts = { network: 0, cached: 0, reused: 0 };
    // The receipt's buckets, so the usage events and the receipt cannot disagree.
    for (const c of this.#calls.values()) counts[QLOO_CALL_BUCKET[c.cache]] += 1;
    return counts;
  }

  receiptCalls(): ReceiptQlooCall[] {
    return [...this.#calls.values()].map((c) => ({
      qlooCallId: c.qlooCallId,
      endpoint: c.path,
      filterType: c.filterType,
      cache: c.cache,
      rows: c.rows,
    }));
  }

  receiptPublicCalls(): ReceiptPublicCall[] {
    return [...this.#publicCalls.values()].map((c) => ({ publicCallId: c.publicCallId, source: c.source, endpoint: c.endpoint }));
  }

  /** The running totals; each `usage` event replaces the last. */
  usageEvent(): EventInputOf<"usage"> {
    return { type: "usage", llmUsd: this.usd(), tokens: this.tokens(), qloo: this.qloo(), elapsedMs: this.elapsedMs() };
  }
}
