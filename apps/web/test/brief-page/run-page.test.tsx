// /run/[id]: the metadata (D31: a reader's own run and a test run are noindex; only a curated showcase is
// indexed), and what the first paint shows: the working view of a live run, the end state of a run that
// stopped early, the answer of a finished one, and the cards for a store that did not answer. The stored
// run is stubbed where the page loads it; the sample run is invented (D29).
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunState } from "@ct/contracts";
import type { LoadedRun } from "../../app/run/[id]/load";
import RunNotFound from "../../app/run/[id]/not-found";
import RunPage, { generateMetadata } from "../../app/run/[id]/page";
import { FAKE_MODEL } from "../../lib/test-run";
import { after, before, endedAs, events, stateOf, text } from "../working/support";

const { loadRun } = vi.hoisted(() => ({ loadRun: vi.fn<(runId: string) => Promise<LoadedRun>>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../../app/run/[id]/load", () => ({ loadRun }));

const SAMPLE = events("brand-health");
const STATE = stateOf(SAMPLE);
const RUN_ID = "run-0000-d31-check";

/** The props Next passes the page: its id, and a query. */
const props = (id = RUN_ID, query: Record<string, string> = {}) =>
  ({ params: Promise.resolve({ id }), searchParams: Promise.resolve(query) }) as PageProps<"/run/[id]">;

/** A stored run as load.ts reads it. */
function stored({ showcase = false, state = STATE }: { showcase?: boolean; state?: RunState }): LoadedRun {
  return { kind: "ok", question: state.question, state, at: after(SAMPLE), showcase };
}

beforeEach(() => {
  loadRun.mockReset();
});

describe("generateMetadata", () => {
  it.each([
    ["a reader's own run", stored({}), false],
    ["a test run", stored({ state: { ...STATE, model: FAKE_MODEL } }), false],
    ["a curated showcase", stored({ showcase: true }), true],
  ] as const)("indexes %s only if it is a showcase", async (_name, run, indexed) => {
    loadRun.mockResolvedValue(run);
    const metadata = await generateMetadata(props());
    expect(loadRun).toHaveBeenCalledWith(RUN_ID);
    expect(metadata.title).toBe(`${STATE.question} · Culture Terminal`);
    if (indexed) expect(metadata).not.toHaveProperty("robots");
    else expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("keeps a missing run, a store that did not answer, and a malformed id out of the index", async () => {
    loadRun.mockResolvedValueOnce({ kind: "not_found" }).mockResolvedValueOnce({ kind: "unavailable" });
    for (const metadata of [await generateMetadata(props()), await generateMetadata(props()), await generateMetadata(props("../x"))]) {
      expect(metadata.title).toBe("Answer · Culture Terminal");
      expect(metadata.robots).toEqual({ index: false, follow: false });
    }
    expect(loadRun).toHaveBeenCalledTimes(2);
  });
});

describe("RunPage", () => {
  it("shows a run still being made as the working view, with Stop", async () => {
    loadRun.mockResolvedValue(stored({ state: stateOf(before(SAMPLE, "report.draft")) }));
    const html = renderToStaticMarkup(await RunPage(props()));
    expect(html).toContain('data-working="live"');
    expect(html).toContain('data-stop="idle"');
    expect(html).toContain('data-header="working"');
  });

  it("shows a run that was stopped as its end state, with no Stop", async () => {
    loadRun.mockResolvedValue(stored({ state: stateOf(endedAs(before(SAMPLE, "report.draft"), "cancelled", null)) }));
    const html = renderToStaticMarkup(await RunPage(props()));
    expect(html).toContain('data-working="static"');
    expect(text(html)).toContain("You stopped this answer.");
    expect(html).not.toContain("data-stop=");
  });

  it("shows a finished run as its answer, not the working view", async () => {
    loadRun.mockResolvedValue(stored({}));
    const html = renderToStaticMarkup(await RunPage(props()));
    expect(html).not.toContain("data-working=");
    expect(html).not.toContain("data-progress-card");
  });

  it("says when the store did not answer, and offers to try again", async () => {
    loadRun.mockResolvedValue({ kind: "unavailable" });
    const html = renderToStaticMarkup(await RunPage(props()));
    expect(html).toContain('data-missing="unavailable"');
    expect(text(html)).toContain("We couldn't load this answer right now.");
    expect(html).toContain(`href="/run/${RUN_ID}"`);
  });

  it("answers 404 for a malformed id or a missing run, with one line and the way to ask", async () => {
    await expect(RunPage(props("../x"))).rejects.toThrow("NEXT_NOT_FOUND");
    loadRun.mockResolvedValue({ kind: "not_found" });
    await expect(RunPage(props())).rejects.toThrow("NEXT_NOT_FOUND");
    const html = renderToStaticMarkup(<RunNotFound />);
    expect(text(html)).toContain("There's no answer at this link. Ask a question");
    expect(html).toContain('href="/#ask"');
    expect(html).not.toMatch(/example/i);
  });
});
