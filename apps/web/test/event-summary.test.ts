// One-line summaries for every event type, and report prose as plain text. Entities are invented (D29).
import { describe, expect, it, vi } from "vitest";
import {
  GHOST_HONESTY_LINE,
  RUN_EVENT_TYPES,
  RunEvent,
  stampEvent,
  type EventInput,
  type EventOf,
  type Metric,
  type RunEventType,
  type RunState,
} from "@ct/contracts";
import { cacheChip, formatAge, shortRequestId, summarizeEvent } from "../lib/event-summary";
import { proseText } from "../lib/report-text";
import { buildFakeScript } from "../server/fake-script";

vi.mock("server-only", () => ({}));

const RUN = "run-summary-test";
const script = buildFakeScript({ runId: RUN, startedAt: Date.UTC(2026, 0, 1), durationMs: 200_000 });

const EXTRA: EventInput[] = [
  {
    type: "needs_input",
    mention: "Juniper",
    entityType: "brand",
    reason: "ambiguous",
    candidates: [
      { key: "pick-a", name: "Juniper Cola", disambiguation: "soft drink", popularity: 0.6 },
      { key: "pick-b", name: "Juniper Tonic", disambiguation: null, popularity: null },
    ],
  },
  {
    type: "ghost",
    answer: {
      headline: "Juniper Cola is a niche brand",
      picks: { competitors: ["Kestrel Tonic"], markets: [], neighbourhoods: [], tenants: [], partners: [] },
      numeric_claims: [],
    },
    diff: {
      items: [],
      overlapAt5: null,
      resolvability: null,
      unsourcedNumericClaims: 0,
      meanPopularity: { ghost: null, qloo: null },
      honestyLine: GHOST_HONESTY_LINE,
    },
  },
  { type: "error", code: "qloo_rate_limited", message: "Qloo asked us to slow down.", retryable: true },
];

const events: RunEvent[] = [...script.steps.map((s) => s.input), ...EXTRA].map((input, i) =>
  RunEvent.parse(stampEvent(input, { seq: i + 1, ts: new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString(), runId: RUN })),
);

const first = <T extends RunEventType>(type: T): EventOf<T> => {
  const found = events.find((e): e is EventOf<T> => e.type === type);
  if (!found) throw new Error(`no ${type} event in the sample`);
  return found;
};

const metric = (over: Partial<Metric>): Metric => ({
  id: "M1",
  key: "subs.rank",
  label: "Rank in own row",
  subjectRefs: ["R1"],
  value: 5,
  reason: null,
  display: "5 of 5",
  unit: "rank",
  badge: "MEASURED",
  formulaId: "subs.rank",
  evidenceIds: ["E1"],
  n: 5,
  conf: 0.5,
  comparator: null,
  window: null,
  ...over,
});

describe("summarizeEvent", () => {
  it("covers every event type with one non-empty line", () => {
    const seen = new Set(events.map((e) => e.type));
    for (const type of RUN_EVENT_TYPES) {
      if (type === "run.end") continue;
      expect(seen, type).toContain(type);
    }
    const end = RunEvent.parse(
      stampEvent({ type: "run.end", status: "needs_input", elapsedMs: 61_000, reason: "Pick one." }, { seq: 999, ts: "2026-01-01T00:00:00.000Z", runId: RUN }),
    );
    for (const event of [...events, end]) {
      const line = summarizeEvent(event);
      expect(line.length, event.type).toBeGreaterThan(0);
      expect(line.length, event.type).toBeLessThanOrEqual(140);
      expect(line, event.type).not.toContain("\n");
    }
    expect(summarizeEvent(end)).toBe("needs_input after 1:01 · Pick one.");
  });

  it("names CLERK's compiled command, desk and job", () => {
    const clerk = first("clerk");
    expect(summarizeEvent(clerk)).toContain(clerk.intent.mnemonic);
    expect(summarizeEvent(clerk)).toContain(`${clerk.intent.pillar} / ${clerk.intent.job}`);
    const refused = { ...clerk, intent: { ...clerk.intent, safety: { allowed: false, category: "private_individual" as const, reframe: null } } };
    expect(summarizeEvent(refused)).toContain("refused (private_individual)");
  });

  it("lists the picker's candidates", () => {
    expect(summarizeEvent(first("needs_input"))).toBe(
      'Pick one for "Juniper" (ambiguous): Juniper Cola (soft drink) · Juniper Tonic',
    );
  });

  it("counts the plan and quotes its hypotheses", () => {
    const plan = first("plan");
    const line = summarizeEvent(plan);
    expect(line).toMatch(new RegExp(`^${plan.plan.hypotheses.length} hypotheses, ${plan.plan.steps.length} steps · H1 `));
  });

  it("shows how a Qloo call was served, with a short request id", () => {
    const qloo = first("qloo");
    const miss = { ...qloo, cache: "miss" as const, requestId: "synthetic-request-alpha", ms: 320, rows: 20, error: null };
    expect(summarizeEvent(miss)).toContain("· MISS · 320 ms · req syntheti… · 20 rows");
    expect(cacheChip({ ...miss, cache: "hit", cacheAgeMs: 3 * 3_600_000 })).toBe("CACHE 3h");
    expect(cacheChip({ ...miss, cache: "hit", cacheAgeMs: null })).toBe("CACHE");
    expect(cacheChip({ ...miss, cache: "reused", originRunId: "a1f3-run" })).toBe("REUSED from #A1F3");
    expect(cacheChip({ ...miss, cache: "stale" })).toBe("STALE");
    expect(cacheChip({ ...miss, cache: "coalesced" })).toBe("COALESCED");
    expect(shortRequestId(null)).toBe("no response");
    expect(shortRequestId("short-id")).toBe("short-id");
    expect(formatAge(45_000)).toBe("45s");
    expect(formatAge(12 * 60_000)).toBe("12m");
    expect(formatAge(2 * 86_400_000)).toBe("2d");
  });

  it("names the tool and its error", () => {
    const end = first("tool.end");
    const failed = { ...end, ok: false, status: "error" as const, error: { code: "qloo_unavailable" as const, message: "Qloo did not answer." } };
    expect(summarizeEvent(failed)).toContain("error in");
    expect(summarizeEvent(failed)).toContain("qloo_unavailable: Qloo did not answer.");
    expect(summarizeEvent(first("tool.start"))).toContain(first("tool.start").tool);
  });

  it("gives the final note's headline, signal, numbers traced and confidence", () => {
    const final = first("report.final");
    const { verdict, receipt } = final.report;
    const line = summarizeEvent(final);
    expect(line).toContain(`signal ${verdict.signal}`);
    expect(line).toContain(`${receipt.numbersTraced.traced}/${receipt.numbersTraced.total} numbers traced`);
    expect(line).toContain(`confidence ${verdict.confidence.score} ${verdict.confidence.band}`);

    const tokened = { ...final, report: { ...final.report, verdict: { ...verdict, headline: "Juniper Cola ranks {{M1}} in its own row" } } };
    const metrics: RunState["metrics"] = { M1: metric({}) };
    expect(summarizeEvent(tokened, metrics)).toMatch(/^Juniper Cola ranks 5 of 5 \(MEASURED\) in its own row · signal /);
    expect(summarizeEvent(tokened)).toMatch(/^Juniper Cola ranks n\/a in its own row/);
  });

  it("marks the CHECKER result, the spend and errors", () => {
    expect(summarizeEvent(first("validation"))).toMatch(/^(✓ Passed|✗ Rejected) \(attempt \d\) · \d+\/\d+ numbers traced/);
    const usage = { ...first("usage"), llmUsd: 0.1234, tokens: { input: 12_000, output: 800, cacheRead: 9_000, cacheCreation: 0 } };
    expect(summarizeEvent(usage)).toMatch(/^\$0\.12 · 21\.8k tokens \(9\.0k cached\) · Qloo /);
    expect(summarizeEvent(first("error"))).toBe("qloo_rate_limited: Qloo asked us to slow down. · retryable");
  });
});

describe("proseText", () => {
  const metrics: RunState["metrics"] = { M1: metric({}), M2: metric({ id: "M2", display: "Rising", badge: "STALE", window: { start: "2025-04-07", end: "2025-09-29" } }) };

  it("writes metric tokens as their value and badge and keeps evidence citations", () => {
    expect(proseText("Rank {{M1}} [E1], momentum {{M2}}.", metrics)).toBe("Rank 5 of 5 (MEASURED) [E1], momentum Rising (STALE).");
  });

  it("never prints an unbound number: an unknown metric reads n/a", () => {
    expect(proseText("Rank {{M9}}.", metrics)).toBe("Rank n/a.");
  });

  it("writes the window token as the trending window", () => {
    expect(proseText("Over {{WINDOW}}.", metrics, { start: "2025-04-07", end: "2025-09-29" })).toBe("Over 2025-04-07..2025-09-29.");
    expect(proseText("Over {{WINDOW}}.")).toBe("Over the trending window.");
  });

  it("leaves markup as text", () => {
    expect(proseText("<b>bold</b> **not markdown**")).toBe("<b>bold</b> **not markdown**");
  });
});
