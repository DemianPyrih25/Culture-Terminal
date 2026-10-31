// ANSWER_QUALITY checks on the rendered answer page, for every job (Part 11, run in CI with the web tests):
// no literal escape sequences, no raw entity ids, no name cut with an ellipsis in a card, the context blocks
// labelled when present, the confidence cap named in plain words (R1), about-level values never read as a
// lead, and the ZIP-city comparison row labelled approximate. The runs are the synthetic job runs of the
// /dev/brief viewer (invented entities, D29) with invented context blocks.
import { describe, expect, it, vi } from "vitest";
import {
  AI_CONTEXT_HEADING,
  AiContextBlock,
  JOB_VALUES,
  WEB_CONTEXT_HEADING,
  WebContextBlock,
  type Metric,
  type RunEvent,
} from "@ct/contracts";
import { jobRunEvents } from "../../app/dev/brief/job-runs";
import { metricView } from "../../lib/brief/ledger";
import { plainDisplay } from "../../lib/brief/plain";
import { zipCityLabel } from "../../lib/answer/job-shapes";
import { capLine } from "../../lib/answer/build";
import { render, slice, text } from "../brief-page/support";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/r/x" }));

const AT = "2026-10-30T09:00:00.000Z";
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const LITERAL_ESCAPE = /\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/;

const aiBlock = AiContextBlock.parse({
  status: "ok",
  items: [{ topic: "Ownership", text: "Described as an independent, founder-led company.", kind: "deal" }],
  presenceMarkets: [],
  model: "claude-sonnet-5-5",
  generatedAt: AT,
  cached: false,
  note: null,
  droppedForNumbers: 0,
});
const webBlock = WebContextBlock.parse({
  status: "ok",
  items: [
    {
      claim: "A local food site reported a new tasting room opening this autumn.",
      url: "https://news.example.com/tasting-room",
      title: "A new tasting room (invented page)",
      publisher: "news.example.com",
      published: null,
      publishedIso: null,
      retrievedAt: AT,
      citedText: "reported a new tasting room",
    },
  ],
  model: "claude-haiku-5-5",
  searches: 2,
  retrievedAt: AT,
  cached: false,
  note: null,
  droppedForNumbers: 0,
});

function withReport(events: readonly RunEvent[], edit: (report: Extract<RunEvent, { type: "report.final" }>["report"]) => object): RunEvent[] {
  return events.map((e) => (e.type === "report.final" ? ({ ...e, report: { ...e.report, ...edit(e.report) } } as RunEvent) : e));
}

describe.each(JOB_VALUES.map((job) => [job] as const))("the %s answer page", (job) => {
  const { html } = render(withReport(jobRunEvents(job), () => ({ aiContext: aiBlock, webContext: webBlock })));
  const page = text(html);

  it("prints no literal escape sequence and no raw entity id", () => {
    expect(page).not.toMatch(LITERAL_ESCAPE);
    expect(html).not.toMatch(UUID);
  });

  it("never cuts a name in a card with an ellipsis", () => {
    // Tailwind's truncate (text-overflow: ellipsis) is not used in the page's main column; names wrap instead.
    const main = html.slice(Math.max(0, html.indexOf("<main")));
    expect(main).not.toMatch(/class="[^"]*\btruncate\b/);
    expect(page).not.toMatch(/\w…(?=\s|$)/);
  });

  it("labels the context blocks as apart from the measured answer", () => {
    expect(page).toContain(AI_CONTEXT_HEADING);
    expect(page).toContain("Context · not measured, not checked");
    expect(page).toContain(WEB_CONTEXT_HEADING);
    expect(html.indexOf("data-context-row=")).toBeGreaterThan(html.indexOf("Why we think this"));
  });
});

describe("confidence copy (R1)", () => {
  it("names the cap that sets the band in plain words", () => {
    const events = withReport(jobRunEvents("brand_health"), (r) => ({
      verdict: {
        ...r.verdict,
        signal: "mixed",
        confidence: { score: 70, band: "MED", breakdown: [{ rule: "signal_mixed", label: "The signal is mixed", count: 1, points: 0, cap: 70 }] },
      },
    }));
    const { html, model } = render(events);
    expect(capLine(model)).toBe("Medium: the signal is mixed");
    expect(text(slice(html, 'data-verdict="answer"', "Next steps"))).toContain("Medium: the signal is mixed");
    expect(html).toContain('data-confidence-cap="true"');
  });

  it("says nothing about a cap when penalties alone set the score", () => {
    const events = withReport(jobRunEvents("brand_health"), (r) => ({
      verdict: {
        ...r.verdict,
        confidence: { score: 45, band: "LOW", breakdown: [{ rule: "insufficient_evidence", label: "x", count: 1, points: -55 }, { rule: "signal_mixed", label: "x", count: 1, points: 0, cap: 70 }] },
      },
    }));
    expect(capLine(render(events).model)).toBeNull();
  });
});

describe("small differences (V13) and the ZIP-city row", () => {
  const metric = (over: Partial<Metric>): Metric =>
    ({
      id: "M1",
      key: "share.youth_tilt",
      label: "youth tilt",
      value: 0.04,
      display: "+0.04",
      unit: "delta",
      badge: "DERIVED",
      formulaId: "share.youth_tilt",
      comparator: "PEERS",
      evidenceIds: ["E1"],
      subjectRefs: [],
      reason: null,
      ...over,
    }) as Metric;

  it("reads an about-level value as about level, with no over or under", () => {
    expect(plainDisplay(metric({ level: "about_level" }))).toBe("+0.04 · about level");
    expect(plainDisplay(metric({ level: "about_level", unit: "index", display: "1.03" }))).toBe("1.03 · about average");
    const view = metricView(metric({ level: "about_level" }), null);
    expect(view.direction).toBeNull();
    expect(view.aboutLevel).toBe(true);
    expect(metricView(metric({}), null).direction).toBe("over");
  });

  it("labels the whole-city row built from ZIP areas as approximate", () => {
    expect(zipCityLabel("Nashville ZIP areas (whole ZIPs)")).toBe("ZIP areas touching Nashville (approximate: whole ZIP areas, not the city itself)");
    expect(zipCityLabel("All of Nashville")).toBe("All of Nashville");
  });
});
