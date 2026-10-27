// The CLERK area backstop: a gazetteer area CLERK listed as a place mention moves to geo.area.
// Invented areas and entities only (D29).
import { compileMnemonic, type GeoApi, type Mention, type MetroId, type Neighbourhood } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import { areaMentionsToGeo } from "../../src/run/areaMentions";
import { intentFor } from "./support";

const area = (id: string, name: string): Neighbourhood =>
  ({ id, name, centroid: { lat: 30, lon: -97 }, areaKm2: 1 }) as unknown as Neighbourhood;

/** Elm Park (alias "EPK") in austin, Cedar Flats in austin, and a second Cedar Flats in nyc. */
const NAMES: Partial<Record<MetroId, Record<string, Neighbourhood>>> = {
  austin: { "elm park": area("elm_park", "Elm Park"), epk: area("elm_park", "Elm Park"), "lark hill": area("lark_hill", "Lark Hill") },
  nyc: { "lark hill": area("ny_lark_hill", "Lark Hill") },
  chicago: { "willow end": area("willow_end", "Willow End") },
};
const geo: Pick<GeoApi, "matchNeighbourhood"> = {
  matchNeighbourhood: (metro, text) => NAMES[metro]?.[text.trim().toLowerCase()] ?? null,
};

const place = (text: string, role: Mention["role"] = "secondary"): Mention => ({ text, entity_type: "place", role, public_figure: false });

const siteIntent = (mentions: Mention[], metro: MetroId | null = "austin", areaText: string | null = null) =>
  intentFor({
    pillar: "location",
    job: "site_selection",
    mentions,
    geo: { metro, area: areaText, unsupported_place: null, market: null },
    constraints: { concepts: ["ramen counter"], sponsor_categories: [], domains: [], ages: [], notes: [] },
    assumptions: [],
  });

describe("areaMentionsToGeo", () => {
  it("moves a place mention that names a curated place type to constraints.concepts, not the resolution gate", () => {
    const out = areaMentionsToGeo(siteIntent([place("bookstores", "primary"), place("Elm Park")]), geo);
    expect(out.mentions).toEqual([]);
    expect(out.constraints.concepts).toEqual(["ramen counter", "bookstores"]);
    expect(out.geo).toMatchObject({ metro: "austin", area: "Elm Park" });
    expect(out.assumptions[0]).toBe("'bookstores' read as the type of business, not one venue");
    const named = siteIntent([place("Lark Hill Books", "primary")], null);
    expect(areaMentionsToGeo(named, geo)).toBe(named);
  });

  it("moves a place mention that names a gazetteer area to an empty geo.area", () => {
    const out = areaMentionsToGeo(siteIntent([place("Elm Park")]), geo);
    expect(out.mentions).toEqual([]);
    expect(out.geo).toMatchObject({ metro: "austin", area: "Elm Park" });
    expect(out.assumptions).toEqual(["'Elm Park' read as the Austin area Elm Park, not a venue"]);
    expect(out.mnemonic).toBe(compileMnemonic(out));
  });

  it("adds no assumption when CLERK's own already names the area", () => {
    const read = { ...siteIntent([place("Elm Park")]), assumptions: ["Elm Park read as an Austin neighbourhood"] };
    expect(areaMentionsToGeo(read, geo).assumptions).toEqual(["Elm Park read as an Austin neighbourhood"]);
  });

  it("matches aliases, keeps real venues and keeps the venue after the area moves", () => {
    const venue = place("Cafe Nova", "primary");
    const out = areaMentionsToGeo(siteIntent([venue, place("EPK")]), geo);
    expect(out.mentions).toEqual([venue]);
    expect(out.geo.area).toBe("EPK");
  });

  it("drops a repeat of geo.area and notes a second area instead of searching it as a venue", () => {
    const repeat = areaMentionsToGeo(siteIntent([place("Elm Park")], "austin", "Elm Park"), geo);
    expect(repeat.mentions).toEqual([]);
    expect(repeat.constraints.notes).toEqual([]);
    const second = areaMentionsToGeo(siteIntent([place("Lark Hill")], "austin", "Elm Park"), geo);
    expect(second.mentions).toEqual([]);
    expect(second.geo.area).toBe("Elm Park");
    expect(second.constraints.notes).toEqual(["area also named: Lark Hill"]);
  });

  it("sets the metro only when exactly one map city has the area", () => {
    expect(areaMentionsToGeo(siteIntent([place("Willow End")], null), geo).geo).toMatchObject({ metro: "chicago", area: "Willow End" });
    const ambiguous = siteIntent([place("Lark Hill")], null);
    expect(areaMentionsToGeo(ambiguous, geo)).toBe(ambiguous);
  });

  it("never moves a mention to a map city when the question is placed in an unsupported city or a market", () => {
    const base = siteIntent([place("Willow End")], null);
    const unsupported = { ...base, geo: { ...base.geo, unsupported_place: "Harbor City, ME" } };
    expect(areaMentionsToGeo(unsupported, geo)).toBe(unsupported);
    const market = { ...base, geo: { ...base.geo, market: "portland" } };
    expect(areaMentionsToGeo(market, geo)).toBe(market);
  });

  it("leaves other jobs, other types and unknown names untouched", () => {
    const market = { ...siteIntent([place("Elm Park")]), job: "market_selection" as const, pillar: "marketing" as const };
    expect(areaMentionsToGeo(market, geo)).toBe(market);
    const brand = siteIntent([{ text: "Elm Park", entity_type: "brand", role: "primary", public_figure: false }]);
    expect(areaMentionsToGeo(brand, geo)).toBe(brand);
    const unknown = siteIntent([place("Cafe Nova")]);
    expect(areaMentionsToGeo(unknown, geo)).toBe(unknown);
  });
});
