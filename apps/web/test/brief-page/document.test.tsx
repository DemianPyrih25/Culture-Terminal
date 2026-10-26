// The finished brief (A05) from the recorded brand-health sample: every section, every number a button
// to its request, every footnote once in the margin, and UNAVAILABLE never printed as 0.
import { describe, expect, it, vi } from "vitest";
import type { Metric, MetricId, RunState } from "@ct/contracts";
import { sentenceCase } from "../../components/brief";
import { NOW_COLUMN_MAX, nowPlacement } from "../../components/brief/risks";
import { SHORT_TRACE_MAX } from "../../lib/brief";
import { after, attrValues, decode, events, render, renderState, slice, stateOf, tagOf, text, upTo } from "./support";

vi.mock("server-only", () => ({}));
// /method ships in Part 7 (ROUTE_LIVE); these tests pin the link each figure will carry then.
vi.mock("@/lib/routes", () => ({ ROUTE_LIVE: { method: true, following: false } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
// The top bar's question field belongs to the Ask stream; here it only says which run it follows up.
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: ({ parentRunId }: { parentRunId?: string | null }) => <input data-ask-parent={parentRunId ?? ""} /> }));

const SAMPLE = events("brand-health");
const finished = render(SAMPLE);

describe("the finished brief", () => {
  it("draws every section, answer first and mechanics last", () => {
    const { html, model } = finished;
    expect(model.mode).toBe("final");
    const at = (id: string) => html.indexOf(`id="${id}"`);
    const order = ["answer", "conviction", "evidence", "risks", "method", "sources"].map(at);
    for (const position of order) expect(position).toBeGreaterThan(0);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The outline links every section, none pending.
    for (const id of ["answer", "conviction", "evidence", "risks", "method", "sources"]) expect(html).toContain(`href="#${id}"`);
    expect(html).not.toContain("(not written yet)");
  });

  it("prints the head, the answer with its signal, and the conviction the CHECKER passed", () => {
    const { html, model } = finished;
    expect(text(slice(html, "<h1", "</h1>"))).toContain(model.header.question ?? "missing");
    const answer = text(slice(html, 'data-answer="final"', 'id="conviction"'));
    expect(answer).toContain("The answer");
    expect(answer).toContain(model.answer.tag);
    expect(text(slice(html, 'data-headline="true"', "</p>"))).toContain("taste island");
    expect(html).toContain('data-trace="passed"');
    expect(text(slice(html, 'data-trace="passed"', "</div>"))).toContain(model.trace.headline);
    expect(html).toContain(`aria-valuetext="${model.conviction.summary?.text}"`);
    expect(text(html)).toContain(model.conviction.why?.label ?? "missing");
  });

  it("makes every footnote a button and gives each its sidenote once, numbered in reading order", () => {
    const { html, model } = finished;
    const buttons = new Set(attrValues(html, "data-footnote").map(Number));
    const numbers = model.footnotes.map((f) => f.n);
    expect([...buttons].sort((a, b) => a - b)).toEqual(numbers);
    // Each footnote's sidenote appears exactly once, and the margin reads 1, 2, 3 down the page.
    const notes = attrValues(html, "data-sidenote").map(Number);
    expect(notes).toEqual(numbers);
    // Every trigger is a button (or a span with the button role) that opens a dialog, the request inspector.
    const triggers = html.match(/<(button|span)[^>]*data-footnote="\d+"[^>]*>/g) ?? [];
    expect(triggers.length).toBeGreaterThan(numbers.length);
    for (const tag of triggers) {
      if (tag.startsWith("<span")) {
        expect(tag).toContain('role="button"');
        expect(tag).toContain('tabindex="0"');
      }
      expect(tag).toContain('aria-haspopup="dialog"');
      expect(tag).toContain('aria-expanded="false"');
    }
  });

  it("makes the whole number in prose the button to its request, superscript included", () => {
    const { html, model } = finished;
    const ids = [...new Set(attrValues(html, "data-metric"))];
    expect(ids.length).toBeGreaterThan(3);
    const shown: string[] = [];
    for (const id of ids) {
      const note = model.footnotes.find((f) => f.key === id);
      if (!note?.metric) throw new Error(`no footnote for ${id}`);
      // Right inside the metric: its trigger, holding every word of the number and the superscript after it.
      const open = html.indexOf("<span", html.indexOf(`data-metric="${id}"`));
      const trigger = html.slice(open, html.indexOf(">", open) + 1);
      const inner = html.slice(open, html.indexOf("</sup>", open));
      expect(trigger).toContain('role="button"');
      expect(trigger).toContain(`data-footnote="${note.n}"`);
      expect(decode(trigger)).toContain(`aria-label="${note.metric.text}, note ${note.n}: open its source"`);
      expect(text(inner)).toBe(`${note.metric.text}${note.n}`);
      // No second button inside it: the superscript is only its mark.
      expect(inner).not.toContain("<button");
      shown.push(note.metric.text);
    }
    // A number in words ("last in 4 of 5 rows") is one trigger too: a span, so it wraps with the line.
    expect(shown.some((t) => t.includes(" "))).toBe(true);
  });

  it("gives a superscript on its own a 24 px target without moving the line", () => {
    const { html } = finished;
    const sups = html.match(/<sup [^>]*><button[^>]*>/g) ?? [];
    expect(sups.length).toBeGreaterThan(0);
    for (const tag of sups) {
      expect(tag).toContain("after:absolute");
      // 7 px past each side of the 10 x 12 px number.
      expect(tag).toContain("after:-inset-[7px]");
      expect(tag).toMatch(/class="[^"]*\brelative\b/);
    }
  });

  it("shows each key figure as a button to its request, with what it is measured against", () => {
    const { html, model } = finished;
    for (const k of model.evidence.keyFigures) {
      const block = slice(html, `data-key-figure="${k.key}"`, "data-key-figure=");
      expect(block).toContain(`data-footnote="${k.footnote}"`);
      expect(text(block)).toContain(k.metric?.text ?? "missing");
      if (k.comparator) expect(text(block)).toContain(k.comparator);
    }
  });

  it("draws each figure with its title, caption, codes, table view and method link", () => {
    const { html, model } = finished;
    expect(model.evidence.figures.length).toBeGreaterThan(1);
    for (const f of model.evidence.figures) {
      const block = slice(html, `data-figure="${f.number}"`, "data-figure=");
      expect(block).toContain(`FIGURE ${f.number}`);
      expect(text(block)).toContain(f.title);
      expect(block).toContain(`data-footnote="${f.footnote}"`);
      expect(block).toContain('data-view="table"');
      expect(block).toContain(`href="${f.methodHref}"`);
      // The source line links to the request in Sources.
      expect(block).toMatch(/href="#source-\d+"/);
      // Matrix columns use the brief's codes.
      for (const c of f.legend.codes) expect(text(block)).toContain(c.code);
    }
  });

  it("pairs the arguments as Qloo data and our read, with their strength", () => {
    const { html, model } = finished;
    for (const a of model.evidence.arguments) {
      const block = text(slice(html, `data-argument="${a.id}"`, "</article>"));
      expect(block).toContain("Qloo data");
      expect(block).toContain("Our read");
      expect(block).toContain(a.strengthLabel);
    }
  });

  it("lists the risks, the method with its pivot and CHECKER line, and every request", () => {
    const { html, model } = finished;
    expect(text(html)).toContain("We would change our view if");
    expect(attrValues(html, "data-change").map(Number)).toEqual(model.risks.changes.map((c) => c.n));
    // The report's open questions print apart from the limitations, under their own kicker.
    const open = model.risks.limitations.filter((l) => l.source === "open_question");
    expect(open.length).toBeGreaterThan(0);
    expect(attrValues(html, "data-limitation").length).toBe(model.risks.limitations.length - open.length);
    expect(attrValues(html, "data-limitation")).not.toContain("open_question");
    expect(attrValues(html, "data-open-question").length).toBe(open.length);
    expect(text(html)).toContain(`${model.risks.limitations.length - open.length} recorded`);
    for (const q of open) expect(text(slice(html, "data-open-question", "</ul>"))).toContain(q.text);
    expect(text(html)).toContain(model.method.line);
    expect(text(html)).toContain(`Show the ${model.method.steps.length} steps`);
    expect(attrValues(html, "data-step").length).toBe(model.method.steps.length);
    expect(attrValues(html, "data-pivot")).toEqual(model.method.pivots.map((p) => p.triggerFindingId));
    expect(html).toContain('data-checker="passed"');
    expect(text(slice(html, 'data-checker="passed"', "</p>"))).toContain(model.method.checker.line ?? "missing");
    expect(attrValues(html, "data-source").map(Number)).toEqual(model.sources.items.map((s) => s.n));
    for (const s of model.sources.items) expect(html).toContain(`id="source-${s.n}"`);
  });

  it("links each applied name of a type a tearsheet describes to its DES tearsheet, and no other name", () => {
    const state = stateOf(SAMPLE);
    const base = state.resolves[0];
    if (!base) throw new Error("the sample resolves no name");
    type Resolved = RunState["resolves"][number];
    // Extra names without a ref, so the rest of the brief reads as before.
    const extra = (mention: string, entityType: Resolved["entityType"], match: Resolved["match"], name: string | null): Resolved => ({
      ...base,
      mention,
      role: "peer",
      entityType,
      match,
      ref: null,
      name,
    });
    const resolves = [
      ...state.resolves,
      extra("Artist Nova", "artist", "exact", "Artist Nova"),
      extra("Kestrel Tonic", "brand", "ambiguous", null),
      extra("Lantern Hall", "place", "exact", "Lantern Hall"),
    ];
    const { html, model } = renderState({ ...state, resolves }, after(SAMPLE));
    expect(model.method.interpretation?.resolves.map((r) => r.entityType)).toEqual(resolves.map((r) => r.entityType));
    const reading = slice(html, 'data-clerk-reading="true"', "<table");
    // The sample's three brands matched exactly, then the artist; the ambiguous brand and the place stay plain text.
    expect(state.resolves.map((r) => [r.entityType, r.match])).toEqual([["brand", "exact"], ["brand", "exact"], ["brand", "exact"]]);
    expect(attrValues(reading, "data-des-link")).toEqual(["brand", "brand", "brand", "artist"]);
    expect(tagOf(reading, 'href="/d/Juniper%20Cola"')).toContain('title="Juniper Cola: open its DES tearsheet"');
    expect(reading).toContain('href="/d/Artist%20Nova?type=artist"');
    expect(text(reading)).toContain("Kestrel Tonic · ");
    expect(text(reading)).toContain("Lantern Hall · ");
    expect(reading).not.toMatch(/href="\/d\/(Kestrel|Lantern)/);
    // Each line still reads as the name, then its match.
    expect(text(reading)).toContain("Juniper Cola · ");
  });

  it("sets a short number in the NOW column, and a number in words on its own line under its condition", () => {
    const { html, model } = finished;
    const changes = model.risks.changes;
    expect(changes.map(nowPlacement)).toEqual(expect.arrayContaining(["column", "below"]));
    for (const c of changes) {
      const row = slice(html, `data-change="${c.n}"`, "data-change=");
      const now = c.now;
      if (!now) continue;
      const value = `${now.metric.text}${now.footnote}`;
      if (nowPlacement(c) === "below") {
        // Under the condition, labelled, left-aligned; the column beside it stays empty and silent.
        expect(now.metric.text.length).toBeGreaterThan(NOW_COLUMN_MAX);
        expect(text(slice(row, 'data-now="below"', "</p>"))).toBe(`Now:${value}`);
        expect(row).toMatch(/<p class="[^"]*text-right[^"]*" aria-hidden="true"><\/p>/);
      } else {
        expect(row).not.toContain("data-now=");
        expect(text(slice(row, "text-right", "</p>"))).toContain(`Now: ${value}`);
      }
    }
    // A condition with nothing measured keeps its dash in the column.
    expect(nowPlacement({ now: null })).toBeNull();
  });

  it("draws the brief's words in a colour that keeps its contrast; faint is left to marks only drawn", () => {
    const live = render(upTo(SAMPLE, "plan"));
    /** Every stretch of the markup from `marker` up to the next `end`. */
    const blocks = (html: string, marker: string, end: string) =>
      [...html.matchAll(new RegExp(marker.replace(/[[\]]/g, "\\$&"), "g"))].map((m) => html.slice(m.index, html.indexOf(end, m.index)));
    const regions = [
      // While live: the answer's tag, the pending key figures, the conviction scale, the awaiting priors.
      ...blocks(live.html, 'data-answer="', "</h2>"),
      ...blocks(live.html, 'data-key-figure="pending"', "</p></div>"),
      ...blocks(live.html, 'role="meter"', "</div>"),
      ...blocks(live.html, "data-prior=", "</span></span></div>"),
      // Finished: the arguments' and recommendations' ids, the risks' column heads, the method's steps.
      ...blocks(finished.html, "data-argument=", "</article>"),
      ...blocks(finished.html, "data-recommendation=", "</li>"),
      ...blocks(finished.html, "min-h-[26px]", "</div>"),
      ...blocks(finished.html, "<thead", "</thead>"),
      ...blocks(finished.html, "data-step=", "</tr>"),
    ];
    expect(regions.length).toBeGreaterThan(10);
    expect(live.model.priors.items.some((p) => p.state === "awaiting_data")).toBe(true);
    for (const region of regions) {
      for (const tag of region.match(/<[a-z]+ [^>]*\btext-faint\b[^>]*>/g) ?? []) expect(tag).toContain('aria-hidden="true"');
    }
    // The live answer's tag reads lighter by weight, not by a fainter colour.
    expect(decode(live.html)).toContain(`<span class="font-normal text-dim">${live.model.answer.tag}</span>`);
  });

  it("offers the next moves as follow-ups of this run, Share, Export PDF and Replay; Follow is not built yet", () => {
    const { html, model } = finished;
    for (const m of model.nextMoves) {
      const href = `/ask?${new URLSearchParams({ q: m.question, parent: model.runId }).toString()}`;
      expect(html).toContain(`href="${href.replace(/&/g, "&amp;")}"`);
    }
    expect(text(html)).toContain("Export PDF");
    expect(text(html)).toContain("Share");
    expect(html).toContain(`href="/run/${model.runId}?replay=1"`);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?Follow this subject/);
  });

  it("keeps the running head out of the way until the page head scrolls off, and prints the honesty line", () => {
    const { html, model } = finished;
    const head = tagOf(html, "data-running-head=");
    expect(head).toContain('data-running-head="hidden"');
    expect(head).toContain('aria-hidden="true"');
    expect(head).toContain('inert=""');
    // It names the finding by the verdict tag; the answer's kicker stays the signal.
    expect(model.header.finding).toBe("Taste island");
    expect(text(slice(html, "data-running-head=", "<main"))).toContain(model.header.finding);
    expect(model.answer.tag).not.toBe(model.header.finding);
    expect(text(html)).toContain(model.statusLine.honesty);
    expect(text(html)).toContain(model.statusLine.requests);
    // The top bar asks follow-ups on this brief.
    expect(html).toContain(`data-ask-parent="${model.runId}"`);
  });

  it("prints the notes again as endnotes for paper", () => {
    const { html, model } = finished;
    const endnotes = text(slice(html, 'aria-label="Notes"'));
    for (const f of model.footnotes) expect(endnotes).toContain(f.trace);
  });

  it("keeps each sidenote short in the margin: capitalised, two lines from 1280 px, a whole one-line trace without the formula id", () => {
    const { html, model } = finished;
    for (const f of model.footnotes) {
      const note = slice(html, `data-sidenote="${f.n}"`, "data-sidenote=");
      const [body, trace] = [...note.matchAll(/<p class="([^"]*)" title="([^"]*)">([^<]*)<\/p>/g)].map((m) => ({
        cls: m[1] ?? "",
        title: decode(m[2] ?? ""),
        shown: decode(m[3] ?? ""),
      }));
      // The margin prints the short form; a figure's codes stay whole, the rest are held to two lines.
      expect(body?.shown).toBe(sentenceCase(f.short.text));
      expect(trace?.shown).toBe(f.short.trace);
      if (f.kind === "figure") expect(body?.cls).not.toContain("line-clamp");
      else expect(body?.cls).toContain("xl:line-clamp-2");
      // The trace is never cut with an ellipsis at 1440, and names no formula.
      expect(trace?.cls).not.toContain("truncate");
      expect(trace?.shown.length).toBeLessThanOrEqual(SHORT_TRACE_MAX);
      if (f.computed) expect(trace?.shown).toBe("computed in code · QUANT");
      // The long note and trace stay readable on hover, and every sentence opens on a capital.
      expect(body?.title).toBe(sentenceCase(f.text));
      expect(body?.shown).not.toMatch(/(^|[.!?]\s+)[a-z]/);
      expect(trace?.title).toBe(f.trace);
    }
  });

  it("lifts every note list above the rows below it, and shows it from 1280 px only once placed", () => {
    const { html } = finished;
    const lists = html.match(/<div data-note-list="true" class="[^"]*"/g) ?? [];
    expect(lists.length).toBeGreaterThan(5);
    for (const tag of lists) {
      // Notes that run past their row stay clickable: they paint and hit-test above the next row.
      expect(tag).toContain("xl:relative");
      expect(tag).toContain("xl:z-[1]");
      // The first paint never prints notes over each other: hidden at xl until the layout places them.
      expect(tag).toContain("xl:invisible");
      expect(tag).toContain("xl:data-[placed]:visible");
    }
    // Without JavaScript nothing places them: they keep their rows' height instead.
    expect(decode(html)).toContain("<noscript><style>@media (min-width: 1280px)");
  });

  it("gives the answer a heading, and offers a skip link past the chrome to it", () => {
    const { html } = finished;
    expect(text(slice(html, "<h2", "</h2>"))).toContain("The answer");
    const skip = tagOf(html, ">Skip to the brief<");
    expect(skip).toContain('href="#answer"');
    expect(html.indexOf("Skip to the brief")).toBeLessThan(html.indexOf("<header"));
    // The outline's "This run" label is not a heading that comes before the page's h1.
    expect(html.slice(0, html.indexOf("<h1"))).not.toMatch(/<h2[^>]*>This run/);
  });

  it("gives a lone compact matrix its own row at its natural width", () => {
    const { html, model } = finished;
    const lone = model.evidence.figures.at(-1);
    if (!lone) throw new Error("no figure");
    const row = slice(html, `data-figure="${lone.number}"`);
    const grid = html.slice(html.lastIndexOf("<div class=\"grid w-full", html.indexOf(`data-figure="${lone.number}"`)), html.indexOf(`data-figure="${lone.number}"`));
    expect(row).toContain(`FIGURE ${lone.number}`);
    expect(grid).not.toContain("sm:grid-cols-2");
  });

  it("marks a reader's own run unlisted (D31), and a test run as such", () => {
    const state = stateOf(SAMPLE);
    const { html } = renderState(state, after(SAMPLE), undefined, { unlisted: true });
    expect(text(slice(html, 'data-marker="UNLISTED"', "</span>"))).toBe("Unlisted · user question");
    expect(finished.html).not.toContain('data-marker="UNLISTED"');
    const test = renderState({ ...state, model: "fake" }, after(SAMPLE), undefined, { unlisted: true });
    expect(text(slice(test.html, 'data-marker="UNLISTED"', "</span>"))).toBe("Unlisted · test run");
  });

  it("keeps Export PDF from printing buttons that do nothing on paper", () => {
    const { html } = finished;
    expect(tagOf(html, 'aria-controls="')).toContain("print:hidden");
  });
});

describe("UNAVAILABLE is never drawn as 0", () => {
  it("prints a cited metric that was not measured as 'not measured' with its reason, everywhere it appears", () => {
    const state = stateOf(SAMPLE);
    const keyId = finished.model.evidence.keyFigures[0]?.key as MetricId;
    const metric = state.metrics[keyId] as Metric;
    const unavailable: RunState = {
      ...state,
      metrics: { ...state.metrics, [keyId]: { ...metric, value: null, display: "0", badge: "UNAVAILABLE", reason: "not_measured" } },
    };
    const { html, model } = renderState(unavailable, after(SAMPLE));
    const figure = slice(html, `data-key-figure="${keyId}"`, "data-key-figure=");
    expect(text(figure)).toContain("Not measured");
    expect(text(figure)).toContain("no data for this entity");
    expect(figure).toContain('data-unavailable="true"');
    expect(text(figure)).not.toMatch(/(^|\D)0(\D|$)/);
    // In prose too: the metric's spans print "not measured", never its display.
    for (const m of html.matchAll(new RegExp(`data-metric="${keyId}"[^>]*>([\\s\\S]*?)</span>`, "g"))) {
      expect(text(m[1] ?? "")).toContain("not measured");
    }
    const note = model.footnotes.find((f) => f.key === keyId);
    expect(note?.unavailable).not.toBeNull();
  });
});
