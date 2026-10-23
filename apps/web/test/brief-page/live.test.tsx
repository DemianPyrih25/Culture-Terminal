// The brief being written (A03), from prefixes of the recorded brand-health sample: the progress line
// and stage strip, the "This run" meters and Stop run, incoming requests with their stamps, priors
// awaiting, pending key figures, the numbers-traced note, and the answer written last.
import { describe, expect, it, vi } from "vitest";
import { attrValues, events, render, renderState, slice, stateOf, text, upTo } from "./support";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: () => null }));

const SAMPLE = events("brand-health");

/** The first n events. */
const first = (n: number) => SAMPLE.slice(0, n);

/** Events through the nth Qloo call of a tool call. */
function upToCall(toolCallId: string, nth: number) {
  let seen = 0;
  const i = SAMPLE.findIndex((e) => e.type === "qloo" && e.toolCallId === toolCallId && ++seen === nth);
  if (i < 0) throw new Error(`no call ${nth} of ${toolCallId}`);
  return SAMPLE.slice(0, i + 1);
}

const SCAN = SAMPLE.find((e) => e.type === "tool.start" && e.phase === "scan");
const SCAN_ID = SCAN?.type === "tool.start" ? SCAN.toolCallId : "missing";

describe("a brief being written", () => {
  it("opens on the question with the answer written last and the CLERK reading", () => {
    const { html, model } = render(first(1));
    expect(model.mode).toBe("live");
    expect(text(slice(html, "<h1", "</h1>"))).toBe(model.header.question);
    expect(text(slice(html, 'data-answer="pending"', "</p>"))).toContain("Written last, after the check");
    expect(text(slice(html, 'data-progress="', "</div>"))).toContain("Reading the question");
    expect(html).toContain('data-stage="clerk" data-state="active"');
  });

  it("shows the progress line, the stage strip and the timer while evidence arrives", () => {
    const { html, model } = render(upToCall(SCAN_ID, 3));
    const live = model.live;
    expect(live).not.toBeNull();
    const progress = text(slice(html, 'data-progress="', 'aria-label="Who is working"'));
    expect(progress).toContain(live?.progress.label ?? "missing");
    expect(progress).toContain(live?.progress.count ?? "missing");
    expect(progress).toContain(live?.progress.clock ?? "missing");
    expect(html).toContain(`aria-valuenow="${Math.round((live?.progress.fraction ?? 0) * 100)}"`);
    for (const s of live?.stages ?? []) expect(html).toContain(`data-stage="${s.role}" data-state="${s.state}"`);
    // The polite live region names the stage, never the ticking clock.
    const region = text(slice(html, 'aria-live="polite" aria-atomic="true"', "</p>"));
    expect(region).toBe(`${live?.progress.label}.`);
    expect(region).not.toContain(live?.progress.clock ?? "missing");
  });

  it("meters this run and offers Stop run with Esc", () => {
    const { html, model } = render(upToCall(SCAN_ID, 3));
    const meters = text(slice(html, 'aria-label="This run"', "</section>"));
    expect(meters).toContain("This run");
    // The cap counts network calls only, so the meter says so; the status line counts every request.
    expect(meters).toContain(`Live calls${model.live?.meters.requests.text}`);
    for (const m of [model.live?.meters.cost, model.live?.meters.time]) {
      expect(meters).toContain(m?.label ?? "missing");
      expect(meters).toContain(m?.text ?? "missing");
    }
    expect(meters).toContain("Stop run");
    expect(meters).toContain("Esc");
    expect(html).toContain('aria-keyshortcuts="Escape"');
  });

  it("lists the requests in flight and the ones that landed, with their stamps", () => {
    const { html, model } = render(upToCall(SCAN_ID, 3));
    const incoming = model.live?.incoming ?? [];
    expect(attrValues(html, "data-incoming")).toEqual(incoming.map((r) => r.state));
    expect(attrValues(html, "data-incoming")).toContain("fetching");
    expect(attrValues(html, "data-incoming")).toContain("received");
    expect(text(html)).toContain("fetching · ");
    // Only the call in flight carries the arrow; the ones that landed are complete.
    for (const row of html.split("data-incoming=").slice(1)) {
      expect(row.startsWith('"fetching"'), row.slice(0, 160)).toBe(row.slice(0, row.indexOf("</span>")).includes("↓"));
    }
    expect(text(html)).not.toContain("receiving");
    // Landed calls carry CACHE, REUSED or LIVE.
    const stamps = attrValues(slice(html, 'data-incoming="', 'id="conviction"'), "data-stamp");
    expect(stamps.length).toBeGreaterThan(0);
    for (const s of stamps) expect(["CACHE", "REUSED", "LIVE", "STALE"]).toContain(s);
  });

  it("holds the priors from the plan awaiting data, with when they were locked", () => {
    const { html, model } = render(upTo(SAMPLE, "plan"));
    expect(model.priors.items.length).toBeGreaterThan(0);
    for (const p of model.priors.items) {
      const row = text(slice(html, `data-prior="${p.id}"`, "data-prior="));
      expect(row).toContain(p.expected);
      expect(row).toContain("AWAITING DATA");
      expect(row).toContain(p.progress ?? "missing");
    }
    expect(text(html)).toContain(`Locked at ${model.priors.lockedAt}`);
  });

  it("fills key figures as they arrive and keeps the rest pending, numbering notes as they come", () => {
    const { html, model } = render(upTo(SAMPLE, "plan"));
    const ready = model.evidence.keyFigures.filter((k) => k.state === "ready");
    const pending = model.evidence.keyFigures.filter((k) => k.state === "pending");
    expect(ready.length).toBeGreaterThan(0);
    expect(pending.length).toBeGreaterThan(0);
    expect(attrValues(html, "data-key-figure").filter((v) => v === "pending").length).toBe(pending.length);
    for (const k of pending) expect(text(html)).toContain(k.pendingNote ?? "missing");
    // A figure still to come reads lighter while the run is written (A03): by weight, never a colour
    // too faint to read.
    const pendingFigure = slice(html, 'data-key-figure="pending"', "data-key-figure=");
    expect(pendingFigure).toContain("font-medium");
    expect(pendingFigure).not.toContain("text-faint");
    // Arrived figures already open their requests, and their notes sit in the margin.
    for (const k of ready) {
      expect(html).toContain(`data-footnote="${k.footnote}"`);
      expect(html).toContain(`data-sidenote="${k.footnote}"`);
    }
  });

  it("says the numbers are traced after the check, then how many the draft cites while the CHECKER runs", () => {
    const { html, model } = render(upTo(SAMPLE, "plan"));
    expect(model.trace.state).toBe("pending");
    expect(model.trace.headline).toBe("Numbers traced after the check");
    expect(text(slice(html, 'data-trace="pending"', "</div>"))).toContain(model.trace.headline);
    const checking = render(upTo(SAMPLE, "report.draft"));
    expect(checking.model.trace.headline).toMatch(/^0 of ~\d+ numbers traced$/);
    expect(text(slice(checking.html, 'data-trace="checking"', "</div>"))).toContain(checking.model.trace.headline);
  });

  it("dims the sections not written yet in the outline and draws none of them", () => {
    const { html } = render(upTo(SAMPLE, "plan"));
    for (const id of ["risks", "method", "sources"]) expect(html).not.toContain(`id="${id}"`);
    expect(html).toContain("(not written yet)");
    // No follow-up bar or replay while the brief is written.
    expect(html).not.toContain('aria-label="Follow up"');
    expect(html).not.toContain("data-replay-link");
  });

  it("checks the draft before the answer is written", () => {
    const { html, model } = render(upTo(SAMPLE, "report.draft"));
    expect(model.live?.progress.label).toBe("Checking every number");
    expect(html).toContain('data-stage="checker" data-state="active"');
    expect(html).toContain('data-answer="pending"');
  });

  it("sets the answer's numbered notes beside it once written, and stops offering Stop run before run.end", () => {
    const list = upTo(SAMPLE, "report.final");
    const { html, model } = render(list);
    expect(model.live).not.toBeNull();
    expect(model.answer.state).toBe("final");
    expect(html).not.toContain("data-incoming=");
    const answerNotes = attrValues(slice(html, 'id="answer"', 'id="conviction"'), "data-sidenote").map(Number);
    expect(answerNotes.length).toBeGreaterThan(0);
    expect(answerNotes[0]).toBe(1);
    expect(html).not.toContain("Stop run");
    expect(html).not.toContain('aria-keyshortcuts="Escape"');
  });

  it("becomes the finished brief in place when the report lands", () => {
    const state = stateOf(SAMPLE);
    const { html, model } = renderState(state, Date.parse(state.createdAt ?? "") + 60_000, "live");
    expect(model.live).toBeNull();
    expect(html).toContain('data-answer="final"');
    expect(html).not.toContain('aria-label="This run"');
    expect(html).not.toContain("Stop run");
  });

  it("tells the reader when the stream drops", () => {
    const list = upToCall(SCAN_ID, 3);
    const state = stateOf(list);
    const { html } = renderState(state, Date.parse(list.at(-1)?.ts ?? "") + 1000, "live", { connection: "reconnecting" });
    expect(text(html)).toContain("Reconnecting…");
  });
});
