// Home (N01, N02, N17): the hero, the question box and its states, the suggestion list (a profile row for
// a typed name, never canned or example questions), the inline states and the how band. Invented names only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AskNotice } from "../../components/ask/ask-machine";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
}));

// "/" is now the landing for signed-out visitors (it reads the session on the server): Home is the view in the shell.
const { SiteShell } = await import("../../components/chrome/site-shell");
const { HomeView } = await import("../../components/home/home-view");
const Home = () => (
  <SiteShell header="home">
    <HomeView />
  </SiteShell>
);
const { AskNoticeView } = await import("../../components/home/ask-notice");
const { MAP_COVERAGE } = await import("../../components/home/home-view");
const { MAP_CITIES } = await import("../../components/home/map-coverage");
const { DAILY_CAP_TEXT } = await import("../../components/home/ask-notice");
const { understoodParts } = await import("../../components/home/understood-line");
const { QUESTION_PLACEHOLDER, QuestionBox, questionKeyAction, questionText } = await import("../../components/home/question-box");
const { SuggestionList, suggestionOptionId } = await import("../../components/home/suggestion-list");
const { looksLikeName, moveActive, PLACE_HINT, suggestionRows, suggestionsFor } = await import("../../components/home/suggestions");

const html = renderToStaticMarkup;
const noop = () => undefined;

describe("Home", () => {
  it("renders the statement and the question box in the home shell, with no help asides", () => {
    const out = html(<Home />);
    expect(out).toMatch(/<h1[^>]*>Ask what any audience really loves\.<\/h1>/);
    // Map coverage is one short line; the city list opens from it.
    expect(MAP_COVERAGE).toBe(`Neighbourhood maps: ${MAP_CITIES.length} US cities`);
    expect(out).toContain(MAP_COVERAGE);
    expect(out).toMatch(/aria-expanded="false"/);
    // No explainer rails or hints on a working screen.
    expect(out).not.toMatch(/How every answer is made|What answers cannot tell you|You see how we read your question/);
    // No limits, costs or time estimates on Home: they live on Settings > Plan & usage.
    expect(out).not.toMatch(/about a minute|\d+ of \d+|per day|quota|economy|\$\d/i);
    // The box is #ask, so "New question" from any page lands in it.
    const field = out.match(/<textarea[^>]*id="ask"[^>]*>/)?.[0] ?? "";
    expect(field).toContain('aria-autocomplete="list"');
    // ARIA allows role=combobox only on an input, so the textarea stays a textbox.
    expect(field).not.toContain("role=");
    expect(field).not.toContain("aria-expanded");
    expect(field).not.toContain("aria-controls");
    expect(out).toContain(`placeholder="${QUESTION_PLACEHOLDER}"`);
    expect(out).toMatch(/<form[^>]*data-state="idle"/);
    expect(out).toContain(">Get answer<");
    // The small label over the statement; the footer is there.
    expect(out).toContain(">New question</p>");
    expect(out).toContain("Not financial advice");
  });

  it("shows no examples anywhere: no ready answers, no Try chips, no showcase or recording links", () => {
    const out = html(<Home />);
    expect(out).not.toMatch(/example|showcase|ready answer|Try:|recording|replay/i);
    expect(out).not.toContain("/r/");
    expect(out).not.toContain("?replay=1");
    // Nothing is listed on the server: the visitor's recent answers load in the browser, only when there are some.
    expect(out).not.toMatch(/Recent briefs|Your answers<\/h2>/);
  });

  it("uses only the placeholder's general words, never a sample name", () => {
    expect(QUESTION_PLACEHOLDER).toBe("Type a question about a brand, artist, place or audience");
  });
});

describe("the question box", () => {
  it("reads Enter as asking and Shift+Enter as nothing, and keeps a question on one line", () => {
    expect(questionKeyAction({ key: "Enter", shiftKey: false })).toBe("submit");
    expect(questionKeyAction({ key: "Enter", shiftKey: true })).toBe("ignore");
    expect(questionKeyAction({ key: "Enter", shiftKey: false, isComposing: true })).toBeNull();
    expect(questionKeyAction({ key: "a", shiftKey: false })).toBeNull();
    expect(questionText("Who is\nthe Juniper Cola\r\naudience?")).toBe("Who is the Juniper Cola audience?");
  });

  it("greys the text and spins the button while reading", () => {
    const out = html(<QuestionBox id="q" value="Juniper Cola" onChange={noop} onSubmit={noop} state="loading" />);
    expect(out).toContain('data-state="loading"');
    expect(out).toMatch(/<textarea[^>]*readOnly=""/);
    expect(out).toContain("text-ink-2");
    expect(out).toMatch(/aria-busy="true"[^>]*>.*Reading…/);
    expect(html(<QuestionBox id="q" value="x" onChange={noop} onSubmit={noop} state="loading" loadingLabel="Starting…" />)).toContain(
      "Starting…",
    );
  });

  it("disables Get answer while live questions are paused", () => {
    const out = html(<QuestionBox id="q" value="Juniper Cola" onChange={noop} onSubmit={noop} state="paused" />);
    expect(out).toMatch(/<button type="submit" disabled=""/);
    expect(out).not.toMatch(/<textarea[^>]*readOnly/);
  });

  it("draws the focus ring for the gallery, and the follow-up pill with x", () => {
    expect(html(<QuestionBox id="q" value="" onChange={noop} onSubmit={noop} showFocus />)).toContain("ring-accent-soft");
    const follow = html(
      <QuestionBox id="q" value="" onChange={noop} onSubmit={noop} followUp={{ label: "Who is the Brand Beta audience?", onDrop: noop }} />,
    );
    expect(follow).toContain("Follow-up to: Who is the Brand Beta audience?");
    expect(follow).toContain('aria-label="Ask on its own"');
    expect(follow).toContain("corner-down-right");
  });

  it("wires the field to the list and its active row", () => {
    const out = html(
      <QuestionBox id="q" value="Juniper Cola" onChange={noop} onSubmit={noop} combobox={{ expanded: true, listId: "list", activeId: "list-profile-0" }} />,
    );
    expect(out).not.toContain('role="combobox"');
    expect(out).not.toContain("aria-expanded");
    expect(out).toContain('aria-controls="list"');
    expect(out).toContain('aria-activedescendant="list-profile-0"');
    expect(out).toContain('aria-autocomplete="list"');
  });
});

describe("suggestions", () => {
  it("opens only for text that reads as a name", () => {
    expect(looksLikeName("Juniper Cola")).toBe(true);
    expect(looksLikeName("J")).toBe(false);
    expect(looksLikeName("Juniper Cola?")).toBe(false);
    expect(looksLikeName("Who is the Juniper Cola audience")).toBe(false);
    expect(looksLikeName("is Juniper Cola big")).toBe(false);
    expect(looksLikeName("one two three four five")).toBe(false);
    expect(looksLikeName("Brand Alpha Beta Gamma")).toBe(true);
  });

  it("offers only the instant audience profile of the typed name: no canned or ready questions", () => {
    const groups = suggestionsFor("  Juniper   Cola ");
    expect(groups).toEqual([
      {
        key: "profile",
        label: "Profile",
        icon: "user-round",
        rows: [{ key: "profile-0", label: "Juniper Cola · audience profile", href: "/d/Juniper%20Cola", tag: "instant" }],
      },
    ]);
    expect(suggestionsFor("Who really competes with Juniper Cola?")).toEqual([]);
    expect(suggestionsFor("")).toEqual([]);
    expect(suggestionRows(groups)).toHaveLength(1);
  });

  it("walks the rows with the arrows, wrapping at both ends", () => {
    expect(moveActive(-1, 3, "ArrowDown")).toBe(0);
    expect(moveActive(2, 3, "ArrowDown")).toBe(0);
    expect(moveActive(0, 3, "ArrowUp")).toBe(2);
    expect(moveActive(-1, 3, "ArrowUp")).toBe(2);
    expect(moveActive(1, 3, "ArrowUp")).toBe(0);
    expect(moveActive(0, 0, "ArrowDown")).toBe(-1);
  });

  it("draws a listbox of grouped options, the active one selected, and the place hint", () => {
    const groups = suggestionsFor("Juniper Cola");
    const out = html(<SuggestionList id="list" groups={groups} activeKey="profile-0" onPick={noop} />);
    expect(out).toContain('role="listbox"');
    expect(out).toMatch(/role="group" aria-labelledby="list-profile-label"/);
    expect(out).toMatch(new RegExp(`id="${suggestionOptionId("list", "profile-0")}" role="option" aria-selected="true"`));
    expect(out).toContain("Instant");
    expect(PLACE_HINT).toBe("Place questions cover 13 US cities: Atlanta, Austin, Boston, Chicago, Dallas, Denver, Houston, Los Angeles, Miami, Nashville, New York City, San Francisco and Seattle.");
    expect(out).toContain(PLACE_HINT);
  });
});

describe("the inline states", () => {
  const view = (notice: AskNotice) => html(<AskNoticeView notice={notice} onReframe={noop} onRetry={noop} />);

  it("paused links to the visitor's own answers, not to examples", () => {
    const out = view({ kind: "paused", text: "New questions reopen at 8:00 pm your time. Answers you already have still open." });
    expect(out).toContain('data-notice="paused"');
    expect(out).toMatch(/href="\/briefs"[^>]*>.*Your answers/);
    expect(out).not.toMatch(/example|ready answers/i);
  });

  it("refused offers the reframe as a chip that asks it", () => {
    const out = view({ kind: "refused", text: "We don't answer political targeting questions. Try this instead:", reframe: "Who loves Riverside cafés?" });
    expect(out).toMatch(/<button type="button"[^>]*>.*Who loves Riverside cafés\?/);
    expect(view({ kind: "refused", text: "We don't give investment advice.", reframe: null })).not.toContain("<button");
  });

  it("needs input has no button; an error and a run that did not start try again", () => {
    expect(view({ kind: "needs_input", text: "Add a second brand to compare with Juniper Cola." })).not.toMatch(/<(button|a) /);
    expect(view({ kind: "error", text: "No connection.", retry: true })).toContain("Try again");
    expect(view({ kind: "error", text: "Bad request.", retry: false })).not.toContain("Try again");
    const failed = view({ kind: "run_failed", text: "Too many answers this hour." });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain('data-tone="danger"');
    expect(failed).toContain("Try again");
  });

  it("a used-up day shows one calm line and See plan, never the limit wording or Try again", () => {
    const out = view({ kind: "run_failed", text: "Today's limit for live runs is reached. Answers you already have still open." });
    expect(out).toContain(DAILY_CAP_TEXT.replace(/'/g, "&#x27;"));
    expect(out).toMatch(/href="\/settings"[^>]*>.*See plan/);
    expect(out).not.toContain("Try again");
    expect(view({ kind: "run_failed", text: "Today's budget for live analysis is used up. Live runs resume at 00:00 UTC." })).toContain('data-cap="daily"');
    expect(view({ kind: "run_failed", text: "The hourly limit for live runs is reached. Try again later." })).not.toContain(">Try again<");
  });
});

describe("the understood-as line", () => {
  it("names the desk, the matched names and the cities, and says when a typed name was read as another", () => {
    const parts = understoodParts({
      pillar: "marketing",
      job: "head_to_head",
      jobLabel: "Head to head",
      mnemonic: "<NAME> VS <NAME>",
      mentions: [
        { text: "JC", type: "brand", role: "primary", match: "inexact", name: "Juniper Cola" },
        { text: "Riverside Tea", type: "brand", role: "peer", match: "exact", name: "Riverside Tea" },
        { text: "Nowhere Brand", type: "brand", role: "peer", match: "not_found", name: null },
      ],
      metros: ["Denver"],
      scope: "",
      lens: "",
    } as never);
    expect(parts).toEqual({
      desk: "Head to head",
      names: ["Juniper Cola", "Riverside Tea"],
      metros: ["Denver"],
      swaps: [{ typed: "JC", read: "Juniper Cola" }],
    });
  });
});
