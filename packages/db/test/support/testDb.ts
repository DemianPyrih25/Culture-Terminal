// Integration-test database: a throwaway database per test file, created on the server named by
// DATABASE_URL (or the docker-compose default) and dropped afterwards. A separate database rather
// than a schema, because drizzle-kit writes foreign keys against "public".
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import { createDb, type Db, DEV_DATABASE_URL, isConnectionError } from "../../src/client";
import { runMigrations } from "../../src/migrate";

const explicitUrl = process.env.DATABASE_URL?.trim() || undefined;
const adminUrl = explicitUrl ?? DEV_DATABASE_URL;

// In CI with DATABASE_URL set the service must be up: skipping there would hide a broken pipeline.
const required = Boolean(process.env.CI) && explicitUrl !== undefined;

// A server answered on the compose default address but it is not the compose database
// (another local Postgres owns the port): treat as "compose database not running".
const NOT_THE_COMPOSE_DB = new Set(["28P01", "28000", "3D000"]);

function codeOf(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** Whether a probe failure means "no database to test against" (skip) rather than a real fault. */
export function isSkippableProbeError(err: unknown, usingDefaultUrl: boolean): boolean {
  if (isConnectionError(err)) return true;
  const code = codeOf(err);
  return usingDefaultUrl && code !== undefined && NOT_THE_COMPOSE_DB.has(code);
}

/** Replaces the database name in a Postgres URL, keeping credentials, host and query options. */
export function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

export type ProbeResult = { ok: true } | { ok: false; reason: string };

/** Checks once whether the target server is reachable. Throws for faults that are not "unreachable". */
export async function probeTestDatabase(): Promise<ProbeResult> {
  const sql = postgres(adminUrl, { max: 1, connect_timeout: 3, onnotice: () => {} });
  try {
    await sql`select 1`;
    return { ok: true };
  } catch (err) {
    if (required || !isSkippableProbeError(err, explicitUrl === undefined)) throw err;
    const where = explicitUrl === undefined ? "the docker-compose default (DATABASE_URL unset)" : "DATABASE_URL";
    const reason = `database at ${where} is unreachable (${codeOf(err) ?? "unknown error"})`;
    console.warn(`[@ct/db] skipping integration tests: ${reason}. Start it with \`pnpm db:up\`.`);
    return { ok: false, reason };
  } finally {
    await sql.end({ timeout: 2 });
  }
}

export interface TestDatabase {
  db: Db;
  url: string;
  name: string;
  dispose(): Promise<void>;
}

async function admin<T>(fn: (sql: postgres.Sql) => Promise<T>): Promise<T> {
  const sql = postgres(adminUrl, { max: 1, connect_timeout: 5, onnotice: () => {} });
  try {
    return await fn(sql);
  } finally {
    await sql.end({ timeout: 2 });
  }
}

/** Creates an empty database (migrated unless `migrate: false`) and a pool on it. */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const name = `ct_test_${process.pid}_${randomBytes(4).toString("hex")}`;
  await admin((sql) => sql.unsafe(`create database "${name}"`));
  const url = withDatabase(adminUrl, name);
  const db = createDb(url, { max: 4, applicationName: "ct-db-test" });
  const dispose = async () => {
    await db.$client.end({ timeout: 5 });
    await admin((sql) => sql.unsafe(`drop database if exists "${name}" with (force)`));
  };
  try {
    if (options.migrate !== false) await runMigrations(db);
  } catch (err) {
    await dispose();
    throw err;
  }
  return { db, url, name, dispose };
}

/** The Postgres SQLSTATE behind a (possibly drizzle-wrapped) error. */
export function pgCode(err: unknown): string | undefined {
  let cur: unknown = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    const code = codeOf(cur);
    if (code) return code;
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}
