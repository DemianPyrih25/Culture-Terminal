// A throwaway, migrated database per test file on the server named by DATABASE_URL (or the
// docker-compose default). Integration tests skip only when no database is reachable.
import { randomBytes } from "node:crypto";
import { createDb, DEV_DATABASE_URL, isConnectionError, runMigrations, type Db } from "@ct/db";

const explicitUrl = process.env.DATABASE_URL?.trim() || undefined;
const adminUrl = explicitUrl ?? DEV_DATABASE_URL;
// In CI with DATABASE_URL set the database must be up: skipping there would hide a broken pipeline.
const required = Boolean(process.env.CI) && explicitUrl !== undefined;
// On the default URL, a server that rejects our credentials or database is not the compose database.
const NOT_THE_COMPOSE_DB = new Set(["28P01", "28000", "3D000"]);

function codeOf(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

async function admin<T>(fn: (db: Db) => Promise<T>, connectTimeoutSec = 5): Promise<T> {
  const db = createDb(adminUrl, { max: 1, connectTimeoutSec, applicationName: "ct-web-test-admin" });
  try {
    return await fn(db);
  } finally {
    await db.$client.end({ timeout: 2 });
  }
}

export async function databaseAvailable(): Promise<boolean> {
  try {
    await admin((db) => db.$client`select 1`, 3);
    return true;
  } catch (err) {
    const skippable =
      isConnectionError(err) || (explicitUrl === undefined && NOT_THE_COMPOSE_DB.has(codeOf(err) ?? ""));
    if (required || !skippable) throw err;
    console.warn(`[web] skipping integration tests: no database (${codeOf(err) ?? "unknown"}). Run \`pnpm db:up\`.`);
    return false;
  }
}

export interface TestDatabase {
  db: Db;
  /** For a second pool on the same database, like another server instance. */
  url: string;
  dispose(): Promise<void>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `ct_web_test_${process.pid}_${randomBytes(4).toString("hex")}`;
  await admin((db) => db.$client.unsafe(`create database "${name}"`));
  const target = new URL(adminUrl);
  target.pathname = `/${name}`;
  const url = target.toString();
  const db = createDb(url, { max: 8, applicationName: "ct-web-test" });
  const dispose = async () => {
    await db.$client.end({ timeout: 5 });
    await admin((a) => a.$client.unsafe(`drop database if exists "${name}" with (force)`));
  };
  try {
    await runMigrations(db);
  } catch (err) {
    await dispose();
    throw err;
  }
  return { db, url, dispose };
}
