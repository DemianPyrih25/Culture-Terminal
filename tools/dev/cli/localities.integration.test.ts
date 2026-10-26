// The locality pins in a real kv table, in a throwaway database: pin writes them, run-skill's metro
// contexts read them, and a repeated pin is answered from qloo_cache. Synthetic mock data
// (QLOO_MOCK=1); skips when no database is reachable.
import { getKv } from "@ct/db";
import { createPgQlooStore } from "@ct/qloo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "../../../packages/db/test/support/testDb";
import { stubGeo } from "./geo";
import { memoryIo } from "./io";
import { LOCALITIES_KV_KEY, MOCK_LOCALITIES_KV_KEY, pgKv, StoredLocalities } from "./localities";
import { runLocalitiesCommand } from "./localities-cli";
import { runSkillCommand } from "./skill-cli";

const probe = await probeTestDatabase();
const ENV = { QLOO_MOCK: "1", QLOO_RPS: "10", QLOO_TAG: "dev-tools-test" };

describe.skipIf(!probe.ok)("locality pins in the kv table", () => {
  let t: TestDatabase | undefined;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  // A new store and kv per command, as in separate processes.
  const deps = () => ({ env: ENV, io: memoryIo(), store: createPgQlooStore(t!.db), kv: pgKv(t!.db) });

  it("writes the pins in the stored shape and answers a repeated pin from qloo_cache", async () => {
    const first = deps();
    expect(await runLocalitiesCommand(["pin", "nashville", "memphis", "--yes"], first)).toBe(0);
    const stored = StoredLocalities.parse(await getKv(t!.db, MOCK_LOCALITIES_KV_KEY));
    expect(stored.nashville?.label).toBe("Nashville");
    expect(stored.memphis?.label).toBe("Memphis");
    expect(await getKv(t!.db, LOCALITIES_KV_KEY)).toBeUndefined();

    const again = deps();
    expect(await runLocalitiesCommand(["pin", "nashville", "memphis", "--replace", "--yes"], again)).toBe(0);
    expect(again.io.stdout.join("\n")).toContain("this run      0 network · 2 cached");
    expect(StoredLocalities.parse(await getKv(t!.db, MOCK_LOCALITIES_KV_KEY))).toEqual(stored);
  });

  it("serves the pins to run-skill's metro contexts", async () => {
    const run = deps();
    const input = JSON.stringify({ type: "brand", set: ["R1", "R2"], ages: [], audiences: [], metros: ["nashville", "memphis"] });
    const code = await runSkillCommand(["share_of_taste", "--names", "Brand Alpha,Brand Beta", "--input", input], { ...run, geo: stubGeo() });
    const text = run.io.stdout.join("\n");
    expect(code).toBe(0);
    expect(text).toContain("localities kv metro_localities.mock (2 pinned)");
    expect(text).not.toContain("no market locality is available");
  });
});
