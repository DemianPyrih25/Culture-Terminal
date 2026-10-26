// /r/[id]/card and the permalink head's card (P1 #4, D31): a curated showcase names its share card as
// og:image and the route draws it; every other run gets no og:* or twitter:* tag and a 404. Only the
// snapshot and dataset reads are stubbed (the database behind GET /api/runs/[id]); the loader, the
// brief model, the card, the fonts and next/og's renderer are real, on the synthetic runs (invented
// entities, D29).
import { readdirSync } from "node:fs";
import path from "node:path";
import { ImageResponse } from "next/og";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Job, type DatasetEnvelope, type RunState } from "@ct/contracts";
import { sampleEvents } from "../../server/samples";
import { endedAs, upTo } from "../brief-page/support";
import { GET } from "../../app/r/[id]/card/route";
import { generateMetadata } from "../../app/r/[id]/page";
import { loadPermalink } from "../../app/r/[id]/load";
import { ogCardMetadata, ogCardPath, OG_SIZE, OgCardImage } from "../../lib/og";
import { ogFonts } from "../../lib/og/fonts";
import { cardOf, jobState, stateOf } from "./support";

const { runSnapshot, runDataset } = vi.hoisted(() => ({
  runSnapshot: vi.fn<(runId: string) => Promise<Response>>(),
  runDataset: vi.fn<(runId: string, datasetId: string) => Promise<Response>>(),
}));

vi.mock("server-only", () => ({}));
// The page module, for its metadata: its document's client parts are not rendered here.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: () => null }));
vi.mock("../../server/http", () => ({ runSnapshot, runDataset }));

const RUN_ID = "run-0000-og-card";

/** What GET /api/runs/[id] answers for a stored run: a new response on every read. */
function serve(state: RunState, showcase: boolean): void {
  const run = { id: RUN_ID, status: state.ended?.status ?? "running", question: state.question, isShowcase: showcase };
  runSnapshot.mockImplementation(async () => Response.json({ run, state: { ...state, runId: RUN_ID } }));
}

const card = (id = RUN_ID) => GET(new Request(`http://localhost${ogCardPath(id)}`), { params: Promise.resolve({ id }) });
const pageMetadata = (id = RUN_ID) => generateMetadata({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) } as PageProps<"/r/[id]">);

/** The permalink's brief as the page reads it, for the head's card. */
async function brief() {
  const found = await loadPermalink(RUN_ID);
  if (found.kind !== "brief") throw new Error(`no brief: ${found.kind}`);
  return found;
}

/** The trust example: a question CLERK refused before any data, ended as refused. */
function refusedState(): RunState {
  const events = sampleEvents("needs-input");
  const clerk = events.find((e) => e.type === "clerk");
  if (clerk?.type !== "clerk") throw new Error("no clerk event");
  return stateOf(endedAs([events[0]!, { ...clerk, intent: { ...clerk.intent, safety: { allowed: false, category: "political_targeting", reframe: null } } }], "refused", "political targeting"));
}

/** A PNG's width and height, from its IHDR chunk. */
function pngSize(bytes: Uint8Array): { width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect([...bytes.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

beforeEach(() => {
  runSnapshot.mockReset();
  runDataset.mockReset();
  runDataset.mockImplementation(async () => Response.json({ error: "Dataset not found." }, { status: 404 }));
});

describe("a curated showcase", () => {
  it("names its card in the permalink's head: a 1200 × 630 PNG with the card's alt text, and a large Twitter card", async () => {
    serve(stateOf(sampleEvents("brand-health")), true);
    const head = ogCardMetadata(RUN_ID, await brief());
    expect(head).toEqual({
      openGraph: {
        images: [{ url: `/r/${RUN_ID}/card`, width: 1200, height: 630, alt: expect.stringContaining("Is the Juniper Cola audience a moat or a niche?"), type: "image/png" }],
      },
      twitter: { card: "summary_large_image" },
    });
    expect(runSnapshot).toHaveBeenCalledWith(RUN_ID);
  });

  it("draws the card: a 1200 × 630 PNG, cached for an hour so an unpinned showcase's card goes", async () => {
    serve(jobState("head_to_head"), true);
    const res = await card();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    const png = new Uint8Array(await res.arrayBuffer());
    expect(pngSize(png)).toEqual({ width: 1200, height: 630 });
    expect(png.byteLength).toBeGreaterThan(20_000);
  }, 30_000);

  it("draws the trust example's refusal too", async () => {
    serve(refusedState(), true);
    expect(ogCardMetadata(RUN_ID, await brief()).openGraph).toBeDefined();
    expect((await card()).status).toBe(200);
  }, 30_000);

  it("reads a lead figure the stream did not carry from its stored dataset", async () => {
    const state = jobState("market_selection");
    const lead = Object.values(state.datasets).find((d) => d.kind === "Matrix")!;
    const envelope = lead.data as DatasetEnvelope;
    serve({ ...state, datasets: Object.fromEntries(Object.entries(state.datasets).map(([id, d]) => [id, { ...d, data: null }])) }, true);
    runDataset.mockImplementation(async () => Response.json(envelope));
    const res = await card();
    expect(res.status).toBe(200);
    expect(runDataset).toHaveBeenCalledWith(RUN_ID, lead.id);
  }, 30_000);
});

describe("no card", () => {
  it("for a reader's own run (D31): no og:* or twitter:* tag in the permalink's head, and the card answers 404", async () => {
    serve(stateOf(sampleEvents("brand-health")), false);
    expect(ogCardMetadata(RUN_ID, await brief())).toEqual({});
    const head = await pageMetadata();
    expect(head).not.toHaveProperty("openGraph");
    expect(head).not.toHaveProperty("twitter");
    expect((await card()).status).toBe(404);
  });

  it("for a showcase stored without its report", async () => {
    serve({ ...jobState("brand_health"), report: null }, true);
    expect(ogCardMetadata(RUN_ID, await brief())).toEqual({});
    expect((await card()).status).toBe(404);
  });

  it("for a run with no finished brief: still running, or waiting for a pick", async () => {
    serve(stateOf(upTo([...sampleEvents("brand-health")], "plan")), true);
    expect((await card()).status).toBe(404);
    serve(stateOf(sampleEvents("needs-input")), true);
    expect((await card()).status).toBe(404);
  });

  it("for an unknown run, or when the run cannot be read", async () => {
    runSnapshot.mockImplementation(async () => Response.json({ error: "no run" }, { status: 404 }));
    expect((await card()).status).toBe(404);
    runSnapshot.mockImplementation(async () => Response.json({ error: "database down" }, { status: 503 }));
    expect((await card()).status).toBe(404);
  });

  it("for a malformed id, without reading anything", async () => {
    expect((await card("../../etc")).status).toBe(404);
    expect((await card("bad id")).status).toBe(404);
    expect(runSnapshot).not.toHaveBeenCalled();
  });

  it("from a metadata image file: the permalink's segment has none, as it would tag every run", () => {
    const segment = readdirSync(path.join(import.meta.dirname, "..", "..", "app", "r", "[id]"));
    for (const file of segment) expect(file).not.toMatch(/^(opengraph|twitter)-image\./);
  });
});

describe("drawing fetches no font", () => {
  const real = globalThis.fetch;
  /** Every URL next/og asks for while drawing, but the inline data it reads; none reaches the network. */
  const fetched = (): string[] => {
    const spy = vi.mocked(globalThis.fetch);
    return spy.mock.calls.map(([input]) => (input instanceof Request ? input.url : String(input))).filter((url) => !url.startsWith("data:"));
  };

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      return url.startsWith("data:") ? real(input, init) : Promise.resolve(new Response("", { status: 404 }));
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("for a character whose capital no card font has: the micro sign never reaches a label set in capitals", async () => {
    const micro = String.fromCodePoint(0xb5);
    const state = JSON.parse(JSON.stringify(jobState("brand_health")).replaceAll("Granite Outfitters", `Granite ${micro} Outfitters`)) as RunState;
    const drawn = cardOf(state);
    expect(drawn.panel?.kind === "figure" && drawn.panel.keyFigures[0]?.comparator).toBe("with Granite Outfitters");
    serve(state, true);
    expect((await card()).status).toBe(200);
    expect(fetched()).toEqual([]);
  }, 30_000);

  it("while a glyph the fonts lack would be fetched, so the check above can fail", async () => {
    const drawn = cardOf(jobState("brand_health"));
    if (drawn.panel?.kind !== "figure") throw new Error("no figure");
    // Set by hand, past cardText: a Greek capital, as a capital label would print the micro sign.
    const forced = { ...drawn, panel: { ...drawn.panel, keyFigures: [{ value: "1", label: "Label", comparator: String.fromCodePoint(0x39c) }] } };
    await new ImageResponse(<OgCardImage card={forced} />, { ...OG_SIZE, fonts: await ogFonts() }).arrayBuffer().catch(() => null);
    expect(fetched().length).toBeGreaterThan(0);
  }, 30_000);

  it.each(Job.options)("for the %s card", async (job) => {
    await new ImageResponse(<OgCardImage card={cardOf(jobState(job))} />, { ...OG_SIZE, fonts: await ogFonts() }).arrayBuffer();
    expect(fetched()).toEqual([]);
  }, 30_000);
});
