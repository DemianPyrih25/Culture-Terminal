// The redesign's maps: the site_selection map card (pins, the extra-interest switch, the top three with
// "Few rivals nearby"), the area map's outline geometry and static drawing, and the outline lookup by
// name. Server markup only; the WebGL canvases load in the browser. Invented outline, fixture lift data.
import { describe, expect, it } from "vitest";
import {
  AreaMap,
  AreaSchematic,
  CORNER_LABEL,
  LiftMapCard,
  MAP_CARD_TITLE,
  areaMapCaption,
  fewRivals,
  fitProjection,
  flagValue,
  mapPins,
  outlineBounds,
  outlinePath,
} from "../../components/figures";
import { findOutline, type OutlineFeature } from "../../components/figures/lift-outlines";
import { austinLiftMap, coarseLiftMap } from "../../components/figures/fixtures";
import { render, text } from "./markup";

const square: OutlineFeature = {
  type: "Feature",
  id: "zip-00001",
  properties: { id: "zip-00001", name: "ZIP 00001 (Fernhill)", centroid: [-86.75, 36.18] },
  geometry: {
    type: "Polygon",
    coordinates: [
      [
        [-86.8, 36.15],
        [-86.7, 36.15],
        [-86.7, 36.21],
        [-86.8, 36.21],
        [-86.8, 36.15],
      ],
    ],
  },
};

describe("map pins", () => {
  const data = austinLiftMap.payload;

  it("pins at most three areas above a typical one, best first, numbered from 1", () => {
    const pins = mapPins(data);
    expect(pins.length).toBeGreaterThan(0);
    expect(pins.length).toBeLessThanOrEqual(3);
    expect(pins.map((p) => p.rank)).toEqual(pins.map((_, i) => i + 1));
    for (const p of pins) expect(p.lift).toBeGreaterThan(1);
    for (let i = 1; i < pins.length; i += 1) expect(pins[i - 1]!.lift).toBeGreaterThanOrEqual(pins[i]!.lift);
  });

  it("marks few rivals where demand is high and similar venues are few", () => {
    expect(fewRivals({ quadrant: "LATENT_OPEN" })).toBe(true);
    expect(fewRivals({ quadrant: "SATURATED" })).toBe(false);
    expect(fewRivals({ quadrant: null })).toBe(false);
  });

  it("pins nothing on a coarse map", () => {
    expect(mapPins(coarseLiftMap.payload)).toEqual([]);
  });

  it("writes the flag value as interest", () => {
    expect(flagValue(1.423)).toBe("1.42× interest");
  });
});

describe("LiftMapCard", () => {
  const html = render(<LiftMapCard data={austinLiftMap.payload} interactive={false} />);

  it("pairs the map with its panel: kind, title, the layer switch and the top areas", () => {
    expect(html).toContain('data-map-card="austin"');
    expect(text(html)).toContain("Where interest is highest");
    expect(html).toMatch(new RegExp(`<h3[^>]*>${MAP_CARD_TITLE}</h3>`));
    expect(html).toMatch(/aria-expanded="false"[^>]*>[\s\S]*Extra interest<\/button>/);
    const pins = mapPins(austinLiftMap.payload);
    for (const p of pins) expect(text(html)).toContain(`${p.name}${flagValue(p.lift)}`);
    const rivals = pins.filter((p) => p.fewRivals).length;
    expect([...html.matchAll(/data-tag="few-rivals"/g)]).toHaveLength(rivals);
  });

  it("draws the static map with the legend and keeps every area in a table for screen readers", () => {
    expect(html).toContain('data-schematic="LIFT"');
    expect(text(html)).toContain("More interest than a typical area");
    expect(html).toContain('class="sr-only" data-view="table"');
    expect(html).not.toContain("<canvas");
  });

  it("says plainly when the map is too coarse to rank areas", () => {
    const coarse = render(<LiftMapCard data={coarseLiftMap.payload} interactive={false} />);
    expect(text(coarse)).toContain("No area stands out");
    expect(coarse).toContain('data-mode="RAW"');
  });
});

describe("area map", () => {
  it("finds an outline by id, by exact name, or by a gazetteer label that carries the name", () => {
    expect(findOutline([square], { id: "zip-00001" })).toBe(square);
    expect(findOutline([square], { name: "Fernhill" })).toBe(square);
    expect(findOutline([square], { name: "fernhill " })).toBe(square);
    expect(findOutline([square], { name: "Elsewhere" })).toBeNull();
  });

  it("fits the outline into its box", () => {
    const b = outlineBounds(square.geometry)!;
    expect(b).toEqual([-86.8, 36.15, -86.7, 36.21]);
    const project = fitProjection(b, 552, 388);
    const sw = project({ lon: -86.8, lat: 36.15 });
    const ne = project({ lon: -86.7, lat: 36.21 });
    expect(sw.x).toBeGreaterThanOrEqual(27);
    expect(ne.x).toBeLessThanOrEqual(525);
    expect(sw.y).toBeGreaterThan(ne.y);
    expect(outlinePath(square.geometry, project)).toMatch(/^M[\d.]+ [\d.]+(L[\d.]+ [\d.]+){4}Z$/);
  });

  it("draws the dashed outline, the venues and the corner pin with its flag", () => {
    const html = render(
      <AreaSchematic
        outline={square}
        corner={{ lon: -86.75, lat: 36.18 }}
        cornerLabel={CORNER_LABEL}
        venues={[{ lon: -86.72, lat: 36.19 }]}
        label="Map of Fernhill"
      />,
    );
    expect(html).toContain('stroke-dasharray="5 3"');
    expect(html).toContain('data-corner-pin="true"');
    expect(html).toContain('data-icon="map-pin"');
    expect(text(html)).toContain("Your corner");
    expect([...html.matchAll(/class="fill-ink-3 stroke-surface"/g)]).toHaveLength(1);
  });

  it("renders its footer on the server and waits for the outline in the browser", () => {
    const html = render(<AreaMap metro="nashville" area={{ name: "Fernhill" }} interactive={false} />);
    expect(text(html)).toContain("Your corner, Fernhill");
    expect(text(html)).toContain(areaMapCaption("Fernhill", false));
    expect(html).toContain("animate-pulse");
    const profile = render(<AreaMap metro="nashville" area={{ name: "Fernhill" }} corner={null} venues={[{ lat: 1, lon: 1 }]} />);
    expect(text(profile)).toContain("FernhillOutline: Fernhill boundary. Dots: a sample of venues nearby.");
  });
});
