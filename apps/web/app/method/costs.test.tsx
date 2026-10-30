// The cost-per-use card on /method (PLAN Part 10): every feature's plan figures from the contracts'
// FEATURE_COSTS, every job's Qloo plan, and what this server's live answers measured, labelled apart.
// The measured rows here are invented for the fixture.
import { DEFAULT_RUN_LIMITS, Feature, FEATURE_COSTS, Job, JOB_QLOO_PLAN, NOTE_LLM_USD } from "@ct/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { costFacts, featureCostRows, jobCostRows, loadMeasuredCosts, measuredFromRows } = await import("./costs");
const { COSTS_COPY, CostSection, rangeText, usdRangeText, usdText } = await import("./cost-section");

type MeasuredCosts = import("./costs").MeasuredCosts;
type MeasuredRow = import("./costs").MeasuredRow;

const ROWS: MeasuredRow[] = [
  { job: "brand_health", runs: 4, qloo_network: 12, qloo_cached: 3, llm_usd: 0.18 },
  // postgres.js may hand numerics back as strings.
  { job: "site_selection", runs: "2", qloo_network: "6.5", qloo_cached: "1", llm_usd: "0.004" },
  { job: "not_a_job", runs: 9, qloo_network: 1, qloo_cached: 0, llm_usd: 0.1 },
  { job: "tenant_mix", runs: 0, qloo_network: null, qloo_cached: null, llm_usd: null },
];

const NO_ENV = {} as NodeJS.ProcessEnv;

const render = (measured: MeasuredCosts) => renderToStaticMarkup(<CostSection facts={costFacts(measured)} />);

describe("cost per use: the plan", () => {
  it("lists every feature in the contracts' order with its plan figures", () => {
    const rows = featureCostRows();
    expect(rows.map((r) => r.feature)).toEqual([...Feature]);
    for (const row of rows) {
      const cost = FEATURE_COSTS[row.feature];
      if (cost.basis !== "plan") continue;
      expect(row.qlooCold, row.feature).toEqual(cost.qlooCold);
      expect(row.qlooWarm, row.feature).toEqual(cost.qlooWarm);
      expect(row.llmUsd, row.feature).toEqual(cost.llmUsd);
      expect(row.perJob).toBe(false);
    }
    expect(rows.find((r) => r.feature === "screener")).toMatchObject({ qlooCold: { min: 5, max: 9 }, qlooWarm: { min: 0, max: 0 } });
    expect(rows.find((r) => r.feature === "taste_map_screener")?.qlooCold).toEqual({ min: 2, max: 13 });
  });

  it("costs a Following re-run as one run of the followed job, spanning the jobs' plans", () => {
    const rerun = featureCostRows().find((r) => r.feature === "following_rerun")!;
    const cold = Job.options.map((job) => JOB_QLOO_PLAN[job].cold);
    expect(rerun.perJob).toBe(true);
    expect(rerun.qlooCold).toEqual({ min: Math.min(...cold.map((c) => c.min)), max: Math.max(...cold.map((c) => c.max)) });
    // audience_discovery has no warm plan; the others span 2–6.
    expect(rerun.qlooWarm).toEqual({ min: 2, max: 6 });
    expect(rerun.llmUsd).toEqual(NOTE_LLM_USD);
  });

  it("lists every job with its plan, and a measured figure only when the database gave one", () => {
    const plain = jobCostRows({ state: "mock" });
    expect(plain.map((r) => r.job)).toEqual([...Job.options]);
    expect(plain.every((r) => r.measured === null)).toBe(true);
    const measured = jobCostRows({ state: "ok", windowDays: 30, jobs: measuredFromRows(ROWS) });
    expect(measured.find((r) => r.job === "brand_health")?.measured).toEqual({ runs: 4, qlooNetwork: 12, qlooCached: 3, llmUsd: 0.18 });
    expect(measured.find((r) => r.job === "head_to_head")?.measured).toBeNull();
    expect(costFacts({ state: "mock" }).limits).toEqual({ qlooCalls: DEFAULT_RUN_LIMITS.qlooCalls, followupCalls: DEFAULT_RUN_LIMITS.followupCalls });
  });
});

describe("cost per use: the measured figures", () => {
  it("reads numbers and numeric strings, and drops unknown jobs and empty groups", () => {
    const jobs = measuredFromRows(ROWS);
    expect(Object.keys(jobs).sort()).toEqual(["brand_health", "site_selection"]);
    expect(jobs.site_selection).toEqual({ runs: 2, qlooNetwork: 6.5, qlooCached: 1, llmUsd: 0.004 });
  });

  it("never reads the database on synthetic data", async () => {
    const query = vi.fn(async () => ROWS);
    expect(await loadMeasuredCosts({ env: { ...NO_ENV, QLOO_MOCK: "1" }, query, timeoutMs: 50 })).toEqual({ state: "mock" });
    expect(query).not.toHaveBeenCalled();
  });

  it("returns the medians of the last 30 days, or unavailable on an error or a slow database", async () => {
    const query = vi.fn<(days: number) => Promise<MeasuredRow[]>>(async () => ROWS);
    const ok = await loadMeasuredCosts({ env: NO_ENV, query, timeoutMs: 50 });
    expect(query).toHaveBeenCalledWith(30);
    expect(ok.state === "ok" && ok.windowDays).toBe(30);
    expect(ok.state === "ok" && ok.jobs.brand_health?.runs).toBe(4);
    const failing = async () => {
      throw new Error("connection refused");
    };
    expect(await loadMeasuredCosts({ env: NO_ENV, query: failing, timeoutMs: 50 })).toEqual({ state: "unavailable" });
    const hanging = () => new Promise<MeasuredRow[]>(() => undefined);
    expect(await loadMeasuredCosts({ env: NO_ENV, query: hanging, timeoutMs: 10 })).toEqual({ state: "unavailable" });
  });
});

describe("the cost card", () => {
  it("prints every feature and job, and labels the figures as plans", () => {
    const html = render({ state: "mock" });
    expect(html).toContain('id="costs"');
    expect(html.match(/data-feature-cost="/g)).toHaveLength(Feature.length);
    expect(html.match(/data-job-cost="/g)).toHaveLength(Job.options.length);
    expect(html).toContain(COSTS_COPY.featuresHeading);
    expect(html).toContain("Plan figures");
    expect(html).toContain('data-measured-state="mock"');
    expect(html).toContain(COSTS_COPY.measuredState({ state: "mock" }));
    expect(html).not.toContain('data-measured="true"');
    // The screener: 5–9 calls cold, none warm, no model.
    const screener = html.slice(html.indexOf('data-feature-cost="screener"'), html.indexOf("</tr>", html.indexOf('data-feature-cost="screener"')));
    expect(screener).toContain(">5–9<");
    expect(screener).toContain(">$0<");
    expect(html).toContain(COSTS_COPY.perJob.split(":")[0]);
    expect(html).toContain(`up to ${DEFAULT_RUN_LIMITS.followupCalls} more`);
  });

  it("shows measured medians beside the plan where live runs exist, and says so where none do", () => {
    const html = render({ state: "ok", windowDays: 30, jobs: measuredFromRows(ROWS) });
    expect(html).toContain('data-measured-state="ok"');
    const health = html.slice(html.indexOf('data-job-cost="brand_health"'), html.indexOf("</tr>", html.indexOf('data-job-cost="brand_health"')));
    expect(health).toContain(">25<");
    expect(health).toContain("12 + 3 · $0.18");
    expect(health).toContain("median of 4 runs");
    const site = html.slice(html.indexOf('data-job-cost="site_selection"'), html.indexOf("</tr>", html.indexOf('data-job-cost="site_selection"')));
    expect(site).toContain("under $0.01");
    expect(html.match(/data-measured="true"/g)).toHaveLength(2);
    expect(html).toContain(COSTS_COPY.noRuns);
  });

  it("states plainly when the measured figures cannot be read", () => {
    const html = render({ state: "unavailable" });
    expect(html).toContain(COSTS_COPY.measuredState({ state: "unavailable" }));
    expect(html).not.toContain('data-measured="true"');
  });

  it("formats ranges and amounts", () => {
    expect(rangeText({ min: 0, max: 0 })).toBe("0");
    expect(rangeText({ min: 8, max: 9 })).toBe("8–9");
    expect(usdRangeText({ min: 0, max: 0 })).toBe("$0");
    expect(usdRangeText(NOTE_LLM_USD)).toBe("$0.10–0.30");
    expect(usdText(0.21)).toBe("$0.21");
    expect(usdText(0.004)).toBe("under $0.01");
  });
});

describe("Part 11: measured feature costs and the per-answer add-ons", () => {
  const FEATURE_ROWS = [
    { feature: "screener", n: 12, qlooNetworkMedian: 3, qlooCachedMedian: 4, llmUsdMedian: 0, msMedian: 900 },
    { feature: "des_profile", n: 1, qlooNetworkMedian: 0, qlooCachedMedian: 6, llmUsdMedian: 0, msMedian: 400 },
    { feature: "not_a_feature", n: 5, qlooNetworkMedian: 1, qlooCachedMedian: 1, llmUsdMedian: 0, msMedian: 1 },
  ];

  it("reads the recorded uses beside the job medians, and keeps the jobs when the features read fails", async () => {
    const query = async () => ROWS;
    const ok = await loadMeasuredCosts({ env: NO_ENV, query, features: async () => FEATURE_ROWS, timeoutMs: 50 });
    expect(ok.state === "ok" && ok.features?.screener).toEqual({ uses: 12, qlooNetwork: 3, qlooCached: 4, llmUsd: 0 });
    expect(ok.state === "ok" && Object.keys(ok.features ?? {}).sort()).toEqual(["des_profile", "screener"]);
    const failing = await loadMeasuredCosts({ env: NO_ENV, query, features: async () => Promise.reject(new Error("x")), timeoutMs: 50 });
    expect(failing.state === "ok" && failing.jobs.brand_health?.runs).toBe(4);
    expect(failing.state === "ok" && failing.features).toEqual({});
  });

  it("shows a feature's measured medians with its number of uses, and plan elsewhere", async () => {
    const measured = await loadMeasuredCosts({ env: NO_ENV, query: async () => ROWS, features: async () => FEATURE_ROWS, timeoutMs: 50 });
    const html = render(measured);
    const screener = html.slice(html.indexOf('data-feature-cost="screener"'), html.indexOf("</tr>", html.indexOf('data-feature-cost="screener"')));
    expect(screener).toContain("Measured: 3 + 4 Qloo · $0, median of 12 uses");
    const verdict = html.slice(html.indexOf('data-feature-cost="verdict_tag"'), html.indexOf("</tr>", html.indexOf('data-feature-cost="verdict_tag"')));
    expect(verdict).toContain("plan: no recorded use yet");
  });

  it("lists what every answer adds: the two context blocks and the OpenStreetMap places", () => {
    const html = render({ state: "mock" });
    expect(html).toContain("Added to every answer");
    for (const addon of ["ai_context", "web_context", "local_supply"]) expect(html).toContain(`data-addon-cost="${addon}"`);
    expect(html).toContain("$0.005–0.02");
    expect(html).toContain("$0.02–0.08");
  });
});
