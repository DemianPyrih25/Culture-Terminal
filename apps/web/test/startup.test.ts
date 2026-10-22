// Startup migrations against a database that is not there yet: the server keeps serving, keeps
// retrying in the background and reports 503 from /api/health until the schema is in place.
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const fake = vi.hoisted(() => ({
  migrateUrl: vi.fn<() => Promise<void>>(),
  pingDb: vi.fn(async () => true),
  purgeRuns: vi.fn(async () => 0),
}));

vi.mock("@ct/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ct/db")>()),
  getDb: () => ({}),
  migrateUrl: fake.migrateUrl,
  pingDb: fake.pingDb,
  purgeRuns: fake.purgeRuns,
}));

const { migrationsApplied, startServer } = await import("../server/startup");
const { health } = await import("../server/http");

const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5433"), { code: "ECONNREFUSED" });
const FLAGS = ["__ctServerStarted", "__ctMigrationsApplied", "__ctContainer"] as const;

let sigtermBefore: ((...args: unknown[]) => void)[] = [];

beforeEach(() => {
  for (const key of FLAGS) delete (globalThis as Record<string, unknown>)[key];
  fake.migrateUrl.mockReset();
  fake.purgeRuns.mockClear();
  vi.stubEnv("NODE_ENV", "production");
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
