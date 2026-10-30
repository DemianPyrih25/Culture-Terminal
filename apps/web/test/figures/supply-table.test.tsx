// SupplyTable (kind Supply: R6, D46): OpenStreetMap counts per area and type, against the city in words,
// street activity, the mix lists, named places, the floor caveat and the © OpenStreetMap credit. The
// fixture is invented (example place names and ids).
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DatasetEnvelope, supplySourceLine, type SupplyPayload } from "@ct/contracts";
import { Exhibit } from "../../components/figures";
import { supplyAreas } from "../../components/figures/fixtures";
import { DENSITY_ABOUT_LEVEL, perKm2Text, SupplyTable, supplyCaption, supplyScopeLine, supplyTableSpec, vsCityText } from "../../components/figures/supply-table";
import { LiftMapCard, osmMapPlaces, OSM_LAYER_LABEL } from "../../components/figures/lift-map-card";
import { standingLiftMap } from "../../components/figures/fixtures";
import { text } from "./markup";

vi.mock("server-only", () => ({}));

const data = supplyAreas.payload;

describe("the words", () => {
  it("reads an index against the city, with the about-level band", () => {
    expect(vsCityText(1)).toBe("about the city's level");
    expect(vsCityText(DENSITY_ABOUT_LEVEL.low)).toBe("about the city's level");
    expect(vsCityText(DENSITY_ABOUT_LEVEL.high)).toBe("about the city's level");
    expect(vsCityText(2.1)).toBe("more than the city (2.1×)");
    expect(vsCityText(0.4)).toBe("less than the city (0.4×)");
    expect(vsCityText(null)).toBe("no city comparison");
  });

  it("keeps the band equal to the one quant computes with, once quant exports it", async () => {
    const quant = (await import("@ct/quant")) as Record<string, unknown>;
    const about = quant.ABOUT_LEVEL as { densityIndexLow: number; densityIndexHigh: number } | undefined;
    if (about) expect([about.densityIndexLow, about.densityIndexHigh]).toEqual([DENSITY_ABOUT_LEVEL.low, DENSITY_ABOUT_LEVEL.high]);
  });

  it("prints densities and the scope", () => {
    expect(perKm2Text(4.5)).toBe("4.5 per km²");
    expect(perKm2Text(0.17)).toBe("0.17 per km²");
    expect(perKm2Text(null)).toBeNull();
    expect(supplyScopeLine(data)).toBe("Areas in Austin");
    const market: SupplyPayload = { ...data, scope: "market", metro: null, market: "austin", radiusKm: 5, rows: [{ ...data.rows[0]!, id: "austin", name: "Austin" }] };
    expect(supplyScopeLine(market)).toBe("Within 5 km of the centre of Austin");
  });
});

describe("the figure", () => {
  const html = renderToStaticMarkup(<SupplyTable title={supplyAreas.title} data={data} formulaId="osm.count" />);

  it("draws each area with each type's count, density and comparison, and street activity", () => {
    const t = text(html);
    expect(html).toContain('data-supply-scope="areas"');
    expect(html.match(/data-supply-row="/g)).toHaveLength(data.rows.length);
    expect(t).toContain("18 places · 4.5 per km² · more than the city (2.1×)");
    expect(t).toContain("6 places · 1.2 per km² · less than the city (0.6×)");
    expect(t).toContain("9 places · 1.5 per km² · about the city's level");
    expect(t).toContain("Street activity: 35.0 per km² (140 shops, food and drink places)");
  });

  it("marks a named area, lists what the area has more and less of, and the named places with OSM links", () => {
    const t = text(html);
    expect(t).toContain("You named");
    expect(t).toContain("Has more of than the city");
    expect(t).toContain("Record shops3 · 3.4× the city");
    expect(t).toContain("Has less of than the city");
    expect(t).toContain("Nothing stands out.");
    expect(html).toContain('href="https://www.openstreetmap.org/node/1000000001"');
    expect(t).toContain("Named places (3)");
  });

  it("states that counts are a floor and carries the source line with the licence link", () => {
    const t = text(html);
    expect(t).toContain(supplyCaption(data));
    expect(t).toContain("counts are a floor, not a census");
    expect(t).toContain(supplySourceLine(data.osmBase));
    expect(t).toContain("© OpenStreetMap contributors (ODbL)");
    expect(html).toContain('href="https://www.openstreetmap.org/copyright"');
    expect(html).toContain('href="/method#osm.count"');
  });

  it("says the floor and the source once when the skill's caption repeats them", () => {
    const repeated: SupplyPayload = {
      ...data,
      caption: `${supplySourceLine(data.osmBase)}. ${data.completeness} Counts are of mapped places, not sales, rents or foot traffic.`,
    };
    const caption = supplyCaption(repeated);
    expect(caption).toBe(`${data.completeness} Counts are of mapped places, not sales, rents or foot traffic.`);
    const t = text(renderToStaticMarkup(<SupplyTable data={repeated} title="Cafés" />));
    expect(t.split("counts are a floor, not a census").length - 1).toBe(1);
    expect(t.split("Culture Terminal analysis").length - 1).toBe(1);
  });

  it("has a table view with every count, density and index, and the city reference marked approximate", () => {
    const spec = supplyTableSpec(data, "Cafés");
    expect(spec.columns.map((c) => c.label)).toContain("Cafés and coffee shops: vs city (1 = city level)");
    expect(spec.rows.some((r) => "section" in r && /approximate/.test(r.section))).toBe(true);
    const failed: SupplyPayload = { ...data, rows: [{ ...data.rows[0]!, counts: { ...data.rows[0]!.counts, cafe: null } }] };
    expect(text(renderToStaticMarkup(<SupplyTable title="x" data={failed} />))).toContain("count failed");
  });

  it("is the Supply kind's family in the exhibit, and its fixture parses", () => {
    expect(() => DatasetEnvelope.parse(supplyAreas)).not.toThrow();
    expect(renderToStaticMarkup(<Exhibit dataset={supplyAreas} />)).toContain('data-supply-scope="areas"');
  });
});

describe("the lift map's OpenStreetMap layer", () => {
  it("offers the layer when a supply read of the same city has named places, off by default", () => {
    expect(osmMapPlaces(data)).toHaveLength(3);
    expect(osmMapPlaces(null)).toEqual([]);
    const card = renderToStaticMarkup(<LiftMapCard data={standingLiftMap.payload} osm={data} interactive={false} outlinesUrl={null} />);
    expect(card).toContain(OSM_LAYER_LABEL);
    expect(card).toContain('data-osm-toggle="true"');
    expect(card).not.toContain('data-osm-place="true"');
    expect(renderToStaticMarkup(<LiftMapCard data={standingLiftMap.payload} interactive={false} outlinesUrl={null} />)).not.toContain(OSM_LAYER_LABEL);
  });
});
