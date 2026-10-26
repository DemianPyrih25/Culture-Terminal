// Constellation (S9 in P1): seeds in the centre, one sector per domain, distance = 1 − FIT, the
// explainability edges, the under-the-radar picks, one keyboard stop per domain that names every
// result, a payload without its seeds, the compact layout for phones and the table view.
import { describe, expect, it } from "vitest";
import { Constellation, layoutConstellation } from "../../components/figures";
import { radialDomain } from "../../components/figures/constellation";
import { FIXTURE_SOURCES, NEIGHBOURHOOD_HALO, NEIGHBOURHOOD_SEEDS, domainLists, neighbourhood } from "../../components/figures/fixtures";
import { textWidth } from "../../components/figures/scale";
import { plotView, render, tableHeads, tableRows, tableView, text } from "./markup";

const data = neighbourhood.payload;
const halo = new Map(Object.entries(NEIGHBOURHOOD_HALO));
const html = render(
  <Constellation
    data={data}
    seeds={NEIGHBOURHOOD_SEEDS}
    halo={NEIGHBOURHOOD_HALO}
    number={6}
    title="Both brands live next to slow radio and outdoor goods"
    source={FIXTURE_SOURCES.neighbourhood}
    formulaId="xdom.edge"
  />,
);
const wide = layoutConstellation(data, NEIGHBOURHOOD_SEEDS, 0, halo, 680, false, 3, {});
const compact = layoutConstellation(data, NEIGHBOURHOOD_SEEDS, 0, halo, 358, true, 1, {});
const placedRows = data.groups.flatMap((g) => g.rows.filter((r) => r.cells[0]!.value !== null));

/** The markup of the wide layout only. */
function wideMarkup(markup: string): string {
  const start = markup.indexOf('data-layout="wide"');
  return markup.slice(start, markup.indexOf('data-layout="compact"', start));
}

describe("Constellation", () => {
  it("is a named group of focusable domains, one keyboard stop each, in a wide and a compact layout", () => {
    const plot = plotView(html);
    expect(plot).toContain('data-constellation="wide"');
    expect(plot).toContain('data-constellation="compact"');
    expect(plot).toMatch(/<div class="hidden sm:block" data-layout="wide">/);
    expect(plot).toMatch(/<div class="sm:hidden" data-layout="compact">/);
    const svg = wideMarkup(plot);
    expect(svg).toContain('role="group" aria-label="Both brands live next to slow radio and outdoor goods"');
    const stops = [...svg.matchAll(/<g data-domain="([^"]+)" tabindex="0" role="img" aria-label="([^"]+)"/g)];
    expect(stops.map((m) => m[1])).toEqual(["artist", "podcast", "tv_show", "movie", "brand"]);
    expect(stops[1]![2]).toContain("Podcasts: 7 results by fit, Field Notes Weekly 1.00, The Long Table 0.93");
    expect(stops[1]![2]).toContain("Under the radar: The Long Table.");
    expect(stops[3]![2]).toBe("Movies: not measured.");
    // The accessible name lists every result, down to the last.
    expect(stops[4]![2]).toContain("Copperline Coffee 0.57.");
  });

  it("draws every scored result once per layout, and lists what it cannot place", () => {
    const svg = wideMarkup(plotView(html));
    expect(svg.match(/data-node="/g)).toHaveLength(placedRows.length);
    expect(text(plotView(html))).toContain("Not placed: Paper Moons (TV · series, below the quality gate) · Movies (call not made: run budget reached)");
  });

  it("puts each result in its domain's sector, nearer the centre the higher its FIT", () => {
    const span = (Math.PI * 2) / wide.sectors.length;
    wide.sectors.forEach((sector, i) => {
      const a0 = -Math.PI / 2 + i * span;
      for (const node of sector.nodes) {
        let a = Math.atan2(node.y - wide.cy, node.x - wide.cx);
        while (a < a0) a += Math.PI * 2;
        expect(a - a0, node.row.label).toBeLessThan(span);
      }
      const byFit = [...sector.nodes].sort((p, q) => q.fit - p.fit);
      const radii = byFit.map((n) => Math.hypot(n.x - wide.cx, n.y - wide.cy));
      for (let k = 1; k < radii.length; k++) expect(radii[k]!).toBeGreaterThanOrEqual(radii[k - 1]! - 1e-9);
    });
    // FIT 1 sits on the inner ring.
    const top = wide.sectors[0]!.nodes[0]!;
    expect(Math.hypot(top.x - wide.cx, top.y - wide.cy)).toBeCloseTo(wide.r0, 6);
  });

  it("fits the rings to the results: the .1 step under a short list, quarters for a full call", () => {
    expect(radialDomain([0.57, 1])).toEqual({ lo: 0.5, step: 0.1 });
    expect(radialDomain([0, 0.4, 1])).toEqual({ lo: 0, step: 0.25 });
    expect(radialDomain([1])).toEqual({ lo: 0.9, step: 0.1 });
    expect(radialDomain([])).toEqual({ lo: 0, step: 0.25 });
    expect(wide.rings.map((r) => r.text)).toEqual([".90", ".80", ".70", ".60", ".50"]);
    expect(wide.rings.at(-1)!.outer).toBe(true);
    expect(wide.rings.at(-1)!.r).toBeCloseTo(wide.r1, 6);
  });

  it("joins a result only to the seed whose share·K reaches 1.1, and draws no spokes then", () => {
    const svg = wideMarkup(plotView(html));
    const edges = data.groups.flatMap((g) => g.rows.flatMap((r) => r.explain));
    expect(edges.length).toBeGreaterThan(5);
    expect(svg.match(/data-edge="/g)).toHaveLength(edges.length);
    expect(svg).toContain('data-edge="artist-2"');
    expect(svg).not.toContain('data-edge="artist-1"');
    expect(wide.spokes).toBe(false);
    expect(svg).toContain('data-seed="R1"');
    expect(svg).toContain('data-seed="R5"');
    expect(text(html)).toContain("JC");
    expect(text(html)).toContain("KRT");
  });

  it("rings and names every under-the-radar pick with its FIT; it greys results it does not name", () => {
    const svg = wideMarkup(plotView(html));
    for (const key of ["artist-3", "podcast-2", "brand-2"]) expect(svg).toContain(`data-node="${key}" data-tone="featured"`);
    const named = wide.sectors.flatMap((s) => s.labels.map((l) => l.text));
    expect(named).toEqual(expect.arrayContaining(["Saint Ferro · 0.86", "The Long Table · 0.93", "Fernleaf Apothecary · 0.93"]));
    expect(svg).toMatch(/data-node="artist-7" data-tone="other"/);
    // TV · series has no pick: no result clears both medians.
    expect(wide.sectors.find((s) => s.key === "tv_show")!.nodes.some((n) => n.pick)).toBe(false);
  });

  it("keeps labels apart and inside the plot, in both layouts", () => {
    for (const layout of [wide, compact]) {
      const boxes = layout.sectors.flatMap((s) =>
        s.labels.map((l) => {
          const w = textWidth(l.text, l.featured ? layout.fontSize + 0.5 : layout.fontSize, { weight: l.featured ? 600 : 400 });
          const x = l.anchor === "start" ? l.x : l.anchor === "end" ? l.x - w : l.x - w / 2;
          return { x, y: l.y - layout.fontSize, w, h: layout.fontSize };
        }),
      );
      for (const b of boxes) {
        expect(b.x).toBeGreaterThanOrEqual(0);
        expect(b.x + b.w).toBeLessThanOrEqual(layout.width);
      }
      for (let i = 0; i < boxes.length; i++) {
        for (let j = i + 1; j < boxes.length; j++) {
          const a = boxes[i]!;
          const b = boxes[j]!;
          const hit = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
          expect(hit, `${i} × ${j}`).toBe(false);
        }
      }
    }
    // Every pick keeps its name on a phone too.
    expect(compact.sectors.flatMap((s) => s.labels.filter((l) => l.featured))).toHaveLength(3);
  });

  it("names every result of a domain in its focused view: beside its dot, or on the line under the plot", () => {
    const podcasts = wide.sectors.find((s) => s.key === "podcast")!;
    expect(podcasts.focusLabels.length).toBeGreaterThan(podcasts.labels.length);
    const svg = wideMarkup(plotView(html));
    expect(svg).toContain('class="opacity-0 group-hover:opacity-100 group-focus:opacity-100" data-labels="focus"');
    // Every domain's default labels give way while any domain is focused or hovered, so none sits under the focused names.
    expect(svg.match(/group-has-\[\[data-domain\]:focus\]\/constellation:opacity-0 group-has-\[\[data-domain\]:hover\]\/constellation:opacity-0" data-labels="default"/g)).toHaveLength(wide.sectors.length);
    // A full S9 call (15 a domain) on a phone has more results than room beside the dots.
    const full = {
      ...data,
      groups: data.groups.map((g) => ({
        ...g,
        rows: Array.from({ length: g.rows.length > 2 ? 15 : 0 }, (_, i) => ({
          ...g.rows[i % g.rows.length]!,
          key: `${g.key}-${i}`,
          label: `${g.rows[i % g.rows.length]!.label} ${i + 1}`,
          cells: [{ value: Number((1 - i / 14).toFixed(2)), reason: null }, ...g.rows[i % g.rows.length]!.cells.slice(1)],
        })),
      })),
    };
    const layouts = [wide, compact, layoutConstellation(full, NEIGHBOURHOOD_SEEDS, 0, halo, 358, true, 1, {}), layoutConstellation(full, NEIGHBOURHOOD_SEEDS, 0, halo, 680, false, 3, {})];
    for (const layout of layouts) {
      for (const sector of layout.sectors) {
        const named = sector.focusLabels.length + sector.overflow.names.length;
        expect(named, `${sector.key} at ${layout.width}`).toBe(sector.nodes.length);
        sector.overflow.lines.forEach((line, k) => {
          const prefix = k === 0 ? textWidth(sector.overflow.prefix, layout.strip.fontSize, { weight: 600 }) - textWidth(sector.overflow.prefix, layout.strip.fontSize) : 0;
          expect(textWidth(line, layout.strip.fontSize) + prefix).toBeLessThanOrEqual(layout.width - 2 * layout.strip.x);
        });
      }
    }
    expect(layouts[2]!.sectors.some((s) => s.overflow.names.length > 0)).toBe(true);
    // The fixture on a phone: one podcast finds no room beside its dot and is listed under the plot.
    const podcastsPhone = compact.sectors.find((s) => s.key === "podcast")!;
    expect(podcastsPhone.overflow.lines).toEqual(["Also in Podcasts: Tin Roof Talks 0.64"]);
    const phone = plotView(html).slice(plotView(html).indexOf('data-layout="compact"'));
    expect(text(phone)).toContain("Also in Podcasts: Tin Roof Talks 0.64");
    // The line holds the hint until a domain is focused or hovered.
    expect(svg).toMatch(/group-has-\[\[data-domain\]:focus\]\/constellation:opacity-0[^"]*" aria-hidden="true" data-hint="true">Focus, hover or tap a domain to name every result in it\.</);
  });

  it("never prints a seed's ref: a payload without its seeds leaves out the lean and says why the lines are missing", () => {
    const bare = render(<Constellation data={data} title="No seeds" />);
    const svg = wideMarkup(plotView(bare));
    expect(svg).toContain("27 results in 5 domains around the seeds;");
    expect(svg).not.toContain("data-edge=");
    expect(text(plotView(bare))).toContain("Seed lines are not drawn: the dataset does not name its seeds, so spokes carry the distance.");
    expect(tableHeads(tableView(bare))).not.toContain("Leans on");
    expect(text(bare)).not.toMatch(/\bR[15] \(/);
    // One seed named, one not: the other reads "a seed".
    const half = render(<Constellation data={data} seeds={[NEIGHBOURHOOD_SEEDS[0], { ref: "R9", label: "Ember Root Beer" }]} title="Half" />);
    const rows = tableRows(tableView(half));
    expect(rows.find((r) => r[0] === "Marigold Static")![6]).toBe("Juniper Cola (71%)");
    expect(rows.find((r) => r[0] === "Saint Ferro")![6]).toBe("a seed (64%)");
    expect(text(plotView(half))).toContain("Some seed lines are not drawn: the dataset does not name the seed they lean on.");
    expect(text(html)).not.toContain("seed lines are not drawn");
  });

  it("is deterministic", () => {
    expect(layoutConstellation(data, NEIGHBOURHOOD_SEEDS, 0, halo, 680, false, 3, {})).toEqual(wide);
  });

  it("draws spokes around a single seed and only the compact layout at half width", () => {
    const one = render(<Constellation data={domainLists.payload} seeds={[{ ref: "R1", label: "Juniper Cola" }]} width={328} title="One seed" />);
    const plot = plotView(one);
    expect(plot).not.toContain('data-layout="wide"');
    expect(plot).toContain('data-constellation="compact"');
    expect(plot).not.toContain("data-edge=");
    expect(plot).toContain('viewBox="0 0 328 ');
    expect(text(one)).toContain("Seed: Juniper Cola");
    expect(text(plot)).toContain("Not placed: Paper Moons (TV · series, not measured)");
  });

  it("prints the halo under each domain and the payload's fixed caption", () => {
    expect(text(wideMarkup(plotView(html)))).toContain("slow radio · food culture");
    expect(html).toContain('data-fixed-caption="true">FIT is the within-call percentile in each domain');
    expect(text(html)).toContain(data.caption!);
  });

  it("lists every result by domain in the table view, with the seed it leans on", () => {
    const table = tableView(html);
    expect(tableHeads(table)).toEqual([
      "Result",
      "Rank",
      "Genre",
      "Fit (within call)",
      "Popularity",
      "Under the radar (fit − popularity)",
      "Leans on",
      "Flags",
    ]);
    const rows = tableRows(table);
    expect(rows).toHaveLength(data.groups.length + data.groups.reduce((s, g) => s + g.rows.length, 0));
    expect(rows[0]).toEqual(["Music · artists · top tags: indie folk, slowcore, americana"]);
    expect(rows.find((r) => r[0] === "Marigold Static")).toEqual(["Marigold Static", "2", "", "0.93", "0.41", "0.52", "Juniper Cola (71%)", ""]);
    expect(rows.find((r) => r[0] === "Low Orchard")![6]).toBe("no clear lean (Juniper Cola 52%, Kettle Ridge Tonic 48%)");
    expect(rows.find((r) => r[0] === "Saint Ferro")![7]).toBe("UNDER THE RADAR");
    expect(rows.find((r) => r[0] === "Paper Moons")!.slice(3, 6)).toEqual(["below the quality gate", "below the quality gate", "below the quality gate"]);
    // A domain the budget skipped keeps one explained row.
    expect(rows.find((r) => r[0] === "Not measured")!.slice(2, 6)).toEqual([
      "call not made: run budget reached",
      "not fetched (budget)",
      "not fetched (budget)",
      "not fetched (budget)",
    ]);
  });
});
