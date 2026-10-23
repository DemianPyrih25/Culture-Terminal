// The brief page's client logic, without a DOM: which stamps flash, the progress headline that only moves
// forward, Stop run's confirm-then-send and its Esc key, the live view's hand-over from the server's first
// paint, and fetching a dataset that was not streamed inline (never keeping a failure).
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialRunState, type DatasetEnvelope } from "@ct/contracts";
import {
  FLASH_WINDOW_MS,
  FreshCalls,
  handOver,
  isStopKey,
  loadDataset,
  noteText,
  noteTrace,
  postCancel,
  sentenceCase,
  steadyProgress,
  stopStep,
  type SteadyProgress,
  type StopPhase,
} from "../../components/brief";
import { pendingNote } from "../../components/brief/figure-row";
import { noteTitles } from "../../components/brief/note-text";
import { events, stateOf, upTo } from "./support";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: () => null }));

const SAMPLE = events("brand-health");

describe("request stamps flash once, as their call lands", () => {
  it("never flashes a call the first paint showed", () => {
    const fresh = new FreshCalls(new Set(["qc-known"]));
    fresh.observe(["qc-known"], 1000);
    expect(fresh.isFresh("qc-known", 1000)).toBe(false);
  });

  it("flashes a call that lands while the reader watches, then stays still", () => {
    const fresh = new FreshCalls();
    // The render that brings the call in, before it is recorded: it flashes.
    expect(fresh.isFresh("qc-new", 5000)).toBe(true);
    fresh.observe(["qc-new"], 5000);
    expect(fresh.isFresh("qc-new", 5000 + FLASH_WINDOW_MS - 1)).toBe(true);
    // A Sources list or an inspector that opens later shows it still.
    expect(fresh.isFresh("qc-new", 5000 + FLASH_WINDOW_MS)).toBe(false);
    fresh.observe(["qc-new", "qc-later"], 9000);
    expect(fresh.isFresh("qc-new", 9000)).toBe(false);
    expect(fresh.isFresh("qc-later", 9000)).toBe(true);
  });

  it("flashes again when a restarted replay lands the call again", () => {
    const fresh = new FreshCalls();
    fresh.observe(["qc-a"], 0);
    expect(fresh.isFresh("qc-a", 5000)).toBe(false);
    fresh.observe([], 6000);
    fresh.observe(["qc-a"], 7000);
    expect(fresh.isFresh("qc-a", 7100)).toBe(true);
  });
});

describe("the progress headline only moves forward", () => {
  function walk(labels: readonly string[]): string[] {
    let steady: SteadyProgress | null = null;
    return labels.map((label, i) => {
      steady = steadyProgress(steady, label, i + 1);
      return steady.label;
    });
  }

  it("holds its furthest stage while the run's own stage steps back", () => {
    expect(
      walk([
        "Writing priors",
        "Gathering evidence",
        "Writing priors",
        "Gathering evidence",
        "Writing the answer",
        "Gathering evidence",
        "Writing the answer",
        "Checking every number",
      ]),
    ).toEqual([
      "Writing priors",
      "Gathering evidence",
      "Gathering evidence",
      "Gathering evidence",
      "Writing the answer",
      "Writing the answer",
      "Writing the answer",
      "Checking every number",
    ]);
  });

  it("follows a repair and its re-check, and shows a headline outside the order as it is", () => {
    expect(walk(["Checking every number", "Repairing the draft", "Checking every number", "Assembling the brief"])).toEqual([
      "Checking every number",
      "Repairing the draft",
      "Checking every number",
      "Assembling the brief",
    ]);
    expect(walk(["Gathering evidence", "Waiting for a pick"])).toEqual(["Gathering evidence", "Waiting for a pick"]);
  });

  it("starts over when a replay restarts", () => {
    const late = steadyProgress(null, "Checking every number", 90);
    expect(steadyProgress(late, "Reading the question", 1).label).toBe("Reading the question");
  });
});

describe("Stop run", () => {
  it("asks first, sends on the second press, and never sends twice", () => {
    let phase: StopPhase = "idle";
    const sends: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const step = stopStep(phase, "press");
      phase = step.phase;
      sends.push(step.send);
    }
    expect(sends).toEqual([false, true, false, false]);
    expect(phase).toBe("sending");
  });

  it("withdraws the question on reset (Keep going, or after five seconds), and asks again after a failure", () => {
    expect(stopStep("confirm", "reset")).toEqual({ phase: "idle", send: false });
    expect(stopStep("sending", "reset")).toEqual({ phase: "sending", send: false });
    expect(stopStep("failed", "press")).toEqual({ phase: "confirm", send: false });
  });

  it("takes Esc only outside fields, without modifiers, and while no dialog is open", () => {
    const esc = { key: "Escape", defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    const body = { tagName: "BODY", isContentEditable: false };
    expect(isStopKey(esc, body, false)).toBe(true);
    expect(isStopKey(esc, null, false)).toBe(true);
    expect(isStopKey({ ...esc, key: "Enter" }, body, false)).toBe(false);
    expect(isStopKey({ ...esc, shiftKey: true }, body, false)).toBe(false);
    // A popover that closed on this press took it.
    expect(isStopKey({ ...esc, defaultPrevented: true }, body, false)).toBe(false);
    for (const tagName of ["INPUT", "TEXTAREA", "SELECT"]) expect(isStopKey(esc, { tagName, isContentEditable: false }, false)).toBe(false);
    expect(isStopKey(esc, { tagName: "DIV", isContentEditable: true }, false)).toBe(false);
    expect(isStopKey(esc, body, true)).toBe(false);
  });

  it("posts the cancel once to the run's cancel route", async () => {
    const doFetch = vi.fn(async () => new Response(null, { status: 202 }));
    expect(await postCancel("run-invented-0001", doFetch as unknown as typeof fetch)).toBe(true);
    expect(doFetch).toHaveBeenCalledTimes(1);
    expect(doFetch).toHaveBeenCalledWith("/api/runs/run-invented-0001/cancel", { method: "POST" });
    expect(await postCancel("run-invented-0001", (async () => new Response(null, { status: 500 })) as unknown as typeof fetch)).toBe(false);
    expect(await postCancel("run-invented-0001", (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).toBe(false);
  });
});

describe("the live view's hand-over", () => {
  it("keeps the server's first paint until the stream has caught up with it", () => {
    const initial = stateOf(upTo(SAMPLE, "plan"));
    const early = stateOf(SAMPLE.slice(0, 3));
    const caughtUp = stateOf(upTo(SAMPLE, "plan"));
    const ahead = stateOf(upTo(SAMPLE, "pivot"));
    expect(handOver(initialRunState(initial.runId), initial)).toBe(initial);
    expect(handOver(early, initial)).toBe(initial);
    expect(handOver(caughtUp, initial)).toBe(caughtUp);
    expect(handOver(ahead, initial)).toBe(ahead);
  });
});

describe("a dataset not streamed inline", () => {
  afterEach(() => vi.restoreAllMocks());
  const envelope = Object.values(stateOf(SAMPLE).datasets).find((d) => d.data)?.data as DatasetEnvelope;

  it("waits for the run to be stored, then fetches it; a 404 before the ledger is written is not kept", async () => {
    expect(pendingNote("MatrixGrid", undefined, false)).toBe("MatrixGrid · drawn once the run is stored");
    expect(pendingNote("MatrixGrid", undefined, true)).toBe("MatrixGrid · loading its data");
    expect(pendingNote("MatrixGrid", null, true)).toBe("MatrixGrid · its data could not be loaded");

    const url = "/api/runs/run-invented-0001/datasets/D9";
    const doFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "Dataset not found." }), { status: 404 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope), { status: 200 }));
    expect(await loadDataset(url, doFetch)).toBeNull();
    // The failure was not kept: the next mount asks again and draws the figure.
    expect(await loadDataset(url, doFetch)).toEqual(envelope);
    // Once stored, the envelope never changes: no third request.
    expect(await loadDataset(url, doFetch)).toEqual(envelope);
    expect(doFetch).toHaveBeenCalledTimes(2);
  });

  it("does not keep a 503 or a body that is not an envelope", async () => {
    const url = "/api/runs/run-invented-0002/datasets/D1";
    const doFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ kind: "Nothing" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(envelope), { status: 200 }));
    expect(await loadDataset(url, doFetch)).toBeNull();
    expect(await loadDataset(url, doFetch)).toBeNull();
    expect(await loadDataset(url, doFetch)).toEqual(envelope);
  });
});

describe("sidenote text", () => {
  it("opens every sentence on a capital and leaves numbers alone", () => {
    expect(sentenceCase("Qloo /v2/insights · brand ← R1 Brand Alpha · 15 rows. taste-island test, vs peers.")).toBe(
      "Qloo /v2/insights · brand ← R1 Brand Alpha · 15 rows. Taste-island test, vs peers.",
    );
    expect(sentenceCase("similarity 0.70 to Brand Beta. hub score 0.13.")).toBe("Similarity 0.70 to Brand Beta. Hub score 0.13.");
  });

  it("prints the short note and trace, and keeps the long ones for the hover titles", () => {
    const note = {
      text: "Qloo /v2/insights · brand ← R1 Brand Alpha · 15 rows. hub score of Brand Alpha (mean within-row percentile), vs peers, computed in QUANT from 5 requests.",
      trace: "computed in code · QUANT · subs.hub",
      short: { text: "Hub score vs peers, from 5 Qloo requests.", trace: "computed in code · QUANT" },
    };
    expect(noteText(note)).toBe("Hub score vs peers, from 5 Qloo requests.");
    expect(noteTrace(note)).toBe("computed in code · QUANT");
    expect(noteTitles(note)).toEqual({ text: sentenceCase(note.text), trace: "computed in code · QUANT · subs.hub" });
    // A figure's codes worked out from a fetched dataset stand in for both.
    expect(noteText(note, "BA Brand Alpha · BB Brand Beta.")).toBe("BA Brand Alpha · BB Brand Beta.");
    expect(noteTitles(note, "BA Brand Alpha · BB Brand Beta.").text).toBe("BA Brand Alpha · BB Brand Beta.");
  });
});
