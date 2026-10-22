import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";
import { closeDb, isConnectionError, migrateUrl, resolveDatabaseUrl } from "@ct/db";
import { shutdownGraceMsFromEnv } from "./config";
import { getRunManager } from "./container";
import { log } from "./log";

const STARTED = "__ctServerStarted";
const MIGRATED = "__ctMigrationsApplied";
type GlobalWithFlags = typeof globalThis & { [STARTED]?: boolean; [MIGRATED]?: boolean };

/** Background migration retries after startup gave up: 5 s, doubling, then every minute. */
const RETRY_FIRST_MS = 5000;
const RETRY_MAX_MS = 60_000;

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

/** Housekeeping that needs the schema: drop fake runs past their retention. */
function afterMigrations(): void {
  try {
    void getRunManager()
      .purgeFakeRuns()
      .catch((err: unknown) => log.warn({ err }, "fake run purge failed"));
  } catch (err) {
    log.warn({ err }, "fake run purge skipped");
  }
}

/**
 * SIGTERM (a Railway redeploy): refuse new runs at once, give active runs the grace period, then
 * mark the rest incomplete. With NEXT_MANUAL_SIG_HANDLE set, Next.js leaves the signal to us and we
 * exit once the drain is done; otherwise Next.js exits when its open connections close, and any run
 * cut short there is finalized as an orphan by the next viewer's database tail.
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
