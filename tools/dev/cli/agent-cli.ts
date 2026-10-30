// `pnpm run-agent "<question>"`: one full agent run (CLERK, resolution gate, ANALYST, CHECKER,
// assembly) from the terminal, with no web server (PLAN Part 3). It prints a live trace and the
// finished note. The LLM calls are always live, so a run needs ANTHROPIC_API_KEY and --yes, and is
// refused when its worst case would take run-agent's spend past LLM_DEV_USD_CAP. The worst case is
// booked in the tally before the run starts and replaced by the measured spend when it returns.
import {
  ANALYST_CONFIGS,
  createAnthropic,
  findPickerChoice,
  runAgent,
  SIDE_TIMEOUTS,
  type AgentRunOptions,
  type AgentRunResult,
  type AnalystMode,
  type AnthropicLike,
  type ContextCache,
  type SideConfig,
} from "@ct/agent";
import { DEFAULT_RUN_LIMITS, Lane, placeSearchMarket, QUESTION_MAX_CHARS, type EventInput, type EventInputOf, type LocalityApi, type MarketId } from "@ct/contracts";
import { closeDb, getContext, getDb, putContext, type Queryable } from "@ct/db";
import type { QlooClient, QlooStore } from "@ct/qloo";
import { searchParams } from "@ct/quant";
import { choiceOption, parseCli, pinsOption, UsageError } from "./args";
import { formatUsd } from "./format";
import { EXIT, safeIo, type CliIo } from "./io";
import { createRunPersistence, type RunPersistence } from "./persist";
import { kvLocalityApi, localitiesKvKey, pgKv, type KvStore } from "./localities";
import { CliError, describePublicData, openCliQloo, stderrLogger, type CliQloo } from "./qloo-setup";
import { renderAgentResult } from "./report-view";
import { cliRunId } from "./skill-cli";
import { checkSpend, DEFAULT_DEV_USD_CAP, readSpend, readUsdCap, reserveSpend, settleSpend, SPEND_FILE } from "./spend";
import { createTracePrinter } from "./trace";

export const RUN_AGENT_USAGE = [
  "usage: pnpm run-agent \"<question>\" --yes [options]",
  "  --yes, -y          confirm the live LLM spend (every run calls CLERK and the ANALYST)",
  "  --economy          economy mode: the Haiku ANALYST instead of Sonnet",
  "  --mock-qloo        synthetic Qloo data (QLOO_MOCK=1); the LLM calls stay live",
  "  --pins \"N=id,…\"    preselect entities: mention name = Qloo entity id (a needs-a-choice run prints them)",
  "  --lane L           public (default) or judge",
  "  --tag T            QLOO_TAG for the call log and the per-tag network cap",
  "  --memory           cache Qloo answers in memory instead of the shared Postgres cache (with --mock-qloo only)",
  "  --persist          store the run and its events in Postgres (runs, run_events)",
  "  --no-ai-context    skip the \"What AI knows (not verified)\" side call",
  "  --no-web           skip the \"From the web\" side call (web search)",
  "  -h, --help         this text",
  "env: ANTHROPIC_API_KEY (required), LLM_DEV_USD_CAP (default 45, cumulative), QLOO_* as for the app,",
  "     AI_CONTEXT_ENABLED / WEB_SEARCH_ENABLED (0 turns a side call off), WEB_SEARCH_MAX_USES (default 3),",
  "     SEC_USER_AGENT (live SEC filings) and CENSUS_API_KEY (live Census figures); QLOO_MOCK=1 mocks both",
  "Ctrl+C cancels the run; the spend tally holds the run's worst case until it returns.",
  "exit codes: 0 completed, 1 failed or not completed, 2 bad arguments or no --yes, 3 needs a choice",
].join("\n");

const OPTIONS = {
  yes: { type: "boolean", short: "y" },
  economy: { type: "boolean" },
  "mock-qloo": { type: "boolean" },
  pins: { type: "string" },
  lane: { type: "string" },
  tag: { type: "string" },
  memory: { type: "boolean" },
  persist: { type: "boolean" },
  // On by default; parseCli's allowNegative reads --no-ai-context and --no-web as false.
  "ai-context": { type: "boolean" },
  web: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

export interface AgentArgs {
  question: string;
  mode: AnalystMode;
  mockQloo: boolean;
  pins: Record<string, string>;
  lane: Lane;
  tag: string | null;
  memory: boolean;
  persist: boolean;
  /** False with --no-ai-context. */
  aiContext: boolean;
  /** False with --no-web. */
  web: boolean;
  yes: boolean;
}

/** The parsed command, or null for --help. Words given without quotes are joined into the question. */
export function parseAgentArgs(argv: readonly string[]): AgentArgs | null {
  const { positionals, options } = parseCli(argv, OPTIONS);
  if (options.help) return null;
  const question = positionals.join(" ").trim();
  if (question === "") throw new UsageError("ask a question, e.g. pnpm run-agent \"How healthy is Liquid Death's taste signal?\" --yes");
  const tag = options.tag?.trim() ?? null;
  if (tag === "") throw new UsageError("--tag needs a non-empty value");
  return {
    question,
    mode: options.economy ? "economy" : "live",
    mockQloo: options["mock-qloo"] === true,
    pins: pinsOption(options.pins),
    lane: choiceOption(options.lane, "--lane", Lane.options, "public"),
    tag,
    memory: options.memory === true,
    persist: options.persist === true,
    aiContext: options["ai-context"] !== false,
    web: options.web !== false,
    yes: options.yes === true,
  };
}

/** The most each side context call may cost (D24: AI context $0.02, web $0.08 at 3 searches), booked in the worst case. */
export const SIDE_WORST_USD = { ai: 0.02, web: 0.08 } as const;

const envSwitch = (raw: string | undefined): boolean => raw?.trim() !== "0";

/**
 * The side context calls for a CLI run (R4, R5): on unless the flag or the environment
 * (AI_CONTEXT_ENABLED=0, WEB_SEARCH_ENABLED=0) turns one off; economy runs no web search (the agent).
 */
export function cliSideConfig(args: Pick<AgentArgs, "aiContext" | "web">, env: NodeJS.ProcessEnv): SideConfig {
  const uses = Number(env.WEB_SEARCH_MAX_USES?.trim() || "3");
  return {
    aiEnabled: args.aiContext && envSwitch(env.AI_CONTEXT_ENABLED),
    webEnabled: args.web && envSwitch(env.WEB_SEARCH_ENABLED),
    webMaxUses: Number.isFinite(uses) ? Math.min(5, Math.max(1, Math.round(uses))) : 3,
    aiTimeoutMs: SIDE_TIMEOUTS.aiMs,
    webTimeoutMs: SIDE_TIMEOUTS.webMs,
  };
}

/** The worst case of one run: the ANALYST's hard stop plus each side call that may run. */
export function worstCaseUsd(usdHard: number, side: SideConfig, mode: AnalystMode): number {
  return usdHard + (side.aiEnabled ? SIDE_WORST_USD.ai : 0) + (side.webEnabled && mode === "live" ? SIDE_WORST_USD.web : 0);
}

/** The shared context_cache (as the web app's), so CLI runs reuse blocks inside their lifetime. */
function pgContextCache(db: Queryable): ContextCache {
  return {
    get: async (key) => {
      const row = await getContext(db, key, new Date());
      return row ? { body: row.body, createdAt: row.createdAt.toISOString() } : null;
    },
    put: async (row) => {
      await putContext(db, { key: row.key, kind: row.kind, model: row.model, body: row.body, usd: row.usd, expiresAt: new Date(Date.now() + row.ttlMs) });
    },
  };
}

/** The database --persist writes to, and how to let go of it. */
export interface CliDatabase {
  db: Queryable;
  close(): Promise<void>;
}

export interface AgentCliDeps {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  /** The agent; tests pass a scripted one. */
  runAgent?: (options: AgentRunOptions) => Promise<AgentRunResult>;
  createAnthropic?: (apiKey: string) => AnthropicLike;
  /** Replaces the Postgres or memory Qloo store (tests). */
  store?: QlooStore;
  /** Replaces the database kv the pinned market localities are read from (tests); null reads none. */
  kv?: KvStore | null;
  /** The database for --persist (default: the shared pool from DATABASE_URL, closed at the end). */
  openDb?: () => CliDatabase;
  /** The local spend tally; null keeps none. */
  spendFile?: string | null;
  /** Cancels the run (Ctrl+C in the entry script). */
  signal?: AbortSignal;
  now?: () => Date;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** What a run reads Qloo through: the client over its cache, and the pinned market localities. */
export interface AgentQloo {
  qloo: CliQloo;
  localities: LocalityApi | null;
}

export interface AgentQlooOptions {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  /** Forces QLOO_MOCK=1. */
  mock: boolean;
  /** Overrides QLOO_TAG. */
  tag: string | null;
  /** Cache Qloo answers in memory (synthetic data only). */
  memory: boolean;
  /** Replaces the Postgres or memory Qloo store (tests). */
  store?: QlooStore;
  /** Replaces the database kv the localities are read from (tests); null reads none. */
  kv?: KvStore | null;
  /** Replaces the live transport's fetch (tests). */
  fetch?: typeof fetch;
}

/**
 * The Qloo client and the pinned market localities exactly as run-agent opens them for a run (the
 * offline eval, tools/eval, shares it). Without the localities (tools/dev/localities.ts), metro, city
 * and market contexts and the lift map's city filter are not measured, as in the web run manager.
 * Throws CliError when Qloo cannot be configured or Postgres is not reachable.
 */
export async function openAgentQloo(options: AgentQlooOptions): Promise<AgentQloo> {
  const qloo = await openCliQloo({
    env: options.env,
    mock: options.mock,
    tag: options.tag,
    store: options.store ?? (options.memory ? "memory" : "pg"),
    logger: stderrLogger(options.io.err),
    fetch: options.fetch,
  });
  const kv = options.kv !== undefined ? options.kv : options.store === undefined && !options.memory ? pgKv(getDb()) : null;
  return { qloo, localities: kv === null ? null : kvLocalityApi(kv, localitiesKvKey(qloo.client.env)) };
}

function exitCodeFor(result: AgentRunResult): number {
  if (result.status === "completed") return EXIT.ok;
  return result.status === "needs_input" ? EXIT.needsInput : EXIT.failed;
}

/**
 * Picker key → Qloo entity id for each candidate, read back through the mention's /search as the
 * resolution gate sent it, and only when that answer is cached (free, no network call). The picker
 * carries opaque keys (D20); the id is what --pins takes. Empty when the answer is not cached.
 */
export async function pickerPins(client: QlooClient, picker: EventInputOf<"needs_input">, metro: MarketId | null): Promise<Map<string, string>> {
  const pins = new Map<string, string>();
  const params = searchParams({ text: picker.mention, type: picker.entityType, metro: picker.entityType === "place" ? metro : null });
  if (params === null) return pins;
  const qloo = client.standalone().forTool(null);
  try {
    if (!(await qloo.has("/search", params))) return pins;
    const search = await qloo.search(params);
    for (const c of picker.candidates) {
      const chosen = findPickerChoice(search.data.results, c.key);
      if (chosen !== null) pins.set(c.key, chosen.entity_id);
    }
  } catch {
    // No ids: the picker falls back to the run-skill hint.
  }
  return pins;
}

export async function runAgentCommand(argv: readonly string[], deps: AgentCliDeps): Promise<number> {
  const io = safeIo(deps.io);
  const { env } = deps;
  const now = deps.now ?? (() => new Date());
  const signal = deps.signal ?? new AbortController().signal;
  let args: AgentArgs | null;
  try {
    args = parseAgentArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(err.message);
    io.err(RUN_AGENT_USAGE);
    return EXIT.usage;
  }
  if (args === null) {
    io.out(RUN_AGENT_USAGE);
    return EXIT.ok;
  }

  // Presence only: the key goes to the SDK and is never printed.
  const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (apiKey === "") {
    io.err("ANTHROPIC_API_KEY is not set. `pnpm run-agent` loads it from .env; every run calls CLERK and the ANALYST live.");
    return EXIT.failed;
  }

  const limits = DEFAULT_RUN_LIMITS;
  let capUsd: number;
  try {
    capUsd = readUsdCap(env, "LLM_DEV_USD_CAP", DEFAULT_DEV_USD_CAP);
  } catch (err) {
    io.err(errorText(err));
    return EXIT.usage;
  }
  const spendFile = deps.spendFile === undefined ? SPEND_FILE : deps.spendFile;
  let spent: number;
  try {
    spent = spendFile === null ? 0 : readSpend(spendFile).usd;
  } catch (err) {
    io.err(`Refusing to start: ${errorText(err)}`);
    return EXIT.failed;
  }
  // The run stops itself at usdHard; the side calls add at most their own caps on top.
  const side = cliSideConfig(args, env);
  const worstUsd = worstCaseUsd(limits.usdHard, side, args.mode);
  const check = checkSpend(capUsd, spent, worstUsd);
  const config = ANALYST_CONFIGS[args.mode];
  io.out(
    `run-agent · ANALYST ${config.model} (${args.mode}) · side calls: AI context ${side.aiEnabled ? "on" : "off"}, web ${side.webEnabled && args.mode === "live" ? "on" : "off"} · ` +
      `worst case ${formatUsd(check.estimateUsd)} (per-run hard cap) · ` +
      `run-agent spend so far ${formatUsd(spent)} of LLM_DEV_USD_CAP ${formatUsd(capUsd)}`,
  );
  const overCap = (spentUsd: number): string =>
    `Refusing to start: ${formatUsd(spentUsd)} spent plus up to ${formatUsd(check.estimateUsd)} for this run would pass ` +
    `LLM_DEV_USD_CAP (${formatUsd(capUsd)}).`;
  if (!check.ok) {
    io.err(overCap(spent));
    return EXIT.failed;
  }
  if (!args.yes) {
    io.err(`This run calls Anthropic live and may spend up to ${formatUsd(check.estimateUsd)}. Nothing was sent; add --yes to start.`);
    return EXIT.usage;
  }
  if (args.question.length > QUESTION_MAX_CHARS) io.err(`note: the agent reads only the first ${QUESTION_MAX_CHARS} characters of the question`);

  let opened: AgentQloo;
  try {
    opened = await openAgentQloo({ env, io, mock: args.mockQloo, tag: args.tag, memory: args.memory, store: deps.store, kv: deps.kv });
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(err.message);
    return EXIT.failed;
  }
  const { qloo, localities } = opened;

  const runId = cliRunId(now());
  const pins = Object.keys(args.pins).length > 0 ? args.pins : undefined;
  const database = args.persist ? (deps.openDb ?? (() => ({ db: getDb(), close: () => closeDb() })))() : null;
  const closeAll = async (): Promise<void> => {
    try {
      await qloo.close();
    } finally {
      await database?.close();
    }
  };
  let persistence: RunPersistence | null = null;
  if (database !== null) {
    persistence = createRunPersistence(database.db, runId, now, io.err);
    try {
      await persistence.start({ question: args.question, mode: args.mode, lane: args.lane, model: config.model, effort: config.effort, limits, pins });
    } catch (err) {
      io.err(`--persist: could not create the run row: ${errorText(err)}`);
      await closeAll();
      return EXIT.failed;
    }
  }
  if (signal.aborted) {
    io.err("cancelled before the run started; nothing was sent");
    await persistence?.fail("Cancelled before the run started.", 0).catch((e: unknown) => io.err(`--persist: ${errorText(e)}`));
    await closeAll();
    return EXIT.failed;
  }

  // Booked before the first LLM call. The cap is checked again here, with no await between that
  // check and the write, since another run may have booked its own worst case meanwhile.
  if (spendFile !== null) {
    let refusal: string | null;
    try {
      const reserved = reserveSpend(spendFile, capUsd, worstUsd, now());
      refusal = reserved.check.ok ? null : overCap(reserved.check.spentUsd);
    } catch (err) {
      refusal = `Refusing to start: could not book the run's worst case in the spend tally: ${errorText(err)}`;
    }
    if (refusal !== null) {
      io.err(refusal);
      await persistence?.fail("Refused by the LLM_DEV_USD_CAP spend guard.", 0).catch((e: unknown) => io.err(`--persist: ${errorText(e)}`));
      await closeAll();
      return EXIT.failed;
    }
  }
  const settle = (deltaUsd: number, write: (line: string) => void, prefix: string): void => {
    if (spendFile === null) return;
    try {
      const t = deltaUsd === 0 ? readSpend(spendFile) : settleSpend(spendFile, deltaUsd, now());
      write(`${prefix}run-agent spend now ${formatUsd(t.usd)} over ${t.runs} run(s) of LLM_DEV_USD_CAP ${formatUsd(capUsd)}`);
    } catch (err) {
      io.err(`could not update the spend tally (${spendFile}); it keeps this run's worst case: ${errorText(err)}`);
    }
  };

  io.out(
    `run ${runId} · Qloo ${qloo.client.env} · tag ${qloo.tag} · cache ${qloo.storeLabel} · public data ${describePublicData(qloo.publicdata)}` +
      `${persistence !== null ? " · persisted" : ""}\n`,
  );
  const startedAt = now().getTime();
  const trace = createTracePrinter(io, () => now().getTime());
  const emit = (event: EventInput): void => {
    trace.emit(event);
    persistence?.event(event);
  };
  const run = deps.runAgent ?? runAgent;
  let result: AgentRunResult;
  try {
    result = await run({
      runId,
      question: args.question,
      lane: args.lane,
      mode: args.mode,
      emit,
      qloo: qloo.client,
      publicdata: qloo.publicdata,
      anthropic: (deps.createAnthropic ?? createAnthropic)(apiKey),
      limits,
      signal,
      pins,
      parent: null,
      localities,
      // The side context calls (R4, R5); the agent reads these two (see the ops handoff).
      ...({ sideConfig: side, contextCache: qloo.storeLabel.startsWith("postgres") && deps.store === undefined ? pgContextCache(getDb()) : null } as object),
    });
  } catch (err) {
    io.err(`run-agent failed: ${errorText(err)}`);
    // What a run that throws spent is unknown, so the booked worst case stands.
    settle(0, io.err, `counted at its worst case ${formatUsd(worstUsd)}; `);
    await persistence?.fail(errorText(err), now().getTime() - startedAt).catch((e: unknown) => io.err(`--persist: ${errorText(e)}`));
    await closeAll();
    return EXIT.failed;
  }

  const picker = trace.needsInput();
  const answers = picker === null ? new Map<string, string>() : await pickerPins(qloo.client, picker, result.intent ? placeSearchMarket(result.intent.geo) : null);
  for (const line of renderAgentResult(result, picker, answers)) io.out(line);
  settle(result.usd - worstUsd, io.out, "  ");
  if (persistence !== null) {
    try {
      await persistence.finish(result);
      io.out(`  persisted run ${runId}`);
    } catch (err) {
      io.err(`--persist: ${errorText(err)}`);
    }
  }
  await closeAll();
  return exitCodeFor(result);
}
