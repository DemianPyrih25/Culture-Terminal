// R4/R5 wiring (D45): the run starts the side context calls once CLERK's intent passes the safety checks,
// shows the ANALYST only the presence line, settles them before ASSEMBLE, meters their spend and puts the
// blocks in the report. The side module is stubbed here (its own tests are the context builder's).
// Invented names and example.com links only (D29).
import type { AiContextBlock, MarketId, WebContextBlock } from "@ct/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as side from "../../src/side";
import type { SideContextOptions, SideContextResult } from "../../src/side";
import { presenceLine } from "../../src/run/agentRun";
import { intentFor, parseAll, planCall, reportWithoutFollowup, respond, run, userTexts } from "./support";

vi.mock("../../src/side", async (importActual) => {
  const actual = await importActual<typeof import("../../src/side")>();
  return { ...actual, startSideContext: vi.fn(actual.startSideContext) };
});

const start = vi.mocked(side.startSideContext);
afterEach(() => start.mockReset());

const AI: AiContextBlock = {
  status: "ok",
  items: [{ topic: "Ownership", text: "Brand Alpha belongs to an invented holding group, SECRET-AI-TEXT.", kind: "deal" }],
  presenceMarkets: ["austin"],
  model: "claude-sonnet-5-5",
  generatedAt: "2026-10-22T09:00:00.000Z",
  cached: false,
  note: null,
  droppedForNumbers: 0,
};
const WEB: WebContextBlock = {
  status: "ok",
  items: [
    {
      claim: "An invented report says Brand Alpha opened a flagship store, SECRET-WEB-TEXT.",
      url: "https://example.com/brand-alpha",
      title: "Brand Alpha opens a store",
      publisher: "example.com",
      published: "October 1, 2026",
      publishedIso: "2026-10-01",
      retrievedAt: "2026-10-22T09:00:00.000Z",
      citedText: "Brand Alpha opened a flagship store",
    },
  ],
  model: "claude-haiku-5-5",
  searches: 2,
  retrievedAt: "2026-10-22T09:00:00.000Z",
  cached: false,
  note: null,
  droppedForNumbers: 0,
};
const RESULT: SideContextResult = {
  ai: AI,
  web: WEB,
  usd: 0.05,
  usage: { input: 1000, output: 200, cacheRead: 0, cacheCreation: 0 },
  webSearches: 2,
  models: { ai: "claude-sonnet-5-5", web: "claude-haiku-5-5" },
};

/** A stub handle: emits both blocks at once, knows the presence markets, settles to RESULT. */
function stubSide(presence: MarketId[] | null = ["austin"]) {
  const seen: { options?: SideContextOptions; waits: number[] } = { waits: [] };
  start.mockImplementation((o) => {
    seen.options = o;
    o.emit({ type: "context.ai", block: AI, usd: 0.01, ms: 900 });
    o.emit({ type: "context.web", block: WEB, usd: 0.04, ms: 2100 });
    return {
      presence: async () => presence,
      settled: async (waitMs) => {
        seen.waits.push(waitMs);
        return RESULT;
      },
    };
  });
  return seen;
}

const SIDE = {
  client: { create: () => Promise.reject(new Error("never called by the stub")) },
  cache: null,
  config: { aiEnabled: true, webEnabled: true, webMaxUses: 3, aiTimeoutMs: 25_000, webTimeoutMs: 45_000 },
};

describe("runAgent: the side context calls", () => {
  it("start once the intent passes, settle before ASSEMBLE, and land in the report and the receipt", async () => {
    const seen = stubSide();
    const intent = intentFor({ geo: { metro: "austin", area: null, unsupported_place: null, market: null, target_metro: null, cities: [] } });
    const { result, events } = await run({ intent, side: SIDE, stream: [respond([planCall()]), ...reportWithoutFollowup()] });
    expect(result.status).toBe("completed");
    parseAll(events);
    expect(start).toHaveBeenCalledTimes(1);
    expect(seen.options).toMatchObject({ runId: "run-test-0001", subjectName: "Brand Alpha", placeLabel: "Austin, TX", mode: "live", cache: null });
    expect(seen.options?.intent.job).toBe("brand_health");
    // One wait, never past SIDE_TIMEOUTS.webMs after the start.
    expect(seen.waits).toHaveLength(1);
    expect(seen.waits[0]).toBeLessThanOrEqual(side.SIDE_TIMEOUTS.webMs);
    // Each block's event goes out as it settles.
    expect(events.filter((e) => e.type === "context.ai" || e.type === "context.web").map((e) => e.type)).toEqual(["context.ai", "context.web"]);
    const report = result.report!;
    expect(report.aiContext).toEqual(AI);
    expect(report.webContext).toEqual(WEB);
    expect(report.receipt.context).toEqual({ aiUsd: 0.01, webUsd: 0.04, webSearches: 2 });
    expect(report.receipt.models).toMatchObject({ context: "claude-sonnet-5-5", web: "claude-haiku-5-5" });
    // The spend joins the run's meter: tokens as LLM spend, the two searches as unmetered fees.
    expect(result.usd).toBeGreaterThanOrEqual(0.05);
    expect(report.receipt.usd).toBeCloseTo(result.usd, 6);
  });

  it("shows the ANALYST only the presence line: no item text, no web text, no link", async () => {
    stubSide(["austin", "denver"]);
    const { fake } = await run({ side: SIDE, stream: [respond([planCall()]), ...reportWithoutFollowup()] });
    const all = fake.streamRequests.flatMap((r) => userTexts(r)).join("\n");
    expect(all).toContain(presenceLine(["austin", "denver"])!);
    expect(all).not.toContain("SECRET-AI-TEXT");
    expect(all).not.toContain("SECRET-WEB-TEXT");
    expect(all).not.toContain("example.com");
    // CLERK never sees them either.
    expect(JSON.stringify(fake.createRequests)).not.toContain("SECRET-");
  });

  it("adds no line when presence is unknown or not ready", async () => {
    stubSide(null);
    const { fake } = await run({ side: SIDE, stream: [respond([planCall()]), ...reportWithoutFollowup()] });
    expect(fake.streamRequests.flatMap((r) => userTexts(r)).join("\n")).not.toContain("AI CONTEXT");
    expect(presenceLine([])).toBeNull();
  });

  it("never starts for a refused question or without a side config, and settles at once when the run stops at the picker", async () => {
    stubSide();
    const refused = await run({ side: SIDE, intent: intentFor({ safety: { allowed: false, category: "private_individual", reframe: null } }) });
    expect(refused.result.status).toBe("refused");
    expect(start).not.toHaveBeenCalled();

    await run({ stream: [respond([planCall()]), ...reportWithoutFollowup()] });
    expect(start).not.toHaveBeenCalled();

    const seen = stubSide();
    const picker = await run({ side: SIDE, intent: intentFor({ mentions: [{ text: "Brand Notfound", entity_type: "brand", role: "primary", public_figure: false }] }) });
    expect(picker.result.status).toBe("needs_input");
    expect(seen.waits).toEqual([0]);
  });
});
