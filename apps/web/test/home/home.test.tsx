// Home (A01): the question field, the starters by desk (the showcase questions word for word, opening
// a stored showcase brief when there is one), the recent briefs from fixtures, and the status line's
// request count. Invented briefs and run ids only.
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { briefList, BRIEFS, EMPTY_LIST } from "../library/briefs";

const showcases = vi.hoisted(() => ({ byQuestion: vi.fn<() => Promise<Map<string, string>>>() }));
// The process's Qloo client as the container holds it: today's count is read from it on the server.
const qloo = vi.hoisted(() => {
  const client = { quota: () => ({ todayNetwork: 214 }) };
  return { client, peek: vi.fn<() => typeof client | undefined>(() => client), get: vi.fn(() => client) };
});

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("../../server/container", () => ({ getDatabase: () => ({}), peekQlooClient: qloo.peek, getQlooClient: qloo.get }));
vi.mock("../../server/run-list", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/run-list")>()),
  showcaseRunsByQuestion: showcases.byQuestion,
}));

const { default: Home } = await import("../../app/page");
const { STARTER_DESKS } = await import("../../components/home/starters");
const { RecentBriefsView } = await import("../../components/home/recent-briefs");
const { qlooRequestsToday, qlooUsageText } = await import("../../components/home/qloo-usage");
const { askHref } = await import("../../components/ask/ask-href");

afterEach(() => {
  vi.unstubAllEnvs();
  showcases.byQuestion.mockReset();
});

const showcaseConfig = JSON.parse(readFileSync(new URL("../../../../config/showcases.json", import.meta.url), "utf8")) as {
  showcases: { code: string; desk: string; question: string }[];
};

/** Markup escapes the way React prints text. */
const escaped = (text: string) => text.replace(/&/g, "&amp;").replace(/'/g, "&#x27;").replace(/"/g, "&quot;");

describe("Home", () => {
  it("renders the chrome, the question field and the four desks of starters", async () => {
    vi.stubEnv("QLOO_DAILY_FRESH_CAP", "1900");
    showcases.byQuestion.mockResolvedValue(new Map());
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain('aria-label="Main"');
    expect(html).toMatch(/<h1[^>]*>Taste intelligence for investors<\/h1>/);
    expect(html).toContain('placeholder="Ask about a brand, an artist, a place or an audience"');
    expect(html).toContain("to ask");
    // The top bar keeps ⌘K; the big field takes /.
    expect(html).toContain('aria-keyshortcuts="Meta+K Control+K"');
    expect(html).toContain('aria-keyshortcuts="/"');
    for (const desk of ["Investment", "Location", "Marketing", "Audience"]) expect(html).toMatch(new RegExp(`<h2[^>]*>${desk}</h2>`));
    for (const starter of STARTER_DESKS.flatMap((d) => d.starters)) {
      expect(html).toContain(`href="${escaped(askHref(starter.question))}"`);
      expect(html).toContain(`>${escaped(starter.label)}</a>`);
    }
    // The recent list loads in the browser: it names this browser's own runs.
    expect(html).toContain('aria-label="Loading recent briefs"');
    expect(html).toContain("Analytics, not financial advice · Group-level taste data · No individuals");
    // Today's Qloo requests come with the page: nothing asks GET /api/health for them.
    expect(html).toContain('<span class="font-mono">Qloo 214 / 1,900 req today</span>');
  });

  it("opens the stored showcase brief of a starter, at no cost, and asks the others", async () => {
    const [first, second] = STARTER_DESKS[0]!.starters;
    showcases.byQuestion.mockResolvedValue(new Map([[` ${first!.question.toUpperCase()}`.trim().toLowerCase(), "run-showcase-0001"]]));
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain(`href="/run/run-showcase-0001"`);
    expect(html).toContain(`>${escaped(first!.label)}<span class="sr-only"> (stored brief)</span></a>`);
    expect(html).not.toContain(`href="${escaped(askHref(first!.question))}"`);
    expect(html).toContain(`href="${escaped(askHref(second!.question))}"`);
  });

  it("asks every starter when the showcases cannot be read", async () => {
    showcases.byQuestion.mockRejectedValue(new Error("connection refused"));
    const html = renderToStaticMarkup(await Home());
    for (const starter of STARTER_DESKS.flatMap((d) => d.starters)) expect(html).toContain(`href="${escaped(askHref(starter.question))}"`);
  });

  it("asks every showcase question word for word on its desk", () => {
    for (const showcase of showcaseConfig.showcases) {
      const desk = STARTER_DESKS.find((d) => d.pillar === showcase.desk);
      const starter = desk?.starters.find((s) => s.showcase === showcase.code);
      expect(starter?.question, showcase.code).toBe(showcase.question);
    }
    for (const desk of STARTER_DESKS) {
      expect(desk.starters.length, desk.pillar).toBeGreaterThanOrEqual(3);
      for (const s of desk.starters) expect(s.label.length, s.label).toBeLessThanOrEqual(32);
    }
  });
});

describe("RecentBriefsView", () => {
  it("lists the briefs with desk and job, verdict, conviction and date, and links to the library", () => {
    const html = renderToStaticMarkup(<RecentBriefsView state={{ kind: "ready", list: briefList(BRIEFS), year: 2026 }} />);
    expect(html).toMatch(/href="\/briefs"[^>]*>All 38 briefs/);
    expect(html).toContain('href="/run/run-brief-0001"');
    expect(html).toContain("Juniper Cola vs Brand Beta: who wins where?");
    expect(html).toContain("Investment · Compare two brands");
    expect(html).toContain("Mixed signal");
    expect(html).toContain('aria-valuenow="71"');
    expect(html).toContain(">14 Oct</time>");
    // Another year prints its year.
    expect(html).toContain(">30 Dec 2025</time>");
    // A run that stopped without a note: no verdict, no conviction (none will come), never a 0.
    expect(html).toContain("Incomplete");
    expect(html).toContain("Conviction: not scored");
    // The empty meter is drawn but hidden: its "pending" would promise a score.
    expect(html).toContain('<span aria-hidden="true"><span role="meter" aria-label="Conviction" aria-valuemin="0" aria-valuemax="100" aria-valuetext="pending"');
    expect(html).not.toContain('aria-valuenow="0"');
  });

  it("says so when there are no briefs, in the page's words, and offers a retry when the list failed", () => {
    const empty = renderToStaticMarkup(<RecentBriefsView state={{ kind: "ready", list: EMPTY_LIST, year: 2026 }} />);
    expect(empty).toContain("No briefs yet. The briefs you run in this browser are listed here.");
    expect(empty).not.toContain('href="/briefs"');
    const home = renderToStaticMarkup(
      <RecentBriefsView state={{ kind: "ready", list: EMPTY_LIST, year: 2026 }} empty={<p>Pick a starter above.</p>} />,
    );
    expect(home).toContain("<p>Pick a starter above.</p>");
    const failed = renderToStaticMarkup(
      <RecentBriefsView state={{ kind: "error", message: "The briefs could not be loaded.", retry: true }} onRetry={() => undefined} />,
    );
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Try again");
  });
});

describe("the status line's Qloo count", () => {
  const client = (todayNetwork: number) => ({ quota: () => ({ todayNetwork }) });

  it("prints today's requests against the quota, read from the server's Qloo client", () => {
    expect(qlooUsageText(214, 1900)).toBe("Qloo 214 / 1,900 req today");
    const running = client(8);
    expect(qlooRequestsToday(() => running, () => running)).toBe(8);
  });

  it("says nothing rather than a wrong 0 while a new client loads the day's count, or when Qloo is not configured", () => {
    const get = vi.fn(() => client(0));
    expect(qlooRequestsToday(() => undefined, get)).toBeNull();
    // The read still creates the client, so the next page has the count.
    expect(get).toHaveBeenCalledOnce();
    const unconfigured = () => {
      throw new Error("QLOO_API_KEY is not set");
    };
    expect(qlooRequestsToday(() => undefined, unconfigured)).toBeNull();
    expect(qlooRequestsToday(() => client(3), unconfigured)).toBeNull();
  });

  it("leaves the count out of the status line when the server could not read it", async () => {
    qloo.peek.mockReturnValueOnce(undefined);
    showcases.byQuestion.mockResolvedValue(new Map());
    const html = renderToStaticMarkup(await Home());
    expect(html).toContain("Analytics, not financial advice");
    expect(html).not.toContain("req today");
  });
});
