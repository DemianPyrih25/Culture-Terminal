// The briefs library (A09) from fixtures: the grouped and flat views, paging, the empty, no-match,
// error and loading states, what a row prints, the URL of a view, and the list request that names this
// browser's own runs. Invented briefs only.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BriefRowView } from "../../components/library/brief-rows";
import { BriefsError, briefsUrl, fetchBriefs } from "../../components/library/briefs-client";
import { deskJobText, headlinePieces, headlineText, shortDate, verdictText } from "../../components/library/format";
import { entersBriefList, LibraryBody, listedRuns, tracedOf, type LibraryData } from "../../components/library/library-body";
import { isGrouped, libraryHref, readLibraryParams, type LibraryParams } from "../../components/library/library-params";
import { brief, briefList, BRIEFS, EMPTY_LIST } from "./briefs";

const DEFAULT: LibraryParams = { q: "", sort: "date", desk: null };
const { total, pillars, numbersTraced, pillarsTraced } = briefList();
const SUMMARY = { total, pillars, numbersTraced, pillarsTraced };

const grouped: LibraryData = {
  kind: "grouped",
  groups: {
    investment: [BRIEFS[0]!, BRIEFS[1]!],
    location: [BRIEFS[2]!],
    marketing: [BRIEFS[3]!],
    audience: [],
  },
  summary: SUMMARY,
  year: 2026,
};

const flat = (over: Partial<Extract<LibraryData, { kind: "flat" }>> = {}): LibraryData => ({
  kind: "flat",
  runs: [BRIEFS[0]!, BRIEFS[1]!],
  next: null,
  summary: SUMMARY,
  year: 2026,
  loadingMore: false,
  moreError: null,
  ...over,
});

function render(data: LibraryData, params: LibraryParams = DEFAULT, selectedId: string | null = null, refreshing = false): string {
  return renderToStaticMarkup(
    <LibraryBody
      params={params}
      search={params.q}
      data={data}
      selectedId={selectedId}
      refreshing={refreshing}
      onLoadMore={() => undefined}
      onRetry={() => undefined}
      onClearSearch={() => undefined}
    />,
  );
}

describe("LibraryBody", () => {
  it("shows the latest per desk, the desks outline, the tools and the numbers traced", () => {
    const html = render(grouped);
    expect(html).toMatch(/<h1[^>]*>Briefs<\/h1>/);
    expect(html).toContain(">Library</span>");
    expect(html).toContain(">38 briefs</span>");
    expect(html).toContain('aria-label="On this page"');
    expect(html).toContain('href="#desk-location"');
    expect(html).toContain("Latest 2 per desk. Open a desk for the full list.");
    expect(html).toContain('placeholder="Search briefs"');
    expect(html).toContain('aria-keyshortcuts="/"');
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("912 / 912 numbers traced");
    expect(html).toContain("Across 38 briefs · Checker");
    for (const [i, desk] of ["Investment", "Location", "Marketing", "Audience"].entries()) {
      expect(html).toContain(`<span class="text-dim">0${i + 1}</span><span class="text-ink">${desk}</span>`);
    }
    expect(html).toMatch(/href="\/briefs\?desk=investment"[^>]*>All 14/);
    expect(html).toContain("No briefs on this desk yet.");
    expect(html).toContain("Briefs are snapshots");
  });

  it("opens the first brief: its verdict with numbered numbers, never a 0 for one not measured, and its notes", () => {
    const html = render(grouped);
    expect(html).toContain("Compare two brands · Brief RUNB");
    expect(html).toMatch(/0\.64<sup[^>]*>1<\/sup>/);
    expect(html).toMatch(/\+0\.12<sup[^>]*>2<\/sup>/);
    expect(html).toMatch(/not measured<sup[^>]*>3<\/sup>/);
    expect(html).not.toContain("[E2]");
    expect(html).toContain('aria-label="Numbers in this verdict"');
    expect(html).toContain("Audience overlap: ");
    expect(html).toContain(">Not measured</span>");
    expect(html).toMatch(/href="\/run\/run-brief-0001"[^>]*>.*Open brief/);
    // Only the selected brief opens.
    expect(html.match(/Open brief/g)).toHaveLength(1);
    // Its notes: in the margin from 1280 px, inside the selected band (above its rule) narrower.
    expect(html).toMatch(/<div role="note" aria-label="Sidenotes" class="pb-\[14px\] xl:hidden">/);
    expect(html).toMatch(/<div role="note" aria-label="Sidenotes" class="[^"]*max-xl:hidden xl:h-0/);
    // From 1280 px the verdict is the row's second grid row, and its notes share it: level with its first line.
    expect(html).toMatch(/class="min-w-0 xl:col-start-1 relative z-\[1\] border-b border-line xl:row-start-2"><div[^>]*><p[^>]*><span>Same customer/);
    expect(html).toMatch(/<div role="note" aria-label="Sidenotes" class="[^"]*xl:row-start-2 max-xl:hidden/);
    const second = render(grouped, DEFAULT, "run-brief-0002");
    expect(second).toMatch(/Brand Alpha is a taste island <\/span><span class="text-ink">6 of 6<sup/);
    expect(second).not.toContain("Same customer, different turf");
    // A run that stopped says so instead of a verdict, and has no score rather than a pending one.
    const stopped = render(grouped, DEFAULT, "run-brief-0004");
    expect(stopped).toContain("This run stopped before its note was written.");
    expect(stopped).toContain("Conviction: not scored");
    expect(stopped).not.toContain('role="note"');
  });

  it("keeps its outline while the list loads or fails, and says what the grouped view shows by the sort", () => {
    for (const data of [{ kind: "loading" } as const, { kind: "error", message: "The briefs could not be loaded.", retry: true } as const]) {
      const html = render(data);
      expect(html).toContain('aria-label="On this page"');
      expect(html).toContain('href="#desk-audience"');
      expect(html).not.toContain("Every brief on this desk");
    }
    expect(render(grouped, { ...DEFAULT, sort: "conviction" })).toContain("Top 2 per desk by conviction. Open a desk for the full list.");
  });

  it("lists the desks as a row of links on phones, where the outline is hidden", () => {
    const html = render(flat(), { q: "", sort: "date", desk: "location" });
    expect(html).toMatch(/<nav aria-label="Desks" class="pb-4 md:hidden">/);
    expect(html).toMatch(/class="pb-4 md:hidden">.*href="\/briefs"[^>]*>All desks/);
  });

  it("pins the snapshot note to the margin's foot from 1280 px, and drops its keys on phones", () => {
    const html = render(grouped);
    expect(html).toContain("sticky bottom-12");
    expect(html.match(/Briefs are snapshots/g)).toHaveLength(2);
    expect(html).toMatch(/max-sm:hidden" aria-hidden="true"><span[^>]*><kbd/);
  });

  it("lists one desk in full with Load more, and the desks as filters", () => {
    const params: LibraryParams = { q: "", sort: "conviction", desk: "investment" };
    const html = render(flat({ next: "cursor-1" }), params);
    expect(html).toContain('aria-label="Desks"');
    expect(html).toMatch(/aria-current="page"[^>]*>.*?Investment/);
    expect(html).toContain('href="/briefs?sort=conviction"');
    expect(html).toContain(">14 briefs</span>");
    expect(html).toContain("Load more");
    expect(html).toContain("Conviction ↓");
    expect(render(flat(), params)).toContain("All 2 briefs shown.");
    expect(render(flat({ next: "cursor-1", loadingMore: true }), params)).toContain("Loading…");
    expect(render(flat({ next: "cursor-1", moreError: "The briefs could not be loaded." }), params)).toContain('role="alert"');
    // While a new view loads, Load more waits: its cursor belongs to the old one.
    expect(render(flat({ next: "cursor-1" }), params, null, true)).toMatch(/<button[^>]*disabled=""[^>]*>.*Load more/);
  });

  it("shows one desk's numbers traced on a desk view, every desk's otherwise", () => {
    expect(tracedOf(SUMMARY, null)).toEqual({ traced: 912, total: 912, briefs: 38 });
    expect(tracedOf(SUMMARY, "investment")).toEqual({ traced: 336, total: 336, briefs: 14 });
    expect(tracedOf({ ...SUMMARY, pillars: { ...SUMMARY.pillars, marketing: 0 } }, "marketing")).toBeNull();
    const html = render(flat(), { q: "", sort: "date", desk: "investment" });
    expect(html).toContain("336 / 336 numbers traced");
    expect(html).toContain("Across 14 briefs · Checker");
    expect(html).not.toContain("912 / 912");
  });

  it("says a desk has no briefs yet even when other desks have some, and links to them", () => {
    const params: LibraryParams = { q: "", sort: "date", desk: "marketing" };
    const html = render(flat({ runs: [], summary: { ...SUMMARY, pillars: { ...SUMMARY.pillars, marketing: 0 } } }), params);
    expect(html).toContain("No briefs yet on the Marketing desk.");
    expect(html).toMatch(/href="\/briefs"[^>]*>.*All 38 briefs/);
    expect(html).not.toContain("Load more");
  });

  it("says when there are no briefs at all, and when a search matches none", () => {
    const empty = render({ kind: "grouped", groups: { investment: [], location: [], marketing: [], audience: [] }, summary: { ...EMPTY_LIST }, year: 2026 });
    expect(empty).toContain("No briefs yet.");
    expect(empty).toContain("other visitors&#x27; briefs never are");
    const params: LibraryParams = { q: "zebra", sort: "date", desk: null };
    const none = render(flat({ runs: [], summary: { ...SUMMARY, total: 0 } }), params);
    expect(none).toContain("No brief matches “zebra”.");
    expect(none).toContain("Clear the search");
    expect(none).toMatch(/role="status" aria-live="polite"[^>]*>0 briefs match “zebra”\.</);
    expect(render(flat(), { ...params, q: "juniper" })).toContain("38 briefs match “juniper”.");
    // On a desk, the count is the desk's.
    expect(render(flat(), { q: "juniper", sort: "date", desk: "location" })).toContain("10 briefs match “juniper”.");
  });

  it("shows a quiet skeleton while loading and an error with Try again", () => {
    expect(render({ kind: "loading" })).toContain('aria-label="Loading briefs"');
    const failed = render({ kind: "error", message: "The briefs could not be loaded.", retry: true });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Try again");
  });

  it("walks the briefs desk by desk", () => {
    expect(listedRuns(grouped).map((b) => b.runId)).toEqual(["run-brief-0001", "run-brief-0002", "run-brief-0003", "run-brief-0004"]);
    expect(listedRuns({ kind: "loading" })).toEqual([]);
  });

  it("takes a bare ↑ or ↓ from the page into the list, and leaves the arrows of fields and controls alone", () => {
    const key = (k: string, over: Partial<Parameters<typeof entersBriefList>[0]> = {}) => ({
      key: k,
      altKey: false,
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      ...over,
    });
    // On arrival, or after a click outside any control, the page itself has focus.
    for (const tag of [null, "BODY", "HTML", "body"]) {
      expect(entersBriefList(key("ArrowDown"), tag), String(tag)).toBe(true);
      expect(entersBriefList(key("ArrowUp"), tag), String(tag)).toBe(true);
    }
    for (const tag of ["INPUT", "A", "BUTTON", "TEXTAREA"]) expect(entersBriefList(key("ArrowDown"), tag), tag).toBe(false);
    for (const k of ["ArrowLeft", "Enter", "j", "/"]) expect(entersBriefList(key(k), "BODY"), k).toBe(false);
    for (const over of [{ shiftKey: true }, { altKey: true }, { metaKey: true }, { ctrlKey: true }, { isComposing: true }, { defaultPrevented: true }]) {
      expect(entersBriefList(key("ArrowDown", over), "BODY"), JSON.stringify(over)).toBe(false);
    }
  });

  it("prints its labels, counts and hints in the readable grey, never the faint one", () => {
    const html = render(grouped);
    // A note's badge, the snapshot note's kicker and its keys.
    expect(html).toMatch(/font-mono text-\[10\.5px\] leading-\[15px\] text-dim">/);
    expect(html).toMatch(/tracking-\[1\.2px\] text-dim uppercase">Briefs are snapshots/);
    expect(html).toMatch(/text-\[11px\] text-dim max-sm:hidden" aria-hidden="true"><span[^>]*><kbd/);
    // The list's column heads.
    expect(html).toMatch(/tracking-\[1\.1px\] text-dim uppercase[^"]*">.*?Question/);
    // A desk view's outline: its kicker and every desk's count, current or not.
    const desk = render(flat(), { q: "", sort: "date", desk: "investment" });
    expect(desk).toMatch(/tracking-\[1\.2px\] text-dim uppercase">Desks</);
    expect(desk.match(/pr-2 text-\[12px\] font-normal text-dim">\d+</g)).toHaveLength(5);
    expect(desk).not.toMatch(/text-faint[^"]*">\d+</);
  });
});

describe("what a row prints", () => {
  it("prints dates in UTC, with the year only outside the current one", () => {
    expect(shortDate("2026-10-14T23:30:00.000Z", 2026)).toBe("14 Oct");
    expect(shortDate("2025-12-30T10:00:00.000Z", 2026)).toBe("30 Dec 2025");
    expect(shortDate("garbage", 2026)).toBe("");
  });

  it("prints the verdict, the desk and job, and the brief id", () => {
    expect(verdictText(brief())).toBe("Mixed signal");
    expect(verdictText(brief({ signal: null, status: "incomplete" }))).toBe("Incomplete");
    expect(deskJobText(brief())).toBe("Investment · Compare two brands");
    expect(deskJobText(brief(), false)).toBe("Compare two brands · Brief RUNB");
    expect(deskJobText(brief({ pillar: null, jobLabel: null }))).toBe("Brief RUNB");
  });

  it("prints the verdict tag when the list sends one that keeps its rule, else the signal", () => {
    expect(verdictText({ ...brief(), tag: "Clear lead" })).toBe("Clear lead");
    expect(verdictText({ ...brief(), tag: "  Clear lead " })).toBe("Clear lead");
    expect(verdictText({ ...brief(), tag: null })).toBe("Mixed signal");
    expect(verdictText({ ...brief(), tag: "Ranks 3rd of 8" })).toBe("Mixed signal");
    expect(verdictText({ ...brief(), tag: "Taste island {{WINDOW}}" })).toBe("Mixed signal");
    expect(verdictText({ ...brief({ signal: null, status: "incomplete" }), tag: null })).toBe("Incomplete");
  });

  it("caps the verdict column at two lines, with the whole tag as its title", () => {
    // 32 characters, the longest tag the rule allows: three lines in the narrow column without the cap.
    const tagged = { ...brief(), tag: "Taste island, nearest to apparel" };
    for (const columns of ["home", "library"] as const) {
      const row = renderToStaticMarkup(<BriefRowView brief={tagged} columns={columns} year={2026} />);
      const cell = /<span class="([^"]*)" title="Taste island, nearest to apparel">/.exec(row);
      expect(cell?.[1], columns).toContain("line-clamp-2");
      expect(cell?.[1], columns).toContain("[overflow-wrap:anywhere]");
    }
    const plain = renderToStaticMarkup(<BriefRowView brief={brief()} columns="library" year={2026} />);
    expect(plain).toContain('title="Mixed signal"');
  });

  it("numbers each cited metric once, in order, and drops evidence tokens", () => {
    const { pieces, notes } = headlinePieces("A {{M2}} and {{M9}}, again {{M2}} [E1].", {
      M2: { label: "Overlap", display: "0.5", badge: "MEASURED" },
    });
    expect(pieces.filter((p) => p.kind === "metric").map((p) => [p.text, p.note])).toEqual([
      ["0.5", 1],
      ["not measured", 2],
      ["0.5", 1],
    ]);
    expect(notes.map((n) => [n.note, n.label, n.value, n.unavailable])).toEqual([
      [1, "Overlap", "0.5", false],
      [2, "M9", "not measured", true],
    ]);
    expect(headlineText("A {{M2}} and {{M9}}, again {{M2}} [E1].", { M2: { label: "Overlap", display: "0.5", badge: "MEASURED" } })).toBe(
      "A 0.5 and not measured, again 0.5.",
    );
  });
});

describe("the library URL", () => {
  it("reads a view from the page's params, unknown values falling back", () => {
    expect(readLibraryParams({})).toEqual(DEFAULT);
    expect(readLibraryParams({ q: "  juniper ", sort: "conviction", desk: "audience" })).toEqual({ q: "juniper", sort: "conviction", desk: "audience" });
    expect(readLibraryParams({ q: ["a", "b"], sort: "popular", desk: "finance" })).toEqual({ q: "a", sort: "date", desk: null });
    expect(readLibraryParams({ q: "x".repeat(300) }).q).toHaveLength(200);
  });

  it("writes a view back without its defaults, and groups only without a desk or a search", () => {
    expect(libraryHref(DEFAULT)).toBe("/briefs");
    expect(libraryHref({ q: "juniper bar", sort: "conviction", desk: "location" })).toBe("/briefs?q=juniper+bar&sort=conviction&desk=location");
    expect(isGrouped(DEFAULT)).toBe(true);
    expect(isGrouped({ q: "x", desk: null })).toBe(false);
    expect(isGrouped({ q: "", desk: "marketing" })).toBe(false);
  });
});

describe("the list request", () => {
  it("names this browser's newest runs beside the query", () => {
    expect(briefsUrl({})).toBe("/api/runs");
    expect(briefsUrl({ limit: 2, sort: "conviction", q: " juniper ", pillar: "location", before: "abc" }, ["run-brief-0001", "run-brief-0002"])).toBe(
      "/api/runs?limit=2&sort=conviction&q=juniper&pillar=location&before=abc&ids=run-brief-0001%2Crun-brief-0002",
    );
    expect(briefsUrl({ sort: "date" }, ["not an id"])).toBe("/api/runs");
  });

  it("reads each brief's verdict tag, null from a list that sends none, and the row prints it", async () => {
    const list = briefList();
    // The other rows send no tag at all, as a list from before the tag existed.
    const tagged = { ...list, runs: list.runs.map((r, i) => ({ ...r, tag: i === 0 ? "Taste island" : undefined })) };
    const page = await fetchBriefs({}, { ids: [], fetch: vi.fn<typeof fetch>(async () => Response.json(tagged)) });
    const tags = page.runs.map((r) => r.tag);
    expect(tags).toEqual(["Taste island", ...list.runs.slice(1).map(() => null)]);
    const row = renderToStaticMarkup(<BriefRowView brief={page.runs[0]!} columns="library" year={2026} />);
    expect(row).toContain("Taste island");
    expect(row).not.toContain("Mixed signal");
  });

  it("reads a page, and refuses what it cannot trust", async () => {
    const ok = vi.fn<typeof fetch>(async () => Response.json(briefList()));
    await expect(fetchBriefs({ limit: 5 }, { ids: ["run-brief-0001"], fetch: ok })).resolves.toMatchObject({ total: 38 });
    expect(ok.mock.calls[0]?.[0]).toBe("/api/runs?limit=5&ids=run-brief-0001");

    const bad = vi.fn(async () => Response.json({ runs: [{ runId: 1 }] }));
    await expect(fetchBriefs({}, { ids: [], fetch: bad })).rejects.toMatchObject({ name: "BriefsError", retry: false });

    const refused = vi.fn(async () => Response.json({ error: "Invalid list request." }, { status: 400 }));
    await expect(fetchBriefs({}, { ids: [], fetch: refused })).rejects.toThrow("Invalid list request.");

    const down = vi.fn(async () => Response.json({ error: "The database is unavailable." }, { status: 503 }));
    await expect(fetchBriefs({}, { ids: [], fetch: down })).rejects.toMatchObject({ retry: true });

    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const error = await fetchBriefs({}, { ids: [], fetch: offline }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BriefsError);
    expect(error).toMatchObject({ retry: true });
  });
});
