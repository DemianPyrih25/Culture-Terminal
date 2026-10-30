import type { EventInput } from "@ct/contracts";
import { RunEventInput } from "@ct/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { resetSideLatches, startSideContext, type SideClient, type SideContextOptions } from "../../src/side";
import { SIDE_NOTES } from "../../src/side/outcome";
import { after, aiMessage, cited, CONFIG, hangs, intentFixture, memoryCache, NOW, scriptedClient, searchResults, searchUse, webMessage } from "./support";

afterEach(() => resetSideLatches());

const AI_ANSWER = {
  items: [{ topic: "Ownership", text: "Brightwave Soda was recently bought by a larger beverage group.", kind: "deal" }],
  presence_markets: ["austin", "denver"],
};
const URL_A = "https://example.com/brightwave";
const WEB = webMessage(
  [
    searchUse("srv_1", "q"),
    searchResults("srv_1", [{ url: URL_A, title: "Brightwave news", page_age: "May 2, 2025" }]),
    cited("Brightwave Soda agreed to be acquired by a regional beverage group.", URL_A, "agreed to be acquired by a regional beverage group"),
  ],
  1,
);

/** Routes by request: the web call carries tools, the AI call does not. */
function routedClient(ai: Parameters<typeof scriptedClient>[0][number], web: Parameters<typeof scriptedClient>[0][number]): SideClient {
  const aiClient = scriptedClient([ai]);
  const webClient = scriptedClient([web]);
  return { create: (req, opts) => (req.tools ? webClient.create(req, opts) : aiClient.create(req, opts)) };
}

function options(client: SideClient, partial: Partial<SideContextOptions> = {}): SideContextOptions & { events: EventInput[] } {
  const events: EventInput[] = [];
  return {
    runId: "run_side_1",
    question: "How healthy is Brightwave Soda's brand in Austin?",
    intent: intentFixture(),
    mode: "live",
    subjectName: "Brightwave Soda",
    placeLabel: "Austin, TX",
    client,
    cache: null,
    config: CONFIG,
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
    now: () => NOW,
    events,
    ...partial,
  };
}

describe("startSideContext", () => {
  it("settles both blocks, emits one valid event each, and sums the cost", async () => {
    const o = options(routedClient(aiMessage(AI_ANSWER), WEB));
    const handle = startSideContext(o);
    const result = await handle.settled(5_000);

    expect(result.ai.status).toBe("ok");
    expect(result.web.status).toBe("ok");
    expect(result.webSearches).toBe(1);
    expect(result.models).toEqual({ ai: "claude-sonnet-5-5", web: "claude-haiku-5-5" });
    expect(result.usd).toBeGreaterThan(0.01);
    expect(result.usage.input).toBeGreaterThan(0);
    expect(o.events.map((e) => e.type).sort()).toEqual(["context.ai", "context.web"]);
    for (const e of o.events) expect(RunEventInput.safeParse(e).success).toBe(true);
    expect(await handle.presence(0)).toEqual(["austin", "denver"]);
  });

  it("presence(0) before the AI block is ready is null, and resolves once it is", async () => {
    const o = options(routedClient(after(30, aiMessage(AI_ANSWER)), WEB));
    const handle = startSideContext(o);
    expect(await handle.presence(0)).toBeNull();
    expect(await handle.presence(2_000)).toEqual(["austin", "denver"]);
    await handle.settled(2_000);
  });

  it("presence is null when the AI block did not succeed", async () => {
    const handle = startSideContext(options(routedClient(new Error("boom"), WEB)));
    await handle.settled(2_000);
    expect(await handle.presence(0)).toBeNull();
  });

  it("aborts a call still running at the settled deadline and marks it timed_out", async () => {
    const o = options(routedClient(aiMessage(AI_ANSWER), hangs));
    const handle = startSideContext(o);
    const started = Date.now();
    const result = await handle.settled(50);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(result.ai.status).toBe("ok");
    expect(result.web).toMatchObject({ status: "timed_out", note: SIDE_NOTES.webTimedOut });
    expect(o.events.find((e) => e.type === "context.web")).toBeDefined();
    // A second settle returns the same blocks at once.
    expect((await handle.settled(0)).web.status).toBe("timed_out");
  });

  it("times a call out at its own timeout", async () => {
    const o = options(routedClient(hangs, WEB), { config: { ...CONFIG, aiTimeoutMs: 30 } });
    const result = await startSideContext(o).settled(5_000);
    expect(result.ai).toMatchObject({ status: "timed_out", note: SIDE_NOTES.aiTimedOut });
    expect(result.web.status).toBe("ok");
  });

  it("settles both without events when the run is aborted", async () => {
    const run = new AbortController();
    const o = options(routedClient(hangs, hangs), { signal: run.signal });
    const handle = startSideContext(o);
    run.abort();
    const result = await handle.settled(5_000);
    expect(result.ai).toMatchObject({ status: "failed", note: SIDE_NOTES.stopped });
    expect(result.web).toMatchObject({ status: "failed", note: SIDE_NOTES.stopped });
    expect(result.usd).toBe(0);
    expect(o.events).toHaveLength(0);
  });

  it("makes no call for an already-aborted run", async () => {
    const run = new AbortController();
    run.abort();
    const client = scriptedClient([]);
    const result = await startSideContext(options(client, { signal: run.signal })).settled(1_000);
    expect(client.requests).toHaveLength(0);
    expect(result.ai.status).toBe("failed");
  });

  it("emits off blocks with their notes when both calls are disabled", async () => {
    const client = scriptedClient([]);
    const o = options(client, { config: { ...CONFIG, aiEnabled: false, webEnabled: false } });
    const result = await startSideContext(o).settled(1_000);
    expect(result.ai).toMatchObject({ status: "off", note: SIDE_NOTES.aiOff });
    expect(result.web).toMatchObject({ status: "off", note: SIDE_NOTES.webOff });
    expect(o.events).toHaveLength(2);
    expect(client.requests).toHaveLength(0);
    expect(result.models).toEqual({ ai: null, web: null });
  });

  it("serves cached blocks at no cost and still emits their events", async () => {
    const cache = memoryCache();
    await startSideContext(options(routedClient(aiMessage(AI_ANSWER), WEB), { cache })).settled(5_000);
    const client = scriptedClient([]);
    const o = options(client, { cache });
    const result = await startSideContext(o).settled(5_000);
    expect(client.requests).toHaveLength(0);
    expect(result.usd).toBe(0);
    expect(result.ai.cached && result.web.cached).toBe(true);
    expect(o.events).toHaveLength(2);
  });

  it("a throwing emit never breaks the run", async () => {
    const o = options(routedClient(aiMessage(AI_ANSWER), WEB), {
      emit: () => {
        throw new Error("log closed");
      },
    });
    const result = await startSideContext(o).settled(5_000);
    expect(result.ai.status).toBe("ok");
  });
});
