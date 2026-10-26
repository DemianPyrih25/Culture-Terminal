// The Launchpad against a real Postgres in a throwaway database: which showcase tiles are pinned comes
// from the pin store (the run holding a config slug, @ct/db pinShowcaseRun), never from a visitor's own
// run (D31), a test run, a run still going or a showcase run of the same question that holds no slug.
// The trust tile opens the pinned refusal. Pinned runs replay the synthetic test run's events under
// their own ids (D29). Skips only when no database is reachable.
import { randomUUID } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appendEvents, createRun, pinShowcaseRun, type Db, type NewRun } from "@ct/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "../support/test-db";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ push: vi.fn() }),
}));
// The status line's Qloo count is not under test: no client is created.
vi.mock("../../server/container", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../server/container")>()),
  peekQlooClient: () => undefined,
  getQlooClient: () => {
    throw new Error("no Qloo client in this test");
  },
}));

const available = await databaseAvailable();
const g = globalThis as { __ctContainer?: unknown };

describe.skipIf(!available)("the Launchpad against Postgres", () => {
  let t: TestDatabase | undefined;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await createTestDatabase();
    const db = t.db;
    const { SHOWCASES, TRUST_QUESTION, TRUST_SLUG } = await import("../../components/launchpad/showcases");
    const { toEventRow } = await import("../../server/event-store");
    const { questionHash } = await import("../../server/question-hash");
    const { fakeRunEvents, fakeRunState } = await import("../brief/support");
    const report = fakeRunState().report!;
    const question = (code: string) => SHOWCASES.find((s) => s.code === code)!.question;

    /** A finished run with the test run's events and note, marked a showcase (no slug) unless `over` says otherwise. */
    async function seed(name: string, q: string, over: Partial<NewRun> = {}): Promise<string> {
      const id = randomUUID();
      await createRun(db as Db, {
        id,
        question: q,
        questionHash: questionHash(q, undefined, "live"),
        status: "completed",
        isShowcase: true,
        report: { ...report, runId: id },
        ...over,
      });
      await appendEvents(db as Db, id, fakeRunEvents(id).map(toEventRow));
      ids[name] = id;
      return id;
    }

    // Pinned as the showcase tool pins: is_showcase, the slug and the config order together.
    const pinned = await seed("pinned", question("S1"), { isShowcase: false });
    await pinShowcaseRun(db as Db, { slug: SHOWCASES[0]!.slug, runId: pinned, order: 1 });
    const refusal = await seed("refusal", TRUST_QUESTION, { isShowcase: false, status: "refused", report: null });
    await pinShowcaseRun(db as Db, { slug: TRUST_SLUG, runId: refusal, order: SHOWCASES.length + 2 });
    await seed("visitor", question("S2"), { isShowcase: false });
    await seed("testRun", question("S3"), { questionHash: `fake:${randomUUID()}` });
    await seed("running", question("S4"), { status: "running", report: null });
    // Marked a showcase but under no slug: the starters may open it, a tile never does.
    await seed("unslugged", question("S5"));
    g.__ctContainer = { db };
  }, 60_000);

  afterAll(async () => {
    delete g.__ctContainer;
    await t?.dispose();
  }, 30_000);

  it("pins only the runs the pin store holds under a slug, and opens none of the others", async () => {
    const { default: Home } = await import("../../app/page");
    const html = renderToStaticMarkup(await Home());
    expect(html).toMatch(/data-showcase="S1" data-pinned="true"/);
    expect(html).toContain(`href="/r/${ids.pinned}"`);
    expect(html).toContain(`data-judge-step="note" href="/r/${ids.pinned}"`);
    for (const code of ["S2", "S3", "S4", "S5"]) expect(html).toMatch(new RegExp(`data-showcase="${code}" data-pinned="false"`));
    for (const name of ["visitor", "testRun", "running"]) expect(html, name).not.toContain(ids[name]!);
    expect(html, "unslugged").not.toContain(`/r/${ids.unslugged}`);
    // The trust tile opens the pinned refusal as its note.
    expect(html).toContain(`data-trust-run="true" href="/r/${ids.refusal}"`);
    // The stored brief's own finding and figure.
    expect(html).toMatch(/data-showcase="S1" data-pinned="true"[\s\S]*?data-thumbnail="(Scorecard|Matrix|Bars|Ranked|Quadrant|Slope|GeoLift|Slate|Momentum|Position)"/);
    expect(html).toMatch(/data-finding="(tag|headline)"/);
  });
});
