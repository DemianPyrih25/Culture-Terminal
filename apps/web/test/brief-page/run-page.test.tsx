// /run/[id] under D31: a reader's own run, and a test run, is noindex and marked unlisted; only a curated
// showcase is indexed, and it carries no marker. The stored run is stubbed where the page loads it.
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunState } from "@ct/contracts";
import type { LoadedRun } from "../../app/run/[id]/load";
import RunPage, { generateMetadata } from "../../app/run/[id]/page";
import { FAKE_MODEL } from "../../lib/test-run";
import { after, events, slice, stateOf, text } from "./support";

const { loadRun } = vi.hoisted(() => ({ loadRun: vi.fn<(runId: string) => Promise<LoadedRun>>() }));

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));
vi.mock("../../components/ask/top-bar-ask", () => ({ TopBarAsk: () => null }));
vi.mock("../../app/run/[id]/load", () => ({ loadRun }));

const SAMPLE = events("brand-health");
const STATE = stateOf(SAMPLE);
const RUN_ID = "run-0000-d31-check";

/** The props Next passes the page: its id, and no query. */
const props = (id = RUN_ID) => ({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }) as PageProps<"/run/[id]">;

/** A stored run as load.ts reads it. */
function stored({ showcase, state = STATE }: { showcase: boolean; state?: RunState }): LoadedRun {
  return { kind: "ok", question: state.question, state, at: after(SAMPLE), showcase };
}

const RUNS = {
  "a reader's own run": stored({ showcase: false }),
  "a test run": stored({ showcase: false, state: { ...STATE, model: FAKE_MODEL } }),
  "a curated showcase": stored({ showcase: true }),
} as const;

beforeEach(() => {
  loadRun.mockReset();
});

describe("generateMetadata", () => {
  it.each([
    ["a reader's own run", false],
    ["a test run", false],
    ["a curated showcase", true],
  ] as const)("indexes %s only if it is a showcase", async (name, indexed) => {
    loadRun.mockResolvedValue(RUNS[name]);
    const metadata = await generateMetadata(props());
    expect(loadRun).toHaveBeenCalledWith(RUN_ID);
    expect(metadata.title).toBe(`${STATE.question} · Culture Terminal`);
    if (indexed) expect(metadata).not.toHaveProperty("robots");
    else expect(metadata.robots).toEqual({ index: false, follow: false });
  });

  it("keeps a missing run, a store that did not answer, and a malformed id out of the index", async () => {
    loadRun.mockResolvedValueOnce({ kind: "not_found" }).mockResolvedValueOnce({ kind: "unavailable" });
    for (const metadata of [await generateMetadata(props()), await generateMetadata(props()), await generateMetadata(props("../x"))]) {
      expect(metadata.title).toBe("Brief · Culture Terminal");
      expect(metadata.robots).toEqual({ index: false, follow: false });
    }
    // A malformed id never reaches the store.
    expect(loadRun).toHaveBeenCalledTimes(2);
  });
});

describe("RunPage", () => {
  it.each([
    ["a reader's own run", "Unlisted · user question"],
    ["a test run", "Unlisted · test run"],
    ["a curated showcase", null],
  ] as const)("marks %s unlisted unless it is a showcase", async (name, marker) => {
    loadRun.mockResolvedValue(RUNS[name]);
    const html = renderToStaticMarkup(await RunPage(props()));
    expect(html).toContain(`href="/run/${RUN_ID}?replay=1"`);
    if (marker === null) expect(html).not.toContain('data-marker="UNLISTED"');
    else expect(text(slice(html, 'data-marker="UNLISTED"', "</span>"))).toBe(marker);
  });
});
