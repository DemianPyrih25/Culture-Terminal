// Measured feature costs for /method (server/feature-costs.ts): the medians of the last 30 days per
// code-only feature, with how many uses they rest on; unknown features and empty ones are left out so
// /method shows the plan figure, labelled as a plan. Invented counts only.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { FEATURE_MEASURE_WINDOW_DAYS, measurementsFromRows } = await import("../../server/feature-costs");
type Db = Parameters<typeof import("../../server/feature-costs").featureCostMeasurements>[0];

const row = (feature: string, n: number) => ({ feature, n, qlooNetworkMedian: 5.25, qlooCachedMedian: 1, llmUsdMedian: 0, msMedian: 812.4 });

describe("featureCostMeasurements", () => {
  it("keeps known features with uses, rounded as /method prints them", () => {
    expect(measurementsFromRows([row("screener", 4), row("des_profile", 0), row("not_a_feature", 9)])).toEqual({
      windowDays: 30,
      features: { screener: { feature: "screener", n: 4, qlooNetwork: 5.3, qlooCached: 1, llmUsd: 0, ms: 812 } },
    });
  });

  it("reads the medians over the window in days", async () => {
    let sinceMs = 0;
    const db = {} as Db;
    vi.doMock("@ct/db", async (importOriginal) => ({
      ...(await importOriginal<typeof import("@ct/db")>()),
      featureUseMedians: async (_db: unknown, o: { sinceMs: number }) => {
        sinceMs = o.sinceMs;
        return [row("des_profile", 2)];
      },
    }));
    vi.resetModules();
    const fresh = await import("../../server/feature-costs");
    const measured = await fresh.featureCostMeasurements(db);
    expect(sinceMs).toBe(FEATURE_MEASURE_WINDOW_DAYS * 86_400_000);
    expect(Object.keys(measured.features)).toEqual(["des_profile"]);
    vi.doUnmock("@ct/db");
  });
});
