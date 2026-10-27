// `pnpm exec tsx tools/dev/warm-metros.ts`: warms and truly pins (no expiry, D25) the city side of each
// map city: the geo_lift restaurant baseline heatmap and the block_dna tag fingerprint, music tags and
// brand list, on the city's pinned Qloo locality (tools/dev/localities.ts). Each request goes through
// @ct/qloo and the shared cache as a skill's would, so a cached one is a HIT and costs nothing; then
// QlooClient.pin marks its entry as never expiring. Locality ids are read from kv and never printed.
import { METRO_LABEL, MetroId, type MarketLocality } from "@ct/contracts";
import { getDb } from "@ct/db";
import type { QlooStore } from "@ct/qloo";
import { isBudgetError } from "@ct/quant";
import { listOption, parseCli, UsageError } from "./args";
import { cacheLabel, formatCount, NONE } from "./format";
import { stubGeo } from "./geo";
import { EXIT, heading, safeIo, type CliIo } from "./io";
import { localitiesKvKey, MalformedPinsError, memoryKv, pgKv, pinOf, readPins, type KvStore, type StoredLocalities } from "./localities";
import { CliError, describeDatabase, openCliQloo, stderrLogger, type CliQloo } from "./qloo-setup";
import { createSkillSession, renderUsage, type SkillSession } from "./skill-cli";
import { renderTable } from "./table";
import {
  CITY_SIDE_KINDS,
  CITY_SIDE_LABEL,
  citySideKey,
  citySideRequests,
  rowsOf,
  withFilterType,
  type CitySideKind,
  type CitySideRequest,
} from "./warm-metros";

const COMMAND = "pnpm exec tsx tools/dev/warm-metros.ts";

export const WARM_USAGE = [
  `usage: ${COMMAND} (--all | --metro <id>[,<id>…]) [--yes] [common options]`,
  "  warms and pins the city side of each map city on its pinned locality, the requests every geo_lift and",
  "  block_dna run makes on the city: the restaurant baseline heatmap, the city tag fingerprint, the city",
  "  music tags and the city brand list (4 calls for a new city, none when cached); pinned entries never expire",
  "  --all            every map city (MetroId)",
  "  --metro IDS      these map cities, comma-separated",
  "  --yes            make the calls and pin; without it, prints the plan and the calls it would make",
  "common options:",
  "  --mock           synthetic Qloo data (QLOO_MOCK=1): no key, no network; reads kv metro_localities.mock",
  "  --tag T          QLOO_TAG for the call log and the per-tag network cap",
  "  --memory         cache and kv in memory (nothing persists; with --mock only)",
  "  -h, --help       this text",
  "Map cities without a locality pin are skipped: pin them first with tools/dev/localities.ts pin.",
  "exit codes: 0 done, 1 failed (or a city has no pin or an empty answer), 2 bad arguments, 3 the plan needs --yes",
].join("\n");

const OPTIONS = {
  all: { type: "boolean" },
  metro: { type: "string" },
  yes: { type: "boolean" },
  mock: { type: "boolean" },
  tag: { type: "string" },
  memory: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** Every warm request is attributed to this tool call in the call table. */
const WARM_TOOL_CALL = "cli-warm-metros";

export interface WarmArgs {
  /** The map cities to warm, in MetroId order. */
  metros: MetroId[];
  yes: boolean;
  mock: boolean;
  tag: string | null;
  memory: boolean;
}

/** The parsed command, or null for --help. Throws UsageError. */
export function parseWarmArgs(argv: readonly string[]): WarmArgs | null {
  const { positionals, options } = parseCli(argv, OPTIONS);
  if (options.help) return null;
  if (positionals.length > 0) throw new UsageError(`unexpected argument "${positionals[0]}"; name cities with --metro`);
  const tag = options.tag?.trim() ?? null;
  if (tag === "") throw new UsageError("--tag needs a non-empty value");
  const all = options.all === true;
  const named = listOption(options.metro);
  if (all && options.metro !== undefined) throw new UsageError("warm takes --all or --metro, not both");
  if (!all && named.length === 0) throw new UsageError("name the cities: --all or --metro <id>[,<id>…]");
  const unknown = named.filter((id) => !MetroId.safeParse(id).success);
  if (unknown.length > 0) {
    throw new UsageError(`unknown map city ${unknown.map((id) => `"${id}"`).join(", ")}; the map cities are ${MetroId.options.join(", ")}`);
  }
  const metros = MetroId.options.filter((id) => all || named.includes(id));
  return { metros, yes: options.yes === true, mock: options.mock === true, tag, memory: options.memory === true };
}

export interface WarmCliDeps {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  /** Replaces the Postgres or memory Qloo store (tests). */
  store?: QlooStore;
  /** Replaces the database kv the locality pins are read from (tests). */
  kv?: KvStore;
  /** Replaces the live transport's fetch (tests). */
  fetch?: typeof fetch;
  now?: () => Date;
}

const print = (io: CliIo, lines: readonly string[]): void => {
  for (const line of lines) io.out(line);
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const plural = (n: number, one: string, many = `${one}s`): string => `${formatCount(n)} ${n === 1 ? one : many}`;

/** Where one request stands: answered by the cache and pinned, cached until it expires, or not cached. */
type Standing = "pinned" | "cached" | "network";

interface PlannedRequest {
  request: CitySideRequest;
  key: string;
  standing: Standing;
}

interface PlannedCity {
  metro: MetroId;
  /** Null when kv holds no locality for the city: nothing is asked for it. */
  locality: MarketLocality | null;
  requests: PlannedRequest[];
}

async function standingOf(session: SkillSession, store: QlooStore, planned: Omit<PlannedRequest, "standing">): Promise<Standing> {
  const cached = await session.scope.forTool(null).has("/v2/insights", withFilterType(planned.request));
  if (!cached) return "network";
  const entry = await store.getEntry(planned.key);
  return entry !== null && entry.pinned && entry.status >= 200 && entry.status < 300 ? "pinned" : "cached";
}

async function planCities(session: SkillSession, qloo: CliQloo, metros: readonly MetroId[], pins: StoredLocalities): Promise<PlannedCity[]> {
  return Promise.all(
    metros.map(async (metro) => {
      const locality = pinOf(pins, metro);
      if (locality === null) return { metro, locality, requests: [] };
      const requests = await Promise.all(
        citySideRequests(locality).map(async (request) => {
          const base = { request, key: citySideKey(request, qloo.client.env) };
          return { ...base, standing: await standingOf(session, qloo.store, base) };
        }),
      );
      return { metro, locality, requests };
    }),
  );
}

const cellOf = (city: PlannedCity, kind: CitySideKind): string => city.requests.find((r) => r.request.kind === kind)?.standing ?? NONE;

function renderPlan(cities: readonly PlannedCity[], io: CliIo): { network: number; toPin: number; requests: number } {
  const all = cities.flatMap((c) => c.requests);
  const network = all.filter((r) => r.standing === "network").length;
  const toPin = all.filter((r) => r.standing !== "pinned").length;
  io.out(
    heading(
      `PLAN (${plural(cities.length, "map city", "map cities")} · ${plural(all.length, "request")} · ` +
        `${formatCount(all.length - network)} cached · ${plural(network, "network call")} · ${formatCount(all.length - toPin)} pinned)`,
    ),
  );
  print(
    io,
    renderTable(
      [{ header: "city" }, { header: "label" }, { header: "locality" }, ...CITY_SIDE_KINDS.map((k) => ({ header: k }))],
      cities.map((c) => [c.metro, METRO_LABEL[c.metro], c.locality === null ? "not pinned" : "pinned", ...CITY_SIDE_KINDS.map((k) => cellOf(c, k))]),
      { indent: "  " },
    ),
  );
  io.out(`  requests: ${CITY_SIDE_KINDS.map((k) => `${k} = ${CITY_SIDE_LABEL[k]}`).join("; ")}`);
  return { network, toPin, requests: all.length };
}

type Outcome =
  | { kind: "pinned"; rows: number; already: boolean }
  | { kind: "empty"; rows: 0 }
  | { kind: "not_fetched" }
  | { kind: "failed"; error: string };

interface Warmed {
  metro: MetroId;
  request: CitySideRequest;
  key: string;
  cache: string;
  outcome: Outcome;
}

function outcomeText(o: Outcome): string {
  switch (o.kind) {
    case "pinned":
      return o.already ? "pinned (already)" : "pinned";
    case "empty":
      return "empty answer: check the locality pin";
    case "not_fetched":
      return "not fetched: a Qloo budget gate refused the call";
    case "failed":
      return `failed: ${o.error}`;
  }
}

/** One request through the session (a HIT when cached, as in a run), then its entry pinned unless it is already. */
async function warmOne(session: SkillSession, qloo: CliQloo, planned: PlannedRequest): Promise<{ cache: string; outcome: Outcome }> {
  const { request } = planned;
  const before = session.calls.length;
  try {
    const answer = await session.scope.forTool(WARM_TOOL_CALL).insights(request.filterType, request.params);
    const cache = cacheLabel(answer.meta.cache);
    const rows = rowsOf(answer.data);
    // An empty city side is never pinned here. The D25 rule keys on the request, so the client may have
    // stored it pinned already: it is reported and the run fails, so a person looks at the locality.
    if (rows === 0) return { cache, outcome: { kind: "empty", rows: 0 } };
    if (planned.standing !== "pinned") await qloo.client.pin("/v2/insights", withFilterType(request));
    return { cache, outcome: { kind: "pinned", rows, already: planned.standing === "pinned" } };
  } catch (err) {
    const record = session.calls.length > before ? session.calls[session.calls.length - 1] : undefined;
    const cache = record === undefined ? NONE : cacheLabel(record.cache);
    return { cache, outcome: isBudgetError(err) ? { kind: "not_fetched" } : { kind: "failed", error: errorText(err) } };
  }
}

interface WarmContext {
  session: SkillSession;
  qloo: CliQloo;
  pins: StoredLocalities;
  kvKey: string;
  io: CliIo;
}

async function runWarm(args: WarmArgs, c: WarmContext): Promise<number> {
  const { session, qloo, pins, kvKey, io } = c;
  const cities = await planCities(session, qloo, args.metros, pins);
  const { network, toPin, requests } = renderPlan(cities, io);
  const unpinned = cities.filter((city) => city.locality === null).map((city) => city.metro);
  if (unpinned.length > 0) {
    io.out(`  no locality pin in kv ${kvKey} (skipped; pin with tools/dev/localities.ts pin <id> first): ${unpinned.join(", ")}`);
  }
  if (requests === 0) {
    io.out("\nnothing to warm: no selected map city has a locality pin");
    return EXIT.failed;
  }
  if (!args.yes) {
    if (toPin === 0) {
      io.out("\nnothing to warm: every request is cached and pinned (run with --yes to read them through the cache anyway)");
      return unpinned.length > 0 ? EXIT.failed : EXIT.ok;
    }
    io.out(
      `\nwarm would make ${plural(network, "network call")} to Qloo ${qloo.client.env} under tag ${qloo.tag} ` +
        `(${formatCount(requests - network)} answered from the cache) and pin ${plural(toPin, "cache entry", "cache entries")}. Run it again with --yes.`,
    );
    return EXIT.needsInput;
  }

  // One request at a time, in plan order: the limiter paces live calls anyway, and the table keeps the order.
  const warmed: Warmed[] = [];
  for (const city of cities) {
    for (const planned of city.requests) {
      const { cache, outcome } = await warmOne(session, qloo, planned);
      warmed.push({ metro: city.metro, request: planned.request, key: planned.key, cache, outcome });
    }
  }

  // Read back from the store after every write has landed: a pin is only reported once it is there.
  await qloo.client.flush();
  const entries = await Promise.all(warmed.map((w) => qloo.store.getEntry(w.key)));
  const stored = entries.map((e) => e?.pinned === true);
  io.out(heading("RESULT"));
  print(
    io,
    renderTable(
      [{ header: "city" }, { header: "request" }, { header: "cache" }, { header: "rows", align: "right" }, { header: "outcome", max: 70 }, { header: "stored" }],
      warmed.map((w, i) => [
        w.metro,
        w.request.kind,
        w.cache,
        w.outcome.kind === "pinned" || w.outcome.kind === "empty" ? formatCount(w.outcome.rows) : NONE,
        outcomeText(w.outcome),
        entries[i] === null ? NONE : stored[i] ? "pinned" : "expires",
      ]),
      { indent: "  " },
    ),
  );
  const pinnedNow = stored.filter(Boolean).length;
  const empty = warmed.filter((w) => w.outcome.kind === "empty").length;
  io.out(`\ncity side: ${formatCount(pinnedNow)} of ${plural(warmed.length, "entry", "entries")} pinned in the cache (${qloo.storeLabel})`);
  if (empty > 0) {
    io.out(
      `  ${plural(empty, "empty answer")}: a run would read no city there. Check the locality pins; an empty answer the D25 rule ` +
        "stored pinned stays until its qloo_cache row is deleted.",
    );
  }

  const failed = warmed.some((w, i) => w.outcome.kind !== "pinned" || !stored[i]);
  return failed || unpinned.length > 0 ? EXIT.failed : EXIT.ok;
}

export async function runWarmCommand(argv: readonly string[], deps: WarmCliDeps): Promise<number> {
  const io = safeIo(deps.io);
  let args: WarmArgs | null;
  try {
    args = parseWarmArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(err.message);
    io.err(WARM_USAGE);
    return EXIT.usage;
  }
  if (args === null) {
    io.out(WARM_USAGE);
    return EXIT.ok;
  }

  const storeOption = deps.store ?? (args.memory ? "memory" : "pg");
  let qloo: CliQloo;
  try {
    qloo = await openCliQloo({ env: deps.env, mock: args.mock, tag: args.tag, store: storeOption, logger: stderrLogger(io.err), fetch: deps.fetch });
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(err.message);
    return EXIT.failed;
  }

  // openCliQloo has reached the database for a Postgres store, so the shared pool serves kv too.
  const kv = deps.kv ?? (storeOption === "pg" ? pgKv(getDb(), `postgres ${describeDatabase(deps.env)}`) : memoryKv());
  const kvKey = localitiesKvKey(qloo.client.env);
  const session = createSkillSession(qloo.client, stubGeo(), deps.now?.() ?? new Date());
  io.out(`warm-metros · Qloo ${qloo.client.env} · tag ${qloo.tag} · cache ${qloo.storeLabel} · kv ${kvKey} in ${kv.label} · run ${session.runId}`);

  let code: number;
  try {
    const pins = await readPins(kv, kvKey);
    code = await runWarm(args, { session, qloo, pins, kvKey, io });
  } catch (err) {
    io.err(err instanceof MalformedPinsError ? err.message : `warm-metros failed: ${errorText(err)}`);
    code = EXIT.failed;
  }
  try {
    if (session.calls.length > 0) await renderUsage(session, qloo, io);
  } catch (err) {
    io.err(`could not report Qloo usage: ${errorText(err)}`);
  } finally {
    await qloo.close();
  }
  return code;
}
