// Following against a real Postgres in a throwaway database. Skips only when no database is reachable.
import { FOLLOWS_PER_VISITOR_MAX } from "@ct/contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client";
import { addFollow, getFollow, listFollows, type NewFollow, removeFollow, setFollowLatestRun } from "../src/repos/follows";
import { createRun, updateRun } from "../src/repos/runs";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "./support/testDb";

const probe = await probeTestDatabase();

describe.skipIf(!probe.ok)("follows against Postgres", () => {
  let t: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  const follow = (over: Partial<NewFollow> = {}): NewFollow => ({
    visitorKey: "visitor-a",
    kind: "brand",
    subjectKey: "brand:juniper cola",
    label: "Juniper Cola",
    question: "How healthy is Juniper Cola's audience taste?",
    job: "brand_health",
    metro: null,
    latestRunId: null,
    ...over,
  });

  it("adds a follow once per subject and refreshes it when followed again", async () => {
    const first = await addFollow(db, follow());
    expect(first).toMatchObject({ ok: true, created: true });
    const run = await createRun(db, { question: "Is Juniper Cola a taste island?", questionHash: "h-juniper" });
    const again = await addFollow(db, follow({ label: "Juniper Cola Co", latestRunId: run.id }));
    expect(again).toMatchObject({ ok: true, created: false });
    if (!first.ok || !again.ok) throw new Error("expected both adds to pass");
    expect(again.follow.id).toBe(first.follow.id);
    expect(again.follow).toMatchObject({ label: "Juniper Cola Co", latestRunId: run.id });
    // A refresh without a run keeps the stored one.
    const kept = await addFollow(db, follow());
    expect(kept.ok && kept.follow.latestRunId).toBe(run.id);
  });

  it("lists only the visitor's own follows, newest first, with the latest note's verdict", async () => {
    const run = await createRun(db, { question: "Where does Aurora Footwear win?", questionHash: "h-aurora", status: "completed" });
    await updateRun(db, run.id, { report: { verdict: { headline: "Aurora wins the young", signal: "strong", tag: "Youth favourite" } } });
    await addFollow(db, follow({ kind: "question", subjectKey: "question:h-aurora", label: "Where does Aurora Footwear win?", latestRunId: run.id }));
    await addFollow(db, follow({ visitorKey: "visitor-b", subjectKey: "brand:aurora footwear" }));

    const mine = await listFollows(db, "visitor-a");
    expect(mine.map((f) => f.kind)).toEqual(["question", "brand"]);
    expect(mine[0]?.latest).toMatchObject({ runId: run.id, status: "completed", headline: "Aurora wins the young", tag: "Youth favourite", signal: "strong" });
    expect((await listFollows(db, "visitor-b")).map((f) => f.subjectKey)).toEqual(["brand:aurora footwear"]);
  });

  it("scopes get, set-latest and remove to the visitor", async () => {
    const [b] = await listFollows(db, "visitor-b");
    if (!b) throw new Error("visitor-b has no follow");
    const run = await createRun(db, { question: "Is Aurora Footwear a taste island?", questionHash: "h-aurora-2" });
    expect(await getFollow(db, "visitor-a", b.id)).toBeUndefined();
    expect(await setFollowLatestRun(db, "visitor-a", b.id, run.id)).toBe(false);
    expect(await removeFollow(db, "visitor-a", b.id)).toBe(false);
    expect(await setFollowLatestRun(db, "visitor-b", b.id, run.id)).toBe(true);
    expect((await getFollow(db, "visitor-b", b.id))?.latestRunId).toBe(run.id);
    expect(await removeFollow(db, "visitor-b", b.id)).toBe(true);
    expect(await listFollows(db, "visitor-b")).toEqual([]);
  });

  it("drops the latest note, not the follow, when its run is deleted", async () => {
    const run = await createRun(db, { question: "What does Austin's taste look like?", questionHash: "h-austin" });
    const added = await addFollow(db, follow({ kind: "place", subjectKey: "place:austin", label: "Austin", latestRunId: run.id }));
    if (!added.ok) throw new Error("expected the add to pass");
    await db.execute(sql`delete from runs where id = ${run.id}`);
    const row = (await listFollows(db, "visitor-a")).find((f) => f.id === added.follow.id);
    expect(row).toMatchObject({ latestRunId: null, latest: null });
  });

  it("refuses a new follow past the per-visitor limit, even when adds race", async () => {
    const adds = Array.from({ length: FOLLOWS_PER_VISITOR_MAX + 3 }, (_, i) =>
      addFollow(db, follow({ visitorKey: "visitor-c", subjectKey: `brand:invented brand ${i}` })),
    );
    const results = await Promise.all(adds);
    expect(results.filter((r) => r.ok)).toHaveLength(FOLLOWS_PER_VISITOR_MAX);
    expect(results.filter((r) => !r.ok)).toHaveLength(3);
    // Following a subject already followed still refreshes it at the limit.
    expect(await addFollow(db, follow({ visitorKey: "visitor-c", subjectKey: "brand:invented brand 0" }))).toMatchObject({ ok: true, created: false });
  });
});
