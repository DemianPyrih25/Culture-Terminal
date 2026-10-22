/** Why a run was stopped from outside the model loop. */
export type StopCause = "cancelled" | "wall_clock";

/** The rejection every pending await sees once the run is stopped. */
export class RunStopped extends Error {
  constructor(readonly stopCause: StopCause) {
    super(stopCause === "cancelled" ? "the run was cancelled" : "the run hit its hard wall-clock limit");
    this.name = "RunStopped";
  }
}

/**
 * One abort signal for the whole ANALYST run: it fires when the caller aborts or when the hard
 * wall-clock deadline passes. Streams, tool execution and hooks all watch it, so a stop is prompt
 * wherever the loop is waiting.
 */
export class RunControl {
  readonly #controller = new AbortController();
  #cause: StopCause | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #detach: (() => void) | null = null;

  constructor(signal: AbortSignal | undefined, hardDeadlineInMs: number) {
    if (signal?.aborted) {
      this.stop("cancelled");
      return;
    }
    if (signal) {
      const onAbort = (): void => this.stop("cancelled");
      signal.addEventListener("abort", onAbort, { once: true });
      this.#detach = () => signal.removeEventListener("abort", onAbort);
    }
    this.#timer = setTimeout(() => this.stop("wall_clock"), Math.max(0, hardDeadlineInMs));
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  get cause(): StopCause | null {
    return this.#cause;
  }

  /** The first cause wins; later calls change nothing. */
  stop(cause: StopCause): void {
    if (this.#cause !== null) return;
    this.#cause = cause;
    this.#controller.abort(new RunStopped(cause));
  }

  /** Settles like `work`, or rejects with RunStopped as soon as the run is stopped. */
  race<T>(work: PromiseLike<T>): Promise<T> {
    const signal = this.signal;
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(signal.reason);
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
      // Handlers stay attached after a stop, so a late rejection of `work` is never unhandled.
      Promise.resolve(work).then(
        (value) => {
          signal.removeEventListener("abort", onAbort);
          resolve(value);
        },
        (err: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }

  dispose(): void {
    if (this.#timer !== null) clearTimeout(this.#timer);
    this.#timer = null;
    this.#detach?.();
    this.#detach = null;
  }
}
