// /status's Part 11 block (server/status.ts `today`): brand screens, the side context calls' spend and
// searches, and OpenStreetMap requests against OSM_DAILY_MAX, read from usage_daily and kv counters.
// Fake sources (test/status/fixtures.ts); counts only.
import { describe, expect, it, vi } from "vitest";
import { SCREENER_DAILY_KV_PREFIX } from "@ct/contracts";
import { fakeSources, LIMITS, TODAY } from "../status/fixtures";

vi.mock("server-only", () => ({}));

const { kvCountOf, readStatus } = await import("../../server/status");
const { CONTEXT_AI_USD_METRIC, CONTEXT_WEB_USD_METRIC, WEB_SEARCHES_METRIC } = await import("../../server/llm-spend");

describe("today's screens, side calls and OpenStreetMap on /status", () => {
  it("reads the counters for today's UTC day", async () => {
    const usage: Record<string, number> = { [CONTEXT_AI_USD_METRIC]: 0.123456, [CONTEXT_WEB_USD_METRIC]: 0.4, [WEB_SEARCHES_METRIC]: 21 };
    const kv: Record<string, number> = { [`${SCREENER_DAILY_KV_PREFIX}${TODAY}`]: 7, [`osm.count.${TODAY}`]: 40 };
    const keys: string[] = [];
    const report = await readStatus(
      fakeSources({
        limits: () => ({ ...LIMITS, osm: { configured: true, dailyMax: 2_000 } }),
        usage: async (day, lane, metric) => (day === TODAY && lane === "all" ? (usage[metric] ?? 0) : -1),
        kvCount: async (key) => {
          keys.push(key);
          return kv[key] ?? 0;
        },
      }),
    );
    expect(report.today).toEqual({
      screens: 7,
      context: { aiUsd: 0.1235, webUsd: 0.4, webSearches: 21 },
      osm: { configured: true, requests: 40, dailyMax: 2_000 },
    });
    expect(keys.sort()).toEqual([`osm.count.${TODAY}`, `screener.count.${TODAY}`]);
  });

  it("leaves each count null when it cannot be read, and the block out of nothing when the sources predate it", async () => {
    const failing = await readStatus(
      fakeSources({
        usage: async () => {
          throw new Error("down");
        },
        kvCount: async () => {
          throw new Error("down");
        },
      }),
    );
    expect(failing.today).toEqual({
      screens: null,
      context: { aiUsd: null, webUsd: null, webSearches: null },
      osm: { configured: false, requests: null, dailyMax: 0 },
    });
    const old = await readStatus(fakeSources());
    expect(old.today?.screens).toBeNull();
  });

  it("reads a kv counter as a whole number, 0 when unset or not a number", () => {
    expect(kvCountOf(12)).toBe(12);
    expect(kvCountOf("7")).toBe(7);
    expect(kvCountOf(undefined)).toBe(0);
    expect(kvCountOf({ n: 3 })).toBe(0);
    expect(kvCountOf(-4)).toBe(0);
  });
});
