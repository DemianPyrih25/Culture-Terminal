// The locality pin rule, the stored kv shape and the markets config, on invented search results
// and ids only (D29).
import type { QlooSearchEntity } from "@ct/contracts";
import { describe, expect, it } from "vitest";
import {
  classifyLocality,
  kvLocalityApi,
  LOCALITIES_KV_KEY,
  localitiesKvKey,
  localitySearchParams,
  MalformedPinsError,
  memoryKv,
  MOCK_LOCALITIES_KV_KEY,
  namesState,
  readPins,
  StoredLocalities,
} from "./localities";
import { loadMarkets, MarketsConfigError, parseMarkets } from "./markets";

function locality(id: string, name: string, disambiguation: string | null, extra: Partial<QlooSearchEntity> = {}): QlooSearchEntity {
  return { entity_id: id, name, types: ["urn:entity:locality"], popularity: 0.5, disambiguation, ...extra };
}

const RIVERTON = { query: "Riverton", stateName: "Oregon", deliberate: false };

describe("classifyLocality", () => {
  it("pins the one exact name whose disambiguation names the state", () => {
    const match = classifyLocality(RIVERTON, [
      locality("loc-a", "Riverton", "Idaho, United States"),
      locality("loc-b", "Riverton", "Oregon, United States"),
      locality("loc-c", "Riverton Heights", "Oregon, United States"),
    ]);
    expect(match.kind).toBe("unique");
    expect(match.kind === "unique" && match.result.entity_id).toBe("loc-b");
  });

  it("asks for a choice between two exact names in the state, never by popularity", () => {
    const match = classifyLocality(RIVERTON, [
      locality("loc-a", "Riverton", "Oregon, United States", { popularity: 0.9 }),
      locality("loc-b", "Riverton", "Oregon, United States", { popularity: 0.1 }),
    ]);
    expect(match).toMatchObject({ kind: "choose", reason: "ambiguous" });
    expect(match.kind === "choose" && match.choices.map((c) => c.entity_id)).toEqual(["loc-a", "loc-b"]);
  });

  it("asks for a choice when no exact name is in the state, offering the exact names", () => {
    const match = classifyLocality(RIVERTON, [locality("loc-a", "Riverton", "Idaho, United States"), locality("loc-b", "Rivertown", "Oregon, United States")]);
    expect(match).toMatchObject({ kind: "choose", reason: "outside_state" });
    expect(match.kind === "choose" && match.choices.map((c) => c.entity_id)).toEqual(["loc-a"]);
  });

  it("never pins a deliberate market automatically, even with one exact name", () => {
    const match = classifyLocality({ ...RIVERTON, deliberate: true }, [locality("loc-b", "Riverton", "Oregon, United States")]);
    expect(match).toMatchObject({ kind: "choose", reason: "deliberate" });
    expect(match.kind === "choose" && match.choices).toHaveLength(1);
  });

  it("reports no exact name, with the other results for context only", () => {
    const match = classifyLocality(RIVERTON, [locality("loc-c", "Riverton Heights", "Oregon, United States")]);
    expect(match.kind).toBe("not_found");
    expect(match.kind === "not_found" && match.others.map((r) => r.name)).toEqual(["Riverton Heights"]);
  });

  it("matches the locality type and the normalised name only, and counts a repeated id once", () => {
    const match = classifyLocality(RIVERTON, [
      locality("loc-p", "Riverton", "Oregon, United States", { types: ["urn:entity:place"] }),
      locality("loc-b", "RIVERTON.", "Oregon, United States"),
      locality("loc-b", "Riverton", "Oregon, United States"),
    ]);
    expect(match.kind === "unique" && match.result.entity_id).toBe("loc-b");
  });
});

describe("namesState", () => {
  it("compares whole comma-separated parts of the disambiguation", () => {
    expect(namesState("Oregon, United States", "Oregon")).toBe(true);
    expect(namesState("Riverton, oregon, United States", "Oregon")).toBe(true);
    expect(namesState("New York, United States", "New York")).toBe(true);
    expect(namesState("Arkansas, United States", "Kansas")).toBe(false);
    expect(namesState("West Virginia, United States", "Virginia")).toBe(false);
    expect(namesState(null, "Oregon")).toBe(false);
  });
});

describe("localitySearchParams", () => {
  it("searches the market's query as a locality with room for exact ties", () => {
    expect(localitySearchParams({ query: " Riverton " })).toEqual({ query: "Riverton", types: "urn:entity:locality", take: 10 });
  });
});

describe("kv pins", () => {
  it("keeps live and synthetic pins under separate keys", () => {
    expect(localitiesKvKey("dev")).toBe(LOCALITIES_KV_KEY);
    expect(localitiesKvKey("prod")).toBe("metro_localities");
    expect(localitiesKvKey("mock")).toBe(MOCK_LOCALITIES_KV_KEY);
  });

  it("reads absent as empty and refuses a value outside the stored shape", async () => {
    expect(await readPins(memoryKv(), LOCALITIES_KV_KEY)).toEqual({});
    const good = { riverton: { entityId: "loc-b", label: "Riverton" } };
    expect(await readPins(memoryKv({ [LOCALITIES_KV_KEY]: good }), LOCALITIES_KV_KEY)).toEqual(good);
    for (const bad of [["loc-b"], { riverton: { entityId: "", label: "Riverton" } }, { riverton: { entityId: "loc-b", label: "R", extra: 1 } }, { "Not An Id": { entityId: "loc-b", label: "R" } }]) {
      await expect(readPins(memoryKv({ [LOCALITIES_KV_KEY]: bad }), LOCALITIES_KV_KEY)).rejects.toThrow(MalformedPinsError);
    }
    expect(StoredLocalities.safeParse(good).success).toBe(true);
  });

  it("serves skills like the web reader: one read, null without a pin, a rejection when malformed", async () => {
    const kv = memoryKv({ [LOCALITIES_KV_KEY]: { riverton: { entityId: "loc-b", label: "Riverton" } } });
    let reads = 0;
    const counted = { ...kv, get: (key: string) => (reads++, kv.get(key)) };
    const api = kvLocalityApi(counted, LOCALITIES_KV_KEY);
    expect(await api.market("riverton")).toEqual({ entityId: "loc-b", label: "Riverton" });
    expect(await api.market("lakeside")).toBeNull();
    // Own keys only: Object.prototype's constructor is no pin.
    expect(await api.market("constructor")).toBeNull();
    expect(reads).toBe(1);
    const broken = kvLocalityApi(memoryKv({ [LOCALITIES_KV_KEY]: "not pins" }), LOCALITIES_KV_KEY);
    await expect(broken.market("riverton")).rejects.toThrow(/malformed/);
  });
});

describe("markets config", () => {
  const config = (markets: unknown[], gazetteer: unknown[] = []) => JSON.stringify({ gazetteer, markets });
  const market = { id: "riverton", label: "Riverton", state: "OR", state_name: "Oregon", query: "Riverton", tier: "secondary" };

  it("reads the markets with their state, query, deliberate mark and the gazetteer centre of the same id", () => {
    const [m] = parseMarkets(config([{ ...market, pin: "deliberate" }], [{ ...market, center: { lat: 44.5, lon: -121.1 } }]));
    expect(m).toEqual({ id: "riverton", label: "Riverton", state: "OR", stateName: "Oregon", query: "Riverton", deliberate: true, center: { lat: 44.5, lon: -121.1 } });
  });

  it("fails with a plain message on a malformed file or a repeated id", () => {
    expect(() => parseMarkets("{")).toThrow(MarketsConfigError);
    expect(() => parseMarkets(config([{ ...market, id: "Bad Id" }]))).toThrow(/markets\.0\.id/);
    expect(() => parseMarkets(config([market, market]))).toThrow(/listed twice/);
  });

  it("loads config/metros.json: every gazetteer metro is a market, Austin is pinned by hand", () => {
    const markets = loadMarkets();
    expect(markets.length).toBeGreaterThan(30);
    const byId = new Map(markets.map((m) => [m.id, m]));
    expect(byId.get("nashville")).toMatchObject({ query: "Nashville", stateName: "Tennessee", deliberate: false });
    expect(byId.get("nashville")?.center).not.toBeNull();
    expect(byId.get("austin")?.deliberate).toBe(true);
  });
});
