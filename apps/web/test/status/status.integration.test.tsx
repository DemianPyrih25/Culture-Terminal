// The two reads server/status.ts makes on its own (until @ct/db has them) against a real Postgres in a
// throwaway database: the latest runs' statuses by hash prefix, and today's cache hit count by
// environment; and kv metro_localities' coverage of the map cities and config markets. Then a whole reading over
// those reads, rendered, with canaries planted in the rows, the pins and the key: no question, entity,
// request id, locality id or key reaches the reading or the page (D31). Skips only
// when no database is reachable. Invented questions, entities and paths only.
import { renderToStaticMarkup } from "react-dom/server";
import { MetroId } from "@ct/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createRun, insertQlooCalls, setKv, type CacheStatus, type RunStatus } from "@ct/db";
import { createTestDatabase, databaseAvailable, type TestDatabase } from "../support/test-db";
import { CANARY_API_KEY, CANARY_ENTITY, CANARY_QUESTION, CANARY_REQUEST_ID, fakeSources } from "./fixtures";

vi.mock("server-only", () => ({}));

const { CONFIG_MARKETS, defaultStatusSources, readLocalityStatus, readQlooCache, readRecentStatuses, readStatus } = await import("../../server/status");
const { StatusView } = await import("../../components/status/status-view");
// The live key by name: the shell may export QLOO_MOCK=1, which reads the mock pins.
const { LOCALITIES_KV_KEY } = await import("../../server/localities");

const available = await databaseAvailable();

describe.skipIf(!available)("status reads against Postgres", () => {
  let t: TestDatabase | undefined;

  beforeAll(async () => {
    t = await createTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await t?.dispose();
  }, 60_000);

  /** A run of this prefix and status, created `minutesAgo` minutes ago. */
  async function seed(prefix: string, status: RunStatus, minutesAgo: number): Promise<void> {
    const run = await createRun(t!.db, {
      question: "How loved is Juniper Cola?",
      questionHash: `${prefix}${status}-${minutesAgo}`,
      status,
    });
    await t!.db.$client`update runs set created_at = now() - make_interval(secs => ${minutesAgo * 60}) where id = ${run.id}`;
  }

  it("lists the latest statuses of one kind of run, newest first, up to the limit", async () => {
    await seed("q1:", "completed", 30);
    await seed("q1:", "failed", 20);
    await seed("q1:", "incomplete", 10);
    await seed("q1:", "refused", 5);
    await seed("fake:", "cancelled", 1);
    await seed("cli:", "completed", 2);
    expect(await readRecentStatuses(t!.db, "q1:", 3)).toEqual(["refused", "incomplete", "failed"]);
    expect(await readRecentStatuses(t!.db, "fake:", 20)).toEqual(["cancelled"]);
    expect(await readRecentStatuses(t!.db, "none:", 20)).toEqual([]);
  });

  it("counts today's calls of one environment and those served without the network", async () => {
    const now = Date.now();
    const call = (env: string, cacheStatus: CacheStatus, msAgo: number) => ({
      env,
      cacheStatus,
      ts: new Date(now - msAgo),
      path: "/v2/insights",
      params: { "filter.type": "urn:entity:brand" },
    });
    await insertQlooCalls(t!.db, [
      call("prod", "miss", 1_000),
      call("prod", "stale", 2_000),
      call("prod", "hit", 3_000),
      call("prod", "reused", 4_000),
      call("prod", "coalesced", 5_000),
      call("dev", "hit", 1_000),
      // Before the window.
      call("prod", "hit", 3 * 3_600_000),
    ]);
    const since = new Date(now - 3_600_000);
    expect(await readQlooCache(t!.db, "prod", since)).toEqual({ total: 5, served: 3, sampled: false });
    expect(await readQlooCache(t!.db, "dev", since)).toEqual({ total: 1, served: 1, sampled: false });
    expect(await readQlooCache(t!.db, "mock", since)).toEqual({ total: 0, served: 0, sampled: false });
    // Past the row cap the count is over the latest calls only.
  });

  it("reads kv metro_localities' coverage of the map cities and the config markets: missing, then partial, by id and count only", async () => {
    // Every map city is a config market; the markets beyond them are share and slate cities.
    expect(CONFIG_MARKETS.length).toBeGreaterThan(MetroId.options.length);
    expect(MetroId.options.every((id) => CONFIG_MARKETS.includes(id))).toBe(true);
    expect(await readLocalityStatus(t!.db, LOCALITIES_KV_KEY)).toEqual({
      state: "missing",
      required: MetroId.options,
      missing: MetroId.options,
      pinned: 0,
      markets: { total: CONFIG_MARKETS.length, missing: CONFIG_MARKETS },
    });
    // The canary stands in for a locality id: the next test checks it never reaches the reading.
    await setKv(t!.db, "metro_localities", { nashville: { entityId: CANARY_REQUEST_ID, label: "Nashville" } });
    expect(await readLocalityStatus(t!.db, LOCALITIES_KV_KEY)).toEqual({
      state: "partial",
      required: MetroId.options,
      missing: MetroId.options.slice(1),
      pinned: 1,
      markets: { total: CONFIG_MARKETS.length, missing: CONFIG_MARKETS.filter((id) => id !== "nashville") },
    });
  });

  it("keeps the canaries in runs, call-log rows, the pins and the key out of the reading and the page", async () => {
    const run = await createRun(t!.db, { question: CANARY_QUESTION, questionHash: `q1:${CANARY_ENTITY}`, status: "completed" });
    await insertQlooCalls(t!.db, [
      {
        env: "prod",
        cacheStatus: "miss",
        path: "/v2/insights",
        params: { "filter.type": "urn:entity:brand", "filter.name": CANARY_ENTITY },
        requestId: CANARY_REQUEST_ID,
        runId: run.id,
        httpStatus: 200,
      },
    ]);

    // The real anthropicConfigured source, over a container that makes its client from the canary key.
    const g = globalThis as { __ctContainer?: unknown };
    const savedKey = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = CANARY_API_KEY;
    g.__ctContainer = {};
    try {
      const report = await readStatus(
        fakeSources({
          now: () => Date.now(),
          anthropicConfigured: defaultStatusSources().anthropicConfigured,
          recentStatuses: (prefix, limit) => readRecentStatuses(t!.db, prefix, limit),
          qlooCache: (env, since) => readQlooCache(t!.db, env, since),
          localities: () => readLocalityStatus(t!.db, LOCALITIES_KV_KEY),
        }),
      );
      // The planted rows were read: the newest live run, and today's prod calls.
      expect(report.llm.configured).toBe(true);
      expect(report.runs.recent.live?.[0]).toBe("completed");
      expect(report.qloo.configured && report.qloo.cache?.total).toBeGreaterThan(0);
      expect(report.localities?.state).toBe("partial");

      const json = JSON.stringify(report);
      const html = renderToStaticMarkup(<StatusView report={report} />);
      for (const canary of [CANARY_QUESTION, CANARY_ENTITY, CANARY_REQUEST_ID, CANARY_API_KEY]) {
        expect(json).not.toContain(canary);
        expect(html).not.toContain(canary);
      }
    } finally {
      delete g.__ctContainer;
      if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = savedKey;
    }
  });
});
