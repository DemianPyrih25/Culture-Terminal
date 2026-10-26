// The curated entities on an invented showcases config: the config's own spelling for any spelling of a
// name, read on first use, and nothing curated (no throw) when the config does not parse (D29).
import { afterEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("../../server/log", () => ({ log: { error: logged.error, warn: vi.fn(), info: vi.fn() } }));

const CONFIG = {
  showcases: [
    {
      expected: {
        mentions: [
          { text: "The Juniper Cola Co", entity_type: "brand" },
          { text: "East Side", entity_type: "place" },
        ],
      },
      extra_pins: [{ text: "Comedian Vega", entity_type: "person" }],
    },
  ],
};

async function curatedOn(config: unknown) {
  vi.resetModules();
  vi.doMock("../../../../config/showcases.json", () => ({ default: config }));
  return import("../../server/des/curated");
}

afterEach(() => {
  vi.doUnmock("../../../../config/showcases.json");
  logged.error.mockClear();
});

describe("curated entities", () => {
  it("answers any spelling of a curated name with the config's own, by type", async () => {
    const { curatedEntities, curatedEntity, isCurated } = await curatedOn(CONFIG);
    expect(curatedEntities()).toEqual([
      { name: "The Juniper Cola Co", type: "brand" },
      { name: "Comedian Vega", type: "person" },
    ]);
    expect(curatedEntity("juniper cola", "brand")).toEqual({ name: "The Juniper Cola Co", type: "brand" });
    expect(curatedEntity("Juniper Cola", "artist")).toBeNull();
    expect(isCurated("COMEDIAN VEGA", "person")).toBe(true);
    expect(isCurated("East Side", "brand")).toBe(false);
  });

  it("curates nothing, and says so once, when the config does not parse", async () => {
    const { curatedEntities, isCurated } = await curatedOn({ showcases: [{ expected: {} }] });
    expect(isCurated("Juniper Cola", "brand")).toBe(false);
    expect(curatedEntities()).toEqual([]);
    expect(logged.error).toHaveBeenCalledTimes(1);
  });
});
