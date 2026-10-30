// The Qloo client for the dev CLIs: options from the environment (QLOO_MOCK, QLOO_TAG, QLOO_TAG_CAP,
// QLOO_RPS), over the shared Postgres cache by default so repeated commands are served from it and
// every network call counts against the tag's cap like any other dev agent. Live Qloo always goes
// through that cache: a memory store would start the tag's count at 0 in every process and
// re-fetch what earlier runs already have, so --memory is for synthetic data only. The SEC and Census
// client (@ct/publicdata) is opened beside it over the same kind of store: QLOO_MOCK=1 mocks it too.
import { closeDb, getDb, pingDb, resolveDatabaseUrl } from "@ct/db";
import {
  createMemoryQlooStore,
  createPgQlooStore,
  createQlooClient,
  qlooClientOptionsFromEnv,
  resolveQlooEnv,
  type QlooClient,
  type QlooEnv,
  type QlooLogger,
  type QlooStore,
} from "@ct/qloo";
import {
  createMemoryPublicStore,
  createPgPublicStore,
  createPublicDataClient,
  publicDataOptionsFromEnv,
  type PublicDataClient,
  type PublicStore,
} from "@ct/publicdata";

/** A failure the CLI reports as a plain message with exit code 1 (no stack trace). */
export class CliError extends Error {
  override readonly name = "CliError";
}

export interface CliQlooOptions {
  env: NodeJS.ProcessEnv;
  /** Forces QLOO_MOCK=1: synthetic data, no key, no network. */
  mock: boolean;
  /** Overrides QLOO_TAG. */
  tag: string | null;
  /**
   * "pg": the shared Postgres cache; "memory": nothing persists, synthetic data only; or a store the
   * caller built (tests).
   */
  store: "pg" | "memory" | QlooStore;
  logger: QlooLogger;
  /** Replaces the live transport's fetch (tests). */
  fetch?: typeof fetch;
}

export interface CliQloo {
  client: QlooClient;
  /**
   * The SEC EDGAR and US Census client, or null when it could not be built (a malformed SEC_USER_AGENT):
   * company_financials and area_economics then answer unavailable. Without SEC_USER_AGENT or
   * CENSUS_API_KEY it exists but that source reports not configured.
   */
  publicdata: PublicDataClient | null;
  store: QlooStore;
  /** Where the cache lives, for the header line. */
  storeLabel: string;
  tag: string;
  tagCap: number | null;
  /** Waits for every background write (call log, cache rows, quota), then closes the pool if this opened it. */
  close(): Promise<void>;
}

/** The database location without credentials, e.g. "localhost:5433/culture_terminal". */
export function describeDatabase(env: NodeJS.ProcessEnv): string {
  const { url } = resolveDatabaseUrl(env);
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return "(unparseable DATABASE_URL)";
  }
}

export function cliQlooEnv(options: Pick<CliQlooOptions, "env" | "mock" | "tag">): NodeJS.ProcessEnv {
  return {
    ...options.env,
    ...(options.mock ? { QLOO_MOCK: "1" } : {}),
    ...(options.tag !== null ? { QLOO_TAG: options.tag } : {}),
  };
}

export const MEMORY_NEEDS_MOCK =
  "--memory works only on synthetic Qloo data (QLOO_MOCK=1, or the command's mock flag). Live calls go through the " +
  "shared Postgres cache, where the QLOO_TAG cap is counted and a repeated request is answered without the network.";

/** Why Postgres is needed and how to get it; --memory is offered only where it is allowed (mock). */
export function postgresUnreachable(env: NodeJS.ProcessEnv, qlooEnv: QlooEnv): string {
  const where = `Postgres is not reachable at ${describeDatabase(env)}.`;
  return qlooEnv === "mock"
    ? `${where} Start it with \`pnpm db:up\`, or pass --memory to cache in memory only.`
    : `${where} Start it with \`pnpm db:up\`: live Qloo calls need the shared cache, which counts the QLOO_TAG cap.`;
}

export async function openCliQloo(options: CliQlooOptions): Promise<CliQloo> {
  const env = cliQlooEnv(options);
  let qlooEnv: QlooEnv;
  try {
    qlooEnv = resolveQlooEnv(env);
  } catch (err) {
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  // Checked before any store or client exists, so a refused command opens nothing.
  if (options.store === "memory" && qlooEnv !== "mock") throw new CliError(MEMORY_NEEDS_MOCK);
  let store: QlooStore;
  let publicStore: PublicStore = createMemoryPublicStore();
  let storeLabel: string;
  let usesDb = false;
  if (options.store === "pg") {
    const db = getDb();
    if (!(await pingDb(db))) {
      await closeDb();
      throw new CliError(postgresUnreachable(env, qlooEnv));
    }
    store = createPgQlooStore(db);
    publicStore = createPgPublicStore(db);
    storeLabel = `postgres ${describeDatabase(env)}`;
    usesDb = true;
  } else if (options.store === "memory") {
    store = createMemoryQlooStore();
    storeLabel = "memory (nothing persists)";
  } else {
    store = options.store;
    storeLabel = "provided store";
  }

  let client: QlooClient;
  let tagCap: number | null;
  let tag: string;
  try {
    const clientOptions = qlooClientOptionsFromEnv(env, { store, logger: options.logger, fetch: options.fetch });
    client = createQlooClient(clientOptions);
    tagCap = clientOptions.tagCap;
    tag = clientOptions.tag;
  } catch (err) {
    if (usesDb) await closeDb();
    throw new CliError(err instanceof Error ? err.message : String(err));
  }
  let publicdata: PublicDataClient | null = null;
  try {
    publicdata = createPublicDataClient(publicDataOptionsFromEnv(env, { store: publicStore, logger: options.logger, fetch: options.fetch }));
  } catch (err) {
    options.logger.warn(`public data (SEC, Census) is off: ${err instanceof Error ? err.message : String(err)}`);
  }
  return {
    client,
    publicdata,
    store,
    storeLabel,
    tag,
    // The client never applies the tag cap to synthetic calls.
    tagCap: client.env === "mock" ? null : tagCap,
    close: async () => {
      try {
        await Promise.all([client.flush(), publicdata?.flush()]);
      } finally {
        if (usesDb) await closeDb();
      }
    },
  };
}

/** "mock", "dev (SEC on, Census off, OSM on: CENSUS_API_KEY not set)" or "off": the public-data part of a CLI header. */
export function describePublicData(client: PublicDataClient | null): string {
  if (client === null) return "off";
  if (client.env === "mock") return "mock";
  const osm = client.configured.osm === true;
  const off = [
    client.configured.sec ? null : "SEC_USER_AGENT",
    client.configured.census ? null : "CENSUS_API_KEY",
    osm ? null : "OSM_USER_AGENT",
  ].filter((v) => v !== null);
  const state = `SEC ${client.configured.sec ? "on" : "off"}, Census ${client.configured.census ? "on" : "off"}, OSM ${osm ? "on" : "off"}`;
  return `${client.env} (${state}${off.length === 0 ? "" : `: ${off.join(" and ")} not set`})`;
}

/** Warnings and errors from the client go to stderr; debug and info stay quiet. */
export function stderrLogger(write: (line: string) => void): QlooLogger {
  const log =
    (level: string) =>
    (first: unknown, second?: unknown): void => {
      const [fields, message] = typeof first === "string" ? [undefined, first] : [first, second];
      const detail = fields === undefined ? "" : ` ${JSON.stringify(fields)}`;
      write(`[qloo ${level}] ${typeof message === "string" ? message : ""}${detail}`);
    };
  const quiet = (): void => undefined;
  return { debug: quiet, info: quiet, warn: log("warn"), error: log("error") };
}
