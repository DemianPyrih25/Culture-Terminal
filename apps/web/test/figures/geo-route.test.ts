// /api/geo/[metro]: the LiftMap outlines from the @ct/geo gazetteers, one cached response per metro.
import { MetroId } from "@ct/contracts";
import { GAZETTEER_CATALOG, type Gazetteer } from "@ct/geo";
import { describe, expect, it } from "vitest";
import { GET, dynamicParams, generateStaticParams } from "../../app/api/geo/[metro]/route";
import { outlinesFor, outlinesResponse } from "../../app/api/geo/outlines";
import { austinLiftMap } from "../../components/figures/fixtures";
import { outlinesUrl } from "../../components/figures";

const square = (lon: number, lat: number) => ({
  type: "Polygon" as const,
  coordinates: [
    [
      [lon, lat],
      [lon + 0.01, lat],
      [lon + 0.01, lat + 0.01],
      [lon, lat + 0.01],
      [lon, lat],
    ],
  ],
});

/** An invented one-area gazetteer, so the shape test does not depend on a shipped data module. */
const TEST_GAZETTEER: Gazetteer = {
  metro: "austin",
  source: "Invented test boundaries, public domain",
  areas: [{ id: "test_area", name: "Test Area", geometry: square(-97.75, 30.25) }],
};

describe("outlinesFor", () => {
  it("serves each area's display polygon with its id, name and centroid", async () => {
    const out = await outlinesFor("austin", { austin: TEST_GAZETTEER });
    expect(out.type).toBe("FeatureCollection");
    expect(out.source).toBe("Invented test boundaries, public domain");
    expect(out.features).toHaveLength(1);
    const f = out.features[0]!;
    expect(f.id).toBe("test_area");
    expect(f.properties.name).toBe("Test Area");
    expect(f.geometry).toEqual(square(-97.75, 30.25));
    // The centroid is [lon, lat], inside the square.
    expect(f.properties.centroid[0]).toBeCloseTo(-97.745, 3);
    expect(f.properties.centroid[1]).toBeCloseTo(30.255, 3);
  });

  it("answers an empty collection for a metro without a gazetteer", async () => {
    expect(await outlinesFor("nashville", {})).toEqual({ type: "FeatureCollection", metro: "nashville", source: null, features: [] });
  });

  it("covers every neighbourhood the Austin fixture names, from the shipped gazetteer", async () => {
    if (!GAZETTEER_CATALOG.austin) return;
    const out = await outlinesFor("austin");
    const ids = new Set(out.features.map((f) => f.id));
    // Centroids come from the catalog, as the gazetteer index computes them.
    expect(out.features.map((f) => f.properties.centroid)).toEqual(GAZETTEER_CATALOG.austin.areas.map((a) => [a.centroid.lon, a.centroid.lat]));
    for (const n of austinLiftMap.payload.neighbourhoods) expect(ids.has(n.id), n.id).toBe(true);
  });
});

describe("GET /api/geo/[metro]", () => {
  it("is prerendered for every metro and refuses any other", async () => {
    expect(dynamicParams).toBe(false);
    expect(generateStaticParams()).toEqual(MetroId.options.map((metro) => ({ metro })));
    const res = await GET(new Request("http://localhost/api/geo/austin"), { params: Promise.resolve({ metro: "austin" }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toContain("max-age=86400");
    const body = (await res.json()) as { type: string; metro: string };
    expect(body).toMatchObject({ type: "FeatureCollection", metro: "austin" });
    expect((await outlinesResponse("atlantis")).status).toBe(404);
  });

  it("is where the LiftMap looks", () => {
    expect(outlinesUrl("austin")).toBe("/api/geo/austin");
  });
});
