import type { Emit, EventInput, EventInputOf, TokenUsage } from "@ct/contracts";
import type { QlooCallRecord } from "@ct/qloo";
import { addTokenUsage, emptyTokenUsage } from "../pricing";
import { QLOO_CALL_BUCKET, type ReceiptQlooCall } from "../report/receipt";

/**
 * Run plumbing shared by every stage: the guarded event sink and the run's meters (LLM spend,
 * tokens and the Qloo call log), from which the `usage` events, the receipt and the result's
 * counts are all derived, so they cannot disagree.
 */

/**
 * The caller's emit, made safe for the run: an exception from persistence or publishing never
 * breaks the run (events are observability, like the loop's observers), and nothing is emitted
 * once runAgent has returned, since the caller then writes run.end.
 */
export class RunEvents {
  #closed = false;
  #fallbacks = 0;

  constructor(private readonly sink: Emit) {}

  readonly emit: Emit = (event: EventInput): void => {
    if (this.#closed) return;
    if (event.type === "fallback") this.#fallbacks += 1;
    try {
      this.sink(event);
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

  /** The running totals; each `usage` event replaces the last. */
  usageEvent(): EventInputOf<"usage"> {
    return { type: "usage", llmUsd: this.usd(), tokens: this.tokens(), qloo: this.qloo(), elapsedMs: this.elapsedMs() };
  }
}
