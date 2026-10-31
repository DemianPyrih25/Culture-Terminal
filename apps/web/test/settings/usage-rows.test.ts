// Settings > Plan & usage (components/settings/usage.ts): the /api/access?usage=1 reader and the rows
// it becomes: used, left, the bar's tone and the reset line. Absent parts make no row.
import { describe, expect, it } from "vitest";
import { durationWords, readUsage, toneOf, usageRows, type Usage } from "../../components/settings/usage";

const USAGE: Usage = {
  scope: "visitor",
  answers: {
    day: { used: 24, limit: 30, nextFreeS: 3 * 3600 + 11 * 60 + 30 },
    hour: { used: 10, limit: 10, nextFreeS: 23 * 60 },
    active: { used: 0, limit: 2 },
  },
  screener: { hour: { used: 0, limit: 20, nextFreeS: null }, minute: { used: 0, limit: 4 } },
};

describe("usage rows", () => {
  it("shows each limit's use, what is left, its tone and when a place frees", () => {
    const rows = usageRows(USAGE, { used: 3, max: 25 });
    expect(rows.map((r) => r.key)).toEqual(["answers-day", "answers-hour", "answers-active", "screener-hour", "follows"]);
    expect(rows[0]).toMatchObject({ used: 24, limit: 30, left: 6, tone: "caution", resets: "Next one frees up in 3 h 12 min" });
    expect(rows[1]).toMatchObject({ left: 0, share: 1, tone: "danger", resets: "Next one frees up in 23 min" });
    expect(rows[2]).toMatchObject({ left: 2, tone: "accent", resets: "None running" });
    expect(rows[3]).toMatchObject({ used: 0, left: 20, resets: "Rolling hour · at most 4 a minute" });
    expect(rows[4]).toMatchObject({ used: 3, limit: 25, left: 22, tone: "accent" });
  });

  it("counts the reset down from the read, and leaves out what could not be read", () => {
    expect(usageRows(USAGE, null, 60 * 22 + 30)[1]?.resets).toBe("Next one frees up in under a minute");
    expect(usageRows({ scope: "visitor" }, null)).toEqual([]);
    expect(usageRows(null, { used: 0, max: 25 }).map((r) => r.key)).toEqual(["follows"]);
  });

  it("tones accent below 80%, caution from 80%, danger at the limit", () => {
    expect([toneOf(7, 10), toneOf(8, 10), toneOf(10, 10), toneOf(12, 10)]).toEqual(["accent", "caution", "danger", "danger"]);
    expect([durationWords(30), durationWords(61), durationWords(7200)]).toEqual(["under a minute", "2 min", "2 h"]);
  });

  it("reads the usage of an /api/access answer and nothing else", () => {
    expect(readUsage({ lane: "public", usage: USAGE })).toEqual(USAGE);
    expect(readUsage({ lane: "public" })).toBeNull();
    expect(readUsage({ usage: { scope: "visitor", answers: { hour: { used: "3" } } } })).toBeNull();
  });
});
