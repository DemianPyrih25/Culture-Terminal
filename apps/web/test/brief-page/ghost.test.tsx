// LLM alone vs Culture Terminal (SPEC §6.6): GHOST's answer beside the brief, from the invented GHOST
// samples of the /dev/brief viewer (D29). Every status with its mark and its word, the honesty line
// whenever the section prints, no section at all without a GHOST, and lists and headings a screen
// reader can walk.
import { describe, expect, it, vi } from "vitest";
import { GHOST_HONESTY_LINE, RunEvent, type GhostAnswer, type GhostDiff } from "@ct/contracts";
import { GHOST_SAMPLES, ghostRunEvents, withGhost } from "../../app/dev/brief/ghost-runs";
import { jobRunEvents } from "../../app/dev/brief/job-runs";
import { GhostCategoryBlock, GhostFigures } from "../../components/brief/ghost";
import { buildGhostView, ghostOf, markClaims, type GhostRun } from "../../lib/brief";
import { render as renderMarkup } from "../figures/markup";
import { after, attrValues, endedAs, events, render, renderState, slice, stateOf, tagOf, text, upTo } from "./support";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/routes", () => ({ ROUTE_LIVE: { method: true, following: false } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: () => <input /> }));

const NO_PICKS: GhostAnswer["picks"] = { competitors: [], markets: [], neighbourhoods: [], tenants: [], partners: [] };

function ghostRun(answer: Partial<GhostAnswer> = {}, diff: Partial<GhostDiff> = {}): GhostRun {
  return {
    answer: { headline: "Invented headline.", picks: NO_PICKS, numeric_claims: [], ...answer },
    diff: {
      items: [],
      overlapAt5: null,
      resolvability: null,
      unsourcedNumericClaims: 0,
      meanPopularity: { ghost: null, qloo: null },
      honestyLine: GHOST_HONESTY_LINE,
      ...diff,
    },
  };
}

const sponsorship = render(ghostRunEvents("sponsorship") ?? []);
const brandHealth = render(ghostRunEvents("brand_health") ?? []);
/** The section's markup: its head up to Method's. */
const section = (html: string) => slice(html, 'id="ghost"', 'id="method"');

describe("the GHOST view", () => {
  it("is null without a GHOST, and reads the event's before the report's", () => {
    expect(buildGhostView(null)).toBeNull();
    const fromEvent = ghostRun({ headline: "From the event." });
    const fromReport = ghostRun({ headline: "From the report." });
    expect(ghostOf({ ghost: fromEvent, report: { ghost: fromReport } })).toBe(fromEvent);
    expect(ghostOf({ ghost: null, report: { ghost: fromReport } })).toBe(fromReport);
    expect(ghostOf({})).toBeNull();
  });

  it("marks every name ✓ both, ★ found only by Qloo or ✗ LLM only, with whether an LLM-only name resolves", () => {
    const view = buildGhostView(GHOST_SAMPLES.sponsorship ?? null);
    const partners = view?.categories.find((c) => c.category === "partners");
    expect(view?.categories.map((c) => c.category)).toEqual(["partners"]);
    // GHOST's column in its own order; the brief's in the diff's.
    expect(partners?.ghost.map((n) => [n.name, n.mark, n.word, n.resolvesText])).toEqual([
      ["Voltline Energy", "✓", "Found by both", null],
      ["Granite Peak Light", "✗", "LLM only", "resolves in Qloo: yes"],
      ["Mesa Line Trucks", "✓", "Found by both", null],
      ["Bluebonnet Boot Co.", "✗", "LLM only", "resolves in Qloo: no"],
      ["Summit Rush Cola", "✗", "LLM only", "resolves in Qloo: yes"],
    ]);
    expect(partners?.qloo.map((n) => [n.name, n.mark])).toEqual([
      ["Harrow Pale Lager", "★"],
      ["Cinder Hollow Rye", "★"],
      ["Mesa Line Trucks", "✓"],
      ["Lantern & Loom", "★"],
      ["Ridgeway Outdoor", "★"],
      ["Voltline Energy", "✓"],
    ]);
    expect(partners?.qloo.every((n) => n.resolves === null && n.resolvesText === null)).toBe(true);
    expect(partners?.tally).toBe("2 both · 4 only Qloo · 3 LLM only");
  });

  it("shows each pick once, under GHOST's spelling, even where the diff holds Qloo's", () => {
    const view = buildGhostView(
      ghostRun(
        { picks: { ...NO_PICKS, partners: ["Voltline", "Granite Peak Light"] } },
        {
          items: [
            { name: "Voltline Energy", category: "partners", status: "both", resolvesInQloo: null, ref: "R1" },
            { name: "Granite Peak Light", category: "partners", status: "llm_only", resolvesInQloo: true, ref: null },
          ],
        },
      ),
    );
    const partners = view?.categories[0];
    expect(partners?.ghost.map((n) => [n.name, n.status, n.resolvesText])).toEqual([
      ["Voltline", "both", null],
      ["Granite Peak Light", "llm_only", "resolves in Qloo: yes"],
    ]);
    expect(partners?.qloo.map((n) => [n.name, n.status])).toEqual([["Voltline Energy", "both"]]);
    expect(partners?.tally).toBe("1 both · 1 LLM only");
  });

  it("pairs a pick by its spelling first, else with the next diff item left, and keeps a pick with none as not checked", () => {
    const view = buildGhostView(
      ghostRun(
        { picks: { ...NO_PICKS, tenants: ["Moth and Mallow", "Larkspur  Bakery!", "Quillfeather Books", "Wrenfield Cider"] } },
        {
          items: [
            { name: "Larkspur Bakery", category: "tenants", status: "both", resolvesInQloo: null, ref: "R4" },
            { name: "Quillfeather Books", category: "tenants", status: "llm_only", resolvesInQloo: false, ref: null },
            { name: "Moth & Mallow Co.", category: "tenants", status: "both", resolvesInQloo: null, ref: "R5" },
          ],
        },
      ),
    );
    const tenants = view?.categories[0];
    expect(tenants?.ghost.map((n) => [n.name, n.status, n.resolvesText])).toEqual([
      ["Moth and Mallow", "both", null],
      ["Larkspur  Bakery!", "both", null],
      ["Quillfeather Books", "llm_only", "resolves in Qloo: no"],
      ["Wrenfield Cider", "llm_only", "resolves in Qloo: not checked"],
    ]);
    expect(tenants?.qloo.map((n) => n.name)).toEqual(["Larkspur Bakery", "Moth & Mallow Co."]);
    expect(tenants?.tally).toBe("2 both · 2 LLM only");
    // A diff item with no pick left to take it still shows, after GHOST's own names.
    const extra = buildGhostView(
      ghostRun(
        { picks: { ...NO_PICKS, tenants: ["Larkspur Bakery"] } },
        {
          items: [
            { name: "Larkspur Bakery", category: "tenants", status: "both", resolvesInQloo: null, ref: "R4" },
            { name: "Copperkettle Tea", category: "tenants", status: "llm_only", resolvesInQloo: true, ref: null },
          ],
        },
      ),
    );
    expect(extra?.categories[0]?.ghost.map((n) => [n.name, n.status, n.resolvesText])).toEqual([
      ["Larkspur Bakery", "both", null],
      ["Copperkettle Tea", "llm_only", "resolves in Qloo: yes"],
    ]);
  });

  it("prints the header figures with what each means, and \"Not measured\" for one the diff did not measure", () => {
    const view = buildGhostView(GHOST_SAMPLES.sponsorship ?? null);
    expect(view?.figures.map((f) => [f.key, f.value, f.comparator])).toEqual([
      ["overlap", "20%", null],
      ["resolvability", "80%", null],
      ["unsourced", "3", null],
      ["popularity", "78th", "vs 52nd · this brief"],
    ]);
    for (const f of view?.figures ?? []) expect(f.meaning.length).toBeGreaterThan(10);
    const empty = buildGhostView(ghostRun());
    expect(empty?.figures.map((f) => [f.key, f.value, f.measured])).toEqual([
      ["overlap", "Not measured", false],
      ["resolvability", "Not measured", false],
      ["unsourced", "0", true],
      ["popularity", "Not measured", false],
    ]);
    expect(empty?.figures.find((f) => f.key === "unsourced")?.meaning).toBe("GHOST stated no numbers");
    expect(empty?.categories).toEqual([]);
  });

  it("underlines each claim where it stands in the headline, whole, never inside a longer number", () => {
    expect(markClaims("About 70% of fans, not 170%, see 3 shows.", ["70%", "3"])).toEqual([
      { text: "About ", claim: false },
      { text: "70%", claim: true },
      { text: " of fans, not 170%, see ", claim: false },
      { text: "3", claim: true },
      { text: " shows.", claim: false },
    ]);
    // The longer claim wins where two overlap; a claim the headline does not hold marks nothing.
    expect(markClaims("Reach 1.5 million.", ["1.5", "1.5 million", "42"]).filter((p) => p.claim)).toEqual([{ text: "1.5 million", claim: true }]);
    expect(markClaims("No numbers here.", [])).toEqual([{ text: "No numbers here.", claim: false }]);
  });
});

describe("the GHOST section of the brief", () => {
  it("reads after Risks and before Method, linked from the outline, and moves Method and Sources down a number", () => {
    const { html } = sponsorship;
    const at = (id: string) => html.indexOf(`id="${id}"`);
    expect(at("risks")).toBeLessThan(at("ghost"));
    expect(at("ghost")).toBeLessThan(at("method"));
    expect(html).toContain('href="#ghost"');
    expect(text(slice(html, 'id="ghost"', "</h2>"))).toContain("05LLM alone vs Culture Terminal");
    expect(text(slice(html, 'id="method"', "</h2>"))).toContain("06Method");
    expect(text(slice(html, 'id="sources"', "</h2>"))).toContain("07Sources");
  });

  it("always prints the honesty line, even for a GHOST with no names, no numbers and no measures", () => {
    for (const { html } of [sponsorship, brandHealth]) expect(text(section(html))).toContain(GHOST_HONESTY_LINE);
    const list = jobRunEvents("sponsorship");
    const bare = renderState({ ...stateOf(list), ghost: ghostRun() }, after(list));
    const part = section(bare.html);
    expect(text(part)).toContain(GHOST_HONESTY_LINE);
    expect(tagOf(part, "data-ghost-honesty")).not.toContain("hidden");
    expect(part).not.toContain("data-ghost-category=");
    expect(part).not.toContain("data-ghost-claims=");
  });

  it("prints no section, no outline link and the usual numbers without a GHOST", () => {
    for (const job of ["sponsorship", "brand_health"] as const) {
      const { html } = render(jobRunEvents(job));
      expect(html).not.toContain('id="ghost"');
      expect(html).not.toContain('href="#ghost"');
      expect(html).not.toContain("data-ghost");
      expect(text(html)).not.toContain(GHOST_HONESTY_LINE);
      expect(text(slice(html, 'id="method"', "</h2>"))).toContain("05Method");
    }
  });

  it("prints no section on a picker, even with a GHOST in the state", () => {
    const list = events("needs-input");
    const { html } = renderState({ ...stateOf(list), ghost: GHOST_SAMPLES.sponsorship ?? null }, after(list));
    expect(html).not.toContain("data-ghost");
    expect(html).not.toContain('href="#ghost"');
  });

  it("prints no section on a refusal, even with a GHOST in the state", () => {
    // An ANALYST refusal: evidence and requests on the page, no report, the run ended refused.
    const list = endedAs(upTo(events("brand-health"), "report.draft"), "refused", "financial advice");
    const { html, model } = renderState({ ...stateOf(list), ghost: GHOST_SAMPLES.brand_health ?? null }, after(list));
    expect(model.terminal?.kind).toBe("refused");
    expect(html).toContain('aria-label="Question refused"');
    expect(html).not.toContain("data-ghost");
    expect(html).not.toContain('href="#ghost"');
  });

  it("draws every status with its mark and its word, and whether an LLM-only name resolves in Qloo", () => {
    const part = section(sponsorship.html);
    const names = [...part.matchAll(/<li[^>]*data-ghost-name="(\w+)"[^>]*>([\s\S]*?)<\/li>/g)].map((m) => ({ status: m[1], body: m[2] ?? "", tag: m[0] }));
    expect(names.map((n) => n.status).sort()).toEqual(["both", "both", "both", "both", "llm_only", "llm_only", "llm_only", "qloo_only", "qloo_only", "qloo_only", "qloo_only"]);
    const word = { both: ["✓", "Found by both"], qloo_only: ["★", "Found only by Qloo"], llm_only: ["✗", "LLM only"] } as const;
    for (const n of names) {
      const [mark, label] = word[n.status as keyof typeof word];
      expect(text(n.body)).toContain(mark);
      // Never colour alone: the word is printed beside the glyph, which screen readers skip.
      expect(text(n.body)).toContain(label);
      expect(n.body).toMatch(new RegExp(`<span aria-hidden="true"[^>]*>${mark}</span>`));
    }
    const resolving = names.filter((n) => n.status === "llm_only").map((n) => text(n.body));
    expect(resolving.filter((t) => t.includes("resolves in Qloo: yes"))).toHaveLength(2);
    expect(resolving.filter((t) => t.includes("resolves in Qloo: no"))).toHaveLength(1);
    expect(attrValues(part, "data-resolves").sort()).toEqual(["false", "true", "true"]);
  });

  it("repeats the two columns per category, and lists GHOST's numbers as unsourced", () => {
    const part = section(brandHealth.html);
    expect(attrValues(part, "data-ghost-category")).toEqual(["competitors", "partners"]);
    expect(attrValues(part, "data-ghost-side")).toEqual(["ghost", "qloo", "ghost", "qloo"]);
    const claims = slice(part, "data-ghost-claims=");
    expect(tagOf(claims, "data-ghost-claims")).toContain('data-ghost-claims="2"');
    expect(attrValues(claims, "data-ghost-claim")).toEqual(["unsourced", "unsourced"]);
    expect(text(claims)).toContain("25 to 34");
    expect(text(claims)).toContain("No source");
    // In the headline too, each claim underlined and spoken as having no source.
    const headline = slice(part, 'data-ghost-headline="ghost"', "</p>");
    expect(attrValues(headline, "data-ghost-unsourced")).toHaveLength(2);
    expect(text(headline)).toContain("12% (no source)");
  });

  it("sets GHOST's headline beside the brief's, or beside why the brief's is not written yet", () => {
    const { html, model } = brandHealth;
    expect(text(slice(html, 'data-ghost-headline="ghost"', "</p>"))).toContain("Juniper Cola competes head-on with Foxglove Cola");
    expect(text(slice(html, 'data-ghost-headline="brief"', "</p>"))).toContain("taste island");
    expect(model.answer.state).toBe("final");
    // Mid-replay: the report has not landed, so the brief's column says why.
    const list = ghostRunEvents("brand_health") ?? [];
    const cut = upTo(list, "validation");
    const early = renderState({ ...stateOf(cut), ghost: GHOST_SAMPLES.brand_health ?? null }, after(cut));
    expect(early.model.answer.state).not.toBe("final");
    const pending = slice(early.html, 'data-ghost-headline="pending"', "</p>");
    expect(text(pending)).toContain(early.model.answer.tag);
  });

  it("gives a screen reader real lists and headings: an ordered list per column, the figures as terms and values", () => {
    const part = section(sponsorship.html);
    const lists = [...part.matchAll(/<ol[^>]*>/g)].map((m) => m[0]);
    expect(lists).toHaveLength(2);
    expect(lists[0]).toContain('aria-label="Partners: LLM alone"');
    expect(lists[1]).toContain('aria-label="Partners: Culture Terminal"');
    for (const tag of lists) expect(tag).toContain('role="list"');
    // The printed rank is hidden from a screen reader, which already hears "1 of 5" from the list.
    const first = slice(part, "data-ghost-name=", "</li>");
    expect(first).toMatch(/<span aria-hidden="true"[^>]*>1<\/span>/);
    // h2 section, h3 blocks, h4 columns.
    expect(part).toMatch(/<h2[^>]*>[\s\S]*LLM alone vs Culture Terminal/);
    expect(part.match(/<h3/g)?.length).toBe(3);
    expect(part.match(/<h4/g)?.length).toBe(4);
    const figures = slice(part, "data-ghost-figures=", "</dl>");
    expect(tagOf(figures, "data-ghost-figures")).toMatch(/^<dl/);
    expect(figures.match(/<dt/g)).toHaveLength(4);
    expect(text(figures)).toContain("Overlap@5");
    expect(text(figures)).toContain("Of each top five, the share both lists name");
  });

  it("stacks the columns on phones and sets them side by side from 640 px", () => {
    const part = section(sponsorship.html);
    for (const tag of [tagOf(part, "data-ghost-columns"), tagOf(part.slice(part.indexOf("data-ghost-headlines")), "grid-cols-1")]) {
      expect(tag).toContain("grid-cols-1");
      expect(tag).toContain("sm:grid-cols-2");
    }
    expect(tagOf(part, "data-ghost-figures")).toContain("grid-cols-2 ");
    expect(tagOf(part, "data-ghost-figures")).toContain("sm:grid-cols-4");
  });
});

describe("the GHOST blocks on their own", () => {
  it("says so when a side named nothing in a category", () => {
    const view = buildGhostView(ghostRun({}, { items: [{ name: "Fernhill Market", category: "markets", status: "qloo_only", resolvesInQloo: null, ref: "R2" }] }));
    const category = view?.categories[0];
    if (!category) throw new Error("no category");
    const html = renderMarkup(<GhostCategoryBlock category={category} />);
    expect(text(html)).toContain("GHOST named none.");
    expect(text(html)).toContain("Fernhill Market");
    expect(text(html)).toContain("Found only by Qloo");
  });

  it("prints a figure the diff did not measure as \"Not measured\", for every reader, never as a dash", () => {
    const view = buildGhostView(ghostRun());
    const html = renderMarkup(<GhostFigures figures={view?.figures ?? []} />);
    expect(attrValues(html, "data-unavailable")).toEqual(["true", "true", "true"]);
    const overlap = slice(slice(html, 'data-ghost-figure="overlap"'), "data-unavailable", "</dd>");
    expect(tagOf(overlap, "data-unavailable")).toContain("font-serif");
    expect(text(overlap)).toBe("Not measured");
    expect(html).not.toContain("sr-only");
    expect(text(html)).not.toContain("–");
  });
});

describe("the dev GHOST samples", () => {
  it("add a ghost event before run.end and the GHOST to the report, and pass the RunEvent schema", () => {
    for (const job of ["sponsorship", "brand_health"] as const) {
      const list = ghostRunEvents(job) ?? [];
      expect(RunEvent.array().safeParse(list).success).toBe(true);
      expect(list.map((e) => e.seq)).toEqual(list.map((_, i) => i + 1));
      expect(list.at(-1)?.type).toBe("run.end");
      expect(list.at(-2)?.type).toBe("ghost");
      const state = stateOf(list);
      expect(state.ghost).toEqual(GHOST_SAMPLES[job]);
      expect(state.report?.ghost).toEqual(GHOST_SAMPLES[job]);
      expect(state.report?.receipt.models.ghost).toBe("claude-sonnet-5-5");
    }
    expect(ghostRunEvents("site_selection")).toBeNull();
    expect(withGhost([], GHOST_SAMPLES.sponsorship ?? (null as never))).toEqual([]);
  });
});
