// The Ask composer (A02) in each state, rendered to markup from fixtures. Invented entities only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { arrowLeavesField, AskComposer } from "../../components/ask/ask-composer";
import type { AskState, PreviewResponse } from "../../components/ask/ask-machine";
import { askStatusText, compiledReading, type AskParent } from "../../components/ask/ask-panel";
import { ASK_GALLERY, FIXTURE_AT, FIXTURE_PARENT, FIXTURE_PREVIEW, FIXTURE_QUESTION } from "../../components/ask/fixtures";
import { questionKeyAction, questionText } from "../../components/ask/question-field";
import { parseCommand } from "../../lib/grammar/parse";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

/** The primary button's label, as Button renders it. */
const RUN_BUTTON = "<span>Run brief</span>";
const MOVE_HINT = "move</span>";

const entry = (name: string) => {
  const found = ASK_GALLERY.find((e) => e.name.startsWith(name));
  if (!found) throw new Error(`no gallery entry ${name}`);
  return found;
};

function render(state: AskState, draft: string, parent: AskParent | null = null, handlers = true): string {
  return renderToStaticMarkup(
    <AskComposer
      value={draft}
      onChange={() => undefined}
      onSubmit={() => undefined}
      state={state}
      compiled={parseCommand(draft)}
      parent={parent}
      onEdit={handlers ? () => undefined : undefined}
      onRun={() => undefined}
      onRetry={handlers ? () => undefined : undefined}
      onAsk={() => undefined}
      onDropParent={handlers ? () => undefined : undefined}
    />,
  );
}

const of = (name: string) => {
  const e = entry(name);
  return render(e.state, e.draft, e.parent ?? null);
};

const ready = (preview: PreviewResponse, question = FIXTURE_QUESTION): AskState => ({
  phase: { kind: "ready", question, preview, at: FIXTURE_AT },
  run: { kind: "idle" },
});

/** The section of the panel labelled `label`. */
function section(html: string, label: string): string {
  const match = html.match(new RegExp(`<section aria-label="${label}".*?</section>`));
  if (!match) throw new Error(`no section ${label}`);
  return match[0];
}

/** How often the panel shows `text`; the live region, which repeats the message to screen readers, aside. */
const count = (html: string, text: string) => html.replace(/<p role="status".*?<\/p>/, "").split(text).length - 1;

describe("AskComposer", () => {
  it("shows the field alone, with ↵ to ask, before there is a question", () => {
    const html = render({ phase: { kind: "idle" }, run: { kind: "idle" } }, "");
    expect(html).toContain('placeholder="Ask about a brand, an artist, a place or an audience"');
    expect(html).toContain("to ask");
    expect(html).not.toContain("<section");
    expect(html).toContain('role="status"');
    // The form is a plain GET to the Ask page with the question.
    expect(html).toMatch(/<form [^>]*action="\/ask" method="get"/);
    expect(html).toContain('name="q"');
  });

  it("wraps a long question in the field instead of cutting it off", () => {
    const long = "Juniper Cola vs Brand Beta: are they fighting for the same customer, and which metros does each win over the next year?";
    const html = render({ phase: { kind: "loading", question: long }, run: { kind: "idle" } }, long);
    // A textarea one line high that grows with its text, up to three lines (five on a phone), whole.
    expect(html).toMatch(/<textarea [^>]*name="q" rows="1"[^>]*class="[^"]*field-sizing-content[^"]*"[^>]*>/);
    expect(html).toMatch(/<textarea [^>]*class="[^"]*max-h-\[118px\][^"]*max-sm:max-h-\[158px\]/);
    expect(html).toContain(`>${long}</textarea>`);
    expect(html).not.toContain("<input");
    // Its placeholder and key hint in the readable grey.
    expect(html).toMatch(/<textarea [^>]*class="[^"]*placeholder:text-dim/);
    expect(html).toContain('<span class="text-[11px] text-dim">to clear</span>');
  });

  it("asks on Enter, holds Shift+Enter back and keeps a question one paragraph", () => {
    expect(questionKeyAction({ key: "Enter", shiftKey: false })).toBe("submit");
    expect(questionKeyAction({ key: "Enter", shiftKey: true })).toBe("ignore");
    // Enter that ends an IME composition is the composition's.
    expect(questionKeyAction({ key: "Enter", shiftKey: false, isComposing: true })).toBeNull();
    expect(questionKeyAction({ key: "a", shiftKey: false })).toBeNull();
    expect(questionKeyAction({ key: "Escape", shiftKey: false })).toBeNull();
    expect(questionText("Brand Alpha\nvs Brand Beta\r\nin Austin\r")).toBe("Brand Alpha vs Brand Beta in Austin ");
    expect(questionText("No breaks here")).toBe("No breaks here");
  });

  it("leaves the field for the panel with ↓ from the end of the text and ↑ from its start only", () => {
    expect(arrowLeavesField("ArrowDown", 0, 0, 0)).toBe(true);
    expect(arrowLeavesField("ArrowUp", 0, 0, 0)).toBe(true);
    expect(arrowLeavesField("ArrowDown", 40, 40, 40)).toBe(true);
    expect(arrowLeavesField("ArrowUp", 40, 40, 40)).toBe(false);
    expect(arrowLeavesField("ArrowUp", 0, 0, 40)).toBe(true);
    expect(arrowLeavesField("ArrowDown", 0, 0, 40)).toBe(false);
    // In the middle of a wrapped question the arrows move the caret between its lines.
    expect(arrowLeavesField("ArrowDown", 12, 12, 40)).toBe(false);
    expect(arrowLeavesField("ArrowUp", 12, 12, 40)).toBe(false);
    // A selection is the reader's: the arrows collapse it.
    expect(arrowLeavesField("ArrowDown", 0, 40, 40)).toBe(false);
  });

  it("loads quietly: a skeleton, no Run button", () => {
    const html = of("Loading");
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Reading the question and matching its names");
    expect(html).toContain("esc</kbd>");
    expect(html).not.toContain(RUN_BUTTON);
  });

  it("compiles a mnemonic at once, before the preview confirms it", () => {
    const html = of("Loading · a mnemonic");
    expect(html).toContain("Real competitors · JUNIPER COLA");
    expect(html).toContain("Compiled to <span");
    expect(html).toContain("JUNIPER COLA &lt;BRAND&gt; HLTH");
    expect(html).toContain("confirming");
  });

  it("reads back the understood question, the estimate and Run brief", () => {
    const html = of("Understood");
    const understood = section(html, "Understood as");
    expect(understood).toContain("Compare two brands");
    expect(understood).toContain("Juniper Cola, Brand Beta");
    expect(understood).toContain("US metros &amp; ages");
    expect(understood).toContain("Investment lens · both names matched exactly · vs US baseline");
    expect(understood).toContain(">Edit</button>");
    const estimate = section(html, "Estimated");
    expect(estimate).toContain("≈19 data requests · ~45 s");
    expect(estimate).toContain("≈7 served from cache · priors written before any data");
    expect(estimate).toContain("&lt;1% of today&#x27;s quota");
    expect(html).toContain(RUN_BUTTON);
    expect(html).toContain(MOVE_HINT);
    expect(html).toContain("edit reading");
    expect(html).not.toContain("You already have");
  });

  it("names the metros the question asks about, unless the scope already does", () => {
    const austin = { ...FIXTURE_PREVIEW.understood!, metros: ["Austin"] };
    expect(section(render(ready({ ...FIXTURE_PREVIEW, understood: austin }), FIXTURE_QUESTION), "Understood as")).toMatch(
      /US metros &amp; ages<\/span><span aria-hidden="true" class="text-faint">·<\/span><span>Austin<\/span>/,
    );
    const site = { ...austin, job: "site_selection" as const, jobLabel: "Where to open", mentions: [], scope: "Austin neighbourhoods" };
    expect(count(section(render(ready({ ...FIXTURE_PREVIEW, understood: site }), FIXTURE_QUESTION), "Understood as"), "Austin")).toBe(1);
  });

  it("offers the brief that already answers it, at no cost", () => {
    const html = of("You already have");
    const have = section(html, "You already have");
    expect(have).toContain('href="/run/run-fixture-a1b2"');
    expect(have).toContain("Open Brief RUNF");
    expect(have).toContain("Same snapshot · instant · $0");
    expect(have).toContain("2h ago");
    expect(have).toContain("Mixed signal");
    expect(have).toContain('aria-valuenow="71"');
    expect(html).toContain("open Brief RUNF");
    expect(html).toContain(RUN_BUTTON);
  });

  it("names a subject with more than one match, and still runs: the brief asks which one", () => {
    const html = of("A subject with more than one match");
    expect(section(html, "Understood as")).toContain("Junipr Cola (brand): more than one match, you will pick one");
    expect(section(html, "Understood as")).toContain("JUNIPR COLA VS BRAND BETA");
    expect(html).toContain(RUN_BUTTON);
  });

  it("says what a reading lacks instead of a placeholder, and offers no Run button until it is read again", () => {
    const one = of("Still needed: two brands to compare");
    expect(section(one, "Understood as")).toContain("Compare two brands");
    expect(section(one, "Understood as")).not.toContain("Compiled to");
    expect(one).not.toContain("&lt;B&gt;");
    expect(one).not.toContain("VS ");
    const needed = section(one, "Still needed");
    expect(needed).toContain(">A second brand to compare with Juniper Cola</p>");
    expect(needed).toContain("Name it in the question and press ↵ to read it again.");
    expect(one).not.toContain('aria-label="Estimated"');
    expect(one).not.toContain(RUN_BUTTON);
    expect(one).toContain(MOVE_HINT);
    expect(one).toContain("edit reading");
    expect(askStatusText(entry("Still needed: two brands").state, "Is Juniper Cola winning?")).toBe(
      "Understood as Compare two brands. Still needed: a second brand to compare with Juniper Cola.",
    );

    const unmatched = of("Still needed: the second name");
    expect(section(unmatched, "Understood as")).toContain("Brand Betta (brand): no exact match, left out");
    expect(section(unmatched, "Understood as")).not.toContain("Compiled to");
    expect(section(unmatched, "Still needed")).toContain("Check the spelling of Brand Betta, or name another brand, then press ↵.");
    expect(unmatched).not.toContain(RUN_BUTTON);

    const site = of("Still needed: where to open");
    expect(site).not.toContain("&lt;CITY&gt;");
    expect(section(site, "Still needed")).toContain(">A city, Nashville or Austin</p>");
    expect(site).not.toContain(RUN_BUTTON);
  });

  it("never prints a refusal's placeholder command", () => {
    const html = of("Refusal");
    expect(html).not.toContain("&lt;AREA&gt;");
    expect(html).not.toContain("Compiled to");
    expect(html).not.toContain("Still needed");
  });

  it("declines with the reason and a reframe, and offers no Run button", () => {
    const html = of("Refusal");
    const refusal = section(html, "Can&#x27;t answer");
    expect(refusal).toContain("Political targeting");
    expect(refusal).toContain("does not answer this kind of question");
    expect(refusal).toContain("Try instead:");
    expect(refusal).toContain("What is the group-level taste profile of the Riverside district for a new café?");
    expect(html).not.toContain(RUN_BUTTON);
  });

  it("says once why live analysis is off, that showcases and replays still work, and opens the brief it has", () => {
    const html = of("Paused (503): live");
    const service = section(html, "Live analysis");
    expect(service).toContain(">Today&#x27;s budget for live analysis is used up</p>");
    expect(service).toContain("Live runs resume at 00:00 UTC. Showcases and replays still work.");
    expect(count(html, "budget for live analysis is used up")).toBe(1);
    expect(html).not.toContain(RUN_BUTTON);
    expect(html).toMatch(/href="\/run\/run-fixture-a1b2"[^>]*>.*Open Brief RUNF/);
  });

  it("gives a paused panel with no brief to open a way out: the stored briefs", () => {
    const html = of("Paused (503), with no brief");
    expect(section(html, "Live analysis")).toContain(">Live analysis is unavailable: this server has no Anthropic API key</p>");
    expect(html).toMatch(/href="\/briefs"[^>]*>.*Browse the briefs/);
    expect(html).toContain(MOVE_HINT);
    expect(html).not.toContain(RUN_BUTTON);
  });

  it("keeps the compiled command when the preview cannot confirm it", () => {
    const html = render(
      { phase: { kind: "paused", question: "JUNIPER COLA HLTH", message: "Live analysis is paused.", alreadyHave: null, at: FIXTURE_AT }, run: { kind: "idle" } },
      "JUNIPER COLA HLTH",
    );
    expect(html).toContain("JUNIPER COLA &lt;BRAND&gt; HLTH");
    expect(html).not.toContain("confirming");
    expect(html).not.toContain("edit reading");
  });

  it("still runs when previews are capped, and says when they resume, once", () => {
    const html = of("Previews capped");
    const service = section(html, "Preview");
    expect(service).toContain(">Question previews are paused for a while</p>");
    expect(service).toContain("You can still run the brief. Previews resume in about 15 min.");
    expect(service).toContain("Showcases and replays still work");
    expect(count(html, "paused for a while")).toBe(1);
    expect(count(html, "still run")).toBe(1);
    expect(html).toContain(RUN_BUTTON);
  });

  it("shows an error once, with Try again", () => {
    const html = of("Error");
    const error = section(html, "Not read");
    expect(error).toContain(">The question could not be sent: the connection failed</p>");
    expect(count(html, "could not be")).toBe(1);
    expect(html).toContain("Try again");
    expect(html).not.toContain(RUN_BUTTON);
    // An error with nothing to try again offers no keys to move by.
    const stuck = render(
      { phase: { kind: "error", question: FIXTURE_QUESTION, message: "Invalid preview request.", retry: false }, run: { kind: "idle" } },
      FIXTURE_QUESTION,
    );
    expect(stuck).not.toContain(MOVE_HINT);
    expect(stuck).not.toContain("Try again");
  });

  it("shows the parent of a follow-up after the reading, so ⇥ reaches Edit first", () => {
    const html = of("Follow-up");
    const parent = section(html, "Following up on");
    expect(parent).toContain("Following up on: </span>Who really competes with Juniper Cola?");
    expect(parent).toContain('href="/run/run-fixture-c3d4"');
    expect(parent).toContain("the new brief can reuse its data");
    expect(parent).toContain("Ask on its own");
    expect(html.indexOf('aria-label="Understood as"')).toBeLessThan(html.indexOf('aria-label="Following up on"'));
    expect(html.indexOf(">Edit</button>")).toBeLessThan(html.indexOf('href="/run/run-fixture-c3d4"'));
    const alone = render({ phase: { kind: "idle" }, run: { kind: "idle" } }, "", { ...FIXTURE_PARENT, question: null });
    expect(section(alone, "Following up on")).toContain("Brief RUNF");
  });

  it("says when the parent cannot be followed up, and that the question runs on its own", () => {
    const html = of("Follow-up on a brief still being written");
    const parent = section(html, "Asked from");
    expect(parent).toContain("Asked from: </span>Who really competes with Juniper Cola?");
    expect(parent).toContain("is still being written: this question runs on its own.");
    expect(parent).not.toContain("Ask on its own");
    expect(html).not.toContain("Following up on");
    for (const [blocked, text] of [
      ["test_run", "is a test run"],
      ["no_note", "has no finished note"],
      ["unreadable", "could not be read"],
    ] as const) {
      expect(section(render(ready(FIXTURE_PREVIEW), FIXTURE_QUESTION, { ...FIXTURE_PARENT, blocked }), "Asked from")).toContain(text);
    }
  });

  it("waits for Enter when the field holds a question not yet read", () => {
    const html = of("Edited");
    const pending = section(html, "New question");
    expect(pending).toContain("Read a neighbourhood · BRAND BETA, AUSTIN");
    expect(pending).toContain("BRAND BETA, AUSTIN DNA");
    expect(html).toContain("read the question");
    expect(html).not.toContain(RUN_BUTTON);
    expect(html).not.toContain("Understood as");
  });

  it("says what the server says while the start waits, and why a run did not start", () => {
    const waiting = of("Starting");
    expect(waiting).toContain("<span>Starting…</span>");
    expect(waiting).toContain("Too many runs are active. Try again shortly.");
    expect(askStatusText(entry("Starting").state, FIXTURE_QUESTION)).toBe("Too many runs are active. Try again shortly.");
    const html = of("Run refused");
    expect(html).toContain('role="alert"');
    expect(html).toContain("Live analysis is paused. Recorded runs are still available.");
  });

  it("announces the reading politely", () => {
    const state = entry("Understood").state;
    expect(askStatusText(state, FIXTURE_QUESTION)).toBe("Understood as Compare two brands. ≈19 data requests · ~45 s.");
    expect(askStatusText(state, "Something else")).toBe("");
    expect(askStatusText(entry("Loading").state, FIXTURE_QUESTION)).toBe("Reading the question…");
    expect(askStatusText({ ...state, run: { kind: "starting", message: null } }, FIXTURE_QUESTION)).toBe("Starting the brief…");
  });

  it("reads a compiled command back in words", () => {
    expect(compiledReading(parseCommand("ramen counter SITE Nashville")!)).toBe("Where to open · ramen counter in Nashville");
    expect(compiledReading(parseCommand("Riverside, Austin TEN")!)).toBe("Best tenant for a space · Riverside, Austin");
    expect(compiledReading(parseCommand("Brand Alpha VS Brand Beta")!)).toBe("Compare two brands · Brand Alpha, Brand Beta");
  });
});
