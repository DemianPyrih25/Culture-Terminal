// The Launchpad (PLAN §8.1): showcase tiles pinned and not pinned, "Judge in 60 seconds", the figure
// glyphs, the proof strip with the eval aggregates and the kit table, and Home with its server reads.
// Pinned runs are the synthetic test run under invented run ids (D29); showcase questions and slugs come
// from config/showcases.json as they are. Eval figures are invented.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatasetKind, TOOL_MNEMONIC, type RunEvent, type RunState } from "@ct/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const reads = vi.hoisted(() => ({
  byQuestion: vi.fn<() => Promise<Map<string, string>>>(),
  pins: vi.fn<() => Promise<{ slug: string; runId: string }[]>>(),
  events: vi.fn<(db: unknown, runId: string) => Promise<RunEvent[]>>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../../server/container", () => ({
  getDatabase: () => ({}),
  peekQlooClient: () => undefined,
  getQlooClient: () => {
    throw new Error("no Qloo client in this test");
  },
}));
vi.mock("../../server/run-list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/run-list")>()),
  showcaseRunsByQuestion: reads.byQuestion,
}));
vi.mock("../../server/event-store", () => ({ readAllEvents: reads.events }));
vi.mock("@ct/db", async (importOriginal) => ({ ...(await importOriginal<typeof import("@ct/db")>()), listPinnedShowcases: reads.pins }));

const { default: Home } = await import("../../app/page");
const { askHref } = await import("../../components/ask/ask-href");
const {
  DeskGrid,
  EVAL_METRIC_IDS,
  evalFigures,
  ExhibitThumbnail,
  isPinned,
  JUDGE_NOT_PINNED,
  JudgeStrip,
  judgeTile,
  KIT_ROWS,
  KIT_WORKFLOWS,
  coveredWorkflows,
  launchpadTiles,
  NOT_PINNED,
  ordinal,
  ProofStrip,
  SHOWCASES,
  showcaseCard,
  showcasesTraced,
  ShowcaseTileView,
  tilesByDesk,
  TRUST_QUESTION,
  TRUST_SLUG,
  TrustTile,
} = await import("../../components/launchpad");
const { parseEvalSummary } = await import("../../components/method/eval-summary");
const { pinnedShowcases, pinsBySlug, readEvalSummary } = await import("../../components/launchpad/load");
const { fakeRunEvents, fakeRunState } = await import("../brief/support");
type ShowcaseCard = import("../../components/launchpad").ShowcaseCard;
type ShowcaseTile = import("../../components/launchpad").ShowcaseTile;

afterEach(() => {
  reads.byQuestion.mockReset();
  reads.pins.mockReset();
  reads.events.mockReset();
});

/** Markup escapes the way React prints text. */
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

const showcase = (code: string) => {
  const found = SHOWCASES.find((s) => s.code === code);
  if (!found) throw new Error(`no showcase ${code}`);
  return found;
};

const card = (runId: string, over: Partial<ShowcaseCard> = {}): ShowcaseCard => ({
  runId,
  finding: { kind: "tag", text: "Taste island" },
  exhibit: "Matrix",
  numbersTraced: { traced: 25, total: 25 },
  ...over,
});

/** All seven tiles, the given ones pinned. */
const tilesWith = (pinned: Record<string, ShowcaseCard>): ShowcaseTile[] => launchpadTiles(SHOWCASES, new Map(Object.entries(pinned)));

/** A state whose report carries this verdict tag (any value, as stored JSON may). */
function withTag(state: RunState, tag: unknown): RunState {
  const report = state.report!;
  return { ...state, report: { ...report, verdict: { ...report.verdict, tag } } } as RunState;
}

describe("showcase tiles", () => {
  it("opens a pinned showcase as its note, replays it and runs it live, with its finding and figure", () => {
    const s1 = showcase("S1");
    const html = renderToStaticMarkup(<ShowcaseTileView tile={{ showcase: s1, card: card("run-showcase-0001") }} />);
    expect(html).toContain('data-pinned="true"');
    expect(html).toContain(`>${escaped(s1.question)}</h4>`);
    expect(html).toContain('href="/r/run-showcase-0001"');
    expect(html).toContain('href="/run/run-showcase-0001?replay=1"');
    expect(html).toContain(`href="${escaped(askHref(s1.question))}"`);
    expect(html).toMatch(/data-finding="tag"><span class="sr-only">Finding: <\/span>Taste island<\/p>/);
    expect(html).toContain('data-thumbnail="Matrix"');
    expect(html).not.toContain(NOT_PINNED);
  });

  it("shows a showcase not pinned yet with its question and [Run live] only, never a stored run's link", () => {
    const s3 = showcase("S3");
    const html = renderToStaticMarkup(<ShowcaseTileView tile={{ showcase: s3, card: null }} />);
    expect(html).toContain('data-pinned="false"');
    expect(html).toContain(`>${escaped(s3.question)}</h4>`);
    expect(html).toContain(`href="${escaped(askHref(s3.question))}"`);
    expect(html).toContain(NOT_PINNED);
    expect(html).not.toContain('href="/r/');
    expect(html).not.toContain("replay=1");
    expect(html).not.toContain("data-finding");
    expect(html).toContain('data-thumbnail="none"');
  });

  it("still opens a pinned brief that could not be read, without inventing a finding or a figure", () => {
    const html = renderToStaticMarkup(
      <ShowcaseTileView tile={{ showcase: showcase("S7"), card: card("run-showcase-0007", { finding: null, exhibit: null, numbersTraced: null }) }} />,
    );
    expect(html).toContain('href="/r/run-showcase-0007"');
    expect(html).toContain('href="/run/run-showcase-0007?replay=1"');
    expect(html).not.toContain("data-finding");
    expect(html).toContain('data-thumbnail="none"');
    expect(html).not.toContain(NOT_PINNED);
  });

  it("names its showcase in every action, so a link list never reads seven alike", () => {
    /** The text of each link in the markup, tags stripped. */
    const linkTexts = (html: string) => [...html.matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
    const s1 = showcase("S1");
    const pinned = renderToStaticMarkup(<ShowcaseTileView tile={{ showcase: s1, card: card("run-showcase-0001") }} />);
    expect(linkTexts(pinned)).toEqual(["Open note", "Replay", "Run live"].map((a) => `${a}: ${escaped(s1.label)}`));
    expect(pinned).toContain(`<span class="sr-only">: ${escaped(s1.label)}</span>`);
    const s6 = showcase("S6");
    const unpinned = renderToStaticMarkup(<ShowcaseTileView tile={{ showcase: s6, card: null }} />);
    expect(linkTexts(unpinned)).toEqual([`Run live: ${escaped(s6.label)}`]);
    const grid = renderToStaticMarkup(<DeskGrid tiles={tilesWith({})} />);
    const names = linkTexts(grid);
    expect(names).toHaveLength(SHOWCASES.length);
    expect(new Set(names).size).toBe(SHOWCASES.length);
  });

  it("states why a tile or a step has no link in readable text, not the faint tone", () => {
    const tile = renderToStaticMarkup(<ShowcaseTileView tile={{ showcase: showcase("S3"), card: null }} />);
    expect(tile).toContain(`<span class="text-[11px] leading-4 text-dim">${NOT_PINNED}</span>`);
    const strip = renderToStaticMarkup(<JudgeStrip showcase={null} />);
    expect(strip).toContain(`<span class="text-[12px] leading-4 text-dim">${JUDGE_NOT_PINNED}</span>`);
  });

  it("prints a headline finding lighter than a tag", () => {
    const finding = { kind: "headline" as const, text: "Brand Alpha is a taste island: its closest audience is an apparel brand" };
    const html = renderToStaticMarkup(<ShowcaseTileView tile={{ showcase: showcase("S2"), card: card("run-showcase-0002", { finding }) }} />);
    expect(html).toMatch(/class="[^"]*text-text-2[^"]*" data-finding="headline">/);
    expect(html).toContain(finding.text);
  });

  it("puts every showcase on its desk once, in desk order, and says how many are pinned", () => {
    const desks = tilesByDesk(tilesWith({}));
    expect(desks.map((d) => d.desk)).toEqual(["investment", "location", "marketing", "audience"]);
    expect(desks.flatMap((d) => d.tiles.map((t) => t.showcase.code)).sort()).toEqual(SHOWCASES.map((s) => s.code).sort());
    for (const d of desks) for (const t of d.tiles) expect(t.showcase.desk).toBe(d.desk);

    const none = renderToStaticMarkup(<DeskGrid tiles={tilesWith({})} />);
    expect(none).toContain("Run any of them live");
    expect(none.match(/data-pinned="false"/g)).toHaveLength(SHOWCASES.length);
    const some = renderToStaticMarkup(<DeskGrid tiles={tilesWith({ S1: card("run-showcase-0001"), S5: card("run-showcase-0005") })} />);
    expect(some).toContain(`2 of ${SHOWCASES.length} pinned · open and replay at no cost`);
    expect(some.match(/data-pinned="true"/g)).toHaveLength(2);
    for (const d of ["Investment", "Location", "Marketing", "Audience"]) expect(none).toMatch(new RegExp(`<span class="text-ink">${d}</span></h3>`));
  });

  it("names each showcase by its starter's label", () => {
    for (const s of SHOWCASES) {
      expect(s.label, s.code).not.toBe("");
      expect(s.label.length, s.code).toBeLessThanOrEqual(32);
    }
  });
});

describe("a showcase's card from its stored run", () => {
  it("reads the verdict tag, the first exhibit's kind and the numbers traced", () => {
    const state = withTag(fakeRunState(), "Taste island");
    const c = showcaseCard(state);
    expect(c.runId).toBe(state.runId);
    expect(c.finding).toEqual({ kind: "tag", text: "Taste island" });
    expect(c.exhibit).toBe(state.report!.exhibits[0]!.kind);
    expect(c.numbersTraced).toEqual(state.report!.receipt.numbersTraced);
  });

  it("falls back to the headline, its numbers printed, when the brief has no tag", () => {
    const base = fakeRunState();
    const metric = Object.values(base.metrics).find((m) => m.value !== null)!;
    const report = base.report!;
    const state = { ...base, report: { ...report, verdict: { ...report.verdict, headline: `Brand Alpha leads at {{${metric.id}}} [E1]` } } };
    for (const tag of [undefined, null, "   ", 7]) {
      const c = showcaseCard(withTag(state, tag));
      expect(c.finding).toEqual({ kind: "headline", text: `Brand Alpha leads at ${metric.display}` });
    }
  });

  it("prints only a tag that keeps its rule (V9), as the brief page and the library do", () => {
    const base = fakeRunState();
    const report = base.report!;
    const state = { ...base, report: { ...report, verdict: { ...report.verdict, headline: "Brand Alpha sits apart from its category [E1]" } } };
    const headline = { kind: "headline", text: "Brand Alpha sits apart from its category" };
    // A digit no CHECKER trace covers, seven words, more than 32 characters, a raw token, one word.
    for (const tag of ["Top 3 brand", "A taste island far from every rival", "Exceptionally underrepresented niche", "Leads {{WINDOW}}", "Island"]) {
      expect(showcaseCard(withTag(state, tag)).finding, tag).toEqual(headline);
    }
    expect(showcaseCard(withTag(state, "  Clear   lead ")).finding).toEqual({ kind: "tag", text: "Clear lead" });
  });

  it("has no finding and no figure for a run without a note", () => {
    const state: RunState = { ...fakeRunState(), report: null };
    expect(showcaseCard(state)).toMatchObject({ runId: state.runId, finding: null, exhibit: null });
  });

  it("adds up the numbers traced across the pinned briefs", () => {
    expect(showcasesTraced(tilesWith({}))).toBeNull();
    const tiles = tilesWith({
      S1: card("run-showcase-0001", { numbersTraced: { traced: 25, total: 25 } }),
      S4: card("run-showcase-0004", { numbersTraced: { traced: 18, total: 19 } }),
      S7: card("run-showcase-0007", { numbersTraced: null }),
    });
    expect(showcasesTraced(tiles)).toEqual({ traced: 43, total: 44, briefs: 2 });
  });
});

describe("Judge in 60 seconds", () => {
  const stepHref = (html: string, step: string) => html.match(new RegExp(`data-judge-step="${step}" href="([^"]*)"`))?.[1];

  it("opens the first showcase's note and its replay, and points at the question field", () => {
    const tiles = tilesWith({ S1: card("run-showcase-0001"), S2: card("run-showcase-0002") });
    const html = renderToStaticMarkup(<JudgeStrip showcase={judgeTile(tiles)} />);
    expect(stepHref(html, "note")).toBe("/r/run-showcase-0001");
    expect(stepHref(html, "replay")).toBe("/run/run-showcase-0001?replay=1");
    expect(html).toContain(`Read “${escaped(showcase("S1").label)}”`);
    expect(html).toMatch(/<a href="#ask"[^>]*>Ask a question<\/a>/);
    expect(html).not.toContain(JUDGE_NOT_PINNED);
    for (const [title, at] of [
      ["Open a note", "0 s"],
      ["Watch a replay", "20 s"],
      ["Ask live", "~90 s"],
    ]) {
      expect(html).toContain(`${title}</span>`);
      expect(html).toContain(`>${at}</span>`);
    }
  });

  it("takes the first pinned showcase in config order while the opener is not pinned", () => {
    const tiles = tilesWith({ S5: card("run-showcase-0005"), S3: card("run-showcase-0003") });
    expect(judgeTile(tiles)?.showcase.code).toBe("S3");
    const html = renderToStaticMarkup(<JudgeStrip showcase={judgeTile(tiles)} />);
    expect(stepHref(html, "note")).toBe("/r/run-showcase-0003");
    expect(stepHref(html, "replay")).toBe("/run/run-showcase-0003?replay=1");
  });

  it("links nothing it cannot open while no showcase is pinned, and still asks live", () => {
    expect(judgeTile(tilesWith({}))).toBeNull();
    const html = renderToStaticMarkup(<JudgeStrip showcase={null} />);
    expect(html).not.toContain("data-judge-step");
    expect(html).not.toContain('href="/r/');
    expect(html.split(JUDGE_NOT_PINNED)).toHaveLength(3);
    expect(html).toContain('href="#ask"');
  });
});

describe("figure glyphs", () => {
  it("draws every dataset kind, and an empty frame without a brief", () => {
    for (const kind of DatasetKind.options) {
      const html = renderToStaticMarkup(<ExhibitThumbnail kind={kind} />);
      expect(html, kind).toMatch(new RegExp(`^<svg aria-hidden="true"[^>]*data-thumbnail="${kind}"`));
      expect(html, kind).toMatch(/<(rect|circle|line|polyline) /);
    }
    expect(renderToStaticMarkup(<ExhibitThumbnail kind={null} />)).toMatch(/^<span aria-hidden="true" data-thumbnail="none"/);
  });
});

describe("the proof strip", () => {
  /** A summary in the one shape /method#eval reads too (components/method/eval-summary.ts). */
  const SUMMARY = {
    ranAt: "2026-10-30",
    model: "claude-sonnet-5-5",
    questions: { total: 16, adversarial: 4 },
    metrics: [
      { id: EVAL_METRIC_IDS.refuted, label: "Priors refuted or qualified", unit: "rate", grounded: 0.38, ghost: null },
      { id: EVAL_METRIC_IDS.traced, label: "Numbers traced", unit: "rate", grounded: 1, ghost: 0 },
      { id: EVAL_METRIC_IDS.adversarial, label: "Adversarial handling", unit: "rate", grounded: 1, ghost: 0.5 },
      { id: "latency_p50", label: "Latency, p50", unit: "seconds", grounded: 61, ghost: 9.5 },
    ],
    realityCheck: { cases: 12, medianPercentile: 0.81, ghostHitRate: 0.25 },
  };
  const parsed = parseEvalSummary(JSON.stringify(SUMMARY));
  const summary = parsed.state === "ok" ? parsed.summary : null;

  it("maps every data tool to the kit's nine workflows", () => {
    expect(coveredWorkflows()).toEqual([...KIT_WORKFLOWS]);
    const tools = Object.keys(TOOL_MNEMONIC).filter((t) => t !== "submit_plan" && t !== "submit_report");
    expect(KIT_ROWS.map((r) => r.tool).sort()).toEqual(tools.sort());
    const html = renderToStaticMarkup(<ProofStrip traced={null} evalSummary={null} trustQuestion={TRUST_QUESTION} />);
    expect(html).toContain("Built on Qloo’s 9 kit workflows + direct REST");
    for (const row of KIT_ROWS) expect(html).toContain(`data-kit-tool="${row.tool}"`);
  });

  it("leaves the eval's numbers out until the eval has written them", () => {
    const html = renderToStaticMarkup(<ProofStrip traced={null} evalSummary={null} trustQuestion={TRUST_QUESTION} />);
    expect(html).toContain("Every number has a receipt");
    expect(html).not.toContain("data-eval-figures");
    expect(html).not.toContain("data-traced");
  });

  it("prints the eval and Reality Check aggregates, and the numbers traced across the showcases", () => {
    expect(summary).not.toBeNull();
    const html = renderToStaticMarkup(
      <ProofStrip traced={{ traced: 1026, total: 1026, briefs: 7 }} evalSummary={summary} trustQuestion={TRUST_QUESTION} />,
    );
    expect(html).toContain('data-eval-figures="5"');
    expect(evalFigures(summary!).map((f) => [f.key, f.value])).toEqual([
      ["reality-check", "81st"],
      ["traced", "100%"],
      ["refuted", "38%"],
      ["ghost-hit", "25%"],
      ["adversarial", "100%"],
    ]);
    expect(html).toContain("Reality Check · random 50th · n = 12");
    expect(html).toContain("The model alone: 0%");
    expect(html).toContain("Across 16 eval questions");
    expect(html).toContain("4 questions · private person, politics, religion, injection");
    expect(html).toContain("Eval of 30 Oct 2026");
    expect(html).toContain("1,026 / 1,026 numbers traced");
    expect(html).toContain("across 7 showcase briefs");
    // The strip shows its own figures; the rest of the table is /method#eval's.
    expect(html).not.toContain("Latency");
  });

  it("shows only the figures a partial summary has, never a dash for a missing one", () => {
    const partial = parseEvalSummary(
      JSON.stringify({
        ...SUMMARY,
        metrics: [
          { id: EVAL_METRIC_IDS.refuted, label: "Priors refuted or qualified", unit: "rate", grounded: null, ghost: null },
          { id: "latency_p50", label: "Latency, p50", unit: "seconds", grounded: 61, ghost: 9.5 },
        ],
        realityCheck: { cases: 12, medianPercentile: 0.72, ghostHitRate: null },
      }),
    );
    expect(partial.state).toBe("ok");
    if (partial.state !== "ok") return;
    expect(evalFigures(partial.summary)).toEqual([
      { key: "reality-check", value: "72nd", label: "Median percentile of the real-world choice", note: "Reality Check · random 50th · n = 12" },
    ]);
    expect(evalFigures({ ...partial.summary, realityCheck: null })).toEqual([]);
  });

  it("orders percentiles in English", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 52, 81, 100].map(ordinal)).toEqual([
      "1st",
      "2nd",
      "3rd",
      "4th",
      "11th",
      "12th",
      "13th",
      "21st",
      "52nd",
      "81st",
      "100th",
    ]);
  });

  it("shows the refusal demo with links to the trust page and to asking it", () => {
    const html = renderToStaticMarkup(<ProofStrip traced={null} evalSummary={null} trustQuestion={TRUST_QUESTION} />);
    expect(html).toContain(`“${escaped(TRUST_QUESTION)}”`);
    expect(html).toContain('href="/trust"');
    expect(html).toContain(`href="${escaped(askHref(TRUST_QUESTION))}"`);
    expect(html).not.toContain("data-trust-run");
    expect(html).toContain("Aggregates only · no Qloo values in this strip");
  });

  it("opens the pinned refusal first, at no cost, and still links the trust page and asking it", () => {
    const html = renderToStaticMarkup(<TrustTile question={TRUST_QUESTION} runId="run-refusal-0001" />);
    expect(html).toMatch(/<a [^>]*href="\/r\/run-refusal-0001"[^>]*>See the refusal<\/a>/);
    expect(html.indexOf("See the refusal")).toBeLessThan(html.indexOf("Ask it yourself"));
    expect(html).toContain('href="/trust"');
    expect(html).toContain(`href="${escaped(askHref(TRUST_QUESTION))}"`);
  });
});

describe("the eval summary file", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "ct-launchpad-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const summary = {
    ranAt: "2026-10-30",
    model: "claude-sonnet-5-5",
    questions: { total: 16, adversarial: 4 },
    metrics: [{ id: "refutation_rate", label: "Priors refuted or qualified", unit: "rate", grounded: 0.38, ghost: null }],
    realityCheck: null,
  };

  it("is read where /method reads it, and is nothing when it is missing or not in the shared shape", () => {
    const first = path.join(dir, "content", "eval-summary.json");
    const second = path.join(dir, "apps", "web", "content", "eval-summary.json");
    expect(readEvalSummary([first, second])).toBeNull();
    mkdirSync(path.dirname(second), { recursive: true });
    writeFileSync(second, JSON.stringify(summary));
    expect(readEvalSummary([first, second])).toEqual(summary);
    // The launchpad's old whole-percent shape is not a summary.
    writeFileSync(second, JSON.stringify({ asOf: "2026-10-30", eval: { refutedPct: 38 } }));
    expect(readEvalSummary([first, second])).toBeNull();
    writeFileSync(second, "{ half a file");
    expect(readEvalSummary([first, second])).toBeNull();
  });
});

describe("Home as the Launchpad", () => {
  const S1_RUN = "run-showcase-0101";
  /** A pin of the showcase with this code, as the pin store lists it. */
  const pin = (code: string, runId: string) => ({ slug: showcase(code).slug, runId });

  it("pins the showcases whose slug holds a run and offers the rest live", async () => {
    reads.byQuestion.mockResolvedValue(new Map());
    reads.pins.mockResolvedValue([pin("S1", S1_RUN)]);
    reads.events.mockImplementation(async (_db, runId) => fakeRunEvents(runId));
    const html = renderToStaticMarkup(await Home());
    expect(html).toMatch(/<h1[^>]*>Taste is a market. Now it has a terminal.<\/h1>/);
    expect(html).toContain('id="ask"');
    expect(html).toMatch(/data-showcase="S1" data-pinned="true"/);
    for (const s of SHOWCASES.slice(1)) expect(html).toMatch(new RegExp(`data-showcase="${s.code}" data-pinned="false"`));
    expect(html).toContain(`href="/r/${S1_RUN}"`);
    expect(html).toContain(`href="/run/${S1_RUN}?replay=1"`);
    // The finding and the figure come from the stored brief.
    const report = fakeRunState().report!;
    expect(html).toContain(`data-thumbnail="${report.exhibits[0]!.kind}"`);
    expect(html).toMatch(/data-finding="(tag|headline)"/);
    // Judge in 60 seconds opens the same brief; the proof strip counts its traced numbers.
    expect(html).toContain(`data-judge-step="note" href="/r/${S1_RUN}"`);
    const { traced, total } = report.receipt.numbersTraced;
    expect(html).toContain(`${traced} / ${total} numbers traced`);
    expect(html).toContain("Analytics, not financial advice. Aggregated group-level taste signals; no individual-level inference.");
  });

  it("matches a pin by its slug, never by the question: a stored run of the same question does not pin a tile", async () => {
    // showcaseRunsByQuestion feeds the starters only.
    reads.byQuestion.mockResolvedValue(new Map([[showcase("S2").question.toLowerCase(), "run-showcase-0202"]]));
    reads.pins.mockResolvedValue([]);
    reads.events.mockImplementation(async (_db, runId) => fakeRunEvents(runId));
    const html = renderToStaticMarkup(await Home());
    expect(html.match(/data-pinned="false"/g)).toHaveLength(SHOWCASES.length);
    expect(html).not.toContain('href="/r/');
    expect(reads.events).not.toHaveBeenCalled();
  });

  it("opens the pinned refusal from the trust tile", async () => {
    reads.byQuestion.mockResolvedValue(new Map());
    reads.pins.mockResolvedValue([{ slug: TRUST_SLUG, runId: "run-refusal-0101" }]);
    const html = renderToStaticMarkup(await Home());
    expect(html).toMatch(/<a [^>]*data-trust-run="true" href="\/r\/run-refusal-0101">See the refusal<\/a>/);
    // A refusal is not a showcase tile, and its events are not read for one.
    expect(html.match(/data-pinned="false"/g)).toHaveLength(SHOWCASES.length);
    expect(reads.events).not.toHaveBeenCalled();
  });

  it("reads only the pinned runs (D31): no other run is opened, and the recent list loads in the browser", async () => {
    reads.byQuestion.mockResolvedValue(new Map());
    reads.pins.mockResolvedValue([pin("S4", "run-showcase-0104")]);
    reads.events.mockImplementation(async (_db, runId) => fakeRunEvents(runId));
    const html = renderToStaticMarkup(await Home());
    expect(reads.events.mock.calls.map(([, runId]) => runId)).toEqual(["run-showcase-0104"]);
    expect(html.match(/href="\/r\/[^"]+"/g)).toEqual(['href="/r/run-showcase-0104"', 'href="/r/run-showcase-0104"']);
    // This browser's own runs are named to the list endpoint from the browser, never rendered here.
    expect(html).toContain('aria-label="Loading recent briefs"');
  });

  it("offers every showcase live when the pins cannot be read", async () => {
    reads.byQuestion.mockRejectedValue(new Error("connection refused"));
    reads.pins.mockRejectedValue(new Error("connection refused"));
    const html = renderToStaticMarkup(await Home());
    expect(html.match(/data-pinned="false"/g)).toHaveLength(SHOWCASES.length);
    expect(html).toContain(JUDGE_NOT_PINNED);
    expect(html).not.toContain("data-trust-run");
    expect(reads.events).not.toHaveBeenCalled();
  });

  it("keeps a pinned tile whose events cannot be read, without a finding", async () => {
    reads.events.mockRejectedValue(new Error("connection reset"));
    const cards = await pinnedShowcases(SHOWCASES, pinsBySlug([pin("S2", "run-showcase-0102")]));
    expect([...cards.keys()]).toEqual(["S2"]);
    expect(cards.get("S2")).toEqual({ runId: "run-showcase-0102", finding: null, exhibit: null, numbersTraced: null });
    expect(isPinned({ showcase: showcase("S2"), card: cards.get("S2")! })).toBe(true);
  });

  it("keeps the first (newest) run of a slug the pin store lists twice", () => {
    const pins = pinsBySlug([pin("S1", "run-showcase-0003"), pin("S2", "run-showcase-0002"), pin("S1", "run-showcase-0001")]);
    expect([...pins]).toEqual([
      [showcase("S1").slug, "run-showcase-0003"],
      [showcase("S2").slug, "run-showcase-0002"],
    ]);
  });
});
