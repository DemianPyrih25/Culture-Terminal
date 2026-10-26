// /r/[id], the read-only permalink of a finished brief (PLAN Part 6, D31), rendered as the server renders
// it from the recorded sample runs (invented entities, D29). Only the snapshot read is stubbed (the
// database behind GET /api/runs/[id]); the loader, the brief model, the layout and the page are real.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reduceRunEvents, type RunEvent, type RunState } from "@ct/contracts";
import { buildBriefModel, inlineText, type BriefModel } from "../../lib/brief";
import { FAKE_MODEL } from "../../lib/test-run";
import { sampleEvents } from "../../server/samples";
import { attrValues, endedAs, slice, text, upTo } from "../brief-page/support";
import PermalinkLayout from "../../app/r/[id]/layout";
import PermalinkNotFound from "../../app/r/[id]/not-found";
import PermalinkPage, { generateMetadata } from "../../app/r/[id]/page";
import { permalinkSummary } from "../../app/r/[id]/load";
import { PendingSwitch } from "../../app/r/[id]/pending";
import { GHOST_SAMPLES } from "../../app/dev/brief/ghost-runs";

const { runSnapshot } = vi.hoisted(() => ({ runSnapshot: vi.fn<(runId: string) => Promise<Response>>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: () => null }));
vi.mock("../../server/http", () => ({ runSnapshot }));

const RUN_ID = "run-0000-permalink";
const BRIEF = [...sampleEvents("brand-health")];
const INCOMPLETE = [...sampleEvents("brand-health-incomplete")];
const NEEDS_INPUT = [...sampleEvents("needs-input")];

/** The props Next passes a page or layout of /r/[id]. */
const params = (id = RUN_ID) => ({ params: Promise.resolve({ id }) });
const pageProps = (id = RUN_ID) => ({ ...params(id), searchParams: Promise.resolve({}) }) as PageProps<"/r/[id]">;

/** The recording's events as the run RUN_ID stores them. */
const stateOf = (events: readonly RunEvent[], over: Partial<RunState> = {}): RunState => ({
  ...reduceRunEvents(RUN_ID, events.map((e) => ({ ...e, runId: RUN_ID }))),
  ...over,
});

/** What GET /api/runs/[id] answers for a stored run: a new response on every read (page, layout and metadata each read it). */
function serve(state: RunState, showcase = false): void {
  const run = { id: RUN_ID, status: state.ended?.status ?? "running", question: state.question, isShowcase: showcase };
  runSnapshot.mockImplementation(async () => Response.json({ run, state }));
}

/** A snapshot that answers with this status and no run. */
function failWith(status: number): void {
  runSnapshot.mockImplementation(async () => Response.json({ error: "no run" }, { status }));
}

async function renderPage(id = RUN_ID): Promise<string> {
  return renderToStaticMarkup(await PermalinkPage(pageProps(id)));
}

/** The layout around the not-found file, as Next renders a 404 of this segment. */
async function render404(id = RUN_ID): Promise<string> {
  return renderToStaticMarkup(await PermalinkLayout({ ...params(id), children: <PermalinkNotFound /> } as unknown as LayoutProps<"/r/[id]">));
}

beforeEach(() => {
  runSnapshot.mockReset();
});

describe("a finished brief", () => {
  it("prints LLM alone vs Culture Terminal when the stored report carries a GHOST", async () => {
    const stored = stateOf(BRIEF);
    if (!stored.report) throw new Error("no report");
    serve(stateOf(BRIEF, { report: { ...stored.report, ghost: GHOST_SAMPLES.brand_health ?? null } }));
    const html = await renderPage();
    expect(html).toContain('id="ghost"');
    expect(html).toContain('href="#ghost"');
  });

  it("renders as stored, read-only: the final brief, its replay on /run", async () => {
    serve(stateOf(BRIEF));
    const html = await renderPage();
    expect(runSnapshot).toHaveBeenCalledWith(RUN_ID);
    expect(html).toContain('data-answer="final"');
    expect(text(html)).toContain("Is the Juniper Cola audience a moat or a niche?");
    expect(html).toContain(`href="/run/${RUN_ID}?replay=1"`);
    // The outline's link and the follow-up bar's.
    expect(attrValues(html, "data-replay-link")).toEqual(["true", "true"]);
    // Nothing streams and nothing can be stopped: no live progress, no Stop run, no REPLAY marker.
    expect(html).not.toContain("data-progress");
    expect(text(html)).not.toContain("Stop run");
    expect(attrValues(html, "data-marker")).not.toContain("REPLAY");
    // The same brief /run/[id] prints once finished, from the same model.
    const model = buildBriefModel(stateOf(BRIEF), Date.parse(BRIEF.at(-1)!.ts));
    expect(text(html)).toContain(inlineText(model.answer.headline));
  });

  it("marks a reader's own run unlisted and keeps it out of the index (D31)", async () => {
    serve(stateOf(BRIEF));
    const html = await renderPage();
    expect(text(slice(html, 'data-marker="UNLISTED"', "</span>"))).toBe("Unlisted · user question");
    const metadata = await generateMetadata(pageProps());
    expect(metadata).toEqual({ title: "Is the Juniper Cola audience a moat or a niche? · Culture Terminal", robots: { index: false, follow: false } });
  });

  it("marks a test run unlisted as one", async () => {
    serve(stateOf(BRIEF, { model: FAKE_MODEL }));
    expect(text(slice(await renderPage(), 'data-marker="UNLISTED"', "</span>"))).toBe("Unlisted · test run");
  });

  it("indexes a curated showcase, with no marker, its question as the title and its answer as the description", async () => {
    serve(stateOf(BRIEF), true);
    const html = await renderPage();
    expect(html).not.toContain('data-marker="UNLISTED"');
    const metadata = await generateMetadata(pageProps());
    expect(metadata).not.toHaveProperty("robots");
    expect(metadata.title).toBe("Is the Juniper Cola audience a moat or a niche? · Culture Terminal");
    expect(metadata.description).toBe(inlineText(buildBriefModel(stateOf(BRIEF), 0).answer.headline));
    expect(metadata.description).not.toMatch(/\{\{|\[E\d/);
    // Its share card (lib/og) as og:image, and a large Twitter card; a reader's own run has neither (above).
    expect(metadata.openGraph?.images).toEqual([expect.objectContaining({ url: `/r/${RUN_ID}/card`, width: 1200, height: 630, type: "image/png" })]);
    expect(metadata.twitter).toEqual({ card: "summary_large_image" });
  });

  it("renders an INCOMPLETE evidence digest too: it ended with a note", async () => {
    serve(stateOf(INCOMPLETE));
    const html = await renderPage();
    expect(html).toContain('data-marker="INCOMPLETE"');
    expect(html).toContain(`href="/run/${RUN_ID}?replay=1"`);
  });

  it("renders the trust example's refusal as an indexed showcase, its refusal message as the description", async () => {
    const clerk = NEEDS_INPUT.find((e) => e.type === "clerk");
    if (clerk?.type !== "clerk") throw new Error("no clerk event");
    const refusedClerk: RunEvent = { ...clerk, intent: { ...clerk.intent, safety: { allowed: false, category: "political_targeting", reframe: null } } };
    const refused = stateOf(endedAs([NEEDS_INPUT[0] as RunEvent, refusedClerk], "refused", "political targeting"));
    expect(refused.ended?.status).toBe("refused");
    serve(refused, true);
    const html = await renderPage();
    expect(text(slice(html, 'aria-label="Question refused"', "</section>"))).toContain("Not answered · Political targeting");
    expect(html).not.toContain('data-marker="UNLISTED"');
    const metadata = await generateMetadata(pageProps());
    expect(metadata).not.toHaveProperty("robots");
    const terminal = buildBriefModel(refused, 0).terminal;
    expect(terminal?.kind).toBe("refused");
    expect(metadata.description).toBe(terminal?.message);
    expect(metadata.description).toBeTruthy();
  });
});

describe("no finished brief", () => {
  it("answers 404 for a run still being written, with the way to follow it live", async () => {
    const running = stateOf(upTo(BRIEF, "plan"));
    serve(running);
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    const html = await render404();
    expect(html).toContain('data-missing="running"');
    expect(text(html)).toContain("This brief is still being written.");
    expect(slice(html, 'data-run-link="true"', "</a>")).toContain("Follow it live");
    expect(html).toContain(`href="/run/${RUN_ID}"`);
    const metadata = await generateMetadata(pageProps());
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("answers 404 for a run that ended without a brief, pointing to the run", async () => {
    serve(stateOf(NEEDS_INPUT));
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    const html = await render404();
    expect(html).toContain('data-missing="no_brief"');
    expect(text(html)).toContain("This run ended without a brief.");
    expect(slice(html, 'data-run-link="true"', "</a>")).toContain("Open the run");
    expect(html).toContain(`href="/run/${RUN_ID}"`);
  });

  it("answers the plain 404 for an unknown run and a malformed id, which never reaches the store", async () => {
    failWith(404);
    await expect(renderPage()).rejects.toThrow("NEXT_NOT_FOUND");
    const missing = await render404();
    expect(missing).toContain('data-missing="not_found"');
    expect(missing).not.toContain("data-run-link");

    runSnapshot.mockClear();
    await expect(renderPage("../x")).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await render404("../x")).toContain('data-missing="not_found"');
    expect((await generateMetadata(pageProps("../x"))).robots).toEqual({ index: false, follow: false });
    expect(runSnapshot).not.toHaveBeenCalled();
  });

  it("says the store did not answer when the snapshot fails", async () => {
    failWith(503);
    const html = await renderPage();
    expect(html).toContain('data-missing="unavailable"');
    expect(html).toContain(`Run ${RUN_ID}`);
  });

  it("shows the not-found file's own 404 when the layout found no pending run", () => {
    const html = renderToStaticMarkup(
      <PendingSwitch>
        <p>plain</p>
      </PendingSwitch>,
    );
    expect(html).toBe("<p>plain</p>");
  });
});

describe("the showcase description", () => {
  it("is the answer's headline as plain text, else the refusal's message", () => {
    const model = buildBriefModel(stateOf(BRIEF), 0);
    expect(permalinkSummary(model)).toBe(inlineText(model.answer.headline));
    const refused = { answer: { headline: null }, terminal: { kind: "refused", message: "This question targets individuals; a group-level reading is offered." } };
    expect(permalinkSummary(refused as unknown as BriefModel)).toBe("This question targets individuals; a group-level reading is offered.");
  });
});
