import { describe, expect, it, vi } from "vitest";
import { parseRunEvent, stampEvent, type RunEvent } from "@ct/contracts";
import { parseCursor, parseSeq, SSE_HEADERS, sseComment, sseEventFrame, sseResponse, sseRetry } from "../server/sse";
import { parseSseFrames, readBody } from "./support/sse";

vi.mock("server-only", () => ({}));

const RUN = "run-sse-test";
const note = (seq: number, text = `note ${seq}`): RunEvent =>
  stampEvent({ type: "note", text }, { seq, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(), runId: RUN });

async function* fromList(events: RunEvent[]): AsyncGenerator<RunEvent> {
  for (const e of events) yield e;
}

describe("SSE frames", () => {
  it("writes one event as an id line and a single data line", () => {
    const event = note(7, "two\nlines");
    const frame = sseEventFrame(event);
    expect(frame).toBe(`id: 7\ndata: ${JSON.stringify(event)}\n\n`);
    expect(frame.split("\n")).toHaveLength(4);
    const [parsed] = parseSseFrames(frame);
    expect(parsed?.id).toBe("7");
    expect(parseRunEvent(parsed?.data ?? "")).toEqual(event);
  });

  it("writes comments and the retry hint", () => {
    expect(sseComment("ping")).toBe(": ping\n\n");
    expect(sseComment("a\nb")).toBe(": a b\n\n");
    expect(sseRetry(2000)).toBe("retry: 2000\n\n");
  });
});

describe("cursor parsing", () => {
  it.each([
    ["0", 0],
    ["12", 12],
    [" 12 ", 12],
    ["2147483647", 2_147_483_647],
  ])("accepts %j", (raw, expected) => {
    expect(parseSeq(raw)).toBe(expected);
  });

  it.each(["", " ", "-1", "1.5", "1e3", "abc", "12abc", "2147483648", "99999999999"])("rejects %j", (raw) => {
    expect(parseSeq(raw)).toBeNull();
  });

  it("prefers Last-Event-ID, then ?after, then 0", () => {
    expect(parseCursor("40", "10")).toBe(40);
    expect(parseCursor(null, "10")).toBe(10);
    expect(parseCursor("junk", "10")).toBe(10);
    expect(parseCursor("junk", "junk")).toBe(0);
    expect(parseCursor(null, null)).toBe(0);
    expect(parseCursor("0", "10")).toBe(0);
  });
});

describe("sseResponse", () => {
  it("sends the SSE headers, the retry hint, then each event, and ends with the source", async () => {
    const events = [note(1), note(2), note(3)];
    const res = sseResponse(() => fromList(events), undefined);
    expect(res.status).toBe(200);
    for (const [name, value] of Object.entries(SSE_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(res.headers.get("cache-control")).toBe("no-cache, no-transform");
    const body = await readBody(res);
    expect(body.startsWith("retry: 2000\n\n")).toBe(true);
    const frames = parseSseFrames(body).filter((f) => f.data !== null);
    expect(frames.map((f) => f.id)).toEqual(["1", "2", "3"]);
  });

  it("sends a ping comment while the source is quiet", async () => {
    async function* slow(): AsyncGenerator<RunEvent> {
      await new Promise((r) => setTimeout(r, 80));
      yield note(1);
    }
    const body = await readBody(sseResponse(() => slow(), undefined, { pingMs: 15 }));
    expect(parseSseFrames(body).some((f) => f.comment === "ping")).toBe(true);
  });

  it("aborts the source when the request goes away", async () => {
    const request = new AbortController();
    let seen: AbortSignal | undefined;
    async function* forever(signal: AbortSignal): AsyncGenerator<RunEvent> {
      seen = signal;
      yield note(1);
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
    }
    const res = sseResponse((signal) => forever(signal), request.signal);
    const reader = res.body!.getReader();
    await reader.read();
    request.abort();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    expect(seen?.aborted).toBe(true);
  });
});
