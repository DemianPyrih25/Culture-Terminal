// run-skill over the Postgres cache, in a throwaway database: a repeated command is served from
// qloo_cache as HIT and logs no second network call. Synthetic mock data (QLOO_MOCK=1); skips when no
// database is reachable.
import { countQlooNetworkCalls } from "@ct/db";
import { createPgQlooStore } from "@ct/qloo";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDatabase, probeTestDatabase, type TestDatabase } from "../../../packages/db/test/support/testDb";
import { stubGeo } from "./geo";
import { memoryIo } from "./io";
import { runSkillCommand } from "./skill-cli";

const probe = await probeTestDatabase();
const ENV = { QLOO_MOCK: "1", QLOO_RPS: "10", QLOO_TAG: "dev-tools-test" };

describe.skipIf(!probe.ok)("run-skill over the Postgres cache", () => {
  let t: TestDatabase | undefined;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 30_000);

  async function run() {
    const io = memoryIo();
    // A new store and client per run, as in two separate processes.
    const code = await runSkillCommand(["peer_landscape", "Brand Alpha", "--k", "4"], { env: ENV, io, store: createPgQlooStore(t!.db), geo: stubGeo() });
    return { code, text: io.text() };
  }

  it("answers the second run from qloo_cache", async () => {
    const first = await run();
    expect(first.code).toBe(0);
    expect(first.text).toContain("this run      6 network · 0 cached");
    const second = await run();
    expect(second.code).toBe(0);
    expect(second.text).toContain("this run      0 network · 6 cached");
    expect(second.text).not.toMatch(/\bMISS\b/);
    expect(second.text.match(/\bHIT\b/g)).toHaveLength(6);
    expect(await countQlooNetworkCalls(t!.db, { env: "mock", tag: "dev-tools-test" })).toBe(6);
  });
});
