// GET /api/runs query parsing, cursors and row mapping, without a database. Invented entities only.
import { describe, expect, it, vi } from "vitest";
import type { RunListRow } from "@ct/db";

vi.mock("server-only", () => ({}));

const { decodeCursor, encodeCursor, followUpBlock, parseRunListQuery, questionKey, RUN_LIST_DEFAULT_LIMIT, RUN_LIST_IDS_MAX, toBriefSummary } =
  await import("../server/run-list");

const params = (query: string) => new URLSearchParams(query);

function row(over: Partial<RunListRow> = {}): RunListRow {
  return {
    id: "run-brief-0001",
    question: "Who really competes with Juniper Cola?",
    pillar: "investment",
    job: "brand_health",
    status: "completed",
    createdAt: new Date("2026-10-22T09:00:00.000Z"),
    createdAtKey: "2026-10-22T09:00:00.000123Z",
    signal: "mixed",
    headline: "Juniper Cola is a taste island {{M2}}",
    tag: "Taste island",
    confidenceScore: 82,
    confidenceBand: "HIGH",
    numbersTraced: { traced: 9, total: 9 },
    qlooNetwork: 11,
    qlooCached: 9,
    qlooReused: null,
    ...over,
  };
}

describe("parseRunListQuery", () => {
  it("defaults to the newest 20 briefs of every desk", () => {
    expect(parseRunListQuery(params(""))).toEqual({
      ok: true,
      query: { limit: RUN_LIST_DEFAULT_LIMIT, sort: "date", search: null, pillar: null, before: null, ids: [] },
    });
    expect(parseRunListQuery(params("limit=&sort=&q=%20%20&pillar=&before="))).toMatchObject({ ok: true, query: { limit: 20, search: null } });
  });

  it("reads the limit, cut to 50, the sort, the trimmed search and the desk", () => {
    expect(parseRunListQuery(params("limit=500&sort=conviction&q=%20Juniper%20&pillar=location&utm=x"))).toEqual({
      ok: true,
      query: { limit: 50, sort: "conviction", search: "Juniper", pillar: "location", before: null, ids: [] },
    });
    expect(parseRunListQuery(params("limit=7"))).toMatchObject({ ok: true, query: { limit: 7 } });
  });

  it("reads the browser's own run ids: trimmed, distinct, empty entries skipped", () => {
    expect(parseRunListQuery(params("ids=run-brief-0001,%20run-brief-0002,,run-brief-0001,"))).toMatchObject({
      ok: true,
      query: { ids: ["run-brief-0001", "run-brief-0002"] },
    });
    const fifty = Array.from({ length: RUN_LIST_IDS_MAX }, (_, i) => `run-brief-${String(i).padStart(4, "0")}`);
    expect(parseRunListQuery(params(`ids=${fifty.join(",")}`))).toMatchObject({ ok: true, query: { ids: fifty } });
    // The same id twice counts once.
    expect(parseRunListQuery(params(`ids=${[...fifty, fifty[0]].join(",")}`)).ok).toBe(true);
  });

  it.each([
    ["limit=0", "limit"],
    ["limit=-3", "limit"],
    ["limit=2.5", "limit"],
    ["limit=ten", "limit"],
    ["sort=newest", "sort"],
    ["pillar=finance", "pillar"],
    [`q=${"x".repeat(201)}`, "q"],
    ["before=not-a-cursor!", "before"],
    ["before=e30", "before"],
    ["ids=run-brief-0001,not%20an%20id", "ids"],
    ["ids=short", "ids"],
    ["ids=run-brief-0001;drop", "ids"],
    [`ids=${Array.from({ length: 51 }, (_, i) => `run-brief-${String(i).padStart(4, "0")}`).join(",")}`, "ids"],
    [`ids=${"a".repeat(4000)}`, "ids"],
  ])("rejects %s", (query, path) => {
    const parsed = parseRunListQuery(params(query));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((i) => i.path)).toContain(path);
  });

  it("takes the next value of a page with the same sort, or a plain timestamp for the date sort", () => {
    const next = encodeCursor("date", { createdAt: "2026-10-22T09:00:00.000123Z", id: "run-brief-0001" });
    expect(parseRunListQuery(params(`before=${next}`))).toMatchObject({
      ok: true,
      query: { before: { createdAt: "2026-10-22T09:00:00.000123Z", id: "run-brief-0001" } },
    });
    expect(parseRunListQuery(params(`before=${next}&sort=conviction`)).ok).toBe(false);
    expect(parseRunListQuery(params("before=2026-10-22T09:00:00Z"))).toMatchObject({
      ok: true,
      query: { before: { createdAt: "2026-10-22T09:00:00Z", id: null } },
    });
    expect(parseRunListQuery(params("before=2026-10-22T09:00:00Z&sort=conviction")).ok).toBe(false);
  });
});

describe("cursors", () => {
  it("round-trip a conviction cursor with its score, a null score included", () => {
    for (const score of [82, null]) {
      const cursor = { createdAt: "2026-10-22T09:00:00.5Z", id: "run-brief-0002", score };
      const encoded = encodeCursor("conviction", cursor);
      expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
      expect(decodeCursor("conviction", encoded)).toEqual(cursor);
    }
  });

  it("refuse a cursor whose time Postgres could not read, or whose fields are wrong", () => {
    const forge = (tuple: unknown) => Buffer.from(JSON.stringify(tuple)).toString("base64url");
    expect(decodeCursor("date", forge(["date", "yesterday", "run-1", null]))).toBeNull();
    // The cursor's shape, but no such time: month 13, day 45, hour 25.
    const impossible = forge(["date", "2026-13-45T25:61:61Z", "run-1", null]);
    expect(decodeCursor("date", impossible)).toBeNull();
    expect(decodeCursor("conviction", forge(["conviction", "2026-02-30T09:00:00.000123Z", "run-1", 82]))).toBeNull();
    const parsed = parseRunListQuery(params(`before=${impossible}`));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.issues.map((i) => i.path)).toContain("before");
    expect(decodeCursor("date", forge(["date", "2026-10-22T09:00:00Z", "", null]))).toBeNull();
    expect(decodeCursor("date", forge(["date", "2026-10-22T09:00:00Z", "run-1"]))).toBeNull();
    expect(decodeCursor("conviction", forge(["conviction", "2026-10-22T09:00:00Z", "run-1", "82"]))).toBeNull();
    expect(decodeCursor("date", forge(["date", "2026-10-22T09:00:00Z", "run-1", null]))).toEqual({
      createdAt: "2026-10-22T09:00:00Z",
      id: "run-1",
    });
  });
});

describe("toBriefSummary", () => {
  it("shows a finished brief with its desk, job label, verdict, conviction, receipts and sources", () => {
    const metrics = { M2: { label: "Juniper Cola rank in its own row", display: "6 of 6", badge: "MEASURED" } };
    expect(toBriefSummary(row(), metrics)).toEqual({
      runId: "run-brief-0001",
      question: "Who really competes with Juniper Cola?",
      pillar: "investment",
      job: "brand_health",
      jobLabel: "Real competitors",
      status: "completed",
      signal: "mixed",
      tag: "Taste island",
      headline: "Juniper Cola is a taste island {{M2}}",
      metrics,
      confidence: { score: 82, band: "HIGH" },
      createdAt: "2026-10-22T09:00:00.000Z",
      numbersTraced: { traced: 9, total: 9 },
      sources: 20,
    });
  });

  it("lists a verdict tag only when it keeps its rule", () => {
    expect(toBriefSummary(row({ tag: null })).tag).toBeNull();
    expect(toBriefSummary(row({ tag: "Ranks 3rd of 8 brands" })).tag).toBeNull();
    expect(toBriefSummary(row({ tag: " Clear lead " })).tag).toBe("Clear lead");
  });

  it("counts the requests a follow-up reused from its parent among its sources, as the brief page does", () => {
    expect(toBriefSummary(row({ qlooReused: 6 })).sources).toBe(26);
    expect(toBriefSummary(row({ qlooReused: 0 })).sources).toBe(20);
  });

  it("never trusts what the stored report says: anything off-contract reads as missing", () => {
    const odd = toBriefSummary(
      row({
        status: "incomplete",
        pillar: "finance",
        job: null,
        signal: "buy",
        confidenceScore: 82.5,
        numbersTraced: { traced: 5, total: 3 },
      }),
    );
    expect(odd).toMatchObject({
      status: "incomplete",
      pillar: null,
      job: null,
      jobLabel: null,
      signal: null,
      confidence: null,
      numbersTraced: null,
      metrics: {},
    });
    expect(toBriefSummary(row({ confidenceBand: "VERY HIGH" })).confidence).toBeNull();
    expect(toBriefSummary(row({ confidenceScore: null })).confidence).toBeNull();
  });
});

describe("followUpBlock", () => {
  const note = { questionHash: "q1:abc", status: "completed" as const, report: null };

  it("refuses a test run, a run still being written, and a run without a note, as POST /api/runs does", () => {
    expect(followUpBlock({ ...note, questionHash: "fake:abc" })).toBe("test_run");
    expect(followUpBlock({ ...note, status: "running" })).toBe("running");
    expect(followUpBlock({ ...note, status: "queued" })).toBe("running");
    expect(followUpBlock({ ...note, status: "failed" })).toBe("no_note");
    expect(followUpBlock({ ...note, status: "needs_input" })).toBe("no_note");
    // Completed, but the stored report is not a note.
    expect(followUpBlock({ ...note, report: { verdict: "strong" } })).toBe("no_note");
  });

  it("takes an agent run that ended completed or incomplete with its note", async () => {
    const { buildFakeScript } = await import("../server/fake-script");
    const { report } = buildFakeScript({ runId: "run-brief-0001", startedAt: Date.parse("2026-10-22T09:00:00Z"), durationMs: 1000 });
    expect(followUpBlock({ ...note, report })).toBeNull();
    expect(followUpBlock({ ...note, status: "incomplete", report })).toBeNull();
  });
});

describe("questionKey", () => {
  it("matches a question whatever its spacing and case", () => {
    expect(questionKey("  Who really  competes with	Juniper Cola? ")).toBe(questionKey("who really competes with juniper cola?"));
  });
});
