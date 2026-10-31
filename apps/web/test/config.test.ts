import { describe, expect, it, vi } from "vitest";
import {
  agentRunDailyCapFromEnv,
  agentRunHourlyCapFromEnv,
  agentRunMaxActiveFromEnv,
  fakeRunHourlyCapFromEnv,
  fakeRunRetentionMsFromEnv,
  judgeRunDailyCapFromEnv,
  judgeRunHourlyCapFromEnv,
  judgeRunMaxActiveFromEnv,
  llmDailyUsdCapFromEnv,
  llmEconomyUsdFromEnv,
  llmJudgeShareFromEnv,
  modeOverrideFromEnv,
  previewHourlyCapFromEnv,
  publicSiteUrlFromEnv,
  qlooDailyFreshCapFromEnv,
  qlooDisabledFromEnv,
} from "../server/config";

vi.mock("server-only", () => ({}));

const HOUR = 3_600_000;
// Next.js types NODE_ENV as required.
const env = (vars: Record<string, string> = {}): NodeJS.ProcessEnv => ({ NODE_ENV: "test", ...vars });

describe("fake run limits from the environment", () => {
  it("defaults to 60 runs an hour and six hours of retention, also for empty values", () => {
    expect(fakeRunHourlyCapFromEnv(env())).toBe(60);
    expect(fakeRunHourlyCapFromEnv(env({ FAKE_RUN_HOURLY_CAP: " " }))).toBe(60);
    expect(fakeRunRetentionMsFromEnv(env())).toBe(6 * HOUR);
    expect(fakeRunRetentionMsFromEnv(env({ FAKE_RUN_RETENTION_HOURS: "" }))).toBe(6 * HOUR);
  });

  it("reads and clamps the values", () => {
    expect(fakeRunHourlyCapFromEnv(env({ FAKE_RUN_HOURLY_CAP: "12" }))).toBe(12);
    expect(fakeRunHourlyCapFromEnv(env({ FAKE_RUN_HOURLY_CAP: "0" }))).toBe(1);
    expect(fakeRunHourlyCapFromEnv(env({ FAKE_RUN_HOURLY_CAP: "lots" }))).toBe(60);
    expect(fakeRunRetentionMsFromEnv(env({ FAKE_RUN_RETENTION_HOURS: "24" }))).toBe(24 * HOUR);
    // Never shorter than the cap's window, or a purge would let the cap count fewer runs.
    expect(fakeRunRetentionMsFromEnv(env({ FAKE_RUN_RETENTION_HOURS: "0.25" }))).toBe(HOUR);
  });
});

describe("agent run limits from the environment", () => {
  it("defaults to D24: 120 agent runs an hour and an 8 USD daily LLM cap, also for empty values", () => {
    expect(agentRunHourlyCapFromEnv(env())).toBe(120);
    expect(agentRunHourlyCapFromEnv(env({ AGENT_RUN_HOURLY_CAP: "" }))).toBe(120);
    expect(agentRunMaxActiveFromEnv(env())).toBe(6);
    expect(agentRunMaxActiveFromEnv(env({ AGENT_RUN_MAX_ACTIVE: " " }))).toBe(6);
    expect(llmDailyUsdCapFromEnv(env())).toBe(8);
    expect(llmDailyUsdCapFromEnv(env({ LLM_DAILY_USD_CAP: " " }))).toBe(8);
  });

  it("reads and clamps the values", () => {
    expect(agentRunHourlyCapFromEnv(env({ AGENT_RUN_HOURLY_CAP: "5" }))).toBe(5);
    expect(agentRunHourlyCapFromEnv(env({ AGENT_RUN_HOURLY_CAP: "0" }))).toBe(1);
    expect(agentRunHourlyCapFromEnv(env({ AGENT_RUN_HOURLY_CAP: "many" }))).toBe(120);
    expect(agentRunMaxActiveFromEnv(env({ AGENT_RUN_MAX_ACTIVE: "5" }))).toBe(5);
    expect(agentRunMaxActiveFromEnv(env({ AGENT_RUN_MAX_ACTIVE: "0" }))).toBe(1);
    expect(llmDailyUsdCapFromEnv(env({ LLM_DAILY_USD_CAP: "2.5" }))).toBe(2.5);
    // Zero refuses every live run, which is a valid way to switch them off.
    expect(llmDailyUsdCapFromEnv(env({ LLM_DAILY_USD_CAP: "-1" }))).toBe(0);
  });
});

describe("the public site URL from the environment", () => {
  it("is undefined when unset or blank, so Next falls back to localhost", () => {
    expect(publicSiteUrlFromEnv(env())).toBeUndefined();
    expect(publicSiteUrlFromEnv(env({ PUBLIC_SITE_URL: " ", RENDER_EXTERNAL_URL: "" }))).toBeUndefined();
  });

  it("reads a full URL, gives a bare host https://, and falls back to Render's external URL", () => {
    expect(publicSiteUrlFromEnv(env({ PUBLIC_SITE_URL: "https://culture-terminal.example" }))?.href).toBe("https://culture-terminal.example/");
    expect(publicSiteUrlFromEnv(env({ PUBLIC_SITE_URL: " culture-terminal.example " }))?.href).toBe("https://culture-terminal.example/");
    expect(publicSiteUrlFromEnv(env({ PUBLIC_SITE_URL: "http://localhost:3100" }))?.href).toBe("http://localhost:3100/");
    expect(publicSiteUrlFromEnv(env({ PUBLIC_SITE_URL: " ", RENDER_EXTERNAL_URL: "https://web.render.example" }))?.href).toBe("https://web.render.example/");
    expect(publicSiteUrlFromEnv(env({ PUBLIC_SITE_URL: "culture-terminal.example", RENDER_EXTERNAL_URL: "https://web.render.example" }))?.host).toBe("culture-terminal.example");
  });

  it("is undefined for a value that is not a URL, instead of failing the root layout", () => {
    for (const value of ["not a url", "https://", "https://bad host.example"]) expect(publicSiteUrlFromEnv(env({ PUBLIC_SITE_URL: value }))).toBeUndefined();
  });
});

describe("preview settings from the environment", () => {
  it("defaults to 120 previews an hour, Qloo on and the 1,900 daily fresh-call quota", () => {
    expect(previewHourlyCapFromEnv(env())).toBe(120);
    expect(previewHourlyCapFromEnv(env({ PREVIEW_HOURLY_CAP: " " }))).toBe(120);
    expect(qlooDisabledFromEnv(env())).toBe(false);
    expect(qlooDailyFreshCapFromEnv(env())).toBe(1_900);
  });

  it("reads and clamps the values; only 1 turns Qloo off", () => {
    expect(previewHourlyCapFromEnv(env({ PREVIEW_HOURLY_CAP: "30" }))).toBe(30);
    expect(previewHourlyCapFromEnv(env({ PREVIEW_HOURLY_CAP: "0" }))).toBe(1);
    expect(previewHourlyCapFromEnv(env({ PREVIEW_HOURLY_CAP: "plenty" }))).toBe(120);
    expect(qlooDisabledFromEnv(env({ QLOO_DISABLED: " 1 " }))).toBe(true);
    for (const value of ["0", "", "true", "yes"]) expect(qlooDisabledFromEnv(env({ QLOO_DISABLED: value }))).toBe(false);
    expect(qlooDailyFreshCapFromEnv(env({ QLOO_DAILY_FRESH_CAP: "1200" }))).toBe(1_200);
  });
});

describe("lanes and breakers from the environment", () => {
  it("defaults to D24: economy at $6, 40% for judges, 30 judge runs an hour on two slots", () => {
    expect(llmEconomyUsdFromEnv(env())).toBe(6);
    expect(llmJudgeShareFromEnv(env())).toBe(0.4);
    expect(judgeRunHourlyCapFromEnv(env())).toBe(30);
    expect(judgeRunMaxActiveFromEnv(env())).toBe(2);
    expect(modeOverrideFromEnv(env())).toBeNull();
  });

  it("defaults to D24's daily caps: 120 judge runs and 500 live runs in all, also for empty values", () => {
    expect(judgeRunDailyCapFromEnv(env())).toBe(120);
    expect(judgeRunDailyCapFromEnv(env({ JUDGE_RUN_DAILY_CAP: " " }))).toBe(120);
    expect(agentRunDailyCapFromEnv(env())).toBe(500);
    expect(agentRunDailyCapFromEnv(env({ AGENT_RUN_DAILY_CAP: "" }))).toBe(500);
    expect(judgeRunDailyCapFromEnv(env({ JUDGE_RUN_DAILY_CAP: "0" }))).toBe(1);
    expect(agentRunDailyCapFromEnv(env({ AGENT_RUN_DAILY_CAP: "50" }))).toBe(50);
  });

  it("reads and clamps the values, so each breaker can be forced", () => {
    expect(llmEconomyUsdFromEnv(env({ LLM_ECONOMY_USD: "0" }))).toBe(0);
    expect(llmEconomyUsdFromEnv(env({ LLM_ECONOMY_USD: "0.5" }))).toBe(0.5);
    // A judge share above 90% would leave the public lane nothing.
    expect(llmJudgeShareFromEnv(env({ LLM_JUDGE_SHARE: "1" }))).toBe(0.9);
    expect(llmJudgeShareFromEnv(env({ LLM_JUDGE_SHARE: "-1" }))).toBe(0);
    expect(judgeRunHourlyCapFromEnv(env({ JUDGE_RUN_HOURLY_CAP: "60" }))).toBe(60);
    expect(judgeRunMaxActiveFromEnv(env({ JUDGE_RUN_MAX_ACTIVE: "0" }))).toBe(1);
  });

  it("takes MODE_OVERRIDE only as one of the three modes", () => {
    expect(modeOverrideFromEnv(env({ MODE_OVERRIDE: " Replay_Only " }))).toBe("replay_only");
    expect(modeOverrideFromEnv(env({ MODE_OVERRIDE: "economy" }))).toBe("economy");
    expect(modeOverrideFromEnv(env({ MODE_OVERRIDE: "live" }))).toBe("live");
    for (const value of ["", "off", "normal"]) expect(modeOverrideFromEnv(env({ MODE_OVERRIDE: value }))).toBeNull();
  });
});
