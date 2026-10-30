// Part 11 settings from the environment (D24, D45): the per-visitor lane, the side context calls, and
// the D24 budgets the server defaults to. Every value is invented or a documented default.
import { describe, expect, it, vi } from "vitest";
import { SIDE_TIMEOUTS } from "@ct/agent";

vi.mock("server-only", () => ({}));

const config = await import("../../server/config");
const { DEFAULT_SPEND_POLICY, laneBudget } = await import("../../server/breakers");
const { PRE_RUN_ECONOMY_USD, PRE_RUN_USD } = await import("../../server/llm-spend");
const { DEFAULT_VISITOR_LIMITS } = await import("../../server/visitor-limits");

const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });

describe("visitorLimitsFromEnv (D24)", () => {
  it("defaults to 2 at once, 10 an hour and 30 a day, like DEFAULT_VISITOR_LIMITS", () => {
    expect(config.visitorLimitsFromEnv(env())).toEqual({ maxActive: 2, perHour: 10, perDay: 30 });
    expect(config.visitorLimitsFromEnv(env())).toEqual(DEFAULT_VISITOR_LIMITS);
  });

  it("reads and clamps each, and never lets the day fall below the hour", () => {
    expect(config.visitorLimitsFromEnv(env({ VISITOR_MAX_ACTIVE: "3", VISITOR_HOURLY_CAP: "5", VISITOR_DAILY_CAP: "12" }))).toEqual({
      maxActive: 3,
      perHour: 5,
      perDay: 12,
    });
    expect(config.visitorLimitsFromEnv(env({ VISITOR_MAX_ACTIVE: "0", VISITOR_HOURLY_CAP: "40", VISITOR_DAILY_CAP: "20" }))).toEqual({
      maxActive: 1,
      perHour: 40,
      perDay: 40,
    });
    expect(config.visitorLimitsFromEnv(env({ VISITOR_HOURLY_CAP: "lots" })).perHour).toBe(10);
  });
});

describe("sideConfigFromEnv (D45)", () => {
  it("turns both side calls on by default with 3 searches and the agent's timeouts", () => {
    expect(config.sideConfigFromEnv(env())).toEqual({
      aiEnabled: true,
      webEnabled: true,
      webMaxUses: 3,
      aiTimeoutMs: SIDE_TIMEOUTS.aiMs,
      webTimeoutMs: SIDE_TIMEOUTS.webMs,
    });
    expect(config.SIDE_TIMEOUT_MS).toEqual({ ai: SIDE_TIMEOUTS.aiMs, web: SIDE_TIMEOUTS.webMs });
  });

  it("turns a call off only with 0 and clamps the searches to 1..5", () => {
    const off = config.sideConfigFromEnv(env({ AI_CONTEXT_ENABLED: "0", WEB_SEARCH_ENABLED: " 0 ", WEB_SEARCH_MAX_USES: "9" }));
    expect(off).toMatchObject({ aiEnabled: false, webEnabled: false, webMaxUses: 5 });
    const odd = config.sideConfigFromEnv(env({ AI_CONTEXT_ENABLED: "no", WEB_SEARCH_ENABLED: "", WEB_SEARCH_MAX_USES: "0" }));
    expect(odd).toMatchObject({ aiEnabled: true, webEnabled: true, webMaxUses: 1 });
  });
});

describe("D24 budgets in code", () => {
  it("defaults the overall and judge caps and the daily LLM budget", () => {
    expect(config.agentRunHourlyCapFromEnv(env())).toBe(120);
    expect(config.agentRunDailyCapFromEnv(env())).toBe(500);
    expect(config.judgeRunMaxActiveFromEnv(env())).toBe(2);
    expect(config.judgeRunHourlyCapFromEnv(env())).toBe(30);
    expect(config.judgeRunDailyCapFromEnv(env())).toBe(120);
    expect(config.llmDailyUsdCapFromEnv(env())).toBe(8);
    expect(config.llmEconomyUsdFromEnv(env())).toBe(6);
    expect(config.llmJudgeShareFromEnv(env())).toBe(0.4);
  });

  it("reserves $0.45 for a live run and $0.06 for an economy run, side calls included", () => {
    expect(PRE_RUN_USD).toBe(0.45);
    expect(PRE_RUN_ECONOMY_USD).toBe(0.06);
    // Economy from $6 × lane share: judge $6 of its own whole budget, public $3.60.
    expect(laneBudget("judge", DEFAULT_SPEND_POLICY).economyAt).toBe(6);
    expect(laneBudget("public", DEFAULT_SPEND_POLICY).economyAt).toBe(3.6);
  });

  it("says whether OpenStreetMap is configured without reading the value", () => {
    expect(config.osmConfiguredFromEnv(env())).toBe(false);
    expect(config.osmConfiguredFromEnv(env({ OSM_USER_AGENT: "  " }))).toBe(false);
    expect(config.osmConfiguredFromEnv(env({ OSM_USER_AGENT: "Culture Terminal (ops@example.com)" }))).toBe(true);
  });
});
