// Popular next to hidden areas (R7, D50): the two lists, the area table with both ranks, the standing and
// the OpenStreetMap columns, the map's outlined "already popular" pins in both layers, and nothing for a map
// stored before Part 11. Fixtures are invented.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { HIDDEN_AREAS_LABEL, POPULAR_AREAS_LABEL, type GeoLiftPayload } from "@ct/contracts";
import { austinLiftMap, coarseLiftMap, standingLiftMap, supplyAreas } from "../../components/figures/fixtures";
import { LiftMap, liftTableSpec } from "../../components/figures/lift-map";
import { LiftMapCard } from "../../components/figures/lift-map-card";
import { PIN_KEY_TEXT } from "../../components/figures/lift-map-parts";
import { flagText, mapPins, popularPins } from "../../components/figures/lift-scale";
import { AreaStandingCard, hasStanding, standingModel, standingTableSpec, supplyForMap } from "../../components/figures/lift-standing";
import { text } from "./markup";

vi.mock("server-only", () => ({}));

const data = standingLiftMap.payload;

describe("the standing model", () => {
  it("lists the popular areas by raw interest and the hidden pockets by demand, from the payload", () => {
    const model = standingModel(data, supplyAreas.payload)!;
    expect(data.popular?.length).toBeGreaterThan(0);
    expect(data.hidden?.length).toBeGreaterThan(0);
    expect(model.popular.map((a) => a.id)).toEqual(data.popular);
    expect(model.hidden.map((a) => a.id)).toEqual(data.hidden);
    for (const a of model.popular) expect(a.rawRank?.[0]).toBeLessThanOrEqual(Math.ceil(data.neighbourhoods.length / 4) + 1);
    expect(model.withOsm).toBe(true);
  });

  it("puts the named area first and ranks every area by all interest", () => {
    const model = standingModel(data)!;
    expect(model.rows[0]?.chip).toBe("You named");
    const ranks = model.rows.slice(1).flatMap((r) => (r.rawRank ? [r.rawRank[0]] : []));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });

  it("reads similar places and street activity from the OpenStreetMap read of the same city only", () => {
    expect(supplyForMap(data, [supplyAreas.payload])).toBe(supplyAreas.payload);
    expect(supplyForMap({ metro: "denver" }, [supplyAreas.payload])).toBeNull();
    const model = standingModel(data, supplyAreas.payload)!;
    const first = model.rows.find((r) => r.id === supplyAreas.payload.rows[0]!.id)!;
    expect(first.osmPlaces).toBe(21);
    expect(first.osmActivityPerKm2).toBe(35);
  });

  it("is absent for a map stored before Part 11 and for a coarse map", () => {
    expect(hasStanding(austinLiftMap.payload)).toBe(false);
    expect(standingModel(austinLiftMap.payload)).toBeNull();
    expect(standingModel({ ...coarseLiftMap.payload, popular: ["x"] })).toBeNull();
    expect(renderToStaticMarkup(<AreaStandingCard data={austinLiftMap.payload} />)).toBe("");
  });
});

describe("the standing card", () => {
  const html = renderToStaticMarkup(<AreaStandingCard data={data} supply={supplyAreas.payload} />);

  it("shows both lists above the table, and says what each one measures", () => {
    const t = text(html);
    expect(t).toContain(POPULAR_AREAS_LABEL);
    expect(t).toContain(HIDDEN_AREAS_LABEL);
    expect(html.indexOf(POPULAR_AREAS_LABEL)).toBeLessThan(html.indexOf('data-standing-table="true"'));
    expect(t).toContain("Hidden pockets have high extra interest for their size but little interest overall");
  });

  it("has the columns raw rank, lift, standing, similar places and street activity, with the OSM credit", () => {
    const spec = standingTableSpec(standingModel(data, supplyAreas.payload)!, "Areas");
    expect(spec.columns.map((c) => c.label)).toEqual([
      "Area",
      "Rank by all interest",
      "Extra interest (lift)",
      "Standing",
      "Similar places (OpenStreetMap)",
      "Street activity per km²",
    ]);
    expect(text(html)).toContain("© OpenStreetMap contributors (ODbL)");
    expect(standingTableSpec(standingModel(data)!, "Areas").columns).toHaveLength(4);
  });

  it("stacks the table into one labelled card per area on a phone, hidden from md up, with the table hidden below md", () => {
    expect(html).toMatch(/class="[^"]*max-md:hidden[^"]*" data-standing-table="true"/);
    expect(html).toMatch(/class="[^"]*md:hidden[^"]*"[^>]*data-standing-rows="true"/);
    const rows = html.split('data-standing-rows="true"')[1] ?? "";
    const model = standingModel(data, supplyAreas.payload)!;
    expect((rows.match(/<li /g) ?? []).length).toBe(model.rows.length);
    expect(text(rows)).toContain("Rank by all interest");
    expect(text(rows)).toContain("Similar places (OpenStreetMap)");
  });
});

describe("on the map", () => {
  it("pins the popular areas with an outlined mark beside the numbered pins, in both layers", () => {
    const pins = mapPins(data, 3);
    const popular = popularPins(data, pins);
    expect(popular.every((p) => p.popular && !pins.some((q) => q.id === p.id))).toBe(true);
    for (const mode of ["LIFT", "RAW"] as const) {
      const card = renderToStaticMarkup(<LiftMapCard data={data} initialMode={mode} interactive={false} outlinesUrl={null} />);
      if (popular.length > 0) expect(card).toContain("data-popular-pin=");
      expect(card).toContain('data-popular-list="true"');
    }
    expect(popularPins(austinLiftMap.payload)).toEqual([]);
  });

  it("flags a hidden numbered pin and a popular pin in words", () => {
    expect(flagText({ lift: 1.42, hidden: true })).toBe("1.42× interest · hidden pocket");
    expect(flagText({ lift: 1, popular: true })).toBe("Already popular");
    expect(flagText({ lift: 1.2 })).toBe("1.20× interest");
    const hiddenPin = mapPins(data, 10).find((p) => p.hidden);
    if (hiddenPin) expect(renderToStaticMarkup(<LiftMapCard data={data} interactive={false} outlinesUrl={null} />)).toContain("Hidden pocket");
  });

  it("explains both pins in the caption, and adds standing columns to the lift table", () => {
    const html = renderToStaticMarkup(<LiftMap data={data} title="Lift" interactive={false} outlinesUrl={null} />);
    expect(text(html)).toContain(PIN_KEY_TEXT);
    const spec = liftTableSpec(data, "Lift");
    expect(spec.columns.map((c) => c.label)).toContain("Rank by all interest");
    expect(liftTableSpec(austinLiftMap.payload as GeoLiftPayload, "Lift").columns.map((c) => c.label)).not.toContain("Rank by all interest");
  });
});
