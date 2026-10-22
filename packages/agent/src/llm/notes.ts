/** The `note` event cadence (PLAN §4.7): thinking updates are coalesced every 300 ms. */
export const NOTE_INTERVAL_MS = 300;

/**
 * Buffers streamed thinking deltas and emits them at most once per interval, plus a final flush at
 * the end of each response. Separate thinking blocks inside one note are split by a blank line.
 */
export class NoteCoalescer {
  #buffer = "";
  #timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (text: string) => void,
    private readonly intervalMs: number = NOTE_INTERVAL_MS,
  ) {}

  /** `snapshot` is the block's text so far; when it equals the delta, a new thinking block began. */
  push(delta: string, snapshot: string): void {
    if (delta === "") return;
    if (snapshot === delta && this.#buffer.trim() !== "") this.#buffer += "\n\n";
    this.#buffer += delta;
    this.#timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  flush(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    const text = this.#buffer.trim();
    this.#buffer = "";
    if (text !== "") this.emit(text);
  }
}
