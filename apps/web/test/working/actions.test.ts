// What the working view does, without a DOM: Stop in one press (and Esc), picking a candidate, starting the
// same question again, the reach words, and the guesses scored from the brief's priors.
import { describe, expect, it, vi } from "vitest";
import { guessOf, isStopKey, pickCandidate, postCancel, reachWord, runAgain, stopPress, type StopPhase } from "../../components/working";
import type { BriefPrior } from "../../lib/brief";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));

describe("Stop", () => {
  it("sends on the first press and never twice; a failure lets the reader press again", () => {
    expect(stopPress("idle")).toEqual({ phase: "sending", send: true });
    for (const phase of ["sending", "sent"] as StopPhase[]) expect(stopPress(phase)).toEqual({ phase, send: false });
    expect(stopPress("failed")).toEqual({ phase: "sending", send: true });
  });

  it("takes Esc only outside fields, without modifiers, and while no dialog is open", () => {
    const key = { key: "Escape", defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    const body = { tagName: "BODY", isContentEditable: false };
    expect(isStopKey(key, body, false)).toBe(true);
    expect(isStopKey({ ...key, key: "Enter" }, body, false)).toBe(false);
    expect(isStopKey({ ...key, shiftKey: true }, body, false)).toBe(false);
    expect(isStopKey({ ...key, defaultPrevented: true }, body, false)).toBe(false);
    expect(isStopKey(key, { tagName: "INPUT", isContentEditable: false }, false)).toBe(false);
    expect(isStopKey(key, { tagName: "DIV", isContentEditable: true }, false)).toBe(false);
    expect(isStopKey(key, body, true)).toBe(false);
  });

  it("posts the cancel to the run's cancel route, and says whether the server took it", async () => {
    const doFetch = vi.fn(async () => new Response(null, { status: 202 }));
    expect(await postCancel("run a/1", doFetch as unknown as typeof fetch)).toBe(true);
    expect(doFetch).toHaveBeenCalledWith("/api/runs/run%20a%2F1/cancel", { method: "POST" });
    expect(await postCancel("r", (async () => new Response(null, { status: 409 })) as unknown as typeof fetch)).toBe(false);
    expect(await postCancel("r", (async () => Promise.reject(new Error("offline"))) as unknown as typeof fetch)).toBe(false);
  });
});

describe("picking a candidate", () => {
  it("records the new run as the reader's own, then opens it", async () => {
    const remember = vi.fn();
    const navigate = vi.fn();
    const start = vi.fn(async () => ({ ok: true as const, runId: "run-new" }));
    const outcome = await pickCandidate("run-old", "pk_one", { start, remember, navigate, onRetry: vi.fn() });
    expect(outcome).toEqual({ ok: true, runId: "run-new" });
    expect(start).toHaveBeenCalledWith({ pick: { runId: "run-old", key: "pk_one" } }, expect.any(Function));
    expect(remember).toHaveBeenCalledWith("run-new");
    expect(navigate).toHaveBeenCalledWith("/run/run-new");
  });

  it("neither records nor navigates when the pick is refused", async () => {
    const remember = vi.fn();
    const navigate = vi.fn();
    const outcome = await pickCandidate("run-old", "pk_one", { start: async () => ({ ok: false, error: "Try again." }), remember, navigate, onRetry: vi.fn() });
    expect(outcome).toEqual({ ok: false, error: "Try again." });
    expect(remember).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("calls a popularity of 0.5 or more widely known", () => {
    expect(reachWord(0.5)).toBe("Widely known");
    expect(reachWord(0.49)).toBe("Less known");
    expect(reachWord(null)).toBeNull();
  });
});

describe("running the question again", () => {
  it("starts the same question, records it and opens it", async () => {
    const start = vi.fn(async () => ({ ok: true as const, runId: "run-2" }));
    const remember = vi.fn();
    const navigate = vi.fn();
    await runAgain("Who rivals Juniper Cola?", { start, remember, navigate });
    expect(start).toHaveBeenCalledWith({ question: "Who rivals Juniper Cola?" });
    expect(remember).toHaveBeenCalledWith("run-2");
    expect(navigate).toHaveBeenCalledWith("/run/run-2");
  });

  it("stays put when the server says no", async () => {
    const navigate = vi.fn();
    const outcome = await runAgain("q", { start: async () => ({ ok: false, error: "Paused" }), remember: vi.fn(), navigate });
    expect(outcome.ok).toBe(false);
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe("guesses from the brief's priors", () => {
  const prior = (over: Partial<BriefPrior>): BriefPrior => ({
    id: "H1",
    expected: "We expected: Its fans skew under 35.",
    expectation: "",
    testTool: "audience_dna",
    state: "awaiting_data",
    mark: "",
    word: "",
    measured: null,
    progress: null,
    ...over,
  });

  it("drops the brief's prefix and maps each state to its word", () => {
    expect(guessOf(prior({}))).toEqual({ id: "H1", state: "waiting", statement: "Its fans skew under 35.", note: null });
    expect(guessOf(prior({ state: "awaiting_check" })).state).toBe("data-in");
    expect(guessOf(prior({ state: "confirmed" })).state).toBe("expected");
    expect(guessOf(prior({ state: "inconclusive" })).state).toBe("cant-tell");
  });

  it("keeps Measured on a surprise, and says why a guess was not scored", () => {
    const measured = [
      { kind: "text" as const, text: "Measured: " },
      { kind: "text" as const, text: "fans lean 35–54." },
    ];
    expect(guessOf(prior({ state: "refuted", measured })).note).toBe("Measured: fans lean 35–54.");
    expect(guessOf(prior({ state: "confirmed", measured })).note).toBe("Fans lean 35–54.");
    expect(guessOf(prior({ state: "not_scored" }))).toMatchObject({ state: "cant-tell", note: "The run stopped before the check." });
  });
});

describe("the live view's hand-over", () => {
  it("keeps the server's first paint until the stream has caught up with it", async () => {
    const { handOver } = await import("../../components/working");
    const { events, stateOf, upTo } = await import("./support");
    const sample = events("brand-health");
    const initial = stateOf(upTo(sample, "plan"));
    const early = stateOf(sample.slice(0, 3));
    const caughtUp = stateOf(upTo(sample, "plan"));
    const ahead = stateOf(upTo(sample, "pivot"));
    expect(handOver(stateOf([]), initial)).toBe(initial);
    expect(handOver(early, initial)).toBe(initial);
    expect(handOver(caughtUp, initial)).toBe(caughtUp);
    expect(handOver(ahead, initial)).toBe(ahead);
  });
});
