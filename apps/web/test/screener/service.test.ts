// The screener service (PLAN §5.5) on the Qloo mock transport: the call plan per seed, every cell citing
// a request of its own screen, the answer cache (a repeat makes no Qloo call), the daily cap and the
// client's budget gates refusing before any request, pickers and misses that apply nothing, markets
// read only where a locality is pinned, and the taste map's calls filling distinctiveness. Invented
// entities only (D29).
import type { LocalityApi, ScreenerAnswer, ScreenerRequest, ScreenerResult } from "@ct/contracts";
import { describe, expect, it, vi } from "vitest";
import { tasteMapFromScreen, type ScreenerMapInput, type TasteMapBuild } from "@ct/quant";
import { cappedQloo, LIVE, mockQloo } from "../des/support";

vi.mock("server-only", () => ({}));

const { ScreenerService, SCREENER_BASE_QLOO_CAP, SCREENER_MAP_QLOO_CAP } = await import("../../server/screener/service");

const OPEN = { visitorPerMinute: 100, visitorPerHour: 1000, globalPerHour: 1000, dailyNetworkCalls: 10_000 };

/** Pins every market id it is asked for, under an invented locality id. */
const PINNED: LocalityApi = { market: async (id) => ({ entityId: `mock-loc-${id}`, label: id.replace(/_/g, " ") }) };

function service(over: { limits?: typeof OPEN; qloo?: ReturnType<typeof mockQloo>["client"]; localities?: LocalityApi | null } = {}) {
  const mock = mockQloo();
  const client = over.qloo ?? mock.client;
  const svc = new ScreenerService(
    { qloo: () => client, qlooEnabled: true, mode: async () => LIVE, localities: () => (over.localities === undefined ? PINNED : over.localities) },
    { limits: over.limits ?? OPEN },
  );
  return { svc, scopes: mock.scopes };
}

function body(over: Partial<ScreenerRequest> & Pick<ScreenerRequest, "seed">): ScreenerRequest {
  return { markets: [], rows: 20, map: false, pick: null, ...over };
}

const ask = (svc: InstanceType<typeof ScreenerService>, b: ScreenerRequest, visitor: string | null = null) => svc.screen({ body: b, lane: "public", visitor });

function ok(answer: ScreenerAnswer): ScreenerResult {
  if (answer.kind !== "ok") throw new Error(`expected a screen, got ${answer.kind}: ${JSON.stringify(answer)}`);
  return answer.screen;
}

function citesOwnRequests(screen: ScreenerResult) {
  const ids = new Set(screen.requests.map((r) => r.id));
  for (const row of screen.rows) {
    for (const cell of Object.values(row.cells)) {
      for (const id of cell.requestIds) expect(ids.has(id)).toBe(true);
      if (cell.status === "unavailable") expect(cell.value).toBeNull();
    }
  }
}

describe("a category screen", () => {
  it("finds the tag, discovers and scores on one scale in one call, and reads three ages: five requests", async () => {
    const { svc, scopes } = service();
    const screen = ok(await ask(svc, body({ seed: { by: "tag", query: "Energy Drinks" } })));
    expect(screen.seed).toEqual({ by: "tag", label: "Energy Drinks" });
    expect(screen.requests.map((r) => r.purpose)).toEqual(["resolve", "discovery", "age", "age", "age"]);
    expect(screen.requests.length).toBeLessThanOrEqual(SCREENER_BASE_QLOO_CAP);
    expect(screen.qloo).toEqual({ network: 5, cached: 0 });
    expect(screen.rows.length).toBeGreaterThan(2);
    expect(screen.rows.length).toBeLessThanOrEqual(20);
    expect(screen.rows.map((r) => r.rank)).toEqual(screen.rows.map((_, i) => i + 1));
    citesOwnRequests(screen);
    // The discovery's tag signal is the FIT scale; each age call names every screened brand.
    expect(screen.requests[1]?.request.query["signal.interests.tags"]).toBe(screen.requests[1]?.request.query["filter.tags"]);
    expect(screen.rows.every((r) => r.cells.fit.requestIds.every((id) => id === "Q2"))).toBe(true);
    const age = screen.requests.find((r) => r.purpose === "age");
    expect(age?.request.query["filter.results.entities"]?.split(",")).toHaveLength(screen.rows.length);
    // No market and no map asked: those columns say why, never 0.
    expect(screen.rows.every((r) => r.cells.metro_breadth.reason === "not_measured" && r.cells.distinctiveness.reason === "not_measured")).toBe(true);
    expect(screen.limitations.join(" ")).toMatch(/Group-level taste/);
    expect(screen.limitations.join(" ")).toMatch(/compressed/);
    expect(screen.limitations.join(" ")).toMatch(/Snapshot: Qloo data as fetched on \d{4}-\d{2}-\d{2}/);
    // Rows carry opaque keys, never a Qloo id; a lane scope with the screen's own cap.
    expect(JSON.stringify(screen.rows)).not.toMatch(/mock-ent-/);
    expect(scopes[0]).toMatchObject({ lane: "public", limits: { qlooCalls: SCREENER_BASE_QLOO_CAP } });
  });

  it("answers a repeat from the answer cache with no Qloo call", async () => {
    const { svc, scopes } = service();
    const b = body({ seed: { by: "tag", query: "energy drinks" } });
    const first = ok(await ask(svc, b));
    const second = ok(await ask(svc, { ...b, seed: { by: "tag", query: "  Energy Drinks " } }));
    expect(scopes).toHaveLength(1);
    expect(second.qloo).toEqual({ network: 0, cached: first.requests.length });
    expect(second.rows).toEqual(first.rows);
    expect(svc.cached(b)?.kind).toBe("ok");
  });
});

describe("a brand screen", () => {
  it("resolves the seed exactly, keeps it as the SEED row with its FIT marked self, in five requests", async () => {
    const { svc } = service();
    const screen = ok(await ask(svc, body({ seed: { by: "brand", name: "Juniper Cola" }, rows: 10 })));
    expect(screen.requests.map((r) => r.purpose)).toEqual(["resolve", "discovery", "age", "age", "age"]);
    const seed = screen.rows.find((r) => r.flags.includes("SEED"));
    expect(seed?.label).toBe("Juniper Cola");
    expect(seed?.cells.fit).toMatchObject({ status: "unavailable", reason: "self" });
    expect(seed?.cells.popularity.requestIds).toEqual(["Q1"]);
    expect(screen.rows.length).toBeLessThanOrEqual(10);
    citesOwnRequests(screen);
  });

  it("asks which brand for a tie and offers the closest names for a miss, sending nothing further", async () => {
    const { svc } = service();
    const tie = await ask(svc, body({ seed: { by: "brand", name: "Juniper Twin" } }));
    expect(tie.kind).toBe("pick");
    if (tie.kind !== "pick") return;
    expect(tie.candidates.filter((c) => c.name === "Juniper Twin")).toHaveLength(2);
    expect(JSON.stringify(tie)).not.toMatch(/mock-ent-/);
    const picked = ok(await ask(svc, body({ seed: { by: "brand", name: "Juniper Twin" }, pick: tie.candidates[1]!.key })));
    expect(picked.rows.find((r) => r.flags.includes("SEED"))?.disambiguation).toBe("2019");

    const miss = await ask(svc, body({ seed: { by: "brand", name: "Notfound Cola" } }));
    expect(miss.kind).toBe("not_found");
  });
});

describe("markets and the taste map", () => {
  it("reads up to four pinned markets, and says which market is not pinned", async () => {
    const { svc } = service();
    const screen = ok(await ask(svc, body({ seed: { by: "tag", query: "Energy Drinks" }, markets: ["nashville", "austin", "denver", "boston"] })));
    expect(screen.requests.filter((r) => r.purpose === "market")).toHaveLength(4);
    expect(screen.requests.length).toBeLessThanOrEqual(SCREENER_BASE_QLOO_CAP);
    expect(screen.rows.some((r) => r.cells.metro_breadth.status === "ok")).toBe(true);
    citesOwnRequests(screen);

    const unpinned = service({ localities: { market: async (id) => (id === "nashville" ? { entityId: "mock-loc-n", label: "Nashville" } : null) } });
    const partial = ok(await ask(unpinned.svc, body({ seed: { by: "tag", query: "Energy Drinks" }, markets: ["nashville", "austin"] })));
    expect(partial.requests.filter((r) => r.purpose === "market")).toHaveLength(1);
    expect(partial.limitations.join(" ")).toMatch(/Austin: its locality is not pinned/);
  });

  it("runs at most 13 taste map calls, which fill distinctiveness for the mapped rows", async () => {
    const tasteMap = vi.fn<(input: ScreenerMapInput) => TasteMapBuild | null>(() => null);
    const mock = mockQloo();
    const svc = new ScreenerService(
      { qloo: () => mock.client, qlooEnabled: true, mode: async () => LIVE, localities: () => PINNED, tasteMap },
      { limits: OPEN },
    );
    const screen = ok(await ask(svc, body({ seed: { by: "tag", query: "Energy Drinks" }, map: true })));
    const mapCalls = screen.requests.filter((r) => r.purpose === "taste_map");
    expect(mapCalls.length).toBeGreaterThanOrEqual(2);
    expect(mapCalls.length).toBeLessThanOrEqual(SCREENER_MAP_QLOO_CAP);
    expect(screen.rows.some((r) => r.cells.distinctiveness.status === "ok")).toBe(true);
    expect(tasteMap).toHaveBeenCalledTimes(1);
    expect(tasteMap.mock.calls[0]?.[0]).toMatchObject({ source: "screener", complete: true });
    expect(mock.scopes[0]?.limits.qlooCalls).toBe(SCREENER_BASE_QLOO_CAP + SCREENER_MAP_QLOO_CAP);
    citesOwnRequests(screen);
  });
});

describe("limits", () => {
  it("refuses a screen the day's allowance cannot cover, before any request", async () => {
    const { svc, scopes } = service({ limits: { ...OPEN, dailyNetworkCalls: SCREENER_BASE_QLOO_CAP - 1 } });
    const answer = await ask(svc, body({ seed: { by: "tag", query: "Energy Drinks" } }));
    expect(answer).toMatchObject({ kind: "unavailable" });
    if (answer.kind === "unavailable") expect(answer.retryAfterS).toBeGreaterThan(0);
    expect(scopes).toHaveLength(0);
  });

  it("stops at the client's daily lane cap with a plain message", async () => {
    const { svc } = service({ qloo: cappedQloo() });
    const answer = await ask(svc, body({ seed: { by: "brand", name: "Juniper Cola" } }));
    expect(answer.kind).toBe("unavailable");
    if (answer.kind === "unavailable") expect(answer.message).toMatch(/used up/);
  });

  it("holds a visitor to the per-minute limit", async () => {
    const { svc } = service({ limits: { ...OPEN, visitorPerMinute: 1 } });
    ok(await ask(svc, body({ seed: { by: "tag", query: "Energy Drinks" } }), "v1"));
    const second = await ask(svc, body({ seed: { by: "tag", query: "Sports Drinks" } }), "v1");
    expect(second).toMatchObject({ kind: "unavailable" });
  });
});

describe("the Category Taste Map", () => {
  const withMap = (tasteMap: (input: ScreenerMapInput) => TasteMapBuild | null) =>
    new ScreenerService({ qloo: () => mockQloo().client, qlooEnabled: true, mode: async () => LIVE, localities: () => PINNED, tasteMap }, { limits: OPEN });

  it("draws the map from the screen's own similarity calls with the quant builder", async () => {
    const screen = ok(await ask(withMap(tasteMapFromScreen), body({ seed: { by: "tag", query: "Energy Drinks" }, map: true })));
    expect(screen.map).not.toBeNull();
    expect(screen.map?.source).toBe("screener");
    expect(screen.map?.points.length).toBeLessThanOrEqual(14);
    expect(screen.requests.filter((r) => r.purpose === "taste_map").length).toBeLessThanOrEqual(SCREENER_MAP_QLOO_CAP);
  });

  it("lists why when the map cannot be drawn, and keeps the table", async () => {
    const message = "Not every similarity call returned, so the taste map is not drawn; the table is unaffected.";
    const screen = ok(await ask(withMap(() => ({ ok: false, reason: "error", message })), body({ seed: { by: "tag", query: "Energy Drinks" }, map: true })));
    expect(screen.map).toBeNull();
    expect(screen.limitations).toContain(message);
    expect(screen.rows.length).toBeGreaterThan(0);
  });

  it("makes no map call unless the reader asks for the map", async () => {
    const screen = ok(await ask(withMap(tasteMapFromScreen), body({ seed: { by: "tag", query: "Energy Drinks" } })));
    expect(screen.map).toBeNull();
    expect(screen.requests.some((r) => r.purpose === "taste_map")).toBe(false);
  });
});

describe("metro breadth and use records (Part 11)", () => {
  it("reads breadth over the chosen market plus the largest pinned markets when one is chosen", async () => {
    const { breadthMarkets } = await import("../../server/screener/service");
    expect(breadthMarkets(["austin"])).toEqual(["austin", "nyc", "los_angeles", "chicago"]);
    expect(breadthMarkets(["nyc"])).toEqual(["nyc", "los_angeles", "chicago"]);
    expect(breadthMarkets(["austin", "denver"])).toEqual(["austin", "denver"]);
    expect(breadthMarkets([])).toEqual([]);
    const { svc } = service();
    const screen = ok(await ask(svc, body({ seed: { by: "tag", query: "Energy Drinks" }, markets: ["austin"] })));
    expect(screen.markets.map((m) => m.id)).toEqual(["austin", "nyc", "los_angeles", "chicago"]);
    expect(screen.limitations.join(" ")).toMatch(/Metro breadth across 4 markets/);
  });

  it("counts each live screen and records its cost, never failing the screen when a write fails", async () => {
    const counted: number[] = [];
    const uses: { feature: string; qlooNetwork: number }[] = [];
    const mock = mockQloo();
    const svc = new ScreenerService(
      {
        qloo: () => mock.client,
        qlooEnabled: true,
        mode: async () => LIVE,
        localities: () => PINNED,
        countScreen: async (now) => {
          counted.push(now);
        },
        recordUse: async (use) => {
          uses.push(use);
          throw new Error("the database is down");
        },
      },
      { limits: OPEN },
    );
    ok(await ask(svc, body({ seed: { by: "tag", query: "Energy Drinks" } })));
    await new Promise((r) => setTimeout(r, 0));
    expect(counted).toHaveLength(1);
    expect(uses).toEqual([expect.objectContaining({ feature: "screener", qlooNetwork: 5 })]);
  });
});
