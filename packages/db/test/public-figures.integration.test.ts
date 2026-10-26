// The public figures CLERK marked in briefs that ran, which the DES tearsheet vets a person with before
// any Qloo request, against a real Postgres in a throwaway database. Skips only when no database is
// reachable; in CI with DATABASE_URL set it never skips. Invented names only.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "../src/client";
import { createRun, listPublicFigureNames } from "../src/repos/runs";
import type { RunStatus } from "../src/schema";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "./support/testDb";

const probe = await probeTestDatabase();

/** A mention as CLERK's intent stores it. */
function mention(text: string, entityType: string, publicFigure: boolean) {
  return { text, entity_type: entityType, role: "primary", public_figure: publicFigure };
}

describe.skipIf(!probe.ok)("public figures from stored intents against Postgres", () => {
  let t: TestDatabase | undefined;
  let db: Db;

  beforeAll(async () => {
    t = await createTestDatabase();
    db = t.db;
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  let n = 0;
  async function seed(status: RunStatus, intent: unknown) {
    n += 1;
    await createRun(db, { question: `Who travels with seed ${n}?`, questionHash: `figures:${n}`, status, intent });
  }

  it("lists each public-figure person once from briefs that ran, and nothing else", async () => {
    await seed("completed", { mentions: [mention("Comedian Vega", "person", true), mention("Juniper Cola", "brand", false)] });
    await seed("incomplete", { mentions: [mention("Comedian Nova", "person", true), mention("Comedian Vega", "person", true)] });
    await seed("completed", { mentions: [mention("Neighbour Vega", "person", false)] });
    await seed("refused", { mentions: [mention("Refused Nova", "person", true)] });
    await seed("completed", { mentions: "not a list" });
    await seed("completed", undefined);

    expect((await listPublicFigureNames(db)).sort()).toEqual(["Comedian Nova", "Comedian Vega"]);
    expect(await listPublicFigureNames(db, 1)).toHaveLength(1);
  });
});
