import path from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb, type Db, getDb } from "./client";

// Arbitrary constant shared by every process that migrates this database. Parallel dev agents
// and overlapping deploys can both run `pnpm db:migrate`; the lock makes the second one a no-op.
export const MIGRATION_LOCK_KEY = 0x43_54_44_42; // "CTDB"

/**
 * The package's drizzle/ folder. Derived from this file's path rather than with
 * `new URL("../drizzle", import.meta.url)`, which bundlers treat as an asset import.
 */
export function defaultMigrationsFolder(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "drizzle");
}

/** MIGRATIONS_DIR (e.g. inside a container image) wins over the package's own folder. */
export function resolveMigrationsFolder(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.MIGRATIONS_DIR?.trim();
  return fromEnv ? path.resolve(fromEnv) : defaultMigrationsFolder();
}

/**
 * Applies pending migrations under a session advisory lock. The lock holds one pooled
 * connection while the migrator uses another, so the pool needs at least two connections.
 * Prefer {@link migrateUrl}: on the app pool, its statement timeout also cuts off the lock wait.
 */
export async function runMigrations(db: Db = getDb(), folder: string = resolveMigrationsFolder()): Promise<void> {
  const max = db.$client.options.max;
  if (typeof max === "number" && max < 2) {
    throw new Error("runMigrations needs a pool of at least 2 connections (one holds the migration lock).");
  }
  const lock = await db.$client.reserve();
  try {
    await lock`select pg_advisory_lock(${MIGRATION_LOCK_KEY})`;
    await migrate(db, { migrationsFolder: folder });
  } finally {
    // If the connection died, the session lock died with it, so an unlock failure is harmless
    // and must not hide the migration error.
    await lock`select pg_advisory_unlock(${MIGRATION_LOCK_KEY})`.catch(() => undefined);
    lock.release();
  }
}

/**
 * A pool for migrations only: two connections (one holds the lock) and no statement timeout, so
 * a long DDL statement or a wait for another migrator's lock never hits the app pool's 30 s limit.
 */
export function createMigrationDb(url: string): Db {
  return createDb(url, { max: 2, statementTimeoutMs: 0, applicationName: "culture-terminal-migrate" });
}

/**
 * Applies pending migrations to the database at `url` on its own {@link createMigrationDb} pool,
 * closed afterwards. Used by `pnpm db:migrate` and by the server on startup.
 */
export async function migrateUrl(url: string, folder: string = resolveMigrationsFolder()): Promise<void> {
  const db = createMigrationDb(url);
  try {
    await runMigrations(db, folder);
  } finally {
    await db.$client.end({ timeout: 5 });
  }
}
