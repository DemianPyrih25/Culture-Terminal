// A queued run (D24, §8.1 Queued) on the working page and in a replay: its place and the longest it may
// still wait while it waits, the progress card once it starts, the not-started card when it ends in the
// queue, and a replay that skips the wait. The sample run is invented (D29).
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { queueTimeoutReason, stampEvent, type EventInput, type RunEvent } from "@ct/contracts";
import { WorkingView } from "../../components/working";
import { endedInQueue, queuedPlace, queueWaitLeftS, ReplayPlayer } from "../../lib/run-stream";
import { events, modelOf, slice, text } from "./support";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));

const SAMPLE = events("brand-health");
const CREATED = SAMPLE[0]!;
const RUN = CREATED.runId;
const T0 = Date.parse(CREATED.ts);

/** The sample's events behind a wait in the queue: run.created, run.queued at each place, then the agent's own events. */
function queuedRun(places: readonly number[], waitMs: number, after: readonly RunEvent[] = []): RunEvent[] {
  const out: RunEvent[] = [CREATED];
  const push = (input: EventInput, offsetMs: number) =>
    out.push(stampEvent(input, { seq: out.length + 1, ts: new Date(T0 + offsetMs).toISOString(), runId: RUN }));
  places.forEach((position, i) => push({ type: "run.queued", position, ahead: position - 1, waitSMax: 120 - i * 10 }, i * 10_000));
  for (const e of after) {
    const input: Partial<RunEvent> = { ...e };
    delete input.seq;
    delete input.ts;
    delete input.runId;
    push(input as EventInput, Date.parse(e.ts) - T0 + waitMs);
  }
  return out;
}

function render(list: readonly RunEvent[], elapsedMs: number): string {
  const { state, model } = modelOf(list);
  return renderToStaticMarkup(<WorkingView runId={RUN} model={model} state={state} mode={state.ended ? "static" : "live"} elapsedMs={elapsedMs} />);
}

afterEach(() => {
  vi.useRealTimers();
});

describe("the working page of a queued run", () => {
  it("shows its place and the longest it may still wait, with Stop", () => {
    const list = queuedRun([3, 2], 0);
    const html = render(list, 15_000);
    expect(html).toContain('data-progress-card="queued"');
    expect(text(slice(html, "data-status-title", "</h2>"))).toBe("Queued · position 2");
    // Told 110 s at 10 s; 5 s later.
    expect(text(slice(html, "data-time", "</p>"))).toBe("Up to 1:45 wait");
    expect(text(html)).toContain("Your question starts on its own when one frees up.");
    expect(html).toContain('data-stop="idle"');
    expect(html).toMatch(/role="status" aria-live="polite" class="sr-only">Queued, position 2</);
  });

  it("switches to the progress card as the agent starts, before CLERK has read the question", () => {
    const list = queuedRun([1], 30_000, SAMPLE.slice(0, 1));
    const { state } = modelOf(list);
    expect(state.status).toBe("queued");
    expect(queuedPlace(state)).toBeNull();
    const html = render(list, 31_000);
    expect(html).not.toContain('data-progress-card="queued"');
    expect(text(slice(html, "data-status-title", "</h2>"))).toBe("Reading your question");
  });

  it("says plainly that a run that timed out in the queue did not start", () => {
    const reason = queueTimeoutReason(120);
    const list = queuedRun([1], 0);
    const end = (input: EventInput) => list.push(stampEvent(input, { seq: list.length + 1, ts: new Date(T0 + 120_000).toISOString(), runId: RUN }));
    end({ type: "error", code: "queue_timeout", message: reason, retryable: true });
    end({ type: "run.end", status: "failed", elapsedMs: 120_000, reason });
    const { state } = modelOf(list);
    expect(endedInQueue(state)).toBe(true);
    const html = render(list, 120_000);
    expect(html).toContain('data-state-card="not_started"');
    expect(text(html)).toContain("This question didn't start.");
    expect(text(html)).toContain(reason);
    expect(text(html)).toContain("Ask again");
  });

  it("counts the wait down from the latest place it was told", () => {
    const place = { position: 1, ahead: 0, waitSMax: 90, at: new Date(T0).toISOString() };
    expect(queueWaitLeftS(place, T0 + 30_500)).toBe(60);
    expect(queueWaitLeftS(place, T0 + 200_000)).toBe(0);
  });
});

describe("a queued run's replay", () => {
  it("plays the wait instantly and leaves it out of the recording's length", () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const work = SAMPLE;
    const list = queuedRun([2, 1], 60_000, work);
    const p = new ReplayPlayer(RUN, { speed: 1, autoplay: false });
    for (const e of list) p.push(e);
    p.play();
    // run.created, both places and the agent's run.created apply at once: no 60 s wait.
    expect(p.getSnapshot().applied).toBeGreaterThanOrEqual(4);
    expect(p.getSnapshot().positionMs).toBe(0);
    const workMs = Date.parse(work.at(-1)!.ts) - T0;
    expect(p.getSnapshot().durationMs).toBe(workMs);
    p.skipToEnd();
    expect(endedInQueue(p.getSnapshot().state)).toBe(false);
  });
});
