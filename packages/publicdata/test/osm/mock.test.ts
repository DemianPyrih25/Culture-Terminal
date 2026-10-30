import { describe, expect, it } from "vitest";
import { createPublicDataClient } from "../../src/client";
import { createMockPublicTransport } from "../../src/mock";
import { MOCK_OSM_BASE, mockCount } from "../../src/osm/mock";
import { osmCityQueries, osmPlaceType } from "../../src/osm/config";
import { createMemoryPublicStore } from "../../src/store";
import { FakeClock } from "../support/fakes";
import { BAR, CAFE, CIRCLE, PIZZA, SQUARE } from "./support";

function mockClient() {
  const clock = new FakeClock();
  const store = createMemoryPublicStore();
  const client = createPublicDataClient({
    env: "mock",
    tag: "test-mock",
    secUserAgent: null,
    transport: createMockPublicTransport({ now: clock.now }),
    store,
    now: clock.now,
    sleep: clock.sleep,
  });
  return { client, store };
}

describe("mock OpenStreetMap", () => {
  it("answers counts deterministically, with no key, no network and no daily count", async () => {
    const a = mockClient();
    const b = mockClient();
    const q = { shapes: [SQUARE, CIRCLE], types: [CAFE, BAR] };
    const ra = await a.client.standalone().forTool(null).osmCounts(q);
    const rb = await b.client.standalone().forTool(null).osmCounts(q);
    expect(ra.data).toEqual(rb.data);
    expect(ra.data.osmBase).toBe(new Date(MOCK_OSM_BASE).toISOString());
    expect(ra.data.counts["area-a"]?.cafe).toBe(mockCount(CIRCLE, "cafe"));
    expect(ra.meta.reference).toMatch(/^mock-[0-9a-f]{16}$/);
    expect(a.store.counters.size).toBe(0);
    // A bigger circle holds more of a type.
    expect(mockCount({ ...CIRCLE, radiusM: 10_000 }, "cafe")).toBeGreaterThan(mockCount({ ...CIRCLE, radiusM: 1_000 }, "cafe"));
  });

  it("invents named places inside the shape that the client's own matching types", async () => {
    const { client } = mockClient();
    const res = await client.standalone().forTool(null).osmPlaces({ shape: SQUARE, types: [CAFE, PIZZA], limit: 20 });
    expect(res.data.length).toBeGreaterThan(0);
    expect(res.data.length).toBeLessThanOrEqual(20);
    for (const p of res.data) {
      expect(p.name).toMatch(/^Example (Cafe|Pizza) \d+$/);
      expect(["cafe", "pizza"]).toContain(p.typeKey);
      expect(p.osmId).toBeGreaterThanOrEqual(9_000_000_000);
      expect(p.lat).toBeGreaterThan(10.05);
      expect(p.lat).toBeLessThan(10.25);
    }
  });

  it("answers a configured city reference", async () => {
    const { client } = mockClient();
    const [query] = osmCityQueries("nashville", ["cafe", "activity"]);
    expect(query).toBeDefined();
    const res = await client.standalone().forTool(null).osmCounts(query!);
    expect(res.data.counts["city:nashville"]?.cafe).toBeGreaterThan(0);
    expect(res.data.counts["city:nashville"]?.activity).toBeGreaterThan(res.data.counts["city:nashville"]?.cafe ?? 0);
    expect(osmPlaceType("cafe")?.query).toEqual(CAFE);
  });
});
