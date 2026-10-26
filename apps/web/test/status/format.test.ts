// The words /status prints: the answer first, each lane (as this server overrules it) and breaker, the
// outcomes and the uptime.
import { describe, expect, it } from "vitest";
import {
  breakerDetail,
  cacheRate,
  formatUptime,
  laneDetail,
  laneView,
  leadSentence,
  LIMITED_TAG,
  MODE_TAG,
  outcomesText,
  statusCounts,
  UNAVAILABLE_TAG,
} from "../../components/status/format";
import type { StatusReport } from "../../server/status";
import { decision, statusReport } from "./fixtures";

const paused = (over: Partial<StatusReport> = {}) =>
  statusReport({
    live: { state: "paused", blocks: ["replay_only"], message: "Live analysis is paused: today's budget for live analysis is used up. It resumes at 00:00 UTC." },
    ...over,
  });

describe("leadSentence", () => {
  it("says live analysis is on when nothing stops it", () => {
    expect(leadSentence(statusReport())).toBe("Live analysis is on: Sonnet 5.5 writes each brief.");
  });

  it("puts the most fundamental block first", () => {
    const report = statusReport({ live: { state: "unavailable", blocks: ["no_anthropic", "replay_only"], message: null } });
    expect(leadSentence(report)).toBe(
      "Live analysis is unavailable: this server has no Anthropic API key. Recorded briefs and test runs still work.",
    );
    expect(leadSentence(statusReport({ live: { state: "unavailable", blocks: ["no_database"], message: null } }))).toMatch(/^The database is unreachable/);
  });

  it("prints the breakers' own message when paused, and what still works", () => {
    expect(leadSentence(paused())).toBe(
      "Live analysis is paused: today's budget for live analysis is used up. It resumes at 00:00 UTC. Showcases, replays and cached answers still work.",
    );
  });

  it("says when the judge lane fares better than the public lane", () => {
    const lanes = { public: decision("public", "replay_only"), judge: decision("judge") };
    expect(leadSentence(paused({ mode: { ...statusReport().mode, lanes } }))).toMatch(/still work\. The judge lane stays live\.$/);
    const economy = { public: decision("public", "replay_only"), judge: decision("judge", "economy") };
    expect(leadSentence(paused({ mode: { ...statusReport().mode, lanes: economy } }))).toMatch(/The judge lane runs on the economy analyst\.$/);
  });

  it("names the breakers past 80% and an override that bypasses them", () => {
    const base = statusReport();
    const report = statusReport({
      breakers: base.breakers.map((b) => (b.key === "qloo_floor" || b.key === "live_hourly" ? { ...b, level: "high" as const } : b)),
      mode: { ...base.mode, override: "live" },
    });
    expect(leadSentence(report)).toBe(
      "Live analysis is on: Sonnet 5.5 writes each brief. Qloo month floor and Public runs per hour are past 80%. MODE_OVERRIDE bypasses every breaker.",
    );
  });

  it("counts a rejected Qloo key in a row, never as a share past 80%", () => {
    const base = statusReport();
    const q = base.qloo as Extract<StatusReport["qloo"], { configured: true }>;
    const report = statusReport({
      qloo: { ...q, authErrors: 1 },
      breakers: base.breakers.map((b) => (b.key === "qloo_auth" ? { ...b, level: "warn" as const } : b)),
    });
    expect(leadSentence(report)).toBe(
      "Live analysis is on: Sonnet 5.5 writes each brief. The Qloo key was rejected 1 time in a row; at 3 live analysis pauses.",
    );
    expect(leadSentence(report)).not.toContain("80%");
  });

  it("says runs go without evidence while QLOO_DISABLED, first or behind a pause", () => {
    expect(leadSentence(statusReport({ live: { state: "limited", blocks: ["qloo_disabled"], message: null } }))).toBe(
      "Qloo calls are switched off (QLOO_DISABLED): live runs answer as insufficient evidence. Showcases, replays and cached answers still work.",
    );
    expect(leadSentence(paused({ live: { ...paused().live, blocks: ["replay_only", "qloo_disabled"] } }))).toMatch(
      /still work\. Qloo calls are switched off \(QLOO_DISABLED\): live runs answer as insufficient evidence\.$/,
    );
    // Unavailable says only why: a server that takes no live run has none to go without evidence.
    expect(leadSentence(statusReport({ live: { state: "unavailable", blocks: ["no_anthropic", "qloo_disabled"], message: null } }))).not.toContain(
      "QLOO_DISABLED",
    );
  });
});

describe("laneView", () => {
  it("shows the decision while this server takes live runs", () => {
    expect(laneView(decision("public"), [])).toEqual({ detail: "Sonnet 5.5 writes each brief", tag: MODE_TAG.live, state: "live" });
    expect(laneView(decision("public"), ["live_hourly"]).state).toBe("live");
  });

  it("overrules a live decision on a server that takes no live run", () => {
    for (const block of ["no_database", "draining", "no_anthropic", "no_qloo"] as const) {
      expect(laneView(decision("judge"), [block])).toEqual({
        detail: "Live by the breakers · this server takes no live runs",
        tag: UNAVAILABLE_TAG,
        state: "unavailable",
      });
    }
    expect(laneView(decision("public", "economy"), ["no_anthropic"]).detail).toBe("Economy by the breakers · this server takes no live runs");
  });

  it("marks a lane limited while QLOO_DISABLED, unless it is paused anyway", () => {
    expect(laneView(decision("public"), ["qloo_disabled"])).toEqual({
      detail: "Live by the breakers · no Qloo calls: runs answer as insufficient evidence",
      tag: LIMITED_TAG,
      state: "limited",
    });
    expect(laneView(decision("public", "replay_only"), ["replay_only", "qloo_disabled"]).state).toBe("replay_only");
  });
});

describe("laneDetail", () => {
  it("says who writes the briefs, or why the lane stepped down and until when", () => {
    expect(laneDetail(decision("public"))).toBe("Sonnet 5.5 writes each brief");
    expect(
      laneDetail(decision("public", "economy", { reason: "today's live budget is nearly used", until: "2026-10-24T00:00:00.000Z" })),
    ).toBe("Haiku 5.5 writes each brief until 00:00 UTC: today's live budget is nearly used");
    expect(laneDetail(decision("judge", "replay_only", { reason: "this month's Qloo quota is at its floor" }))).toBe(
      "No live runs: this month's Qloo quota is at its floor",
    );
  });
});

describe("breakerDetail", () => {
  const report = statusReport();

  it("prints each breaker's numbers", () => {
    expect(breakerDetail("llm_spend", report)).toBe("$0.12 today · public economy at $0.49, paused at $0.79");
    expect(breakerDetail("qloo_floor", report)).toBe("41,000 calls left this month · floor 2,000");
    expect(breakerDetail("qloo_daily", report)).toBe("120 of 1,900 fresh calls today");
    expect(breakerDetail("qloo_auth", report)).toBe("Rejected 0 times in a row · replay only at 3");
    expect(breakerDetail("live_hourly", report)).toBe("4 of 20 started in the last hour");
    expect(breakerDetail("draining", report)).toBe("Accepted on this server");
    expect(breakerDetail("qloo_switch", report)).toBe("Allowed");
    expect(breakerDetail("override", report)).toBe("MODE_OVERRIDE not set");
  });

  it("says who stored the mode, and clips a long reason", () => {
    expect(breakerDetail("stored", report)).toBe("Live · never switched");
    const stored = { mode: "replay_only" as const, reason: "qloo", since: "2026-10-22T19:04:00.000Z" };
    expect(breakerDetail("stored", statusReport({ mode: { ...report.mode, stored } }))).toBe("Replay only · set by qloo · 22 Oct, 19:04 UTC");
    const long = { mode: "economy" as const, reason: "x".repeat(200), since: null };
    expect(breakerDetail("stored", statusReport({ mode: { ...report.mode, stored: long } }))).toBe(`Economy · set by ${"x".repeat(59)}…`);
  });

  it("says when a number could not be read or does not apply", () => {
    const unread = statusReport({ llm: { ...report.llm, todayUsd: null }, qloo: { configured: false, disabled: false } });
    expect(breakerDetail("llm_spend", unread)).toMatch(/^Today's spend could not be read/);
    expect(breakerDetail("qloo_floor", unread)).toBe("Qloo is not configured");
  });
});

describe("outcomes", () => {
  it("counts statuses in a fixed order and leaves out the absent ones", () => {
    const statuses = ["failed", "completed", "needs_input", "completed"] as const;
    expect(statusCounts(statuses)).toEqual([
      { status: "completed", n: 2 },
      { status: "needs_input", n: 1 },
      { status: "failed", n: 1 },
    ]);
    expect(outcomesText(statuses)).toBe("2 completed · 1 awaiting a pick · 1 failed");
    expect(outcomesText([])).toBe("");
  });
});

describe("cacheRate and formatUptime", () => {
  it("rounds the rate, and has none without a call", () => {
    expect(cacheRate({ total: 3, served: 2, sampled: false })).toBe(67);
    expect(cacheRate({ total: 0, served: 0, sampled: false })).toBeNull();
    expect(cacheRate(null)).toBeNull();
  });

  it("prints uptime at the scale that reads", () => {
    expect(formatUptime(42)).toBe("42 s");
    expect(formatUptime(360)).toBe("6 min");
    expect(formatUptime(3 * 3600)).toBe("3 h");
    expect(formatUptime(3 * 3600 + 12 * 60)).toBe("3 h 12 min");
    expect(formatUptime(52 * 3600)).toBe("2 d 4 h");
  });
});
