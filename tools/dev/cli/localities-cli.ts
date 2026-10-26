// `pnpm exec tsx tools/dev/localities.ts list|pin`: the Qloo locality of each config/metros.json
// market, pinned in kv for the metro, city and market contexts of SHARE, RANK, SLATE, LIFT and BLOCK
// (apps/web/server/localities.ts reads it). Each market resolves through one /search for its query
// as urn:entity:locality, through @ct/qloo and the shared cache; only an exact name in the market's
// state is pinned without asking (D20), and a deliberate or ambiguous market prints a picker. The
// ids go to the database kv and nowhere else: never to the terminal, never to a file.
import type { LatLon, MarketId, QlooParams, QlooSearchEntity } from "@ct/contracts";
import { getDb } from "@ct/db";
import type { QlooStore } from "@ct/qloo";
import { isBudgetError } from "@ct/quant";
import { z } from "zod";
import { intOption, parseCli, UsageError } from "./args";
import { formatCount, formatFixed2, NONE } from "./format";
import { stubGeo } from "./geo";
import { EXIT, heading, safeIo, type CliIo } from "./io";
import {
  classifyLocality,
  localitiesKvKey,
  localitySearchParams,
  LOCALITY_SEARCH_TAKE,
  MalformedPinsError,
  memoryKv,
  pgKv,
  pinOf,
  readPins,
  type ChoiceReason,
  type KvStore,
  type StoredLocalities,
} from "./localities";
import { loadMarkets, MarketsConfigError, type Market } from "./markets";
import { CliError, describeDatabase, openCliQloo, stderrLogger, type CliQloo } from "./qloo-setup";
import { createSkillSession, renderUsage, type SkillSession } from "./skill-cli";
import { renderTable, truncate } from "./table";

const COMMAND = "pnpm exec tsx tools/dev/localities.ts";

export const LOCALITIES_USAGE = [
  `usage: ${COMMAND} list [common options]`,
  `       ${COMMAND} pin (--all | <market id>…) [--pick N] [--replace] [--yes] [common options]`,
  "  list             every market in config/metros.json with its pin and whether its /search is cached (no Qloo calls)",
  "  pin              resolves the markets not yet pinned: one /search each (types urn:entity:locality, the market's",
  "                   query), exact name in the market's state only, and writes the pins to kv",
  "  --all            every market in config/metros.json",
  "  --pick N         for one market: pin the Nth exact match of its listing (a deliberate pin or an ambiguous name)",
  "  --replace        resolve markets that are already pinned again and replace their pins",
  "  --yes            make the calls and write kv; without it, pin prints the plan and the calls it would make",
  "common options:",
  "  --mock           synthetic Qloo data (QLOO_MOCK=1): no key, no network; pins go to kv metro_localities.mock",
  "  --tag T          QLOO_TAG for the call log and the per-tag network cap",
  "  --memory         cache and kv in memory (nothing persists; with --mock only)",
  "  -h, --help       this text",
  "Live pins go to kv metro_localities. Locality ids are written to the database kv only, never printed.",
  "exit codes: 0 done, 1 failed (or a market has no exact match), 2 bad arguments, 3 a market needs a choice or pin needs --yes",
].join("\n");

const OPTIONS = {
  all: { type: "boolean" },
  pick: { type: "string" },
  replace: { type: "boolean" },
  yes: { type: "boolean" },
  mock: { type: "boolean" },
  tag: { type: "string" },
  memory: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

const PIN_ONLY = ["all", "pick", "replace", "yes"] as const;
const SEARCH_TOOL_CALL = "cli-localities";

export interface LocalitiesArgs {
  command: "list" | "pin";
  /** The markets pin resolves, in config order (every market with --all; empty for list). */
  ids: MarketId[];
  all: boolean;
  /** 1-based choice in one market's listing, or null. */
  pick: number | null;
  replace: boolean;
  yes: boolean;
  mock: boolean;
  tag: string | null;
  memory: boolean;
}

/** The parsed command, or null for --help. Throws UsageError. */
export function parseLocalitiesArgs(argv: readonly string[], markets: readonly Market[]): LocalitiesArgs | null {
  const { positionals, options } = parseCli(argv, OPTIONS);
  if (options.help) return null;
  const [command, ...rest] = positionals;
  if (command === undefined) throw new UsageError("name a command: list or pin");
  if (command !== "list" && command !== "pin") throw new UsageError(`unknown command "${command}"; the commands are list and pin`);
  const tag = options.tag?.trim() ?? null;
  if (tag === "") throw new UsageError("--tag needs a non-empty value");
  const common = { mock: options.mock === true, tag, memory: options.memory === true };

  if (command === "list") {
    if (rest.length > 0) throw new UsageError("list takes no market ids; it lists every market");
    for (const flag of PIN_ONLY) if (options[flag] !== undefined) throw new UsageError(`--${flag} applies to pin only`);
    return { command, ids: [], all: false, pick: null, replace: false, yes: false, ...common };
  }

  const all = options.all === true;
  if (all && rest.length > 0) throw new UsageError("pin takes --all or market ids, not both");
  if (!all && rest.length === 0) throw new UsageError("pin needs --all or at least one market id");
  const known = new Set(markets.map((m) => m.id));
  const unknown = rest.filter((id) => !known.has(id.trim()));
  if (unknown.length > 0) {
    throw new UsageError(`unknown market ${unknown.map((id) => `"${id}"`).join(", ")}; run list for the market ids in config/metros.json`);
  }
  const wanted = new Set(rest.map((id) => id.trim()));
  const ids = markets.filter((m) => all || wanted.has(m.id)).map((m) => m.id);
  const pick = options.pick === undefined ? null : intOption(options.pick, "--pick", { min: 1, max: LOCALITY_SEARCH_TAKE, fallback: 1 });
  if (pick !== null && (all || ids.length !== 1)) throw new UsageError("--pick chooses for one market: name exactly one market id");
  return { command, ids, all, pick, replace: options.replace === true, yes: options.yes === true, ...common };
}

export interface LocalitiesCliDeps {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  /** Replaces the Postgres or memory Qloo store (tests). */
  store?: QlooStore;
  /** Replaces the database kv (tests). */
  kv?: KvStore;
  /** Replaces the live transport's fetch (tests). */
  fetch?: typeof fetch;
  /** Replaces config/metros.json (tests). */
  markets?: readonly Market[];
  now?: () => Date;
}

const print = (io: CliIo, lines: readonly string[]): void => {
  for (const line of lines) io.out(line);
};

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const plural = (n: number, one: string, many = `${one}s`): string => `${formatCount(n)} ${n === 1 ? one : many}`;

/** "pinned", "pinned as 'Label'" when kv holds another label, or "—". */
function pinText(market: Market, pins: StoredLocalities): string {
  const pin = pinOf(pins, market.id);
  if (pin === null) return NONE;
  return pin.label === market.label ? "pinned" : `pinned as '${pin.label}'`;
}

interface Planned {
  market: Market;
  params: QlooParams;
  cached: boolean;
}

async function plan(session: SkillSession, markets: readonly Market[]): Promise<Planned[]> {
  const probe = session.scope.forTool(null);
  return Promise.all(
    markets.map(async (market) => {
      const params = localitySearchParams(market);
      return { market, params, cached: await probe.has("/search", params) };
    }),
  );
}

async function runList(session: SkillSession, markets: readonly Market[], pins: StoredLocalities, kvKey: string, io: CliIo, qloo: CliQloo): Promise<number> {
  const planned = await plan(session, markets);
  io.out(heading(`MARKETS (${markets.length}) · kv ${kvKey}`));
  print(
    io,
    renderTable(
      [{ header: "market" }, { header: "label" }, { header: "query" }, { header: "state" }, { header: "rule" }, { header: "pin", max: 40 }, { header: "search" }],
      planned.map(({ market, cached }) => [
        market.id,
        market.label,
        market.query,
        market.state,
        market.deliberate ? "deliberate" : "auto",
        pinText(market, pins),
        cached ? "cached" : "not cached",
      ]),
      { indent: "  " },
    ),
  );
  const extra = Object.keys(pins).filter((id) => !markets.some((m) => m.id === id));
  if (extra.length > 0) io.out(`  kv also pins ${extra.join(", ")} (not in config/metros.json)`);

  const open = planned.filter((p) => pinOf(pins, p.market.id) === null);
  const deliberate = open.filter((p) => p.market.deliberate).map((p) => p.market.id);
  const network = open.filter((p) => !p.cached).length;
  io.out("");
  io.out(
    `  ${plural(markets.length, "market")} · ${formatCount(markets.length - open.length)} pinned · ${formatCount(open.length)} not pinned` +
      (deliberate.length > 0 ? ` (deliberate, chosen by hand with pin <id> --pick N: ${deliberate.join(", ")})` : ""),
  );
  if (open.length > 0) {
    io.out(
      `  pin --all would search ${plural(open.length, "market")}: ${formatCount(open.length - network)} cached, ` +
        `${plural(network, "network call")} to Qloo ${qloo.client.env} under tag ${qloo.tag}`,
    );
  }
  return EXIT.ok;
}

type Outcome =
  | { kind: "pinned"; market: Market; result: QlooSearchEntity; replaced: boolean }
  | { kind: "choose"; market: Market; reason: ChoiceReason | "pick_out_of_range"; choices: QlooSearchEntity[] }
  | { kind: "not_found"; market: Market; others: QlooSearchEntity[] }
  | { kind: "not_searched"; market: Market }
  | { kind: "failed"; market: Market; error: string };

const SearchLocation = z.object({ lat: z.number(), lon: z.number() });

function locationOf(result: QlooSearchEntity): LatLon | null {
  const parsed = SearchLocation.safeParse((result as { location?: unknown }).location);
  return parsed.success ? parsed.data : null;
}

/** Great-circle distance in km. */
function distanceKm(a: LatLon, b: LatLon): number {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** "Austin (Texas, United States · pop 0.93 · at 30.27,-97.74 · 1 km from centre)": no id, ever. */
function describeResult(result: QlooSearchEntity, market: Market): string {
  const at = locationOf(result);
  const parts = [
    result.disambiguation ?? null,
    result.popularity === undefined ? null : `pop ${formatFixed2(result.popularity)}`,
    at === null ? null : `at ${at.lat.toFixed(2)},${at.lon.toFixed(2)}`,
    at === null || market.center === null ? null : `${Math.round(distanceKm(at, market.center))} km from centre`,
  ].filter((p) => p !== null && p !== "");
  return parts.length === 0 ? result.name : `${result.name} (${parts.join(" · ")})`;
}

function decide(market: Market, results: readonly QlooSearchEntity[], pick: number | null, replaced: boolean): Outcome {
  const match = classifyLocality(market, results);
  if (match.kind === "not_found") return { kind: "not_found", market, others: match.others };
  if (pick !== null) {
    const chosen = match.choices[pick - 1];
    return chosen === undefined
      ? { kind: "choose", market, reason: "pick_out_of_range", choices: match.choices }
      : { kind: "pinned", market, result: chosen, replaced };
  }
  if (match.kind === "unique") return { kind: "pinned", market, result: match.result, replaced };
  return { kind: "choose", market, reason: match.reason, choices: match.choices };
}

function outcomeText(o: Outcome): string {
  switch (o.kind) {
    case "pinned":
      return o.replaced ? "replaced" : "pinned";
    case "choose":
      return "needs a choice";
    case "not_found":
      return "not found";
    case "not_searched":
      return "not searched";
    case "failed":
      return "failed";
  }
}

function matchText(o: Outcome): string {
  switch (o.kind) {
    case "pinned":
      return describeResult(o.result, o.market);
    case "choose":
      return plural(o.choices.length, "exact match", "exact matches");
    case "not_found":
      return `no locality named '${o.market.query}'`;
    case "not_searched":
      return "a Qloo budget gate refused the call";
    case "failed":
      return o.error;
  }
}

function reasonText(o: Extract<Outcome, { kind: "choose" }>, pick: number | null): string {
  switch (o.reason) {
    case "deliberate":
      return "config/metros.json marks it pin: deliberate, so a person chooses";
    case "ambiguous":
      return `${o.choices.length} exact matches in ${o.market.stateName}`;
    case "outside_state":
      return `no exact match names ${o.market.stateName}`;
    case "pick_out_of_range":
      return `--pick ${pick ?? "?"} is out of range`;
  }
}

function renderChoices(outcomes: readonly Outcome[], pick: number | null, io: CliIo): void {
  const open = outcomes.filter((o): o is Extract<Outcome, { kind: "choose" }> => o.kind === "choose");
  if (open.length === 0) return;
  io.out(heading("NEEDS A CHOICE (nothing was pinned for these)"));
  for (const o of open) {
    io.out(`  ${o.market.id} '${o.market.query}' (${o.market.stateName}): ${reasonText(o, pick)}; exact matches:`);
    o.choices.forEach((c, i) => io.out(`     ${i + 1}. ${truncate(describeResult(c, o.market), 100)}`));
    io.out(`     to pin one: ${COMMAND} pin ${o.market.id} --pick <n> --yes`);
  }
}

function renderNotFound(outcomes: readonly Outcome[], io: CliIo): void {
  const missing = outcomes.filter((o): o is Extract<Outcome, { kind: "not_found" }> => o.kind === "not_found");
  if (missing.length === 0) return;
  io.out(heading("NOT FOUND (no exact name; check the query in config/metros.json)"));
  for (const o of missing) {
    const others = o.others.map((r) => truncate(describeResult(r, o.market), 60));
    io.out(`  ${o.market.id} '${o.market.query}': ${others.length === 0 ? "no results" : `other results: ${others.join("; ")}`}`);
  }
}

/** The pins in config order, then any other market ids kv already held. */
function orderedPins(pins: StoredLocalities, markets: readonly Market[]): StoredLocalities {
  const out: StoredLocalities = {};
  for (const m of markets) {
    const pin = pinOf(pins, m.id);
    if (pin !== null) out[m.id] = pin;
  }
  for (const [id, pin] of Object.entries(pins)) if (!Object.hasOwn(out, id)) out[id] = pin;
  return out;
}

interface PinContext {
  session: SkillSession;
  qloo: CliQloo;
  kv: KvStore;
  kvKey: string;
  markets: readonly Market[];
  pins: StoredLocalities;
  io: CliIo;
}

async function runPin(args: LocalitiesArgs, c: PinContext): Promise<number> {
  const { session, qloo, kv, kvKey, markets, pins, io } = c;
  const selected = markets.filter((m) => args.ids.includes(m.id));
  // An explicit --pick is a deliberate replacement of that one market's pin.
  const resolveAgain = args.replace || args.pick !== null;
  const kept = selected.filter((m) => pinOf(pins, m.id) !== null && !resolveAgain);
  const targets = await plan(session, selected.filter((m) => !kept.includes(m)));
  const network = targets.filter((t) => !t.cached).length;

  io.out(heading(`PLAN (${plural(targets.length, "market")} to resolve · ${formatCount(targets.length - network)} cached · ${plural(network, "network call")})`));
  if (targets.length > 0) {
    print(
      io,
      renderTable(
        [{ header: "market" }, { header: "query" }, { header: "state" }, { header: "rule" }, { header: "now", max: 40 }, { header: "search" }],
        targets.map(({ market, cached }) => [
          market.id,
          market.query,
          market.state,
          market.deliberate ? "deliberate" : "auto",
          pinText(market, pins),
          cached ? "cached" : "network",
        ]),
        { indent: "  " },
      ),
    );
  }
  if (kept.length > 0) io.out(`  kept (already pinned; --replace resolves them again): ${kept.map((m) => m.id).join(", ")}`);
  if (targets.length === 0) {
    io.out("\nnothing to pin: every selected market is pinned");
    return EXIT.ok;
  }
  if (!args.yes) {
    io.out(
      `\npin would make ${plural(network, "network call")} to Qloo ${qloo.client.env} under tag ${qloo.tag} ` +
        `(${formatCount(targets.length - network)} answered from the cache) and write kv ${kvKey}. Run it again with --yes.`,
    );
    return EXIT.needsInput;
  }

  // One market at a time: the limiter paces live calls anyway, and the listing keeps config order.
  const qlooTool = session.scope.forTool(SEARCH_TOOL_CALL);
  const outcomes: Outcome[] = [];
  for (const { market, params } of targets) {
    try {
      const search = await qlooTool.search(params);
      outcomes.push(decide(market, search.data.results, args.pick, pinOf(pins, market.id) !== null));
    } catch (err) {
      outcomes.push(isBudgetError(err) ? { kind: "not_searched", market } : { kind: "failed", market, error: errorText(err) });
    }
  }

  io.out(heading("RESULT"));
  print(
    io,
    renderTable(
      [{ header: "market" }, { header: "outcome" }, { header: "match", max: 90 }, { header: "kv label" }],
      outcomes.map((o) => [o.market.id, outcomeText(o), matchText(o), o.kind === "pinned" ? o.market.label : NONE]),
      { indent: "  " },
    ),
  );
  renderChoices(outcomes, args.pick, io);
  renderNotFound(outcomes, io);

  const fresh: StoredLocalities = {};
  for (const o of outcomes) if (o.kind === "pinned") fresh[o.market.id] = { entityId: o.result.entity_id, label: o.market.label };
  const written = Object.keys(fresh).length;
  let writeFailed = false;
  if (written > 0) {
    try {
      // Read again just before writing, so pins written meanwhile by another process are kept.
      const latest = await readPins(kv, kvKey);
      const merged = orderedPins({ ...latest, ...fresh }, markets);
      await kv.set(kvKey, merged);
      const total = markets.filter((m) => pinOf(merged, m.id) !== null).length;
      io.out(`\nkv ${kvKey}: wrote ${plural(written, "pin")}; ${formatCount(total)} of ${plural(markets.length, "market")} pinned`);
    } catch (err) {
      writeFailed = true;
      io.err(`could not write kv ${kvKey}: ${errorText(err)}`);
    }
  } else {
    io.out(`\nkv ${kvKey}: nothing written`);
  }

  const failed = writeFailed || outcomes.some((o) => o.kind === "failed" || o.kind === "not_searched" || o.kind === "not_found");
  if (failed) return EXIT.failed;
  return outcomes.some((o) => o.kind === "choose") ? EXIT.needsInput : EXIT.ok;
}

export async function runLocalitiesCommand(argv: readonly string[], deps: LocalitiesCliDeps): Promise<number> {
  const io = safeIo(deps.io);
  let markets: readonly Market[];
  try {
    markets = deps.markets ?? loadMarkets();
  } catch (err) {
    if (!(err instanceof MarketsConfigError)) throw err;
    io.err(err.message);
    return EXIT.failed;
  }

  let args: LocalitiesArgs | null;
  try {
    args = parseLocalitiesArgs(argv, markets);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(err.message);
    io.err(LOCALITIES_USAGE);
    return EXIT.usage;
  }
  if (args === null) {
    io.out(LOCALITIES_USAGE);
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
  io.out(`localities ${args.command} · Qloo ${qloo.client.env} · tag ${qloo.tag} · cache ${qloo.storeLabel} · kv ${kvKey} in ${kv.label} · run ${session.runId}`);

  let code: number;
  try {
    const pins = await readPins(kv, kvKey);
    code = args.command === "list" ? await runList(session, markets, pins, kvKey, io, qloo) : await runPin(args, { session, qloo, kv, kvKey, markets, pins, io });
  } catch (err) {
    io.err(err instanceof MalformedPinsError ? err.message : `localities ${args.command} failed: ${errorText(err)}`);
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
