// Every job's brief page, from the synthetic runs of the /dev/brief viewer (invented entities, D29): the
// Part 5 figure families in the evidence section, the area and its location method under the question,
// the CODE FALLBACK note beside its figure, and the next moves as chips with their desks.
import { describe, expect, it, vi } from "vitest";
import { Job } from "@ct/contracts";
import { jobRunEvents } from "../../app/dev/brief/job-runs";
import { figureDisplay } from "../../components/brief/figure-row";
import { attrValues, decode, render, slice, text } from "./support";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/routes", () => ({ ROUTE_LIVE: { method: true, following: false } }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }) }));
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: () => <input /> }));

const page = (job: Job) => render(jobRunEvents(job));

describe("the brief page of every job", () => {
  it.each(Job.options)("%s: draws each exhibit in its family with its source line and its note", (job) => {
    const { html, model } = page(job);
    const kinds = attrValues(html, "data-kind");
    expect(kinds).toEqual(model.evidence.figures.map((f) => f.kind));
    for (const f of model.evidence.figures) {
      const figure = slice(html, `data-figure="${f.number}"`, f.number < model.evidence.figures.length ? `data-figure="${f.number + 1}"` : 'data-argument="');
      // Drawn, not a placeholder: every kind has its family now.
      expect(figure).not.toContain("not built yet");
      expect(decode(text(figure))).toContain(f.source.text);
      expect(figure).toContain(`data-footnote="${f.footnote}"`);
    }
    // Every key figure prints the number the strip holds, never the whole display.
    for (const k of model.evidence.keyFigures) expect(decode(text(slice(html, `data-key-figure="${k.key}"`, "</div>")))).toContain(k.value ?? "missing");
  });

  it("gives the lift map the whole reading column, never half of it", () => {
    const { html, model } = page("site_selection");
    const map = model.evidence.figures.find((f) => f.kind === "GeoLift");
    expect(map).toBeDefined();
    const tag = html.slice(html.lastIndexOf("<div", html.indexOf(`data-figure="${map?.number}"`)), html.indexOf(">", html.indexOf(`data-figure="${map?.number}"`)));
    expect(tag).toContain("--plot-min:520px");
    expect(figureDisplay(map?.dataset ?? (null as never), [], 328).GeoLift?.width).toBe(680);
  });

  it("links each axis of a Taste Position card to the figure it reads", () => {
    const { html, model } = page("brand_health");
    const { figures } = model.evidence;
    const position = figures.find((f) => f.kind === "Position");
    if (position?.dataset?.kind !== "Position") throw new Error("no Taste Position card in the brand-health brief");
    const card = slice(html, `data-figure="${position.number}"`, position.number < figures.length ? `data-figure="${position.number + 1}"` : 'data-argument="');
    let linked = 0;
    for (const axis of position.dataset.payload.axes) {
      const row = slice(card, `data-axis="${axis.axis}"`, "</tr>");
      const target = figures.find((f) => f.datasetId === axis.datasetId);
      if (!target) {
        // An axis whose exhibit the brief does not draw links nowhere.
        expect(row, axis.axis).not.toContain('href="#figure-');
        continue;
      }
      expect(row, axis.axis).toContain(`href="#figure-${target.number}"`);
      expect(html).toContain(`id="figure-${target.number}"`);
      linked += 1;
    }
    expect(linked).toBeGreaterThan(0);
  });

  it("names the area and how it was read under the question, and the fallback beside its figure", () => {
    const { html, model } = page("tenant_mix");
    const block = model.evidence.figures[0];
    const n = block?.location?.fallbackNotes[0];
    expect(n).toEqual(expect.any(Number));
    const line = slice(html, "data-location=", "</p>");
    // The method in words is read out, the fallback cites the note its figure cites.
    expect(decode(text(line))).toBe(`AreaZIP 37206 (East Nashville), Nashville·read by POINT, a centre point· code fallback POLYGON → POINT${n}`);
    expect(line).toContain('data-area-method="POINT"');
    expect(line).toContain(`data-footnote="${n}"`);
    const figureHtml = slice(html, `data-figure="${block?.number}"`, 'data-figure="2"');
    expect(figureHtml).toContain(`data-fallback-note="${n}"`);
    // On the source line, after its text (A06 "… as points⁵"), not in the caption.
    const sourceAt = figureHtml.indexOf(">Source: ");
    expect(sourceAt).toBeGreaterThan(-1);
    expect(figureHtml.indexOf(`data-fallback-note="${n}"`)).toBeGreaterThan(sourceAt);
    // The note itself sits in the margin with its code-fallback trace.
    expect(decode(text(slice(html, `data-sidenote="${n}"`, "</div></div>")))).toContain("code fallback · POLYGON → POINT");
    // A brief that reads no place has no area line.
    expect(page("sponsorship").html).not.toContain("data-location=");
  });

  it("offers the next moves as chips with their desks, each opening Ask with this brief as the parent", () => {
    const { html, model } = page("sponsorship");
    const bar = slice(html, 'aria-label="Follow up"');
    expect(attrValues(bar, "data-desk")).toEqual(["marketing", "location", "audience"]);
    for (const m of model.nextMoves) {
      const chip = slice(bar, `data-next-move="${m.label}"`, "</a>");
      expect(chip).toContain(`href="${m.href.replace(/&/g, "&amp;")}"`);
      expect(decode(text(chip))).toContain(`${m.deskLabel}`);
      expect(decode(text(chip))).toContain(m.label);
    }
  });
});
