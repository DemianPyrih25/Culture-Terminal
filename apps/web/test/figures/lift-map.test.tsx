// LiftMap: the server render is a static schematic with the "Extra interest | All interest" switch,
// numbered pins with flags, the ramp legend and the boundary source; the WebGL map code is never in the server render or
// in the static import graph. The table view lists every neighbourhood with its lift or its reason.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { DivergingBars, LiftMap, geoLiftBars, liftCaption, liftTableSpec } from "../../components/figures";
import type { ShortcutKeyEvent } from "../../components/ui/shortcut";
import { modeForKey, modeForKeyEvent } from "../../components/figures/lift-map-view";
import { FIXTURE_SOURCES, austinLiftMap, coarseLiftMap } from "../../components/figures/fixtures";
import { decode, plotView, render, rowMarkup, tableHeads, tableRows, tableView, text } from "./markup";

// /method ships in Part 7; these tests pin the link each figure will carry then.
vi.mock("@/lib/routes", () => ({ ROUTE_LIVE: { method: true, following: false } }));

const data = austinLiftMap.payload;
const html = render(
  <LiftMap
    data={data}
    title="The fit sits east of the interstate"
    caption="Lift vs the restaurant baseline."
    source={FIXTURE_SOURCES.heatmap}
    formulaId="lift.area"
  />,
);
const FIGURES = path.join(import.meta.dirname, "..", "..", "components", "figures");

describe("LiftMap · server render", () => {
  it("draws the schematic: every lift cell, the venue sample, the labelled markers", () => {
    const plot = plotView(html);
    expect(plot).toContain('data-schematic="LIFT"');
    expect(plot).toContain('role="img"');
    const lifted = data.cells.filter((c) => c.lift !== null).length;
    expect([...plot.matchAll(/data-cell="/g)]).toHaveLength(lifted);
    expect([...plot.matchAll(/data-supply="true"/g)]).toHaveLength(data.supply!.points.length);
    const top = data.neighbourhoods[0]!;
    expect(plot).toContain(`data-marker="${top.id}"`);
    expect(text(plot)).toContain(`${top.name}${top.lift!.toFixed(2)}×`);
    // A neighbourhood without a lift is never labelled on the map.
    expect(plot).not.toContain('data-marker="holly"');
  });

  it("offers Extra interest and All interest, extra interest first, with the ramp legend", () => {
    const plot = plotView(html);
    expect(plot).toContain('role="radiogroup" aria-label="Map layer: The fit sits east of the interstate"');
    expect(plot).toMatch(/aria-checked="true"[^>]*>Extra interest</);
    expect(plot).toMatch(/aria-checked="false"[^>]*>All interest</);
    expect(text(plot)).toContain("More interest than a typical area");
    expect(plot).toContain('data-precision="6"');
    expect(text(plot)).not.toContain("Rough areas only");
  });

  it("pins the three areas with the most extra interest, numbered, with flags", () => {
    const plot = plotView(html);
    const pins = [...plot.matchAll(/data-pin="(\d)"/g)].map((m) => m[1]);
    expect(pins).toEqual(["1", "2", "3"].slice(0, pins.length));
    expect(pins.length).toBeGreaterThan(0);
    expect(text(plot)).toMatch(/\d\.\d\d× interest/);
  });

  it("maps keys to modes", () => {
    expect(modeForKey("1")).toBe("RAW");
    expect(modeForKey("2")).toBe("BASE");
    expect(modeForKey("3")).toBe("LIFT");
    expect(modeForKey("4")).toBeNull();
    expect(modeForKey("l")).toBeNull();
  });

  it("switches mode on a bare 1/2/3 pressed in the figure, never on a modified key or while typing", () => {
    const key = (k: string, extra: Partial<ShortcutKeyEvent> = {}): ShortcutKeyEvent => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, ...extra });
    const button = { tagName: "BUTTON" };
    expect(modeForKeyEvent(key("1"), button)).toBe("RAW");
    expect(modeForKeyEvent(key("2"), { tagName: "CANVAS" })).toBe("BASE");
    expect(modeForKeyEvent(key("3"), null)).toBe("LIFT");
    expect(modeForKeyEvent(key("1", { ctrlKey: true }), button)).toBeNull();
    expect(modeForKeyEvent(key("1", { metaKey: true }), button)).toBeNull();
    expect(modeForKeyEvent(key("1", { altKey: true }), button)).toBeNull();
    expect(modeForKeyEvent(key("1", { isComposing: true }), button)).toBeNull();
    expect(modeForKeyEvent(key("1", { defaultPrevented: true }), button)).toBeNull();
    expect(modeForKeyEvent(key("1"), { tagName: "INPUT", type: "search" })).toBeNull();
    expect(modeForKeyEvent(key("1"), { tagName: "DIV", isContentEditable: true })).toBeNull();
    expect(modeForKeyEvent(key("4"), button)).toBeNull();
  });

  it("starts on all interest when asked, keeping the same pins", () => {
    const raw = plotView(render(<LiftMap data={data} title="Raw" initialMode="RAW" />));
    expect(raw).toContain('data-schematic="RAW"');
    expect(raw).toContain('data-mode="RAW"');
    expect(raw).toMatch(/aria-checked="true"[^>]*>All interest</);
    expect([...raw.matchAll(/<g data-chip="[^"]+">/g)].length).toBeGreaterThan(0);
    expect(text(raw)).toContain("More interest");
  });

  it("never renders the WebGL map on the server", () => {
    expect(html).not.toContain("maplibregl");
    expect(html).not.toContain("<canvas");
  });

  it("prints the fixed caption with the boundary source", () => {
    expect(liftCaption(data)).toBe(`${data.caption}. Boundaries: ${data.boundarySource}.`);
    expect(decode(html)).toContain(`data-fixed-caption="true">${liftCaption(data)}<`);
  });
});

describe("LiftMap · coarse", () => {
  const coarse = render(<LiftMap data={coarseLiftMap.payload} title="Coarse" />);

  it("notes the map is too coarse and makes no neighbourhood claims", () => {
    const plot = plotView(coarse);
    expect(text(plot)).toContain("Rough areas only: too coarse to compare neighbourhoods");
    expect(plot).toContain("text-caution-ink");
    expect(plot).not.toContain("data-marker=");
    expect(plot).not.toContain("data-chip=");
  });

  it("opens on RAW, where its cells carry no confidence", () => {
    const plot = plotView(coarse);
    expect(plot).toContain('data-mode="RAW"');
    expect(plot).toContain('data-schematic="RAW"');
    expect(plot).toMatch(/aria-checked="true"[^>]*>All interest</);
  });

  it("still shows where lift sits when switched to LIFT", () => {
    const plot = plotView(render(<LiftMap data={coarseLiftMap.payload} title="Coarse lift" initialMode="LIFT" />));
    const opacities = [...plot.matchAll(/<rect [^>]*fill-opacity="([\d.]+)"[^>]*data-cell=/g)].map((m) => Number(m[1]));
    expect(opacities).toHaveLength(coarseLiftMap.payload.cells.length);
    expect(opacities.every((o) => o > 0)).toBe(true);
  });

  it("explains every missing lift in the table view", () => {
    const rows = tableRows(tableView(coarse));
    expect(rows[0]).toEqual(["East Cesar Chavez", "location too coarse", "location too coarse", "0", "location too coarse"]);
  });
});

describe("LiftMap · table view", () => {
  it("lists every neighbourhood, lifts first, with supply and white space, then the cells", () => {
    const table = tableView(html);
    expect(tableHeads(table)).toEqual([
      "Neighbourhood",
      "Lift vs restaurants",
      "Confidence",
      "Gated cells",
      "Demand pctl",
      "Supply pctl",
      "Venues",
      "White space",
      "Quadrant",
    ]);
    const rows = tableRows(table);
    const first = data.neighbourhoods[0]!;
    expect(rows[0]![0]).toBe(first.name);
    expect(rows[0]![1]).toBe(`${first.lift!.toFixed(2)}×`);
    const holly = rows.find((r) => r[0] === "Holly")!;
    expect(holly[1]).toBe("too few cells");
    expect(rows.find((r) => r[0] === "Cells")).toBeDefined();
    expect(rows.at(-1)![0]).toBe(`${data.cells.length} geohash-6 cells, ${data.cells.filter((c) => c.gated).length} past the gate`);
  });

  it("drops the supply columns when no sample was taken", () => {
    const spec = liftTableSpec({ ...data, supply: null }, "Lift");
    expect(spec.columns.map((c) => c.label)).not.toContain("Venues");
    for (const row of spec.rows) if ("cells" in row) expect(row.cells).toHaveLength(5);
  });
});

describe("geoLiftBars", () => {
  it("turns neighbourhood lifts into a one-series dot plot around 1.00 that keeps the reasons", () => {
    const bars = geoLiftBars(data);
    expect(bars.baseline).toBe(1);
    expect(bars.unit).toBe("lift");
    expect(bars.groups[0]!.bars).toHaveLength(data.neighbourhoods.length);
    expect(bars.groups[0]!.bars.find((b) => b.key === "holly")!.values[0]).toEqual({ value: null, reason: "insufficient_n" });
    expect(geoLiftBars(coarseLiftMap.payload).groups[0]!.bars).toEqual([]);
    const dots = plotView(render(<DivergingBars data={bars} display="dumbbell" title="Dots" />));
    // A dot below the baseline is drawn in the negative colour, one above in the data colour.
    const low = data.neighbourhoods.filter((n) => n.lift !== null).at(-1)!;
    expect(rowMarkup(dots, low.id)).toContain("fill-second");
    expect(rowMarkup(dots, data.neighbourhoods[0]!.id)).toMatch(/<circle[^>]*class="fill-accent"/);
    expect(text(rowMarkup(dots, "holly"))).toContain("too few cells");
  });
});

describe("map code stays out of every static bundle", () => {
  it("is reached only through a dynamic import", () => {
    const view = readFileSync(path.join(FIGURES, "lift-map-view.tsx"), "utf8");
    expect(view).toContain('import("./lift-map-canvas")');
    // Only types are imported statically; they are erased.
    expect(view).not.toMatch(/^import (?!type )[^;]*from "\.\/lift-map-canvas";/m);
    const area = readFileSync(path.join(FIGURES, "area-map.tsx"), "utf8");
    expect(area).toContain('import("./area-map-canvas")');
    expect(area).not.toMatch(/^import (?!type )[^;]*from "\.\/area-map-canvas";/m);
    for (const file of [
      "index.ts",
      "lift-map.tsx",
      "lift-map-card.tsx",
      "lift-map-parts.tsx",
      "area-map.tsx",
      "area-map-shape.ts",
      "exhibit.tsx",
      "lift-map-schematic.tsx",
      "lift-scale.ts",
    ]) {
      const source = readFileSync(path.join(FIGURES, file), "utf8");
      expect(source, file).not.toMatch(/from "(maplibre-gl|@deck\.gl\/[a-z-]+)"/);
      expect(source, file).not.toMatch(/from "\.\/lift-map-canvas"/);
      expect(source, file).not.toMatch(/^import (?!type )[^;]*from "\.\/(map-base|area-map-canvas)";/m);
    }
  });

  it("names the Positron basemap and its three credits in the shared map module", () => {
    // The rendered attribution and when it shows are tested in lift-map-canvas.test.tsx.
    const canvas = readFileSync(path.join(FIGURES, "map-base.tsx"), "utf8");
    expect(canvas).toContain('BASEMAP_STYLE = "https://tiles.openfreemap.org/styles/positron"');
    for (const credit of ["© OpenFreeMap", "© OpenMapTiles", "© OpenStreetMap contributors"]) expect(canvas).toContain(credit);
  });
});
