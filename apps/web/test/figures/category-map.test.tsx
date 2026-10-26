// CategoryMap, the Category Taste Map (S1 in P1): MDS positions on one shared scale, labels that
// avoid each other and every dot and read as their own dot's, the stress and the unscored pairs on
// the map, one keyboard stop per point with its nearest peer, the compact layout for phones and the
// table view. The fixture is checked against its own similarity matrix.
import { computeSubstitution } from "@ct/quant";
import { describe, expect, it } from "vitest";
import { CategoryMap, layoutCategoryMap, mapLabelKinds, stressReading } from "../../components/figures";
import { boxDistance } from "../../components/figures/category-map";
import { FIXTURE_SOURCES, TASTE_MAP_SIMILARITY, categoryTasteMap } from "../../components/figures/fixtures";
import { textWidth } from "../../components/figures/scale";
import { plotView, render, tableHeads, tableRows, tableView, text } from "./markup";

const data = categoryTasteMap.payload;
const html = render(
  <CategoryMap
    data={data}
    number={8}
    title="Juniper Cola sits with the colas, a long way from the ales"
    source={FIXTURE_SOURCES.tasteMap}
    formulaId="subs.similarity"
  />,
);
const wide = layoutCategoryMap(data, 680, 340, false);
const compact = layoutCategoryMap(data, 358, 280, true);

function wideMarkup(markup: string): string {
  const start = markup.indexOf('data-layout="wide"');
  return markup.slice(start, markup.indexOf('data-layout="compact"', start));
}

type Layout = ReturnType<typeof layoutCategoryMap>;
type Box = { x: number; y: number; w: number; h: number };

/** The drawn box of each label (full or coded), as the text is measured. */
function labelBoxes(layout: Layout): { key: string; box: Box; leader: boolean }[] {
  return layout.points.flatMap((p) => {
    if (!p.label) return [];
    const size = p.label.coded ? layout.fontSize - 1 : layout.fontSize;
    const w = textWidth(p.label.text, size, { weight: p.point.target || p.label.coded ? 600 : 400 });
    const x = p.label.anchor === "start" ? p.label.x : p.label.anchor === "end" ? p.label.x - w : p.label.x - w / 2;
    return [{ key: p.point.key, box: { x, y: p.label.y - size + 1, w, h: size - 1 }, leader: p.label.leader !== null }];
  });
}

const hit = (a: Box, b: Box) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

describe("CategoryMap", () => {
  it("is a named group with one keyboard stop per point that names its nearest peer", () => {
    const svg = wideMarkup(plotView(html));
    expect(svg).toContain('role="group" aria-label="Juniper Cola sits with the colas, a long way from the ales"');
    const stops = [...svg.matchAll(/<g data-point="([^"]+)" data-tone="([^"]+)" tabindex="0" role="img" aria-label="([^"]+)"/g)];
    expect(stops).toHaveLength(data.points.length);
    expect(stops[0]![2]).toBe("target");
    expect(stops[0]![3]).toBe("Juniper Cola (subject): nearest by audience similarity: Brand Alpha, 0.82; cluster Colas.");
    // The nearest-peer line shows on focus or hover only.
    expect(svg).toContain('class="opacity-0 group-hover:opacity-100 group-focus:opacity-100" data-nearest="true"');
  });

  it("on focus, rings the nearest peer, redraws its label at full strength and sets the value clear of every label and dot", () => {
    const svg = wideMarkup(plotView(html));
    const wildmint = svg.slice(svg.indexOf('data-point="R15"'), svg.indexOf('data-point="R5"'));
    const nearest = wildmint.slice(wildmint.indexOf('data-nearest="true"'));
    // Wildmint Soda's nearest peer is Saltmarsh Seltzer: ringed and named inside the focused point.
    expect(nearest).toContain('data-peer="true"');
    expect(text(nearest)).toContain("Saltmarsh Seltzer");
    expect(text(nearest)).toContain("0.75");
    for (const layout of [wide, compact]) {
      const labels = labelBoxes(layout);
      for (const p of layout.points) {
        if (!p.nearest) continue;
        const w = textWidth("0.75", 10, { weight: 600 });
        const box = { x: p.nearest.text.x - w / 2, y: p.nearest.text.y - 9, w, h: 9 };
        for (const l of labels) expect(hit(box, l.box), `${p.point.key} value on ${l.key}'s label at ${layout.width}`).toBe(false);
        for (const q of layout.points) expect(hit(box, { x: q.px - 4, y: q.py - 4, w: 8, h: 8 }), `${p.point.key} value on ${q.point.key}`).toBe(false);
      }
    }
  });

  it("draws both axes on one scale, with y growing upward", () => {
    for (const layout of [wide, compact]) {
      const [a, ...rest] = layout.points;
      const ratios = rest.map((b) => Math.hypot(b.px - a!.px, b.py - a!.py) / Math.hypot(b.point.x - a!.point.x, b.point.y - a!.point.y));
      for (const r of ratios) expect(r).toBeCloseTo(ratios[0]!, 6);
      const higher = [...layout.points].sort((p, q) => q.point.y - p.point.y);
      expect(higher[0]!.py).toBeLessThan(higher.at(-1)!.py);
    }
  });

  it("labels every point on the wide and the phone map, apart from each other and off every dot", () => {
    expect(Object.values(mapLabelKinds(wide)).every((k) => k === "full")).toBe(true);
    expect(Object.values(mapLabelKinds(compact)).every((k) => k === "full")).toBe(true);
    for (const layout of [wide, compact, layoutCategoryMap(data, 328, 280, true), layoutCategoryMap(data, 240, 200, true)]) {
      const boxes = labelBoxes(layout);
      for (let i = 0; i < boxes.length; i++) {
        const a = boxes[i]!;
        for (let j = i + 1; j < boxes.length; j++) expect(hit(a.box, boxes[j]!.box), `${a.key} × ${boxes[j]!.key}`).toBe(false);
        for (const p of layout.points) {
          if (p.point.key === a.key) continue;
          expect(hit(a.box, { x: p.px - 3, y: p.py - 3, w: 6, h: 6 }), `${a.key} on ${p.point.key}`).toBe(false);
        }
        expect(a.box.x).toBeGreaterThanOrEqual(0);
        expect(a.box.x + a.box.w).toBeLessThanOrEqual(layout.width);
      }
    }
  });

  it("puts a label beside its own dot, never nearer another dot (a leader joins the rest)", () => {
    for (const layout of [wide, compact, layoutCategoryMap(data, 328, 280, true), layoutCategoryMap(data, 240, 200, true)]) {
      const at = new Map(layout.points.map((p) => [p.point.key, { x: p.px, y: p.py }]));
      for (const { key, box, leader } of labelBoxes(layout)) {
        if (leader) continue;
        const own = boxDistance(box, at.get(key)!);
        for (const [other, q] of at) if (other !== key) expect(own, `${key} reads as ${other}'s at ${layout.width}`).toBeLessThan(boxDistance(box, q));
      }
    }
  });

  it("falls back to codes, keyed under the map, when a narrow map has no room", () => {
    const narrow = layoutCategoryMap(data, 240, 200, true);
    const kinds = Object.values(mapLabelKinds(narrow));
    expect(kinds).toContain("code");
    // On focus a full label stays where it is; a coded one gives way to the full name.
    for (const p of narrow.points) {
      if (p.label && !p.label.coded) expect(p.focusLabel).toEqual(p.label);
      if (p.label?.coded && p.focusLabel) expect(p.focusLabel.text).toBe(p.point.label);
    }
    const markup = render(<CategoryMap data={data} width={240} height={200} title="Narrow" />);
    expect(text(markup)).toContain("Codes: ");
  });

  it("prints the stress on the map and in the note, and joins the near-substitutes", () => {
    const svg = wideMarkup(plotView(html));
    expect(svg).toMatch(/data-badge="stress">STRESS 0\.09 · FAIR</);
    expect(text(plotView(html))).toContain("Stress 0.09 (Kruskal: fair); the two axes hold 88% of the variance. The axes have no units");
    for (const link of ["R2-R3", "R4-R8", "R5-R7"]) expect(svg).toContain(`data-link="${link}"`);
    expect(text(plotView(html))).toContain("Not placed: Brand Gamma (not scored)");
    expect(text(svg)).toContain("of 1 − similarity");
  });

  it("says how many placed pairs were never scored, beside the stress and in the table", () => {
    const gaps = render(<CategoryMap data={{ ...data, imputed: 2 }} title="Gaps" />);
    expect(text(plotView(gaps))).toContain("the two axes hold 88% of the variance; 2 pairs were not scored and sit at the largest distance.");
    expect(tableRows(tableView(gaps))[0]).toEqual(["Map stress 0.09 (fair) · two axes hold 88% · 2 pairs not scored, at the largest distance"]);
    const one = render(<CategoryMap data={{ ...data, imputed: 1 }} title="Gap" />);
    expect(text(plotView(one))).toContain("; 1 pair was not scored and sits at the largest distance.");
  });

  it("reads stress the way Kruskal did", () => {
    expect([0, 0.04, 0.09, 0.15, 0.3].map(stressReading)).toEqual(["excellent", "good", "fair", "poor", "unreliable"]);
  });

  it("swaps in a compact map below sm, and draws only that at half width", () => {
    expect(plotView(html)).toContain('data-category-map="compact"');
    const half = render(<CategoryMap data={data} width={328} title="Half" />);
    expect(plotView(half)).not.toContain('data-layout="wide"');
    expect(plotView(half)).toContain('viewBox="0 0 328 280"');
  });

  it("lists every entity, the near-substitutes and the omissions in the table view", () => {
    const table = tableView(html);
    expect(tableHeads(table)).toEqual(["Entity", "Nearest peer", "Audience similarity", "Cluster", "Map x", "Map y"]);
    const rows = tableRows(table);
    expect(rows[0]).toEqual(["Map stress 0.09 (fair) · two axes hold 88%"]);
    // The subject sits left of centre and above it.
    expect(rows[1]).toEqual(["Juniper Cola (subject)", "Brand Alpha", "0.82", "Colas", "−0.04", "0.08"]);
    expect(rows.filter((r) => r.length > 1 && r[1] === "mutual nearest").map((r) => r[0])).toEqual([
      "Brand Alpha ↔ Brand Beta",
      "Saltmarsh Seltzer ↔ Tidewell Water",
      "Kettle Ridge Tonic ↔ Larkspur Kombucha",
    ]);
    expect(rows.at(-1)).toEqual(["Brand Gamma", "not scored", "not scored", "", "", ""]);
  });

  it("holds a fixture consistent with its similarity matrix: stress, nearest peers, near-substitutes", () => {
    const d = TASTE_MAP_SIMILARITY.map((row) => row.map((s) => (s === null ? 0 : 1 - s)));
    let residual = 0;
    let total = 0;
    data.points.forEach((a, i) =>
      data.points.forEach((b, j) => {
        if (j <= i) return;
        const map = Math.hypot(a.x - b.x, a.y - b.y);
        residual += (d[i]![j]! - map) ** 2;
        total += d[i]![j]! ** 2;
      }),
    );
    expect(Math.sqrt(residual / total)).toBeCloseTo(data.stress, 2);
    const subs = computeSubstitution({ refs: data.points.map((p) => p.key), targetIndex: 0, sim: TASTE_MAP_SIMILARITY });
    expect(subs.nearSubstitutes.map(([i, j]) => `${data.points[i]!.key}-${data.points[j]!.key}`)).toEqual(data.links.map((l) => `${l.a}-${l.b}`));
    data.points.forEach((p, i) => {
      const row = TASTE_MAP_SIMILARITY[i]!;
      expect(p.nearest?.value).toBe(Math.max(...row.filter((s): s is number => s !== null)));
    });
  });
});
