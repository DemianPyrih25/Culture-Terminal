// How a run can stop short of a brief: the picker (needs_input, D20), a refusal with a reframe, an
// INCOMPLETE evidence digest, a failure and a cancel. Each says why and what still shows.
import { describe, expect, it, vi } from "vitest";
import type { RunEvent, RunState } from "@ct/contracts";
import { pickCandidate, refusalRequestsLine } from "../../components/brief";
import { readRecentRunIds, rememberRun } from "../../lib/recent-briefs";
import { after, attrValues, endedAs, events, render, renderState, slice, stateOf, tagOf, text, upTo } from "./support";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: () => null }));

describe("needs_input: the picker", () => {
  const PICKER = events("needs-input");
  const { html, model } = render(PICKER);

  it("offers every candidate with its name, disambiguation and popularity, to pick from", () => {
    const terminal = model.terminal;
    if (terminal?.kind !== "needs_input") throw new Error("expected a picker");
    expect(attrValues(html, "data-candidate")).toEqual(terminal.candidates.map((c) => c.key));
    for (const c of terminal.candidates) {
      const row = text(slice(html, `data-candidate="${c.key}"`, "</button>"));
      expect(row).toContain(c.name);
      if (c.disambiguation) expect(row).toContain(c.disambiguation);
      if (c.popularity !== null) expect(row).toContain(c.popularity.toFixed(2).replace(/^0/, ""));
      expect(row).toContain("Pick");
    }
    // The run has ended, so the picks are live buttons.
    expect(tagOf(html, "data-candidate=")).not.toContain('disabled=""');
    expect(text(html)).toContain("Nothing was picked for you");
  });

  it("draws no conviction, evidence or risks for a run that never fetched them", () => {
    for (const id of ["conviction", "evidence", "risks"]) expect(html).not.toContain(`id="${id}"`);
    expect(html).toContain('id="sources"');
    // The run waits for the reader: its answer says so, not "run stopped".
    const kicker = text(slice(html, 'data-answer="stopped"', "</h2>"));
    expect(kicker).toContain("Waiting for your pick");
    expect(kicker).not.toContain("run stopped");
  });

  it("records the run a pick starts as the reader's own brief, then opens it", async () => {
    const stored = new Map<string, string>();
    const storage = { getItem: (k: string) => stored.get(k) ?? null, setItem: (k: string, v: string) => void stored.set(k, v) };
    const navigate = vi.fn();
    const start = vi.fn(async () => ({ ok: true as const, runId: "run-picked-0001" }));
    const outcome = await pickCandidate("run-asked-0001", "pk_invented_1", {
      start,
      remember: (id) => void rememberRun(id, storage),
      navigate,
      onRetry: vi.fn(),
    });
    expect(outcome).toEqual({ ok: true, runId: "run-picked-0001" });
    expect(start).toHaveBeenCalledWith({ pick: { runId: "run-asked-0001", key: "pk_invented_1" } }, expect.any(Function));
    expect(readRecentRunIds(storage)).toEqual(["run-picked-0001"]);
    expect(navigate).toHaveBeenCalledWith("/run/run-picked-0001");
  });

  it("neither records nor navigates when the pick is refused", async () => {
    const remember = vi.fn();
    const navigate = vi.fn();
    const outcome = await pickCandidate("run-asked-0001", "pk_invented_1", {
      start: async () => ({ ok: false, error: "That pick has expired." }),
      remember,
      navigate,
      onRetry: vi.fn(),
    });
    expect(outcome.ok).toBe(false);
    expect(remember).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("offers no substitute when the name was not found", () => {
    const state = stateOf(PICKER);
    const notFound: RunState = { ...state, needsInput: state.needsInput && { ...state.needsInput, reason: "not_found", candidates: [] } };
    const { html: markup } = renderState(notFound, after(PICKER));
    expect(attrValues(markup, "data-candidate")).toEqual([]);
    expect(text(markup)).toContain("Nothing was substituted");
    expect(text(markup)).toContain("Ask again with another name");
  });

  it("keeps the picks closed in a replay, and says so", () => {
    const state = stateOf(PICKER);
    const { html: markup } = renderState(state, after(PICKER), "replay");
    expect(tagOf(markup, "data-candidate=")).toContain('disabled=""');
    expect(text(slice(markup, 'data-picks="replay"', "</p>"))).toContain("Replay: the picks are closed here");
    expect(text(markup)).not.toContain("the picks open in a moment");
  });
});

describe("refused", () => {
  const base = events("needs-input");
  const clerk = base.find((e) => e.type === "clerk");
  if (clerk?.type !== "clerk") throw new Error("no clerk event");
  const reframe = "Which cultural interests set the Brand Alpha audience apart from its peers";
  const refusedClerk: RunEvent = { ...clerk, intent: { ...clerk.intent, safety: { allowed: false, category: "political_targeting", reframe } } };

  it("shows the reason and a reframe it can answer, with no request made", () => {
    const list = endedAs([base[0] as RunEvent, refusedClerk], "refused", "political targeting");
    const { html, model } = render(list);
    expect(model.terminal?.kind).toBe("refused");
    const card = text(slice(html, 'aria-label="Question refused"', "</section>"));
    expect(card).toContain("Not answered · Political targeting");
    expect(card).toContain("No Qloo request was made.");
    expect(card).not.toContain("nothing was spent");
    expect(text(slice(html, 'data-answer="', "</h2>"))).toContain("Question refused");
    expect(html).toContain(`href="/ask?${new URLSearchParams({ q: reframe }).toString()}"`);
    expect(html).not.toContain('id="evidence"');
  });

  it("counts the requests an ANALYST refusal made, and lists them in Sources", () => {
    const SAMPLE = events("brand-health");
    const list = endedAs(upTo(SAMPLE, "report.draft"), "refused", "financial advice");
    const { html, model } = render(list);
    expect(model.terminal?.kind).toBe("refused");
    const n = model.sources.items.length;
    expect(n).toBeGreaterThan(1);
    const card = text(slice(html, 'aria-label="Question refused"', "</section>"));
    expect(card).toContain(`${n} Qloo requests were made before the refusal; they are listed in Sources.`);
    expect(card).not.toContain("No Qloo request was made");
    expect(card).not.toContain("before any data was requested");
    expect(attrValues(html, "data-source").length).toBe(n);
    expect(refusalRequestsLine(1)).toBe("1 Qloo request was made before the refusal; it is listed in Sources.");
  });
});

describe("incomplete: the evidence digest", () => {
  const LIST = events("brand-health-incomplete");
  const { html, model } = render(LIST);

  it("marks the brief INCOMPLETE once and gives the reason once, and keeps the evidence it gathered", () => {
    const terminal = model.terminal;
    if (terminal?.kind !== "incomplete") throw new Error("expected an incomplete run");
    expect(attrValues(html, "data-marker").filter((m) => m === "INCOMPLETE")).toEqual(["INCOMPLETE"]);
    expect(text(slice(html, 'aria-label="Incomplete brief"', "</section>"))).toBe("INCOMPLETEEvidence digest");
    // The digest's thesis says why it stopped; nothing above the evidence says it again.
    const reason = terminal.reason ?? "missing";
    const answer = text(slice(html, 'id="answer"', 'id="conviction"'));
    expect(answer.split(reason).length - 1).toBe(1);
    expect(text(html)).toContain(model.answer.headline?.map((p) => (p.kind === "text" ? p.text : "")).join("") ?? "missing");
    expect(model.evidence.figures.length).toBeGreaterThan(0);
    expect(attrValues(html, "data-figure").length).toBe(model.evidence.figures.length);
    // No CHECKER read a digest: the trace note says so rather than claiming a pass.
    expect(html).toContain('data-trace="skipped"');
    expect(html).toContain('data-checker="skipped"');
  });
});

describe("failed and cancelled", () => {
  const SAMPLE = events("brand-health");

  it("says the run stopped, and what of the brief still shows", () => {
    const list = endedAs(upTo(SAMPLE, "plan"), "cancelled", "stopped by the reader");
    const { html, model } = render(list);
    expect(model.terminal?.kind).toBe("cancelled");
    const card = text(slice(html, 'aria-label="Run stopped"', "</section>"));
    expect(card).toContain("stopped before the brief was written");
    expect(card).toContain("What still shows: the priors as written");
    // Nothing still pretends to run: no meters, no Stop run, priors not scored, pending figures say so.
    expect(html).not.toContain('aria-label="This run"');
    expect(html).not.toContain("Stop run");
    expect(attrValues(html, "data-state").filter((s) => s === "not_scored").length).toBe(model.priors.items.length);
    expect(text(html)).toContain("not measured · run stopped");
    // The run has ended, so a figure that never came says why in full, not lighter as while it was written.
    const pendingFigure = slice(html, 'data-key-figure="pending"', "data-key-figure=");
    expect(pendingFigure).toContain("font-semibold");
    expect(pendingFigure).not.toContain("font-medium");
    expect(pendingFigure).not.toContain("text-faint");
  });

  it("lists the errors of a failed run", () => {
    const list = endedAs(upTo(SAMPLE, "plan"), "failed", "the model could not be reached");
    const { html, model } = render(list);
    expect(model.terminal?.kind).toBe("failed");
    expect(text(slice(html, 'aria-label="Run failed"', "</section>"))).toContain("The run failed: the model could not be reached.");
  });
});
