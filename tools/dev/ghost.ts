// pnpm exec tsx --env-file-if-exists=.env tools/dev/ghost.ts attach <runId> --yes [options]
//
// GHOST for a finished brief (SPEC §6.6 item 2, D23): the run's ANALYST model answers the run's question
// with no tools (@ct/agent ghostForRun), given the places the brief can rank and, for a follow-up, the
// earlier questions of its chain without their answers. Its picks are looked up through the cached Qloo
// /search (at most ten), and the diff against the stored brief is appended to the run as a `ghost` event
// after its last event and stored on the row: runs.ghost, report.ghost and report.receipt.models.ghost. The brief pages
// rebuild the run's state from its events (reduceRunEvents applies a ghost event after run.end), so
// /run/[id] and /r/[id] show "LLM alone vs Culture Terminal" from then on. The LLM call is live and costs
// money: it needs --yes, and its worst case is booked in run-agent's tally against LLM_DEV_USD_CAP
// (tools/dev/cli/spend.ts) before it is sent. Showcase prewarm attaches GHOST through attachGhost.
import path from "node:path";
import {
  ANALYST_CONFIGS,
  createAnthropic,
  GHOST_EARLIER_MAX,
  ghostForRun,
  GhostError,
  ghostMetroOf,
  ghostWorstCaseUsd,
  isPricedModel,
  type AnthropicLike,
  type GhostForRunResult,
  type LlmModel,
} from "@ct/agent";
import {
  DatasetEnvelope,
  Job,
  reduceRunEvents,
  Report,
  RunEvent,
  stampEvent,
  unstampEvent,
  type GhostAnswer,
  type GhostDiff,
  type RunState,
} from "@ct/contracts";
import {
  appendEvents,
  closeDb,
  DEFAULT_EVENT_PAGE,
  getDb,
  getRun,
  isConnectionError,
  lastSeq,
  listEvents,
  listLedgerRows,
  lockRun,
  updateRun,
  type Queryable,
  type Run,
} from "@ct/db";
import type { QlooClient, QlooStore } from "@ct/qloo";
import { parseCli, UsageError } from "./cli/args";
import { formatCount, formatMs, formatUsd } from "./cli/format";
import { consoleIo, EXIT, safeIo, type CliIo } from "./cli/io";
import { CliError, describeDatabase, openCliQloo, stderrLogger } from "./cli/qloo-setup";
import { checkSpend, DEFAULT_DEV_USD_CAP, readSpend, readUsdCap, reserveSpend, settleSpend, SPEND_FILE } from "./cli/spend";
import { terminalSafe } from "./cli/table";

const MODELS = [...new Set(Object.values(ANALYST_CONFIGS).map((c) => c.model))];

export const GHOST_USAGE = [
  "usage: pnpm exec tsx --env-file-if-exists=.env tools/dev/ghost.ts attach <runId> --yes [options]",
  "  attach <runId>     GHOST for a completed brief: the run's ANALYST model with no tools, its picks looked up in Qloo,",
  "                     the diff appended as a ghost event and stored on the run (runs.ghost, report.ghost)",
  "  --yes, -y          confirm the live LLM spend (one GHOST answer)",
  `  --model M          the model GHOST answers with (default: the run's ANALYST, D23): ${MODELS.join(" or ")}`,
  "  --replace          attach a new GHOST to a run that already has one",
  "  --mock-qloo        synthetic Qloo data (QLOO_MOCK=1) for the pick lookups; the LLM call stays live",
  "  --memory           cache Qloo answers in memory instead of the shared Postgres cache (with --mock-qloo only)",
  "  --tag T            QLOO_TAG for the call log and the per-tag network cap",
  "  -h, --help         this text",
  "env: DATABASE_URL (the run's database), ANTHROPIC_API_KEY, LLM_DEV_USD_CAP (default 45, cumulative), QLOO_* as for the app",
  "exit codes: 0 attached, 1 refused or failed, 2 bad arguments or no --yes",
].join("\n");

const OPTIONS = {
  yes: { type: "boolean", short: "y" },
  model: { type: "string" },
  replace: { type: "boolean" },
  "mock-qloo": { type: "boolean" },
  memory: { type: "boolean" },
  tag: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

/** What attach is asked to do. */
export interface GhostAttachOptions {
  runId: string;
  yes: boolean;
  /** --model; null answers with the run's ANALYST model. */
  model: LlmModel | null;
  replace: boolean;
  /** Forces QLOO_MOCK=1 for the pick lookups. */
  mock: boolean;
  /** Caches Qloo answers in memory (synthetic data only). */
  memory: boolean;
  /** Overrides QLOO_TAG. */
  tag: string | null;
}

/** The web's run id rule (apps/web/lib/run-id.ts). */
const RUN_ID = /^[A-Za-z0-9-]{8,64}$/;

/** The parsed command, or null for --help. */
export function parseGhostArgs(argv: readonly string[]): GhostAttachOptions | null {
  const { positionals, options } = parseCli(argv, OPTIONS);
  if (options.help) return null;
  const [command, runId, ...rest] = positionals;
  if (command === undefined) throw new UsageError("name a command: attach <runId>");
  if (command !== "attach") throw new UsageError(`unknown command "${command}": attach <runId>`);
  const id = runId?.trim() ?? "";
  if (id === "") throw new UsageError("attach needs a run id");
  if (!RUN_ID.test(id)) throw new UsageError(`"${runId}" is not a run id`);
  if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
  const model = options.model?.trim() ?? null;
  if (model !== null && !isPricedModel(model)) throw new UsageError(`--model must be ${MODELS.join(" or ")} (D23), got "${options.model}"`);
  const tag = options.tag?.trim() ?? null;
  if (tag === "") throw new UsageError("--tag needs a non-empty value");
  return {
    runId: id,
    yes: options.yes === true,
    model,
    replace: options.replace === true,
    mock: options["mock-qloo"] === true,
    memory: options.memory === true,
    tag,
  };
}

// The run --------------------------------------------------------------------------------------------

/** A run GHOST may not be attached to; the message says why. */
export class GhostRefused extends Error {
  override readonly name = "GhostRefused";
}

/**
 * The stored report GHOST is diffed against, or why the run cannot have one: it is not completed, it
 * stored no report, its report has no job (so GHOST has no lists to fill), or it already has a GHOST
 * and `replace` is off. The runs row's report comes first, the report.final event's after it.
 */
export function checkRun(
  run: Pick<Run, "status" | "ghost" | "report">,
  state: Pick<RunState, "ghost" | "report">,
  replace: boolean,
): { report: Report } | { problem: string } {
  if (run.status !== "completed") {
    const why = run.status === "queued" || run.status === "running" ? "it is still running" : run.status === "needs_input" ? "it is waiting for a pick" : `it ended ${run.status}`;
    return { problem: `${why}; GHOST is attached to completed briefs only` };
  }
  const raw: unknown = run.report ?? state.report;
  if (raw === null || raw === undefined) return { problem: "it stored no report" };
  if (!Job.safeParse((raw as { job?: unknown }).job).success) return { problem: "its report has no job, so GHOST has no pick lists to fill" };
  const parsed = Report.safeParse(raw);
  if (!parsed.success) return { problem: `its stored report does not parse as the contracts' Report (${parsed.error.issues[0]?.message ?? "invalid"})` };
  if (!replace && (run.ghost != null || state.ghost !== null || parsed.data.ghost !== null)) {
    return { problem: "it already has a GHOST column; --replace attaches a new one" };
  }
  return { report: parsed.data };
}

/**
 * The run's datasets for the diff: the ledger's stored envelopes (the datasets table), then any dataset
 * the events streamed inline that the ledger lacks (a run whose ledger was never written).
 */
export function runDatasets(rows: readonly { payload: unknown }[], state: Pick<RunState, "datasets">): DatasetEnvelope[] {
  const byId = new Map<string, DatasetEnvelope>();
  for (const row of rows) {
    const parsed = DatasetEnvelope.safeParse(row.payload);
    if (parsed.success) byId.set(parsed.data.id, parsed.data);
  }
  for (const d of Object.values(state.datasets)) if (d.data !== null && !byId.has(d.data.id)) byId.set(d.data.id, d.data);
  return [...byId.values()];
}

/**
 * The questions of the run's chain before it, oldest first: at most GHOST_EARLIER_MAX, the latest
 * ones, read by walking parent_run_id. A follow-up's ANALYST read its parent's case summary; GHOST
 * gets the questions alone, since the summary carries the parent's Qloo metrics. A missing parent or
 * a loop ends the walk.
 */
export async function earlierQuestions(db: Queryable, run: Pick<Run, "id" | "parentRunId">): Promise<string[]> {
  const questions: string[] = [];
  const seen = new Set([run.id]);
  let ancestor = run.parentRunId;
  while (ancestor && !seen.has(ancestor) && questions.length < GHOST_EARLIER_MAX) {
    seen.add(ancestor);
    const parent = await getRun(db, ancestor);
    if (!parent) break;
    questions.unshift(parent.question);
    ancestor = parent.parentRunId;
  }
  return questions;
}

/** The stored report with GHOST on it, as the contracts define both: report.ghost and receipt.models.ghost. */
export function withGhost(report: Report, ghost: { answer: GhostAnswer; diff: GhostDiff }, model: LlmModel): Report {
  return Report.parse({ ...report, ghost, receipt: { ...report.receipt, models: { ...report.receipt.models, ghost: model } } });
}

/** Every stored event of the run, rebuilt as the SSE route reads them back; a row that breaks the contracts is skipped. */
export async function readRunEvents(db: Queryable, runId: string): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  let after: number | undefined;
  for (;;) {
    const rows = await listEvents(db, runId, after);
    for (const row of rows) {
      const payload = typeof row.payload === "object" && row.payload !== null ? row.payload : {};
      const parsed = RunEvent.safeParse({ ...payload, type: row.type, seq: row.seq, ts: row.ts.toISOString(), runId: row.runId });
      if (parsed.success) events.push(parsed.data);
    }
    const last = rows.at(-1);
    if (rows.length < DEFAULT_EVENT_PAGE || !last) return events;
    after = last.seq;
  }
}

/**
 * Appends the ghost event after the run's last event and stores GHOST on the row, in one transaction with
 * the row locked, so the event and the columns never disagree. The run is checked again on the locked
 * row. Returns the event's seq.
 */
export async function storeGhost(
  db: Queryable,
  runId: string,
  ghost: { answer: GhostAnswer; diff: GhostDiff },
  model: LlmModel,
  options: { replace: boolean; now: Date },
): Promise<number> {
  return db.transaction(async (tx) => {
    const run = await lockRun(tx, runId);
    if (!run) throw new GhostRefused(`run ${runId} no longer exists`);
    if (run.status !== "completed") throw new GhostRefused(`run ${runId} is now ${run.status}`);
    if (run.ghost != null && !options.replace) throw new GhostRefused(`another attach stored a GHOST on run ${runId} meanwhile; --replace attaches a new one`);
    const seq = ((await lastSeq(tx, runId)) ?? 0) + 1;
    const event = RunEvent.parse(stampEvent({ type: "ghost", ...ghost }, { seq, ts: options.now.toISOString(), runId }));
    const { type, ...payload } = unstampEvent(event).input;
    if ((await appendEvents(tx, runId, [{ seq, type, payload, ts: new Date(event.ts) }])) !== 1) {
      throw new Error(`seq ${seq} of run ${runId} was taken by another writer`);
    }
    const stored = Report.safeParse(run.report);
    await updateRun(tx, runId, { ghost, ...(stored.success ? { report: withGhost(stored.data, ghost, model) } : {}) });
    return seq;
  });
}

// Attach ---------------------------------------------------------------------------------------------

export interface GhostAttachDeps {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  /**
   * The run's database, asked for on every use: closing a Qloo client over the shared Postgres cache
   * closes the shared pool, and the next call opens it again.
   */
  db: () => Queryable;
  /** Where the database is, for messages (default: DATABASE_URL without credentials). */
  where?: string;
  createAnthropic?: (apiKey: string) => AnthropicLike;
  /** Replaces the Postgres or memory Qloo store (tests). */
  store?: QlooStore;
  /** Replaces the whole Qloo client the picks are looked up through (showcase tests). */
  openQloo?: () => Promise<{ client: QlooClient; close(): Promise<void> }>;
  /** run-agent's spend tally; null keeps none. */
  spendFile?: string | null;
  signal?: AbortSignal;
  now?: () => Date;
}

export type GhostAttachOutcome =
  | { status: "attached"; runId: string; seq: number; model: LlmModel; usd: number; diff: GhostDiff }
  /** Nothing was sent. */
  | { status: "refused"; reason: string }
  /** No --yes: the plan was printed and nothing was sent. */
  | { status: "unconfirmed" }
  /** The model was called; its spend is in the tally. usd: what it cost, null when unknown (the tally keeps the worst case). */
  | { status: "failed"; reason: string; usd: number | null };

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const percent = (x: number | null): string => (x === null ? "not measured" : `${Math.round(x * 100)}%`);

function databaseLabel(deps: GhostAttachDeps): string {
  if (deps.where) return deps.where;
  try {
    return describeDatabase(deps.env);
  } catch {
    return "(DATABASE_URL unset)";
  }
}

/** "2 both · 3 only Qloo · 4 LLM only (1 resolves in Qloo, 2 do not, 1 not checked) · overlap@5 20% · …". */
export function diffLine(diff: GhostDiff): string {
  const of = (status: GhostDiff["items"][number]["status"]) => diff.items.filter((i) => i.status === status);
  const llm = of("llm_only");
  const resolves = llm.filter((i) => i.resolvesInQloo === true).length;
  const not = llm.filter((i) => i.resolvesInQloo === false).length;
  const unchecked = llm.length - resolves - not;
  return (
    `${of("both").length} both · ${of("qloo_only").length} only Qloo · ${llm.length} LLM only ` +
    `(${resolves} resolve in Qloo, ${not} do not, ${unchecked} not checked) · overlap@5 ${percent(diff.overlapAt5)} · ` +
    `resolvability ${percent(diff.resolvability)} · ${diff.unsourcedNumericClaims} number(s) with no source`
  );
}

async function openQloo(deps: GhostAttachDeps, options: GhostAttachOptions): Promise<{ client: QlooClient; close(): Promise<void>; label: string }> {
  if (deps.openQloo) return { ...(await deps.openQloo()), label: "provided client" };
  const qloo = await openCliQloo({
    env: deps.env,
    mock: options.mock,
    tag: options.tag,
    store: deps.store ?? (options.memory ? "memory" : "pg"),
    logger: stderrLogger(deps.io.err),
  });
  return { client: qloo.client, close: qloo.close, label: `Qloo ${qloo.client.env} · tag ${qloo.tag} · cache ${qloo.storeLabel}` };
}

/**
 * GHOST for one completed run: checks the run, prints the plan and its worst case, and with `yes` books
 * the worst case, asks the model (with the chain's earlier questions for a follow-up), looks the picks
 * up, stores the event and the columns, and settles the tally to what the answer cost. The run's registry is not stored, so the diff matches GHOST's picks to
 * the brief's names by name, market and area (buildGhostDiff's fallbacks), never by entity id.
 */
export async function attachGhost(deps: GhostAttachDeps, options: GhostAttachOptions): Promise<GhostAttachOutcome> {
  const io = safeIo(deps.io);
  const { env } = deps;
  const now = deps.now ?? (() => new Date());
  const refuse = (reason: string): GhostAttachOutcome => {
    io.err(`Refusing to attach GHOST to run ${options.runId}: ${reason}.`);
    return { status: "refused", reason };
  };

  const run = await getRun(deps.db(), options.runId);
  if (!run) return refuse(`there is no such run in ${databaseLabel(deps)}`);
  const state = reduceRunEvents(run.id, await readRunEvents(deps.db(), run.id));
  const checked = checkRun(run, state, options.replace);
  if ("problem" in checked) return refuse(checked.problem);
  const { report } = checked;
  const analyst = report.receipt.models.analyst ?? run.model;
  const model = options.model ?? analyst;
  if (model === null || !isPricedModel(model)) return refuse(`its ANALYST model is ${model ?? "not recorded"}; pass --model ${MODELS.join(" or ")}`);
  const datasets = runDatasets((await listLedgerRows(deps.db(), run.id)).datasets, state);
  const earlier = await earlierQuestions(deps.db(), run);

  // Presence only: the key goes to the SDK and is never printed.
  const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (apiKey === "") return refuse("ANTHROPIC_API_KEY is not set (run the tool with --env-file-if-exists=.env)");
  let capUsd: number;
  try {
    capUsd = readUsdCap(env, "LLM_DEV_USD_CAP", DEFAULT_DEV_USD_CAP);
  } catch (err) {
    return refuse(errorText(err));
  }
  const spendFile = deps.spendFile === undefined ? SPEND_FILE : deps.spendFile;
  let spent: number;
  try {
    spent = spendFile === null ? 0 : readSpend(spendFile).usd;
  } catch (err) {
    return refuse(errorText(err));
  }
  const worst = ghostWorstCaseUsd(model);
  const which = model === analyst ? "the run's ANALYST" : `not the run's ANALYST ${analyst ?? "(not recorded)"}; D23 keeps them the same`;
  const chain = earlier.length === 0 ? "" : ` · after ${earlier.length} earlier question(s) of its chain`;
  io.out(
    `ghost attach · run ${run.id} · ${report.job} · ${datasets.length} dataset(s)${chain} · GHOST ${model} (${which}) · worst case ${formatUsd(worst)} · ` +
      `run-agent spend so far ${formatUsd(spent)} of LLM_DEV_USD_CAP ${formatUsd(capUsd)}`,
  );
  const overCap = (spentUsd: number): string =>
    `${formatUsd(spentUsd)} spent plus up to ${formatUsd(worst)} for GHOST would pass LLM_DEV_USD_CAP (${formatUsd(capUsd)})`;
  if (!checkSpend(capUsd, spent, worst).ok) return refuse(overCap(spent));
  if (!options.yes) {
    io.err(`This calls Anthropic live once and may spend up to ${formatUsd(worst)}. Nothing was sent; add --yes to start.`);
    return { status: "unconfirmed" };
  }

  let qloo: Awaited<ReturnType<typeof openQloo>>;
  try {
    qloo = await openQloo(deps, options);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    return refuse(err.message);
  }
  const settle = (deltaUsd: number): string => {
    if (spendFile === null) return "";
    try {
      const t = deltaUsd === 0 ? readSpend(spendFile) : settleSpend(spendFile, deltaUsd, now());
      return ` · run-agent spend now ${formatUsd(t.usd)} over ${t.runs} run(s) of LLM_DEV_USD_CAP ${formatUsd(capUsd)}`;
    } catch (err) {
      io.err(`could not update the spend tally (${spendFile}); it keeps GHOST's worst case: ${errorText(err)}`);
      return "";
    }
  };
  try {
    // Booked before the call, with no await between the cap check and the write.
    if (spendFile !== null) {
      let refusal: string | null;
      try {
        const reserved = reserveSpend(spendFile, capUsd, worst, now());
        refusal = reserved.check.ok ? null : overCap(reserved.check.spentUsd);
      } catch (err) {
        refusal = `could not book GHOST's worst case in the spend tally: ${errorText(err)}`;
      }
      if (refusal !== null) return refuse(refusal);
    }
    io.out(`  ${qloo.label}`);
    let lookups = 0;
    const tool = qloo.client.standalone({ onCall: () => (lookups += 1), signal: deps.signal }).forTool(null);
    let result: GhostForRunResult;
    try {
      result = await ghostForRun({
        report,
        datasets,
        model,
        anthropic: (deps.createAnthropic ?? createAnthropic)(apiKey),
        search: (params) => tool.search(params),
        // taste_twins: the twins are areas of the target city, so GHOST is shown that city's areas.
        metro: state.intent ? ghostMetroOf(state.intent) : null,
        earlier,
        log: io.err,
        signal: deps.signal,
      });
    } catch (err) {
      // A response that arrived has a known cost; with none, the booked worst case stands.
      const cost = err instanceof GhostError && err.usage !== null ? err.usd : null;
      const tally = settle(cost === null ? 0 : cost - worst);
      io.err(`GHOST failed: ${errorText(err)} (${cost === null ? `counted at its worst case ${formatUsd(worst)}` : `it spent ${formatUsd(cost)}`})${tally}`);
      return { status: "failed", reason: errorText(err), usd: cost };
    }
    const u = result.usage;
    io.out(
      `  GHOST ${result.model} · ${formatUsd(result.usd)} · ${formatMs(result.ms)} · in ${formatCount(u.input + u.cacheRead + u.cacheCreation)} · ` +
        `out ${formatCount(u.output)} tokens · ${lookups} Qloo lookup call(s)${settle(result.usd - worst)}`,
    );
    io.out(`  diff · ${diffLine(result.diff)}`);
    let seq: number;
    try {
      seq = await storeGhost(deps.db(), run.id, { answer: result.answer, diff: result.diff }, result.model, { replace: options.replace, now: now() });
    } catch (err) {
      if (!(err instanceof GhostRefused)) throw err;
      io.err(`GHOST was answered but not stored: ${err.message}.`);
      return { status: "failed", reason: err.message, usd: result.usd };
    }
    io.out(`  stored as event ${seq} of run ${run.id} (runs.ghost, report.ghost, receipt.models.ghost); /run/${run.id} shows it`);
    return { status: "attached", runId: run.id, seq, model: result.model, usd: result.usd, diff: result.diff };
  } finally {
    await qloo.close();
  }
}

// Entry ----------------------------------------------------------------------------------------------

export interface GhostCliDeps extends Omit<GhostAttachDeps, "db"> {
  /** The run's database (default: the shared pool from DATABASE_URL). */
  db?: () => Queryable;
}

export async function runGhostCommand(argv: readonly string[], deps: GhostCliDeps): Promise<number> {
  const io = safeIo(deps.io);
  let options: GhostAttachOptions | null;
  try {
    options = parseGhostArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(err.message);
    io.err(GHOST_USAGE);
    return EXIT.usage;
  }
  if (options === null) {
    io.out(GHOST_USAGE);
    return EXIT.ok;
  }
  const attach = { ...deps, io, db: deps.db ?? (() => getDb()) };
  try {
    const outcome = await attachGhost(attach, options);
    return outcome.status === "attached" ? EXIT.ok : outcome.status === "unconfirmed" ? EXIT.usage : EXIT.failed;
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    io.err(`Postgres is not reachable at ${databaseLabel(attach)}. Start it with \`pnpm db:up\`, or set DATABASE_URL.`);
    return EXIT.failed;
  }
}

// Run as a script (tools/eval/ghost.ts shares the file name, so the folder is checked too).
const entry = process.argv[1] ?? "";
if (path.basename(entry) === "ghost.ts" && path.basename(path.dirname(entry)) === "dev") {
  const controller = new AbortController();
  // A listener that stays: with one registered, Node no longer exits on SIGINT by itself.
  process.on("SIGINT", () => {
    if (!controller.signal.aborted) {
      consoleIo.err("\ncancelling (Ctrl+C again to quit at once; the spend tally keeps GHOST's worst case)");
      controller.abort(new Error("cancelled from the terminal"));
      return;
    }
    process.exit(130);
  });
  runGhostCommand(process.argv.slice(2), { env: process.env, io: consoleIo, signal: controller.signal })
    .then(
      (code) => {
        process.exitCode = code;
      },
      (err: unknown) => {
        consoleIo.err(terminalSafe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
        process.exitCode = 1;
      },
    )
    .finally(() => closeDb());
}
