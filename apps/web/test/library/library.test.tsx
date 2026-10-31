// Your answers (/briefs): only this browser's own runs, as AnswerRows. The list request and the runs read
// one by one, what each status prints, the day, the empty, loading and error states, and the page. No
// examples, no filters. Invented runs only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/briefs",
}));

const { default: YourAnswersPage, metadata } = await import("../../app/briefs/page");
const { AnswerRow } = await import("../../components/library/answer-row");
const { answerFromRun, answerFromSummary, ANSWERS_SNAPSHOT_MAX, BriefsError, byNewest, loadYourAnswers, relativeDay } = await import(
  "../../components/library/answers"
);
const { verdictText } = await import("../../components/library/format");
const { EMPTY_DETAIL, YourAnswersView } = await import("../../components/library/your-answers");
const { brief, briefList } = await import("./briefs");
type AnswerItem = import("../../components/library/answers").AnswerItem;

const html = renderToStaticMarkup;
const NOW = Date.parse("2026-10-26T15:00:00.000Z");

const MINE_DONE = "run-mine-0001";
const MINE_WORKING = "run-mine-0002";
const MINE_STOPPED = "run-mine-0003";
const MINE_GONE = "run-mine-0004";
const SHOWCASE = "run-showcase-0001";

/** A stand-in for GET /api/runs and GET /api/runs/[id]. */
function stubFetch(listStatus = 200) {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.startsWith("/api/runs?")) {
      if (listStatus !== 200) return Response.json({ error: "The list is down." }, { status: listStatus });
      return Response.json(
        briefList([
          brief({ runId: SHOWCASE, question: "Who really competes with Brand Alpha?", createdAt: "2026-10-26T14:00:00.000Z" }),
          brief({ runId: MINE_DONE, tag: "Taste island", createdAt: "2026-10-25T10:00:00.000Z" }),
        ]),
      );
    }
    const id = decodeURIComponent(url.slice("/api/runs/".length));
    if (id === MINE_WORKING) {
      return Response.json({ run: { id, status: "running", question: "Which cities love Juniper Cola most?", createdAt: "2026-10-26T14:30:00.000Z" }, state: {} });
    }
    if (id === MINE_STOPPED) {
      return Response.json({ run: { id, status: "cancelled", question: "Who is the Artist Nova audience?", createdAt: "2026-10-20T09:00:00.000Z" }, state: {} });
    }
    return Response.json({ error: "Not found." }, { status: 404 });
  });
}

describe("loading Your answers", () => {
  it("lists only this browser's runs: the finished ones from the list, the rest read one by one, newest first", async () => {
    const fetch = stubFetch();
    const items = await loadYourAnswers([MINE_WORKING, MINE_DONE, MINE_STOPPED, MINE_GONE], { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(items.map((i) => [i.runId, i.status, i.note])).toEqual([
      [MINE_WORKING, "working", "Working…"],
      [MINE_DONE, "done", "Taste island"],
      [MINE_STOPPED, "stopped", "Stopped"],
    ]);
    // The showcase the list adds is never one of the visitor's answers.
    expect(items.some((i) => i.runId === SHOWCASE)).toBe(false);
    const [listUrl] = fetch.mock.calls[0] as unknown as [string];
    expect(listUrl).toContain("limit=50");
    expect(new URL(listUrl, "http://x").searchParams.get("ids")).toBe([MINE_WORKING, MINE_DONE, MINE_STOPPED, MINE_GONE].join(","));
    // The listed run is not read again.
    expect(fetch.mock.calls.map(([u]) => String(u))).not.toContain(`/api/runs/${MINE_DONE}`);
  });

  it("asks nothing for a browser with no runs", async () => {
    const fetch = stubFetch();
    await expect(loadYourAnswers([], { fetch: fetch as unknown as typeof globalThis.fetch })).resolves.toEqual([]);
    await expect(loadYourAnswers(["not an id!"], { fetch: fetch as unknown as typeof globalThis.fetch })).resolves.toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads at most ANSWERS_SNAPSHOT_MAX runs one by one", async () => {
    const fetch = stubFetch();
    const ids = Array.from({ length: 30 }, (_, i) => `run-extra-${String(i).padStart(4, "0")}`);
    await loadYourAnswers(ids, { fetch: fetch as unknown as typeof globalThis.fetch });
    expect(fetch).toHaveBeenCalledTimes(1 + ANSWERS_SNAPSHOT_MAX);
  });

  it("fails as a whole when the list cannot be read", async () => {
    const fetch = stubFetch(503);
    await expect(loadYourAnswers([MINE_DONE], { fetch: fetch as unknown as typeof globalThis.fetch })).rejects.toBeInstanceOf(BriefsError);
  });
});

describe("what a row says", () => {
  it("a finished answer shows its verdict tag, else its signal; a run without one is partial", () => {
    expect(answerFromSummary(brief({ tag: "Taste island" })).note).toBe("Taste island");
    expect(answerFromSummary(brief({ tag: null, signal: "mixed" }))).toMatchObject({ status: "done" });
    expect(answerFromSummary(brief({ status: "incomplete", signal: null, tag: null }))).toMatchObject({ status: "partial", note: "Partial answer" });
    expect(verdictText({ tag: null, signal: null, status: "completed" })).toBe("Answer ready");
  });

  it("names every status the list leaves out", () => {
    const row = (status: Parameters<typeof answerFromRun>[0]["status"]) =>
      answerFromRun({ id: "run-mine-0009", status, question: "Q", createdAt: "2026-10-26T10:00:00.000Z" });
    expect([row("queued"), row("running")].map((r) => [r.status, r.note])).toEqual([
      ["working", "Working…"],
      ["working", "Working…"],
    ]);
    expect(row("cancelled")).toMatchObject({ status: "stopped", note: "Stopped" });
    expect(row("failed")).toMatchObject({ status: "stopped", note: "Not finished" });
    expect(row("refused")).toMatchObject({ status: "stopped", note: "Declined" });
    expect(row("needs_input")).toMatchObject({ status: "stopped", note: "Needs input" });
    expect(row("incomplete")).toMatchObject({ status: "partial" });
  });

  it("dates rows Today, Yesterday, else the day, with the year when it is not this one", () => {
    expect(relativeDay("2026-10-26T01:00:00.000Z", NOW, "UTC")).toBe("Today");
    expect(relativeDay("2026-10-25T23:59:00.000Z", NOW, "UTC")).toBe("Yesterday");
    expect(relativeDay("2026-10-14T10:00:00.000Z", NOW, "UTC")).toBe("14 Oct");
    expect(relativeDay("2025-12-31T10:00:00.000Z", NOW, "UTC")).toBe("31 Dec 2025");
    // The visitor's own day: 01:00 UTC is still yesterday in Chicago.
    expect(relativeDay("2026-10-26T01:00:00.000Z", NOW, "America/Chicago")).toBe("Yesterday");
    expect(relativeDay("not a date", NOW)).toBe("");
  });

  it("sorts newest first", () => {
    const item = (runId: string, createdAt: string): AnswerItem => ({ runId, question: runId, status: "done", note: "", createdAt });
    expect(byNewest([item("a", "2026-10-01T00:00:00Z"), item("b", "bad"), item("c", "2026-10-02T00:00:00Z")]).map((i) => i.runId)).toEqual([
      "c",
      "a",
      "b",
    ]);
  });

  it("draws the row as one link to the run, with a status icon, the note and the day", () => {
    const done = html(
      <AnswerRow item={{ runId: MINE_DONE, question: "Juniper Cola vs Brand Beta, by city", status: "done", note: "Taste island", createdAt: "2026-10-26T10:00:00.000Z" }} day="Today" />,
    );
    expect(done).toMatch(/^<a [^>]*data-status="done"/);
    expect(done).toContain(`href="/run/${MINE_DONE}"`);
    expect(done).toContain("text-good");
    expect(done).toContain("Done: ");
    expect(done).toContain("Juniper Cola vs Brand Beta, by city");
    expect(done).toContain("Taste island");
    expect(done).toContain('<time dateTime="2026-10-26T10:00:00.000Z">Today</time>');
    const working = html(<AnswerRow item={{ runId: MINE_WORKING, question: "Q", status: "working", note: "Working…", createdAt: "" }} day="" />);
    expect(working).toContain("motion-safe:animate-spin");
  });
});

describe("the list's states", () => {
  it("shows two skeleton rows while loading", () => {
    const out = html(<YourAnswersView state={{ kind: "loading" }} />);
    expect(out).toContain('aria-label="Loading your answers"');
    expect(out.match(/<li /g)).toHaveLength(2);
  });

  it("offers Try again when the list cannot be read", () => {
    const out = html(<YourAnswersView state={{ kind: "error", message: "Your answers couldn't be loaded.", retry: true }} onRetry={() => undefined} />);
    expect(out).toContain('role="alert"');
    expect(out).toContain("Try again");
  });

  it("is an empty well that asks a question, with no examples to open", () => {
    const out = html(<YourAnswersView state={{ kind: "ready", items: [], now: NOW }} />);
    expect(out).toContain(EMPTY_DETAIL);
    expect(out).toContain("No answers yet");
    expect(out).toMatch(/href="[^"]*#ask"[^>]*>.*Ask a question/);
    expect(out).not.toMatch(/example/i);
  });

  it("lists the rows in order", () => {
    const items: AnswerItem[] = [
      { runId: MINE_WORKING, question: "Which cities love Juniper Cola most?", status: "working", note: "Working…", createdAt: "2026-10-26T14:30:00.000Z" },
      { runId: MINE_DONE, question: "Juniper Cola vs Brand Beta, by city", status: "done", note: "Taste island", createdAt: "2026-10-25T10:00:00.000Z" },
    ];
    const out = html(<YourAnswersView state={{ kind: "ready", items, now: NOW }} timeZone="UTC" />);
    expect(out.indexOf(MINE_WORKING)).toBeLessThan(out.indexOf(MINE_DONE));
    expect(out).toContain(">Today</time>");
    expect(out).toContain(">Yesterday</time>");
  });

  it("gives every row an always-visible trash button and the list a Clear history, when they can act", () => {
    const items: AnswerItem[] = [
      { runId: MINE_DONE, question: "Juniper Cola vs Brand Beta, by city", status: "done", note: "Taste island", createdAt: "2026-10-25T10:00:00.000Z" },
    ];
    const bare = html(<YourAnswersView state={{ kind: "ready", items, now: NOW }} />);
    expect(bare).not.toContain("Remove from your answers");
    expect(bare).not.toContain("Clear history");
    const out = html(<YourAnswersView state={{ kind: "ready", items, now: NOW }} onRemove={() => undefined} onClear={() => undefined} />);
    expect(out).toContain('aria-label="Remove from your answers: Juniper Cola vs Brand Beta, by city"');
    expect(out).toContain('data-icon="trash-2"');
    expect(out).toContain("Clear history");
    const button = /<button[^>]*aria-label="Remove from your answers[^"]*"[^>]*>/.exec(out)?.[0] ?? "";
    expect(button).not.toMatch(/opacity-0|max-md:hidden/);
  });
});

describe("/briefs", () => {
  it("is Your answers: the title, the heading, the active nav and the list, with no filters or examples", () => {
    expect(metadata.title).toBe("Your answers · Culture Terminal");
    const out = html(<YourAnswersPage />);
    expect(out).toMatch(/<h1[^>]*>Your answers<\/h1>/);
    expect(out).toMatch(/<a[^>]*data-nav="answers"[^>]*aria-current="page"/);
    expect(out).toContain('aria-label="Loading your answers"');
    expect(out).not.toMatch(/example|showcase|aria-pressed/i);
  });
});
