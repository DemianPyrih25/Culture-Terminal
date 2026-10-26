// Startup migrations against a database that is not there yet: the server keeps serving, keeps
// retrying in the background and reports 503 from /api/health until the schema is in place. And
// the SIGTERM handler's order: drain, flush the Qloo client's writes, close the pool, exit. And the
// housekeeping after migrations: old fake runs, old visitor hashes, and the market locality pins.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

vi.mock("server-only", () => ({}));

const fake = vi.hoisted(() => ({
  migrateUrl: vi.fn<() => Promise<void>>(),
  pingDb: vi.fn(async () => true),
  purgeRuns: vi.fn(async () => 0),
  clearIpHashes: vi.fn(async () => 0),
  closeDb: vi.fn(async () => {}),
  localitiesKey: "metro_localities",
  localities: undefined as unknown,
}));

vi.mock("@ct/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ct/db")>()),
  getDb: () => ({}),
  migrateUrl: fake.migrateUrl,
  pingDb: fake.pingDb,
  purgeRuns: fake.purgeRuns,
  clearIpHashes: fake.clearIpHashes,
  closeDb: fake.closeDb,
  // Only the locality pins are answered here; any other key reads as unset.
  getKv: async (_db: unknown, key: string) => (key === fake.localitiesKey ? fake.localities : undefined),
}));

const { afterMigrations, HOUSEKEEPING_EVERY_MS, installShutdownHandler, migrationsApplied, startServer } = await import("../server/startup");
const { log } = await import("../server/log");
const { health } = await import("../server/http");

const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" });
const FLAGS = ["__ctServerStarted", "__ctMigrationsApplied", "__ctContainer", "__ctHousekeeping"] as const;

let sigtermBefore: ((...args: unknown[]) => void)[] = [];

beforeEach(() => {
  for (const key of FLAGS) delete (globalThis as Record<string, unknown>)[key];
  fake.migrateUrl.mockReset();
  fake.purgeRuns.mockClear();
  fake.clearIpHashes.mockClear();
  fake.localitiesKey = "metro_localities";
  fake.localities = undefined;
  vi.stubEnv("NODE_ENV", "production");
  // Live Qloo data, whatever the shell exports: QLOO_MOCK=1 reads the mock pins (the last housekeeping test).
  vi.stubEnv("QLOO_MOCK", "");
  vi.stubEnv("RUN_MIGRATIONS", "");
  // Production requires DATABASE_URL; the mocked migrateUrl never connects to it.
  vi.stubEnv("DATABASE_URL", "postgres://ct:ct@db.invalid:5432/culture_terminal");
  vi.stubEnv("MIGRATIONS_DIR", fileURLToPath(new URL("../../../packages/db/drizzle", import.meta.url)));
  sigtermBefore = process.listeners("SIGTERM") as typeof sigtermBefore;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const listener of process.listeners("SIGTERM")) {
    if (!sigtermBefore.includes(listener as (typeof sigtermBefore)[number])) process.removeListener("SIGTERM", listener);
  }
  for (const key of FLAGS) delete (globalThis as Record<string, unknown>)[key];
});

async function healthBody(): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await health();
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("startServer migrations", () => {
  it("keeps retrying in the background after startup gives up, and health is 503 until they apply", async () => {
    for (let i = 0; i < 6; i++) fake.migrateUrl.mockRejectedValueOnce(refused());
    fake.migrateUrl.mockResolvedValue(undefined);

    const started = startServer();
    await vi.advanceTimersByTimeAsync(4 * 2000);
    await expect(started).resolves.toBeUndefined();
    expect(fake.migrateUrl).toHaveBeenCalledTimes(5);
    expect(migrationsApplied()).toBe(false);
    expect(await healthBody()).toMatchObject({ status: 503, body: { ok: false, db: { ok: true }, migrations: false } });

    // First background retry after 5 s: still refused, so the next waits 10 s.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.migrateUrl).toHaveBeenCalledTimes(6);
    expect(migrationsApplied()).toBe(false);
    await vi.advanceTimersByTimeAsync(9000);
    expect(fake.migrateUrl).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.migrateUrl).toHaveBeenCalledTimes(7);

    expect(migrationsApplied()).toBe(true);
    expect(fake.purgeRuns).toHaveBeenCalledTimes(1);
    expect(await healthBody()).toMatchObject({ status: 200, body: { ok: true, migrations: true } });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(fake.migrateUrl).toHaveBeenCalledTimes(7);
  });

  it("applies at once when the database is up, then purges old fake runs", async () => {
    fake.migrateUrl.mockResolvedValue(undefined);
    await startServer();
    expect(fake.migrateUrl).toHaveBeenCalledTimes(1);
    expect(migrationsApplied()).toBe(true);
    expect(fake.purgeRuns).toHaveBeenCalledTimes(1);
    expect((await healthBody()).status).toBe(200);
  });

  it("stops retrying at an error that is not about reaching the database", async () => {
    for (let i = 0; i < 5; i++) fake.migrateUrl.mockRejectedValueOnce(refused());
    fake.migrateUrl.mockRejectedValueOnce(Object.assign(new Error("syntax error"), { code: "42601" }));
    fake.migrateUrl.mockResolvedValue(undefined);

    const started = startServer();
    await vi.advanceTimersByTimeAsync(4 * 2000);
    await started;
    await vi.advanceTimersByTimeAsync(5000);
    expect(fake.migrateUrl).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fake.migrateUrl).toHaveBeenCalledTimes(6);
    expect((await healthBody()).body).toMatchObject({ ok: false, migrations: false });
  });

  it("does not wait for migrations when RUN_MIGRATIONS=0", async () => {
    vi.stubEnv("RUN_MIGRATIONS", "0");
    await startServer();
    expect(fake.migrateUrl).not.toHaveBeenCalled();
    expect(migrationsApplied()).toBe(true);
    expect(await healthBody()).toMatchObject({ status: 200, body: { ok: true, migrations: true } });
  });
});

describe("housekeeping after migrations", () => {
  it("purges old fake runs, clears old visitor hashes and says when the locality pins are missing", async () => {
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      afterMigrations();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.purgeRuns).toHaveBeenCalledTimes(1);
      expect(fake.clearIpHashes).toHaveBeenCalledWith(expect.anything(), { olderThanMs: 25 * 3_600_000 });
      const lines = warn.mock.calls.map((call) => JSON.stringify(call));
      expect(lines.filter((line) => line.includes("metro_localities"))).toEqual([
        expect.stringContaining('"missing":["nashville","austin"]'),
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it("clears old visitor hashes every hour after that, with no live run starting, on one timer per process", async () => {
    expect(HOUSEKEEPING_EVERY_MS).toBe(3_600_000);
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      afterMigrations();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.clearIpHashes).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(HOUSEKEEPING_EVERY_MS - 1);
      expect(fake.clearIpHashes).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.clearIpHashes).toHaveBeenCalledTimes(2);
      expect(fake.purgeRuns).toHaveBeenCalledTimes(2);
      // A second pass (the background migration retry) sweeps at once but adds no second timer.
      afterMigrations();
      await vi.advanceTimersByTimeAsync(0);
      expect(fake.clearIpHashes).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(HOUSEKEEPING_EVERY_MS);
      expect(fake.clearIpHashes).toHaveBeenCalledTimes(4);
      expect(fake.clearIpHashes).toHaveBeenLastCalledWith(expect.anything(), { olderThanMs: 25 * 3_600_000 });
    } finally {
      warn.mockRestore();
    }
  });

  it("names only the unpinned markets of a partial value, never a locality id", async () => {
    fake.localities = { nashville: { entityId: "invented-locality-0001", label: "Nashville" } };
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      afterMigrations();
      await vi.advanceTimersByTimeAsync(0);
      const lines = warn.mock.calls.map((call) => JSON.stringify(call)).filter((line) => line.includes("metro_localities"));
      expect(lines).toEqual([expect.stringContaining('"missing":["austin"]')]);
      expect(lines.join(" ")).not.toContain("invented-locality");
    } finally {
      warn.mockRestore();
    }
  });

  it("reads the mock pins on synthetic Qloo data, as the mock dev server runs", async () => {
    vi.stubEnv("QLOO_MOCK", "1");
    fake.localitiesKey = "metro_localities.mock";
    fake.localities = { nashville: { entityId: "invented-locality-0001", label: "Nashville" } };
    const warn = vi.spyOn(log, "warn").mockImplementation(() => undefined);
    try {
      afterMigrations();
      await vi.advanceTimersByTimeAsync(0);
      const lines = warn.mock.calls.map((call) => JSON.stringify(call)).filter((line) => line.includes("metro_localities"));
      expect(lines).toEqual([expect.stringMatching(/"key":"metro_localities\.mock".*"missing":\["austin"\]/)]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("SIGTERM", () => {
  const steps: string[] = [];
  let exit: MockInstance<typeof process.exit>;

  beforeEach(() => {
    steps.length = 0;
    vi.stubEnv("NEXT_MANUAL_SIG_HANDLE", "true");
    fake.closeDb.mockImplementation(async () => void steps.push("closeDb"));
    exit = vi.spyOn(process, "exit").mockImplementation((() => void steps.push("exit")) as never);
  });

  afterEach(() => {
    exit.mockRestore();
    fake.closeDb.mockReset();
  });

  /** Installs the handler and fires it, as a redeploy does, with this process container. */
  function sigterm(container: Record<string, unknown>): void {
    (globalThis as Record<string, unknown>).__ctContainer = container;
    installShutdownHandler();
    const handler = process.listeners("SIGTERM").find((l) => !sigtermBefore.includes(l as (typeof sigtermBefore)[number]));
    if (!handler) throw new Error("no SIGTERM handler was installed");
    handler("SIGTERM");
  }

  it("flushes the Qloo client's background writes after the drain and before the pool closes", async () => {
    sigterm({ qloo: { flush: async () => void steps.push("flush") } });
    await vi.advanceTimersByTimeAsync(0);
    expect(steps).toEqual(["flush", "closeDb", "exit"]);
  });

  it("gives up on a flush that hangs after three seconds", async () => {
    sigterm({ qloo: { flush: () => new Promise<void>(() => {}) } });
    await vi.advanceTimersByTimeAsync(2900);
    expect(steps).toEqual([]);
    await vi.advanceTimersByTimeAsync(100);
    expect(steps).toEqual(["closeDb", "exit"]);
  });

  it("creates no Qloo client just to flush it", async () => {
    const container: Record<string, unknown> = {};
    sigterm(container);
    await vi.advanceTimersByTimeAsync(0);
    expect(steps).toEqual(["closeDb", "exit"]);
    expect(container.qloo).toBeUndefined();
  });
});
