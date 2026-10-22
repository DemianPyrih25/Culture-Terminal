import { describe, expect, it } from "vitest";
import { cacheLabel, formatMs, formatTokens, formatUsd, idList, metricValue, qlooChip, shortFilterType } from "./format";

describe("number formatting", () => {
  it("shows milliseconds below a second and seconds above", () => {
    expect(formatMs(312.4)).toBe("312 ms");
    expect(formatMs(1234)).toBe("1.2 s");
  });

  it("shows dollars to the cent, with a third digit below ten cents", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.042)).toBe("$0.042");
    expect(formatUsd(0.6)).toBe("$0.60");
    expect(formatUsd(15)).toBe("$15.00");
  });

  it("lists token counts with thousands separators", () => {
    expect(formatTokens({ input: 12345, output: 678, cacheRead: 0, cacheCreation: 1000 })).toBe(
      "in 12,345 · out 678 · cache read 0 · cache write 1,000",
    );
  });
});

describe("chips", () => {
  it("labels cache statuses the way the trace stamps them", () => {
    expect(["miss", "hit", "reused", "coalesced", "stale"].map((c) => cacheLabel(c as never))).toEqual([
      "MISS",
      "HIT",
      "REUSED",
      "COALESCED",
      "STALE",
    ]);
  });

  it("shortens entity filter types only", () => {
    expect(shortFilterType("urn:entity:brand")).toBe("brand");
    expect(shortFilterType("urn:tag")).toBe("urn:tag");
    expect(shortFilterType(null)).toBe("—");
  });

  it("puts endpoint, filter type, cache, time, request id and rows on one line", () => {
    const call = { endpoint: "/v2/insights", filterType: "urn:entity:brand", cache: "miss" as const, ms: 312, requestId: "req-synthetic-1", rows: 20, error: null };
    expect(qlooChip(call)).toBe("/v2/insights brand MISS 312 ms req req-synthetic-1 · 20 rows");
    expect(qlooChip({ ...call, endpoint: "/search", filterType: null, cache: "hit", requestId: null, rows: null, error: "HTTP 400" })).toBe(
      "/search HIT 312 ms req — · error: HTTP 400",
    );
  });
});

describe("metricValue", () => {
  it("shows the display string, the raw value when the display is empty, and the reason when there is no value", () => {
    expect(metricValue({ value: 0.5, display: "2 of 6", reason: null })).toBe("2 of 6");
    expect(metricValue({ value: 0.5, display: "", reason: null })).toBe("0.5");
    expect(metricValue({ value: null, display: "", reason: "budget_truncated" })).toBe("— (budget_truncated)");
  });

  it("joins ids or shows a dash", () => {
    expect(idList(["E1", "M2"])).toBe("E1 M2");
    expect(idList([])).toBe("—");
  });
});
