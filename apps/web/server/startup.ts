import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import { closeDb, getKv, isConnectionError, migrateUrl, resolveDatabaseUrl, type Queryable } from "@ct/db";
import { audienceCatalogueKvKey, readAudienceCatalogue, resolveQlooEnv } from "@ct/qloo";
import { shutdownGraceMsFromEnv } from "./config";
import { getDatabase, getRunManager, peekPublicDataClient, peekQlooClient } from "./container";
import { logLocalityCoverage, readLocalityCoverage } from "./localities";
import { log } from "./log";

const STARTED = "__ctServerStarted";
const MIGRATED = "__ctMigrationsApplied";
const SWEEPING = "__ctHousekeeping";
type GlobalWithFlags = typeof globalThis & {
  [STARTED]?: boolean;
  [MIGRATED]?: boolean;
  [SWEEPING]?: ReturnType<typeof setInterval>;
};

/** Background migration retries after startup gave up: 5 s, doubling, then every minute. */
const RETRY_FIRST_MS = 5000;
const RETRY_MAX_MS = 60_000;
/**
 * SIGTERM waits at most this long for the Qloo client's background writes. With the drain
 * (SHUTDOWN_GRACE_MS plus an agent's stop grace) and closing the pool, it stays inside Render's 200 s shutdown delay.
 */
const QLOO_FLUSH_MS = 3000;
/**
 * The housekeeping after migrations runs again this often while the process lives, so old visitor
 * hashes are cleared within an hour of leaving every window even when no live run starts (replay
 * only after judging).
 */
export const HOUSEKEEPING_EVERY_MS = 3_600_000;

/**
 * Whether this process may serve requests that touch the schema: its migrations ran, or
 * RUN_MIGRATIONS=0 leaves the schema to someone else. /api/health answers 503 until then.
 */
export function migrationsApplied(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RUN_MIGRATIONS === "0" || (globalThis as GlobalWithFlags)[MIGRATED] === true;
}

/**
 * Where the Drizzle migrations live. The bundled server cannot find them next to @ct/db's source,
 * so: MIGRATIONS_DIR (the Docker image sets it), else the repository layout seen from the working
 * directory (repo root, or apps/web under `pnpm --filter web start`).
 */
// The turbopackIgnore hints keep the build's file tracer from copying the whole repository into
// the standalone output; the Dockerfile copies the migrations folder itself.
export function resolveMigrationsDir(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string | null {
  const candidates = [
    env.MIGRATIONS_DIR?.trim() || null,
    path.join(/*turbopackIgnore: true*/ cwd, "packages", "db", "drizzle"),
    path.join(/*turbopackIgnore: true*/ cwd, "..", "..", "packages", "db", "drizzle"),
  ];
  for (const dir of candidates) {
    if (dir && existsSync(path.join(/*turbopackIgnore: true*/ dir, "meta", "_journal.json"))) {
      return path.resolve(/*turbopackIgnore: true*/ dir);
    }
  }
  return null;
}

async function migrateOnce(): Promise<void> {
  const folder = resolveMigrationsDir();
  if (!folder) throw new Error("Drizzle migrations not found; set MIGRATIONS_DIR.");
  // Its own short-lived pool with no statement timeout: waiting for another instance's migration
  // lock or a long DDL statement must not hit the app pool's 30 s limit.
  await migrateUrl(resolveDatabaseUrl().url, folder);
  (globalThis as GlobalWithFlags)[MIGRATED] = true;
  log.info({ folder }, "database migrations applied");
}

async function migrate(): Promise<void> {
  const attempts = 5;
  for (let attempt = 1; ; attempt++) {
    try {
      await migrateOnce();
      return;
    } catch (err) {
      // A database that is still starting is worth waiting for; anything else is not.
      if (!isConnectionError(err) || attempt >= attempts) throw err;
      log.warn({ attempt }, "database not reachable yet; retrying migrations");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
}

/**
 * Keeps trying after startup gave up on an unreachable database, so a database that comes back
 * later still gets its schema without a restart. Stops at the first error that is not about reaching
 * the database: that one needs a person.
 */
function retryMigrationsInBackground(delayMs: number = RETRY_FIRST_MS): void {
  const timer = setTimeout(() => {
    void (async () => {
      try {
        await migrateOnce();
        afterMigrations();
      } catch (err) {
        if (!isConnectionError(err)) {
          log.error({ err }, "database migrations failed; not retrying");
          return;
        }
        const next = Math.min(delayMs * 2, RETRY_MAX_MS);
        log.warn({ retryInMs: next }, "database still not reachable; will retry migrations");
        retryMigrationsInBackground(next);
      }
    })();
  }, delayMs);
  // Retries alone must not keep a shutting-down process alive.
  (timer as { unref?: () => void }).unref?.();
}

/** Drops fake runs past their retention and clears visitor hashes past the per-visitor windows. */
function sweep(): void {
  try {
    const runs = getRunManager();
    void runs.purgeFakeRuns().catch((err: unknown) => log.warn({ err }, "fake run purge failed"));
    void runs.forgetVisitors().catch((err: unknown) => log.warn({ err }, "clearing old visitor hashes failed"));
  } catch (err) {
    log.warn({ err }, "fake run purge skipped");
  }
}

/** The sweep every HOUSEKEEPING_EVERY_MS: one timer per process, which never keeps it alive. */
function sweepEveryHour(): void {
  const g = globalThis as GlobalWithFlags;
  if (g[SWEEPING] !== undefined) return;
  const timer = setInterval(sweep, HOUSEKEEPING_EVERY_MS);
  (timer as { unref?: () => void }).unref?.();
  g[SWEEPING] = timer;
}

/**
 * Says in the log when the pinned audience catalogue (D21, tools/dev/audiences.ts pin) is missing or
 * malformed: every run then offers no AUDIENCES and refuses every audience context, with no other sign.
 */
export async function checkAudienceCatalogue(db: Queryable, key: string = audienceCatalogueKvKey(resolveQlooEnv(process.env))): Promise<void> {
  const read = readAudienceCatalogue(await getKv(db, key));
  const effect = "runs offer no audience segments and refuse every audience context";
  if (read.state === "missing") log.warn({ key }, `kv "${key}" is not set: ${effect}`);
  else if (read.state === "malformed") log.error({ key }, `kv "${key}" is malformed: ${effect}`);
  else if (read.segments.length === 0) log.warn({ key }, `kv "${key}" holds no usable segment: ${effect}`);
}

/**
 * Housekeeping that needs the schema: drop fake runs past their retention and clear visitor hashes
 * past the per-visitor windows, now and every hour after, and say in the log when the market
 * locality pins are missing or partial, or the audience catalogue is not pinned.
 */
export function afterMigrations(): void {
  sweep();
  sweepEveryHour();
  try {
    void readLocalityCoverage(getDatabase())
      .then((coverage) => logLocalityCoverage(coverage, { at: "startup" }))
      .catch((err: unknown) => log.warn({ err }, "the market locality pins could not be read"));
  } catch (err) {
    log.warn({ err }, "the market locality check skipped");
  }
  try {
    void checkAudienceCatalogue(getDatabase()).catch((err: unknown) => log.warn({ err }, "the audience catalogue could not be read"));
  } catch (err) {
    log.warn({ err }, "the audience catalogue check skipped");
  }
}

/**
 * Waits for the Qloo client's background writes (the quota snapshot, call-log rows, shared cache
 * entries and counters), at most QLOO_FLUSH_MS. A process that never made a client has none to flush.
 */
async function flushQloo(): Promise<void> {
  const qloo = peekQlooClient();
  if (!qloo) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), QLOO_FLUSH_MS);
  });
  try {
    const outcome = await Promise.race([qloo.flush().then(() => "flushed" as const), deadline]);
    if (outcome === "deadline") log.warn({ waitedMs: QLOO_FLUSH_MS }, "SIGTERM: Qloo writes still pending; going on without them");
  } catch (err) {
    log.warn({ err }, "SIGTERM: the Qloo flush failed");
  } finally {
    clearTimeout(timer);
  }
}

/** The same for the SEC and Census client (call-log rows and shared cache entries), at most QLOO_FLUSH_MS. */
async function flushPublicData(): Promise<void> {
  const client = peekPublicDataClient();
  if (!client) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), QLOO_FLUSH_MS);
  });
  try {
    const outcome = await Promise.race([client.flush().then(() => "flushed" as const), deadline]);
    if (outcome === "deadline") log.warn({ waitedMs: QLOO_FLUSH_MS }, "SIGTERM: public-data writes still pending; going on without them");
  } catch (err) {
    log.warn({ err }, "SIGTERM: the public-data flush failed");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * SIGTERM (a Render redeploy): refuse new runs at once, give active runs the grace period, then
 * mark the rest incomplete, and let the Qloo client finish its writes. With NEXT_MANUAL_SIG_HANDLE
 * set, Next.js leaves the signal to us and we close the pool and exit after that; otherwise Next.js
 * exits when its open connections close, and any run cut short there is finalized as an orphan by
 * the next viewer's database tail.
 */
export function installShutdownHandler(): void {
  process.once("SIGTERM", () => {
    void (async () => {
      const runs = getRunManager();
      runs.beginShutdown();
      log.info({ active: runs.activeCount() }, "SIGTERM: not accepting new runs; draining");
      try {
        const result = await runs.drain(shutdownGraceMsFromEnv());
        log.info(result, "drain finished");
      } catch (err) {
        log.error({ err }, "drain failed");
      }
      // Before the pool closes: the quota snapshot is otherwise written at most every 5 s.
      await Promise.all([flushQloo(), flushPublicData()]);
      if (process.env.NEXT_MANUAL_SIG_HANDLE) {
        await closeDb().catch(() => undefined);
        process.exit(0);
      }
    })();
  });
}

/** Called once per server process from instrumentation.ts. */
export async function startServer(): Promise<void> {
  const g = globalThis as GlobalWithFlags;
  if (g[STARTED]) return;
  g[STARTED] = true;

  installShutdownHandler();

  if (process.env.RUN_MIGRATIONS === "0") {
    log.info("migrations skipped (RUN_MIGRATIONS=0)");
    afterMigrations();
    return;
  }
  try {
    await migrate();
    afterMigrations();
  } catch (err) {
    // Unreachable database: keep serving so /api/health can say so (503) and keep retrying in the
    // background. A failing migration against a reachable database in production must not serve
    // on a half-applied schema.
    if (process.env.NODE_ENV === "production" && !isConnectionError(err)) throw err;
    log.error({ err }, "database migrations did not run");
    if (isConnectionError(err)) retryMigrationsInBackground();
  }
}
