/** Browser side of POST /api/runs, shared by the question form and the test-run button. */

export type StartRunOutcome = { ok: true; runId: string } | { ok: false; error: string };

export interface StartRunOptions {
  /** Called before each automatic retry with the server's message. */
  onRetry?: (message: string) => void;
  attempts?: number;
  retryMs?: number;
  fetch?: typeof fetch;
  wait?: (ms: number) => Promise<void>;
}

const defaultWait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Starts a run: `body` undefined starts the test run, `{question}` a live one and `{pick}` answers a
 * picker. Retries on its own when the server says `retry: true` (503 while a deploy drains, 429 when
 * every slot is taken); any other refusal, an hourly limit included, comes back with its message.
 */
export async function startRun(body: unknown, options: StartRunOptions = {}): Promise<StartRunOutcome> {
  const { attempts = 5, retryMs = 2000, fetch: doFetch = fetch, wait = defaultWait } = options;
  const init: RequestInit =
    body === undefined
      ? { method: "POST" }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  for (let attempt = 1; ; attempt++) {
    const res = await doFetch("/api/runs", init).catch(() => null);
    const reply = (await res?.json().catch(() => null)) as { runId?: unknown; error?: unknown; retry?: unknown } | null;
    if (res?.ok && typeof reply?.runId === "string") return { ok: true, runId: reply.runId };
    const message = typeof reply?.error === "string" ? reply.error : null;
    if (reply?.retry === true && attempt < attempts) {
      options.onRetry?.(message ?? "Retrying…");
      await wait(retryMs);
      continue;
    }
    return { ok: false, error: message ?? "Could not start a run. Try again." };
  }
}
