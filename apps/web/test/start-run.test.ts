import { describe, expect, it, vi } from "vitest";
import { startRun } from "../lib/start-run";

type Reply = { status: number; body: unknown } | "network-error";

function fakeFetch(replies: Reply[]) {
  const calls: RequestInit[] = [];
  const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    calls.push(init ?? {});
    const reply = replies.shift();
    if (!reply || reply === "network-error") throw new TypeError("network error");
    return new Response(JSON.stringify(reply.body), { status: reply.status });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

const noWait = async () => {};

describe("startRun (browser)", () => {
  it("posts no body for the test run and JSON for a question", async () => {
    const test = fakeFetch([{ status: 201, body: { runId: "run-fake-0001" } }]);
    expect(await startRun(undefined, { fetch: test.fetch })).toEqual({ ok: true, runId: "run-fake-0001" });
    expect(test.calls[0]).toEqual({ method: "POST" });

    const live = fakeFetch([{ status: 201, body: { runId: "run-agent-0001" } }]);
    expect(await startRun({ question: "Is Brand Alpha a moat?" }, { fetch: live.fetch })).toEqual({ ok: true, runId: "run-agent-0001" });
    expect(live.calls[0]).toMatchObject({ method: "POST", body: JSON.stringify({ question: "Is Brand Alpha a moat?" }) });
    expect(live.calls[0]?.headers).toEqual({ "Content-Type": "application/json" });
  });

  it("retries while the server says retry, reporting its message", async () => {
    const { fetch } = fakeFetch([
      { status: 503, body: { error: "The server is restarting.", retry: true } },
      { status: 429, body: { error: "Too many runs are active.", retry: true } },
      { status: 201, body: { runId: "run-agent-0002" } },
    ]);
    const onRetry = vi.fn();
    expect(await startRun({ question: "q" }, { fetch, onRetry, wait: noWait })).toEqual({ ok: true, runId: "run-agent-0002" });
    expect(onRetry.mock.calls).toEqual([["The server is restarting."], ["Too many runs are active."]]);
  });

  it("returns the server's message for a refusal it should not retry, and gives up after the attempts", async () => {
    const refused = fakeFetch([{ status: 503, body: { error: "Today's budget for live analysis is used up.", retry: false } }]);
    expect(await startRun({ question: "q" }, { fetch: refused.fetch, wait: noWait })).toEqual({
      ok: false,
      error: "Today's budget for live analysis is used up.",
    });
    const busy = fakeFetch(Array.from({ length: 3 }, () => ({ status: 429, body: { error: "Busy.", retry: true } })));
    expect(await startRun({ question: "q" }, { fetch: busy.fetch, attempts: 3, wait: noWait })).toEqual({ ok: false, error: "Busy." });
    expect(busy.calls).toHaveLength(3);
  });

  it("explains a network failure", async () => {
    const { fetch } = fakeFetch(["network-error"]);
    expect(await startRun({ question: "q" }, { fetch, wait: noWait })).toEqual({ ok: false, error: "Could not start a run. Try again." });
  });
});
