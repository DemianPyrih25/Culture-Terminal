import { sql } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import { drizzle, type PostgresJsDatabase, type PostgresJsQueryResultHKT } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";

export type Schema = typeof schema;

/** A database handle created by {@link createDb}; `$client` is the underlying postgres.js pool. */
export type Db = PostgresJsDatabase<Schema> & { $client: Sql };

/** Anything repos can query through: a {@link Db} or a transaction opened on one. */
export type Queryable = PgDatabase<PostgresJsQueryResultHKT, Schema>;

/** The docker-compose database (`pnpm db:up`), used in development when DATABASE_URL is unset. */
export const DEV_DATABASE_URL = "postgres://ct:ct@localhost:5433/culture_terminal";

export interface DbOptions {
  /** Pool size. Railway Hobby Postgres allows ~100 connections; one web instance needs few. */
  max?: number;
  /** Per-statement timeout in ms; 0 disables it (the migrator uses 0). */
  statementTimeoutMs?: number;
  /** Seconds to wait for a TCP connection before failing. */
  connectTimeoutSec?: number;
  applicationName?: string;
}

export function createDb(url: string, options: DbOptions = {}): Db {
  const client = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: 30,
    connect_timeout: options.connectTimeoutSec ?? 10,
    // Recycle connections so a failover or a long-lived process never pins a stale backend.
    max_lifetime: 60 * 30,
    // postgres.js prints NOTICEs by default; the migrator's "already exists" notices are noise.
    onnotice: () => {},
    connection: {
      application_name: options.applicationName ?? "culture-terminal",
      statement_timeout: options.statementTimeoutMs ?? 30_000,
      // A crashed handler must not leave a transaction holding locks.
      idle_in_transaction_session_timeout: 60_000,
    },
  });
  return drizzle(client, { schema });
}

export interface ResolvedDatabaseUrl {
  url: string;
  /** True when DATABASE_URL was unset and the docker-compose default is used. */
  isDefault: boolean;
}

export function resolveDatabaseUrl(env: NodeJS.ProcessEnv = process.env): ResolvedDatabaseUrl {
  const url = env.DATABASE_URL?.trim();
  if (url) return { url, isDefault: false };
  if (env.NODE_ENV === "production") {
    throw new Error("DATABASE_URL is not set. It is required in production.");
  }
  return { url: DEV_DATABASE_URL, isDefault: true };
}

// The singleton lives on globalThis so Next.js dev reloads reuse one pool instead of leaking one per reload.
type DbGlobal = typeof globalThis & { __ctDb?: { db?: Db; warnedDefault?: boolean } };
const state = ((globalThis as DbGlobal).__ctDb ??= {});

export function warnDefaultUrlOnce(): void {
  if (state.warnedDefault) return;
  state.warnedDefault = true;
  process.stderr.write(
    "[@ct/db] DATABASE_URL is not set; using the docker-compose database at localhost:5433/culture_terminal (start it with `pnpm db:up`).\n",
  );
}

/** The process-wide database, created on first use from DATABASE_URL. */
export function getDb(): Db {
  if (!state.db) {
    const { url, isDefault } = resolveDatabaseUrl();
    if (isDefault) warnDefaultUrlOnce();
    state.db = createDb(url);
  }
  return state.db;
}

/** Closes the process-wide pool (graceful shutdown). Safe to call when no pool was opened. */
export async function closeDb(timeoutSec = 5): Promise<void> {
  const db = state.db;
  state.db = undefined;
  if (db) await db.$client.end({ timeout: timeoutSec });
}

/** True when the database answers a trivial query. For health checks; never throws. */
export async function pingDb(db: Queryable): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

// Node and postgres.js codes for "could not reach a server", as opposed to a server that answered
// with an error (bad credentials, missing database, failed query).
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ETIMEDOUT",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
  "CONNECTION_DESTROYED",
  // "the database system is starting up"
  "57P03",
]);

/** True when an error means the server could not be reached at all. */
export function isConnectionError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && CONNECTION_ERROR_CODES.has(code)) return true;
  // Node reports dual-stack (IPv4 + IPv6) connect failures as an AggregateError.
  if (err instanceof AggregateError) return err.errors.some(isConnectionError);
  const cause = (err as { cause?: unknown }).cause;
  return cause !== undefined && cause !== err && isConnectionError(cause);
}
