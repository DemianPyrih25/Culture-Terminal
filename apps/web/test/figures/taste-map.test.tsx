// TasteMap (Category Taste Map): one scale for both axes, the subject ringed, hub as dot size, the
// stress caption, unscored pairs and unplaced entities spelled out, a table view, a phone layout, and
// three points listed rather than drawn.
import { TasteMapPayload } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { Exhibit, TasteMap, dotRadius, stressText, tasteMapCaption, tasteMapModel, tasteMapTableSpec } from "../../components/figures";
import { FIXTURE_SOURCES, tasteMap, tasteMapThree } from "../../components/figures/fixtures";
import { plotView, render, tableHeads, tableRows, tableView, text } from "./markup";

const data = tasteMap.payload;
const html = render(
  <TasteMap data={data} title="Juniper Cola sits apart from its peers" source={FIXTURE_SOURCES.tasteMap} formulaId="taste_map_mds" />,
);

describe("tasteMapModel", () => {
  const wide = tasteMapModel(data, { width: 680, height: 340 });
  const narrow = tasteMapModel(data, { width: 340, height: 320 });

  it("uses one scale for both axes, so map distance keeps its ratio in every direction", () => {
    for (const model of [wide, narrow]) {
      const [a, b] = [model.points[0]!, model.points[5]!];
      const [pa, pb] = [data.points[0]!, data.points[5]!];
      const ratio = Math.hypot(a.cx - b.cx, a.cy - b.cy) / Math.hypot(pa.x - pb.x, pa.y - pb.y);
      expect(ratio).toBeCloseTo(model.scale, 0);
      // y up: the higher point in the data is higher on the page.
      expect(model.points[3]!.cy).toBeLessThan(model.points[5]!.cy);
    }
  });

  it("keeps every dot inside the plot frame, at both sizes", () => {
    for (const model of [wide, narrow]) {
      for (const p of model.points) {
        expect(p.cx - p.r).toBeGreaterThanOrEqual(0);
        expect(p.cx + p.r).toBeLessThanOrEqual(model.width);
        expect(p.cy - p.r).toBeGreaterThanOrEqual(0);
        expect(p.cy + p.r).toBeLessThanOrEqual(model.plotBottom);
      }
    }
  });

  it("labels the subject first and never overlaps two labels; the 340 px layout keeps most labels", () => {
    for (const model of [wide, narrow]) {
      expect(model.labels[0]).toMatchObject({ key: "R1", target: true });
      for (const l of model.labels) expect(l.x).toBeGreaterThanOrEqual(0);
    }
    expect(wide.labels).toHaveLength(6);
    expect(narrow.labels.length).toBeGreaterThanOrEqual(4);
  });

  it("sizes dots by hub (larger = hub) and gives an unmeasured hub the neutral size", () => {
    expect(dotRadius(1)).toBeGreaterThan(dotRadius(0.2));
    expect(dotRadius(null)).toBe(4.5);
    const alpha = wide.points.find((p) => p.key === "R2")!;
    const ale = wide.points.find((p) => p.key === "R6")!;
    expect(alpha.r).toBeGreaterThan(ale.r);
  });

  it("draws a scale bar of a nice taste distance at the plot's scale", () => {
    expect(wide.scaleBar).not.toBeNull();
    const bar = wide.scaleBar!;
    expect(bar.text).toMatch(/^0?\.\d+ less similar$|^\d.* less similar$/);
    const step = Number(bar.text.split(" ")[0]);
    expect(bar.length).toBeCloseTo(step * wide.scale, 1);
  });

  it("is deterministic and survives coincident points", () => {
    expect(tasteMapModel(data, { width: 680, height: 340 })).toEqual(wide);
    const same = TasteMapPayload.parse({ ...data, points: data.points.slice(0, 4).map((p) => ({ ...p, x: 0, y: 0 })), k: 4, imputedPairs: [] });
    const model = tasteMapModel(same, { width: 340, height: 320 });
    expect(model.scaleBar).toBeNull();
    for (const p of model.points) expect(p.cx).toBe(170);
  });
});

describe("TasteMap", () => {
  it("is an image with an accessible title, no axes, the subject ringed and every label", () => {
    const plot = plotView(html);
    expect(plot).toContain('role="img"');
    expect(plot).toContain("<title>Juniper Cola sits apart from its peers</title>");
    expect(plot).toMatch(/data-point="R1" data-tone="target"/);
    for (const p of data.points) expect(text(plot)).toContain(p.label);
    expect(plot).toContain('data-scale-bar="true"');
  });

  it("draws a wide layout and a 340 px phone layout, one shown per breakpoint", () => {
    const plot = plotView(html);
    expect(plot).toMatch(/class="max-md:hidden" data-layout="wide"/);
    expect(plot).toMatch(/class="md:hidden" data-layout="narrow"/);
    expect(plot).toContain('viewBox="0 0 340 320"');
  });

  it("captions the stress and the honest reading, and spells out unscored pairs and unplaced entities", () => {
    expect(tasteMapCaption(data)).toBe(
      "Positions show audience taste similarity (relative, not sales or switching); stress 0.07 (fair fit).",
    );
    expect(html).toContain('data-fixed-caption="true"');
    const plot = text(plotView(html));
    expect(plot).toContain("Unscored pairs, drawn at the largest scored distance: Saltmarsh Seltzer – Granite Hollow Ale");
    expect(plot).toContain("Not placed: Brand Kappa (dropped by Qloo)");
    expect(plot).toContain("the axes have no meaning");
    expect(text(html)).toContain("Larger dot: hub, close to many");
  });

  it("words the stress on Kruskal's scale", () => {
    expect(stressText(0.03)).toBe("stress 0.03 (good fit)");
    expect(stressText(0.15)).toMatch(/rough fit/);
    expect(stressText(0.31)).toMatch(/poor fit/);
  });

  it("lists every point by distance to the subject, then the unplaced ones, in the table view", () => {
    const table = tableView(html);
    expect(tableHeads(table)).toEqual([
      "Name",
      "Map distance to Juniper Cola",
      "Nearest on the map",
      "Map distance to nearest",
      "Hub score",
      "x",
      "y",
    ]);
    const rows = tableRows(table);
    expect(rows[0]![0]).toBe("Juniper Cola (subject)");
    expect(rows[1]![0]).toBe("Brand Alpha");
    expect(rows[1]![2]).toBe("Juniper Cola");
    expect(rows).toHaveLength(7);
    expect(rows[6]).toEqual(expect.arrayContaining(["Brand Kappa", "not placed"]));
    expect(rows[0]![4]).toMatch(/not measured/);
  });

  it("lists three entities instead of drawing a map, and says why", () => {
    const three = render(<Exhibit dataset={tasteMapThree} />);
    const plot = plotView(three);
    expect(plot).not.toContain("<svg");
    expect(text(plot)).toContain("Only 3 entities could be placed. Any 3 distances fit a flat map exactly");
    expect(tasteMapCaption(tasteMapThree.payload)).toMatch(/3 entities are too few to map\.$/);
    expect(tableRows(tableView(three))).toHaveLength(3);
    // The screener map has no subject column when no point is the target.
    const spec = tasteMapTableSpec({ ...tasteMapThree.payload, points: tasteMapThree.payload.points.map((p) => ({ ...p, target: false })) }, "t");
    expect(spec.columns.map((c) => c.label)).not.toContain("Map distance to Juniper Cola");
  });

  it("is what Exhibit draws for a TasteMap envelope, with its method link", () => {
    const viaExhibit = render(<Exhibit dataset={tasteMap} />);
    expect(viaExhibit).toContain('data-point="R1"');
    expect(viaExhibit).toContain("/method#taste_map_mds");
  });
});
