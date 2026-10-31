// The context row (R4, R5, D45): "What AI knows (not verified)" and "From the web", apart from the measured
// answer, after "Why we think this". Invented blocks: example.com links, invented names, no model called.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  AI_CONTEXT_CAPTION,
  AI_CONTEXT_HEADING,
  AiContextBlock,
  PRESENCE_CHIP_LABEL,
  WEB_CONTEXT_CAPTION,
  WEB_CONTEXT_HEADING,
  WebContextBlock,
  type RunEvent,
} from "@ct/contracts";
import { jobRunEvents } from "../../app/dev/brief/job-runs";
import { AiContextCard, ContextRow, WebContextCard } from "../../components/answer/context-cards";
import { aiContextView, buildAnswerContext, contextModelName, safeHttpUrl, webContextView } from "../../lib/answer/context";
import { render, slice, text } from "../brief-page/support";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }), usePathname: () => "/r/x" }));

const AT = "2026-10-30T09:00:00.000Z";

const ai = (over: Partial<AiContextBlock> = {}): AiContextBlock =>
  AiContextBlock.parse({
    status: "ok",
    items: [
      { topic: "Ownership", text: "Kestrel Tonic is described as a family-owned maker.", kind: "deal" },
      { topic: "Where it sells", text: "It is said to sell mostly through regional grocers.", kind: "footprint" },
      { topic: "Brand safety", text: "No widely reported controversy is known.", kind: "risk" },
    ],
    presenceMarkets: ["austin"],
    model: "claude-sonnet-5-5",
    generatedAt: AT,
    cached: false,
    note: null,
    droppedForNumbers: 1,
    ...over,
  });

const web = (over: Partial<WebContextBlock> = {}): WebContextBlock =>
  WebContextBlock.parse({
    status: "ok",
    items: [
      {
        claim: "Kestrel Tonic opened a tasting room, according to a local food site.",
        url: "https://news.example.com/kestrel-tasting-room",
        title: "Kestrel opens a tasting room",
        publisher: "news.example.com",
        published: "April 30, 2025",
        publishedIso: "2025-04-30",
        retrievedAt: AT,
        citedText: "Kestrel Tonic opened a tasting room",
      },
      {
        claim: "The brand added a lower-sugar tonic, a trade newsletter reported.",
        url: "https://trade.example.org/kestrel-new-line",
        title: "",
        publisher: "trade.example.org",
        published: null,
        publishedIso: null,
        retrievedAt: AT,
        citedText: "added a lower-sugar tonic",
      },
    ],
    model: "claude-haiku-5-5",
    searches: 3,
    retrievedAt: AT,
    cached: false,
    note: null,
    droppedForNumbers: 0,
    ...over,
  });

describe("the context views", () => {
  it("groups AI items by kind and names the model, the date and that it is not verified", () => {
    const view = aiContextView(ai());
    expect(view.groups.map((g) => g.label)).toEqual(["Deals and ownership", "Where it already operates", "Brand-safety risks"]);
    expect(view.footer).toBe("Model: Claude Sonnet 5.5 · generated 30 Oct 2026 · not verified");
    expect(view.note).toBeNull();
    expect(contextModelName("claude-haiku-5-5")).toBe("Claude Haiku 5.5");
    expect(contextModelName(null)).toBeNull();
  });

  it("gives each web item its link words, published date or date unknown, and retrieved date", () => {
    const view = webContextView(web());
    expect(view.items[0]).toMatchObject({ linkText: "news.example.com: Kestrel opens a tasting room", published: "published 30 Apr 2025", retrieved: "retrieved 30 Oct 2026" });
    expect(view.items[1]).toMatchObject({ linkText: "trade.example.org", published: "date unknown" });
    expect(view.footer).toBe("3 searches");
    expect(webContextView(web({ cached: true, searches: 1 })).footer).toBe("1 search · saved copy");
  });

  it("only links http(s) urls without credentials", () => {
    expect(safeHttpUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHttpUrl("javascript:alert(1)")).toBeNull();
    expect(safeHttpUrl("https://user:pw@example.com/")).toBeNull();
    expect(safeHttpUrl("not a url")).toBeNull();
  });

  it("says why in one line when a block is not ok", () => {
    expect(aiContextView(ai({ status: "off", items: [], presenceMarkets: [], note: "AI context is off on this server." })).note).toBe("AI context is off on this server.");
    expect(webContextView(web({ status: "timed_out", items: [], note: null })).note).toBe("This step ran out of time.");
    expect(webContextView(web({ status: "empty", items: [], note: "The web search found nothing citable." })).note).toBe("The web search found nothing citable.");
  });

  it("prefers the report's blocks, falls back to the live ones, and keeps presence only from an ok AI block", () => {
    const live = buildAnswerContext({ aiContext: ai(), webContext: null });
    expect(live.ai).not.toBeNull();
    expect(live.web).toBeNull();
    expect(live.presence).toEqual(["austin"]);
    const stored = buildAnswerContext({ report: { aiContext: ai({ presenceMarkets: ["denver"] }) }, aiContext: ai() });
    expect(stored.presence).toEqual(["denver"]);
    expect(buildAnswerContext({ aiContext: ai({ status: "failed", items: [], note: "x" }) }).presence).toEqual([]);
    expect(buildAnswerContext({})).toEqual({ ai: null, web: null, presence: [] });
  });
});

describe("the context cards", () => {
  it("draws the AI card with its heading, groups and footer (no explainer caption), on its own tint apart", () => {
    const html = renderToStaticMarkup(<AiContextCard view={aiContextView(ai())} />);
    expect(html).toContain(AI_CONTEXT_HEADING);
    expect(text(html)).not.toContain(AI_CONTEXT_CAPTION);
    expect(html).toContain("bg-[#EDEBF5]");
    expect(html).toContain('data-context-kind="deal"');
    expect(text(html)).toContain("Kestrel Tonic is described as a family-owned maker.");
    expect(html).not.toMatch(/\d+\s*%/);
  });

  it("draws the web card with escaped claims and nofollow ugc links in a new tab", () => {
    const html = renderToStaticMarkup(<WebContextCard view={webContextView(web({ items: [{ ...web().items[0]!, claim: "A <script>alert(1)</script> claim with enough length." }] }))} />);
    expect(html).toContain(WEB_CONTEXT_HEADING);
    expect(text(html)).not.toContain(WEB_CONTEXT_CAPTION);
    expect(html).not.toContain("<script>");
    expect(html).toContain('rel="nofollow noopener noreferrer ugc"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('href="https://news.example.com/kestrel-tasting-room"');
  });

  it("draws nothing for runs stored before the blocks existed, and one card alone takes the row", () => {
    expect(renderToStaticMarkup(<ContextRow context={{ ai: null, web: null, presence: [] }} />)).toBe("");
    expect(renderToStaticMarkup(<ContextRow context={{ ai: aiContextView(ai()), web: null, presence: [] }} />)).toContain('data-context-row="ai"');
    expect(renderToStaticMarkup(<ContextRow context={{ ai: aiContextView(ai()), web: webContextView(web()), presence: [] }} />)).toContain('data-context-row="ai+web"');
  });
});

/** The run's report.final with the two blocks in it (as assemble stores them). */
function withBlocks(events: readonly RunEvent[], blocks: { aiContext?: AiContextBlock; webContext?: WebContextBlock }): RunEvent[] {
  return events.map((e) => (e.type === "report.final" ? ({ ...e, report: { ...e.report, ...blocks } } as RunEvent) : e));
}

describe("on the answer page", () => {
  const base = jobRunEvents("market_selection");

  it("puts the row after Why we think this and before More charts, from the stored report", () => {
    const { html } = render(withBlocks(base, { aiContext: ai(), webContext: web() }));
    const why = html.indexOf("Why we think this");
    const row = html.indexOf("data-context-row=");
    expect(why).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(why);
    const more = html.indexOf("More charts");
    if (more > 0) expect(row).toBeLessThan(more);
    expect(text(slice(html, "data-context-row=", "Ask next"))).toContain("Kestrel Tonic opened a tasting room");
  });

  it("marks a market the AI says the subject already operates in, without moving it", () => {
    const before = render(base).html;
    const after = render(withBlocks(base, { aiContext: ai({ presenceMarkets: ["austin", "nashville", "denver", "chicago"] }) })).html;
    expect(before).not.toContain(PRESENCE_CHIP_LABEL);
    expect(after).toContain(PRESENCE_CHIP_LABEL);
    // The ranking stays the data's: the same rows in the same order, a chip beside the marked ones.
    const rows = (html: string) => [...html.matchAll(/data-row="([^"]+)"/g)].map((m) => m[1]);
    expect(rows(after)).toEqual(rows(before));
  });

  it("draws nothing extra for a run without the blocks", () => {
    expect(render(base).html).not.toContain("data-context-row=");
  });
});
