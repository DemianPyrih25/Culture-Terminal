// The working view (N03, N04) and the end states in its slot (N16), as the server's first paint prints
// them: the page head with Stop, the progress card, the guesses, the draft numbers, the which-one card,
// and the cards of a run that ended early. The sample runs are invented (D29).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { RunEvent } from "@ct/contracts";
import { WorkingView, type WorkingViewProps } from "../../components/working";
import { DRAFT_CHART_TITLE, draftChartTitle } from "../../components/working/draft-chart";
import { after, attrValues, before, endedAs, events, modelOf, slice, text, upTo } from "./support";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));

const SAMPLE = events("brand-health");
const PICK = events("needs-input");

function render(list: readonly RunEvent[], extra: Partial<WorkingViewProps> = {}): string {
  const { state, model } = modelOf(list);
  const first = list[0];
  const elapsedMs = first ? after(list) - Date.parse(first.ts) : 0;
  return renderToStaticMarkup(
    <WorkingView runId={state.runId} model={model} state={state} mode={state.ended ? "static" : "live"} elapsedMs={elapsedMs} {...extra} />,
  );
}

describe("early: the progress card", () => {
  it("shows a tile skeleton and the question before CLERK has read it", () => {
    const html = render(upTo(SAMPLE, "run.created"));
    expect(html).toContain('data-header="working"');
    expect(html).toMatch(/<h1[^>]*>Is the Juniper Cola audience a moat or a niche\?<\/h1>/);
    expect(text(slice(html, "data-status-title", "</h2>"))).toBe("Reading your question");
    expect(html).not.toContain("Brands &amp; investing");
  });

  it("names the topic and job, offers Stop, and spells out the steps and the time", () => {
    const html = render(upTo(SAMPLE, "tool.start"));
    expect(text(html)).toContain("Brands & investing · Real competitors");
    expect(html).toContain('data-stop="idle"');
    expect(html).toContain('aria-keyshortcuts="Escape"');
    expect(text(slice(html, "data-status-title", "</h2>"))).toBe("Comparing audiences");
    // The elapsed clock alone: no lane estimate on the working view.
    expect(text(slice(html, "data-time", "</p>"))).toMatch(/^\d:\d\d$/);
    expect(attrValues(html, "data-step")).toEqual(["read", "find", "pull", "write", "check"]);
    expect(attrValues(html, "data-state").slice(0, 5)).toEqual(["done", "done", "active", "pending", "pending"]);
    expect(html).toMatch(/role="progressbar"[^>]*aria-valuenow="\d+"/);
    expect(text(slice(html, "data-reading-as", "</p>"))).toBe("Reading it as: Real competitors · Juniper Cola");
    expect(html).toContain(`href="/ask?q=${encodeURIComponent("Is the Juniper Cola audience a moat or a niche?").replace(/%20/g, "+")}"`);
    // The polite region says the step, never the ticking time.
    expect(html).toMatch(/role="status" aria-live="polite" class="sr-only">Pulling taste data</);
  });

  it("lists the guesses full width before any number arrives, waiting for data", () => {
    const html = render(upTo(SAMPLE, "plan"));
    expect(html).toContain('data-guesses="full"');
    expect(text(html)).toContain("Before looking at the data, we guessed");
    expect(attrValues(html, "data-guess").every((g) => g === "waiting" || g === "data-in")).toBe(true);
    expect(text(html)).not.toContain("We expected:");
  });
});

describe("late: draft numbers and the noticed line", () => {
  const late = before(SAMPLE, "validation");

  it("says what it noticed and checks every number", () => {
    const html = render(late);
    expect(text(slice(html, "data-status-title", "</h2>"))).toBe("Checking every number");
    expect(text(slice(html, "data-noticed", "</p>"))).toMatch(/^Noticed: Granite Outfitters .*Looking closer\.$/);
  });

  it("shows the key numbers as drafts, with no Source, beside the side guesses", () => {
    const html = render(late, {
      keyNumbers: [
        { value: "0.84 match", label: "Closest audience", context: "Granite Outfitters · 1.00 = identical" },
        { value: "#2 of 6", label: "Most distinctive fans" },
        { variant: "word", value: "Leans older", label: "Age lean" },
      ],
      chart: <section data-test-chart="true">chart</section>,
    });
    expect(html).toContain('data-key-numbers="draft"');
    expect(html.split('data-draft="true"').length - 1).toBe(3);
    expect(html).not.toContain("Source of");
    expect(html).toContain('data-test-chart="true"');
    expect(html).toContain('data-guesses="side"');
    expect(text(html)).toContain("We guessed, then checked");
  });

  it("tells the reader when the live stream is lost", () => {
    const html = render(upTo(SAMPLE, "tool.start"), { connectionLost: true });
    expect(text(slice(html, 'data-state-card="reconnecting"'))).toContain("Live updates stopped. Reload to catch up. Reload");
  });
});

describe("a run that ended early: its card takes the progress card's slot", () => {
  it("stopped: one line and Run it again, with no Stop left", () => {
    const html = render(endedAs(upTo(SAMPLE, "tool.start"), "cancelled", "stopped by the reader"));
    expect(html).not.toContain("data-progress-card");
    expect(html).not.toContain("data-stop=");
    expect(text(slice(html, 'data-state-card="cancelled"', "</section>"))).toBe(
      "You stopped this answer. Run it again",
    );
  });

  it("failed: the line, Try again and the reason under Details", () => {
    const html = render(endedAs(upTo(SAMPLE, "tool.start"), "failed", "the model did not answer"));
    const card = slice(html, 'data-state-card="failed"', "</section>");
    expect(text(card)).toContain("This answer couldn't be finished. Try again Details");
    expect(card).toContain('aria-expanded="false"');
    expect(card).toMatch(/aria-hidden="true"[^>]*>.*the model did not answer/);
  });

  it("failed after numbers arrived: the compact line", () => {
    const html = render(endedAs(upTo(SAMPLE, "plan"), "failed", null), { keyNumbers: [{ value: "0.84", label: "Closest audience" }] });
    expect(text(slice(html, 'data-state-card="failed"'))).toContain("This answer couldn't be finished.");
    expect(html).toContain('data-tone="danger"');
    // The guesses that were waiting say the run stopped before the check.
    expect(text(html)).toContain("The run stopped before the check.");
  });

  it("partial without a report: the partial card", () => {
    const html = render(endedAs(upTo(SAMPLE, "tool.start"), "incomplete", "hard limit"));
    expect(text(slice(html, 'data-state-card="incomplete"', "</section>"))).toBe(
      "Partial answer Ran out of time before concluding. Not checked. Try again",
    );
  });

  it("refused: what we don't answer, and a question we can", () => {
    const list = upTo(SAMPLE, "clerk").map((e) =>
      e.type === "clerk"
        ? { ...e, intent: { ...e.intent, safety: { allowed: false, category: "political_targeting" as const, reframe: "Which artists do outdoor-brand fans love?" } } }
        : e,
    );
    const html = render(endedAs(list, "refused", null));
    const card = slice(html, 'data-state-card="refused"', "</section>");
    expect(text(card)).toBe("We don't answer political targeting questions. Try this instead: Which artists do outdoor-brand fans love?");
    expect(card).toContain(`href="/ask?q=Which+artists+do+outdoor-brand+fans+love%3F"`);
    // The offered question wraps on a phone instead of being cut.
    expect(card).toMatch(/<a(?=[^>]*data-reframe)(?=[^>]*whitespace-normal!)[^>]*>/);
  });
});

describe("needs input", () => {
  it("asks which one, with each candidate's detail and reach, open to pick once the run ended", () => {
    const html = render(PICK);
    const card = slice(html, 'data-state-card="pick"');
    expect(text(card)).toContain('"Twinleaf Cola" could mean a few things. Which one?');
    expect(attrValues(card, "data-candidate").length).toBeGreaterThan(1);
    expect(text(card)).toMatch(/Twinleaf Cola 2004 Less known/);
    expect(text(card)).toMatch(/Twinleaf Cola 2019 Widely known/);
    expect(text(card)).toContain("Not listed? Edit question");
    expect(card).not.toMatch(/<button[^>]*disabled=""/);
  });

  it("keeps the picks closed in a replay", () => {
    const html = render(PICK, { mode: "replay" });
    expect(html).toContain('data-tag="recording"');
    expect(slice(html, "data-candidate")).toMatch(/^<button[^>]*disabled=""/);
  });

  it("says a name that is not in Qloo's data, and offers Edit question", () => {
    const notFound = PICK.map((e) => (e.type === "needs_input" ? { ...e, reason: "not_found" as const, candidates: [] } : e));
    const html = render(notFound);
    const card = slice(html, 'data-state-card="not_found"');
    expect(text(card)).toContain(`"Twinleaf Cola" isn't in Qloo's data. Check the spelling or use the full name.`);
    expect(text(card)).toContain("Edit question");
  });
});

describe("a replay", () => {
  it("is marked Recording, with play or pause and 1× or 4×, and never offers Stop or Edit question", () => {
    const html = render(upTo(SAMPLE, "tool.start"), {
      mode: "replay",
      replay: { playing: true, done: false, speed: 4, onPlay: () => undefined, onPause: () => undefined, onSpeed: () => undefined, positionMs: 12_000, durationMs: 26_000, progress: 0.4 },
    });
    expect(text(html)).toContain("Recording");
    expect(html).toContain('aria-label="Pause the recording"');
    expect(html).toMatch(/role="radiogroup" aria-label="Speed"/);
    expect(attrValues(slice(html, 'aria-label="Speed"', "</div>"), "aria-checked")).toEqual(["false", "true"]);
    expect(text(slice(html, "data-time", "</p>"))).toBe("Recording · 0:12 of 0:26");
    expect(html).not.toContain("data-stop=");
    expect(html).not.toContain("Edit question");
    expect(html).toContain('data-progress-card="replay"');
  });
});

describe("the draft chart's title", () => {
  it("is a plain line until the answer is drafted, then the drafted exhibit's own title", () => {
    expect(draftChartTitle({ datasetId: "D1" }, null)).toBe(DRAFT_CHART_TITLE);
    expect(draftChartTitle({ datasetId: "D1" }, { exhibits: [{ dataset_id: "D2", title: "Another chart", caption: "" }] })).toBe(DRAFT_CHART_TITLE);
    expect(draftChartTitle({ datasetId: "D1" }, { exhibits: [{ dataset_id: "D1", title: "Its closest audience is a tonic brand", caption: "" }] })).toBe(
      "Its closest audience is a tonic brand",
    );
  });
});
