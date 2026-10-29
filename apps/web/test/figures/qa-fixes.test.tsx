// QA fixes for the charts stream: legacy figures on the 12 px sentence-case scale and drawn at their
// natural width (a phone scrolls instead of shrinking text), table views that are never a hidden scroll
// box, map overlays kept clear of the pins, and the outline request told apart from a missing boundary.
// Invented fixtures only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MomentumStrip, QuadrantScatter, SlopeChart, LiftMapCard } from "../../components/figures";
import { momentumStrip, tenantSlope } from "../../components/figures/fixtures-desks";
import { austinLiftMap, blockDna, sponsorQuadrant } from "../../components/figures/fixtures";
import { DivergingBars } from "../../components/figures/diverging-bars";
import { fitPadding, overlayBoxes } from "../../components/figures/lift-map-canvas";
import { fetchOutlines } from "../../components/figures/lift-outlines";
import { placeChips } from "../../components/figures/lift-scale";
import { ColumnChart, NeighbourColumns, RankedFitList, Scoreboard } from "../../components/plots";
import { interest, neighbours, tenantFit } from "../../app/dev/figures/plot-fixtures";
import { plotView, render } from "./markup";

const figures = [
  ["MomentumStrip", render(<MomentumStrip data={momentumStrip.payload} title="Interest over the window" />)],
  ["QuadrantScatter", render(<QuadrantScatter data={sponsorQuadrant.payload} title="Fit vs how well known" />)],
  ["SlopeChart", render(<SlopeChart data={tenantSlope.payload} title="Tenant fit, city to site" />)],
  ["DivergingBars", render(<DivergingBars data={blockDna.payload} title="What each area has more of" />)],
] as const;

describe("legacy figures on the new type scale", () => {
  it.each(figures)("%s: no label under 12 px, no tracking, no all-caps heads", (_, html) => {
    const plot = plotView(html);
    const sizes = [...plot.matchAll(/font-size="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(sizes.length).toBeGreaterThan(0);
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(12);
    expect(plot).not.toContain("letter-spacing");
    for (const caps of ["STALE", "ENTITY", "TRENDING WINDOW", "PRICED IN", "NOT PLACED", "Δ VS", "NO SIGNAL"]) expect(plot).not.toContain(caps);
  });

  it.each(figures)("%s: the SVG draws at its natural width, inside a scroll box, never scaled down", (_, html) => {
    const plot = plotView(html);
    expect(plot).toMatch(/<svg[^>]* width="680"/);
    expect(plot).not.toContain('width="100%"');
    expect(html).toMatch(/data-view="plot" class="min-w-0 overflow-x-auto"/);
  });

  it("says No data after the window instead of the STALE badge", () => {
    const html = figures[0][1];
    expect(html).toContain("No data after Aug 2026");
    expect(html).not.toContain(">STALE<");
  });
});

describe("table views", () => {
  it("a visually hidden table is never a scroll box (axe scrollable-region-focusable)", () => {
    const html = figures[1][1];
    const at = html.indexOf('class="sr-only" data-view="table"');
    expect(at).toBeGreaterThan(-1);
    const table = html.slice(at, html.indexOf("</table>", at));
    expect(table).not.toContain("overflow-x-auto");
  });

  it("the map card's screen-reader table has no scroll wrapper either", () => {
    const html = render(<LiftMapCard data={austinLiftMap.payload} kind="Where to open" title="Best areas" interactive={false} />);
    const at = html.indexOf('data-view="table"');
    expect(html.slice(at, html.indexOf("</table>", at))).not.toContain("overflow-x-auto");
  });

  it("the map card keeps every area name whole, the tag under the value", () => {
    const html = render(<LiftMapCard data={austinLiftMap.payload} kind="Where to open" title="Best areas" interactive={false} />);
    const list = html.slice(html.indexOf("top areas"), html.indexOf("</ol>"));
    expect(list).not.toContain("truncate");
    expect(list).toContain("break-words");
  });
});

describe("plots at 390", () => {
  it("RankedFitList gives the name its own line below md and wraps it, never cut with an ellipsis", () => {
    const html = render(<RankedFitList rows={tenantFit} label="Best fit for this corner" />);
    expect(html).toContain("col-span-3 min-w-0");
    expect(html).toContain("[overflow-wrap:anywhere]");
    expect(html).not.toMatch(/truncate|line-clamp/);
    expect(html).toContain("relative col-start-2 h-3");
  });

  it("Scoreboard drops the side names below md and reads the score as a sentence", () => {
    const html = render(<Scoreboard a={{ name: "Brand Alpha", score: 4 }} b={{ name: "Brand Beta", score: 1 }} caption="cities where each ranks first" />);
    expect([...html.matchAll(/max-md:hidden">Brand (Alpha|Beta)</g)]).toHaveLength(2);
    expect(html).toContain('<span class="sr-only">Brand Alpha 4, Brand Beta 1</span>');
    expect(html).not.toContain("aria-label");
  });

  it("ColumnChart's after panel lets its pill wrap", () => {
    const html = render(<ColumnChart points={interest} after="No data after Sep 2025" label="Interest" />);
    expect(html).toContain("[&amp;&gt;span]:whitespace-normal");
    expect(html).toContain("min-w-24");
  });

  it("NeighbourColumns heads are h3 under the card's h2", () => {
    const html = render(<NeighbourColumns columns={neighbours} label="Fans also love" />);
    expect(html).toContain("<h3");
    expect(html).not.toContain("<h4");
  });
});

describe("map overlays", () => {
  it("fits the areas clear of the legend, zoom buttons and credits", () => {
    expect(fitPadding(358)).toEqual({ top: 56, bottom: 48, left: 16, right: 56 });
    expect(fitPadding(816).bottom).toBeGreaterThanOrEqual(48);
  });

  it("places no flag under the zoom buttons or the credits", () => {
    const w = 358;
    const h = 280;
    // A pin near the bottom-right corner: every spot but the one up and to the left is covered.
    const placed = placeChips([{ id: "a", x: 300, y: 240, r: 14, w: 120, h: 46 }], { w, h }, 8, overlayBoxes(w, h));
    const at = placed.get("a");
    if (at) {
      for (const box of overlayBoxes(w, h)) {
        const clear = at.x + 120 <= box.x || box.x + box.w <= at.x || at.y + 46 <= box.y || box.y + box.h <= at.y;
        expect(clear).toBe(true);
      }
    }
  });
});

describe("outline requests", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("tells a failed request apart from an empty list, and asks again after a failure", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(new Response("nope", { status: 500 }));
    fetch.mockResolvedValueOnce(new Response(JSON.stringify({ type: "FeatureCollection", metro: "nashville", source: null, features: [] })));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchOutlines("/api/geo/test-retry")).toEqual({ ok: false });
    expect(await fetchOutlines("/api/geo/test-retry")).toEqual({ ok: true, features: [] });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
