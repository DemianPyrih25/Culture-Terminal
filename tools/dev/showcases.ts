// pnpm exec tsx --env-file-if-exists=.env tools/dev/showcases.ts <command>
//
// The curated showcases (PLAN §9 and Part 6, SPEC §9 and §11.6): which stored run each slug of
// config/showcases.json opens, and the entities each one pins. `list` shows them; `pin` marks a
// finished agent run as a slug's showcase once it checks the run; `unpin` takes it off; `pins` stores
// the entities a run resolved (showcase_pins) so a rerun resolves the same ones; `prewarm` records a
// showcase live through run-agent's path (LLM and Qloo calls that cost money, so it needs --yes, and
// the spend counts toward the web's daily LLM budget), pins the result and attaches GHOST to it
// (tools/dev/ghost.ts attachGhost; --no-ghost skips it). The database is DATABASE_URL's; entity ids
// live only there, never in git (D29).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ANALYST_CONFIGS,
  buildCaseSummary,
  ghostWorstCaseUsd,
  runAgent,
  sanitizeQuestion,
  type AgentRunOptions,
  type AgentRunResult,
  type AnalystMode,
} from "@ct/agent";
import { DEFAULT_RUN_LIMITS, placeSearchMarket, reduceRunEvents, Report, RunEvent, type RunState } from "@ct/contracts";
import {
  closeDb,
  DEFAULT_EVENT_PAGE,
  getDb,
  getPinnedShowcase,
  getRun,
  incrementQlooUsage,
  isConnectionError,
  listEvents,
  listPinnedShowcases,
  listShowcasePins,
  pinRunCacheEntries,
  pinShowcaseRun,
  replaceShowcasePins,
  SHOWCASE_SLUG,
  unpinShowcase,
  updateRun,
  type PinVerifier,
  type Queryable,
  type Run,
  type RunStatus,
  type ShowcasePinInput,
} from "@ct/db";
import { resolveQlooEnv, utcDay, type QlooClient } from "@ct/qloo";
import { classifyMatches, normaliseName, searchParams } from "@ct/quant";
import { z } from "zod";
import { runAgentCommand, type AgentCliDeps } from "./cli/agent-cli";
import { parseCli, UsageError } from "./cli/args";
import { formatUsd, NONE } from "./cli/format";
import { consoleIo, EXIT, heading, safeIo, type CliIo } from "./cli/io";
import { CliError, describeDatabase, openCliQloo, stderrLogger } from "./cli/qloo-setup";
import { renderTable, terminalSafe } from "./cli/table";
import { attachGhost, type GhostAttachOutcome } from "./ghost";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
export const SHOWCASES_FILE = path.join(ROOT, "config", "showcases.json");

export const SHOWCASES_USAGE = [
  "usage: pnpm exec tsx --env-file-if-exists=.env tools/dev/showcases.ts <command>",
  "  list                       config/showcases.json and the run each slug opens",
  "  pin <slug> <runId>         pin a finished agent run as the slug's showcase (its question must match)",
  "  unpin <slug>               unpin the slug's showcase run",
  "  pins <slug> [<runId>]      store the entities the run resolved (default: the slug's pinned run) in showcase_pins",
  "  prewarm <slug> --yes       record the slug's showcase live (CLERK, ANALYST, Qloo), pin it and attach GHOST",
  "  prewarm --all --yes        every showcase, the chain and the trust example, in config order",
  "  --tag T                    prewarm: QLOO_TAG for the call log and the per-tag network cap",
  "  --no-ghost                 prewarm: pin without GHOST (by default each completed showcase gets it once pinned)",
  "  -h, --help                 this text",
  "env: DATABASE_URL (the target database); prewarm also ANTHROPIC_API_KEY, QLOO_API_KEY (never QLOO_MOCK) and LLM_DEV_USD_CAP",
  "exit codes: 0 done, 1 refused or failed, 2 bad arguments or no --yes",
].join("\n");

// config/showcases.json -----------------------------------------------------------------------------

const Slug = z.string().regex(SHOWCASE_SLUG);
const Question = z.string().trim().min(1);

/** The parts of config/showcases.json this tool reads; packages/agent's config test checks the rest. */
export const ShowcaseConfig = z.object({
  showcases: z.array(z.object({ code: z.string().min(1), slug: Slug, desk: z.string(), question: Question })).min(1),
  chain: z.object({
    slug: Slug,
    title: z.string(),
    steps: z.array(z.object({ step: z.number().int().positive(), from: z.string().nullable(), question: Question })).min(1),
  }),
  trust: z.object({ slug: Slug, question: Question }),
});
export type ShowcaseConfig = z.infer<typeof ShowcaseConfig>;

export function loadShowcaseConfig(file: string = SHOWCASES_FILE): ShowcaseConfig {
  return ShowcaseConfig.parse(JSON.parse(readFileSync(file, "utf8")));
}

export interface ChainStep {
  step: number;
  /** The showcase code this step starts from (its pinned run can stand in for it), or null. */
  from: string | null;
  question: string;
}

/** One pinnable slug of the config. */
export interface ShowcaseEntry {
  kind: "showcase" | "chain" | "trust";
  /** S1…S7, CHAIN or TRUST. */
  code: string;
  slug: string;
  /** showcase_order: the position in config/showcases.json, from 1. */
  order: number;
  desk: string | null;
  /** The question the pinned run asks; the chain's is its last step's. */
  question: string;
  /** How the pinned run ended: the trust example is a refusal, every other showcase a finished note. */
  status: RunStatus;
  /** The chain's steps, oldest first; each later one is a follow-up of the one before. Empty otherwise. */
  steps: ChainStep[];
}

/** The pinnable slugs in config order: the showcases, then the chain, then the trust example. */
export function showcaseEntries(config: ShowcaseConfig): ShowcaseEntry[] {
  const entries: ShowcaseEntry[] = config.showcases.map((s, i) => ({
    kind: "showcase",
    code: s.code,
    slug: s.slug,
    order: i + 1,
    desk: s.desk,
    question: s.question,
    status: "completed",
    steps: [],
  }));
  const steps = config.chain.steps.map((s) => ({ step: s.step, from: s.from, question: s.question }));
  const last = steps.at(-1);
  if (last) {
    entries.push({ kind: "chain", code: "CHAIN", slug: config.chain.slug, order: entries.length + 1, desk: "all", question: last.question, status: "completed", steps });
  }
  entries.push({ kind: "trust", code: "TRUST", slug: config.trust.slug, order: entries.length + 1, desk: null, question: config.trust.question, status: "refused", steps: [] });
  return entries;
}

// Questions, hashes and the checks before a pin ------------------------------------------------------

/** A question as the answer cache reads it: sanitized as the models see it, NFKC, spaces collapsed, any case. */
export function questionKey(question: string): string {
  return sanitizeQuestion(question).normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

export function sameQuestion(a: string, b: string): boolean {
  return questionKey(a) === questionKey(b);
}

/** Agent runs the web starts, and runs this tool adopts, carry this question-hash prefix (apps/web/server/question-hash.ts). */
export const AGENT_HASH_PREFIX = "q1:";
const TEST_HASH_PREFIX = "fake:";
const CLI_HASH_PREFIX = "cli:";

/**
 * The web's answer-cache key (D26) for a question, its pins and its mode: apps/web/server/question-hash.ts
 * questionHash, which tools cannot import (it is server-only). A test keeps the two in step. An adopted
 * run gets the unpinned key (adoptedHash), so the library lists it, the answer cache serves it to the
 * same typed question and it can be followed up.
 */
/** The web's ANSWER_VERSION (apps/web/server/question-hash.ts), which the key carries; the same test keeps it in step. */
export const WEB_ANSWER_VERSION = 3;

export function webQuestionHash(question: string, pins: Readonly<Record<string, string>> | undefined, mode: AnalystMode): string {
  const normalised = sanitizeQuestion(question).normalize("NFKC").toLowerCase();
  const sortedPins = Object.entries(pins ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const digest = createHash("sha256").update(JSON.stringify([normalised, sortedPins, mode, { answerVersion: WEB_ANSWER_VERSION }])).digest("hex");
  return `${AGENT_HASH_PREFIX}${digest}`;
}

const StoredPins = z.record(z.string(), z.string()).nullable();

/** The pins a run row stored (normalised mention → entity id), or undefined when it has none. */
export function storedPins(value: unknown): Record<string, string> | undefined {
  const parsed = StoredPins.safeParse(value ?? null);
  return parsed.success && parsed.data !== null && Object.keys(parsed.data).length > 0 ? parsed.data : undefined;
}

/**
 * The web's key for a run this tool adopts: the key a visitor's question gets, which has no pins (the
 * answer cache looks a typed question up unpinned). The pins are the curated resolution of the question's
 * own mentions; they stay in runs.pins for a rerun.
 */
export function adoptedHash(run: Pick<Run, "question" | "mode">): string {
  return webQuestionHash(run.question, undefined, run.mode);
}

/** A run that may not be pinned; the message says why. */
export class PinRefused extends Error {
  override readonly name = "PinRefused";
}

/**
 * Why a run may not stand for a showcase question, or null when it may. `adopt`: the run was recorded by
 * prewarm on live Qloo data just now, so its run-agent prefix is accepted (the pin gives it the web's key).
 */
export function runProblem(run: Pick<Run, "questionHash" | "status" | "question">, question: string, status: RunStatus, adopt = false): string | null {
  const hash = run.questionHash;
  if (hash.startsWith(TEST_HASH_PREFIX)) return "it is a test run: its brief is invented";
  if (hash.startsWith(CLI_HASH_PREFIX) && !adopt) {
    return "run-agent stored it (--persist), and a CLI run may be on synthetic Qloo data; record the showcase with `prewarm`, or pin a run the web recorded";
  }
  if (!hash.startsWith(AGENT_HASH_PREFIX) && !(adopt && hash.startsWith(CLI_HASH_PREFIX))) return "it is not an agent run";
  if (run.status !== status) {
    return run.status === "queued" || run.status === "running" ? "it is still running" : `it ended ${run.status}, and this showcase needs a ${status} run`;
  }
  if (!sameQuestion(run.question, question)) return `its question is not the showcase's: "${run.question}"`;
  return null;
}

/**
 * The chain's pinned run is its last step; each step before it is that run's parent, grandparent and so
 * on, every one a finished agent run asking its step's question (SPEC §9, the chain tile).
 */
async function chainProblem(db: Queryable, last: Run, steps: readonly ChainStep[]): Promise<string | null> {
  let child = last;
  for (let i = steps.length - 2; i >= 0; i--) {
    const step = steps[i];
    if (!step) break;
    const parentId = child.parentRunId;
    if (parentId === null) return `step ${step.step + 1} has no parent run: the chain is recorded as follow-ups of one another`;
    const parent = await getRun(db, parentId);
    if (!parent) return `step ${step.step}'s run ${parentId} no longer exists`;
    const problem = runProblem(parent, step.question, "completed");
    if (problem !== null) return `step ${step.step} (run ${parent.id}): ${problem}`;
    child = parent;
  }
  return null;
}

/** The checks pinShowcaseRun runs on the locked row before it pins. */
export function pinVerifier(entry: ShowcaseEntry, adopt = false): PinVerifier {
  return async (run, tx) => {
    const problem = runProblem(run, entry.question, entry.status, adopt) ?? (entry.kind === "chain" ? await chainProblem(tx, run, entry.steps) : null);
    if (problem !== null) throw new PinRefused(problem);
  };
}

// Commands -------------------------------------------------------------------------------------------

export type ShowcaseCommand =
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "pin"; slug: string; runId: string }
  | { kind: "unpin"; slug: string }
  | { kind: "pins"; slug: string; runId: string | null }
  /** ghost: attach GHOST to each completed showcase once it is pinned (--no-ghost turns it off). */
  | { kind: "prewarm"; slug: string | null; yes: boolean; tag: string | null; ghost: boolean };

const OPTIONS = {
  yes: { type: "boolean", short: "y" },
  all: { type: "boolean" },
  tag: { type: "string" },
  ghost: { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

function slugArg(raw: string | undefined, command: string): string {
  if (raw === undefined) throw new UsageError(`${command} needs a slug (\`list\` shows them)`);
  if (!SHOWCASE_SLUG.test(raw)) throw new UsageError(`"${raw}" is not a showcase slug (\`list\` shows them)`);
  return raw;
}

function runIdArg(raw: string | undefined, command: string): string {
  const id = raw?.trim() ?? "";
  if (id === "") throw new UsageError(`${command} needs a run id`);
  if (!/^[A-Za-z0-9-]{8,64}$/.test(id)) throw new UsageError(`"${raw}" is not a run id`);
  return id;
}

export function parseShowcaseArgs(argv: readonly string[]): ShowcaseCommand {
  const { positionals, options } = parseCli(argv, OPTIONS);
  if (options.help) return { kind: "help" };
  const [command, ...rest] = positionals;
  const prewarm = command === "prewarm";
  if (!prewarm && (options.yes !== undefined || options.all !== undefined || options.tag !== undefined || options.ghost !== undefined)) {
    throw new UsageError("--yes, --all, --tag and --no-ghost belong to prewarm");
  }
  const most = (n: number) => {
    if (rest.length > n) throw new UsageError(`${command} takes at most ${n} argument(s), got ${rest.length}`);
  };
  switch (command) {
    case undefined:
      throw new UsageError("name a command: list, pin, unpin, pins or prewarm");
    case "list":
      most(0);
      return { kind: "list" };
    case "pin":
      most(2);
      return { kind: "pin", slug: slugArg(rest[0], "pin"), runId: runIdArg(rest[1], "pin") };
    case "unpin":
      most(1);
      return { kind: "unpin", slug: slugArg(rest[0], "unpin") };
    case "pins":
      most(2);
      return { kind: "pins", slug: slugArg(rest[0], "pins"), runId: rest[1] === undefined ? null : runIdArg(rest[1], "pins") };
    case "prewarm": {
      most(1);
      const all = options.all === true;
      if (all === (rest[0] !== undefined)) throw new UsageError("prewarm takes one slug or --all");
      const tag = options.tag?.trim() ?? null;
      if (tag === "") throw new UsageError("--tag needs a non-empty value");
      return { kind: "prewarm", slug: all ? null : slugArg(rest[0], "prewarm"), yes: options.yes === true, tag, ghost: options.ghost !== false };
    }
    default:
      throw new UsageError(`unknown command "${command}": list, pin, unpin, pins or prewarm`);
  }
}

export interface ShowcasesDeps {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  /**
   * The target database, asked for on every use: run-agent closes the shared pool when a run ends, and
   * the next call opens it again.
   */
  db: () => Queryable;
  /** Where the database is, for the header lines (default: DATABASE_URL without credentials). */
  where?: string;
  /** config/showcases.json, parsed (default: read from the repo). */
  config?: ShowcaseConfig;
  /**
   * The Qloo client `pins` reads the /search cache through, and prewarm's GHOST looks its picks up
   * through (default: the shared Postgres cache; GHOST's under prewarm's --tag).
   */
  openQloo?: () => Promise<{ client: QlooClient; close(): Promise<void> }>;
  /** What prewarm hands run-agent for each run, and GHOST after it (tests: a scripted agent, a memory store, a clock). */
  agent?: Partial<Pick<AgentCliDeps, "runAgent" | "createAnthropic" | "store" | "spendFile" | "now">>;
  /** Cancels prewarm: the run in progress stops and no further run starts. */
  signal?: AbortSignal;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const stamp = (d: Date): string => d.toISOString().slice(0, 16).replace("T", " ");

function databaseLabel(deps: ShowcasesDeps): string {
  if (deps.where) return deps.where;
  try {
    return describeDatabase(deps.env);
  } catch {
    return "(DATABASE_URL unset)";
  }
}

function findEntry(entries: readonly ShowcaseEntry[], slug: string, io: CliIo): ShowcaseEntry | null {
  const entry = entries.find((e) => e.slug === slug) ?? null;
  if (entry === null) io.err(`"${slug}" is not a slug of config/showcases.json; \`list\` shows them.`);
  return entry;
}

/** Every stored event of the run, rebuilt as the SSE route reads them back; a row that breaks the contracts is skipped. */
async function readEvents(db: Queryable, runId: string): Promise<RunEvent[]> {
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

async function list(deps: ShowcasesDeps, entries: readonly ShowcaseEntry[]): Promise<number> {
  const { io } = deps;
  const pinned = await listPinnedShowcases(deps.db());
  const pins = await listShowcasePins(deps.db());
  const bySlug = new Map(pinned.map((p) => [p.slug, p]));
  const pinCount = (slug: string) => pins.filter((p) => p.slug === slug).length;
  io.out(`showcases · config/showcases.json · database ${databaseLabel(deps)}`);
  const rows = entries.map((e) => {
    const run = bySlug.get(e.slug);
    return [String(e.order), e.code, e.slug, e.desk ?? NONE, run?.runId ?? NONE, run?.status ?? NONE, run ? stamp(run.createdAt) : NONE, String(pinCount(e.slug)), e.question];
  });
  const columns = [
    { header: "#", align: "right" as const },
    { header: "CODE" },
    { header: "SLUG" },
    { header: "DESK" },
    { header: "PINNED RUN" },
    { header: "STATUS" },
    { header: "RECORDED (UTC)" },
    { header: "PINS", align: "right" as const },
    { header: "QUESTION", max: 56 },
  ];
  for (const line of renderTable(columns, rows, { indent: "  " })) io.out(line);
  const known = new Set(entries.map((e) => e.slug));
  for (const p of pinned.filter((x) => !known.has(x.slug))) {
    io.out(`  note: run ${p.runId} is pinned as "${p.slug}", which config/showcases.json no longer lists; \`unpin ${p.slug}\` takes it off`);
  }
  const open = entries.filter((e) => !bySlug.has(e.slug)).length;
  io.out(heading(`${entries.length - open} of ${entries.length} pinned`));
  return EXIT.ok;
}

/** Pins the run; prints what changed. False when the run is missing or refused. */
async function pinRun(deps: ShowcasesDeps, entry: ShowcaseEntry, runId: string, adopt: boolean): Promise<boolean> {
  const { io } = deps;
  const questionHash = adopt ? await adoptHashOf(deps.db(), runId) : undefined;
  let result: Awaited<ReturnType<typeof pinShowcaseRun>>;
  try {
    result = await pinShowcaseRun(deps.db(), { slug: entry.slug, runId, order: entry.order, ...(questionHash ? { questionHash } : {}) }, pinVerifier(entry, adopt));
  } catch (err) {
    if (!(err instanceof PinRefused)) throw err;
    io.err(`Refusing to pin run ${runId} as ${entry.slug}: ${err.message}.`);
    return false;
  }
  if (!result) {
    io.err(`There is no run ${runId} in ${databaseLabel(deps)}.`);
    return false;
  }
  io.out(`pinned run ${runId} as ${entry.code} ${entry.slug} (order ${entry.order})`);
  if (result.replaced.length > 0) io.out(`  unpinned ${result.replaced.join(", ")}, which held ${entry.slug} before`);
  if (result.movedFrom !== null) io.out(`  it was pinned as ${result.movedFrom}, which now has no run`);
  const cache = await pinRunCacheEntries(deps.db(), runId);
  io.out(`  pinned ${cache.pinned} of the ${cache.keys} cached Qloo answers it used (they no longer expire)`);
  return true;
}

async function adoptHashOf(db: Queryable, runId: string): Promise<string | undefined> {
  const run = await getRun(db, runId);
  return run && !run.questionHash.startsWith(AGENT_HASH_PREFIX) ? adoptedHash(run) : undefined;
}

async function pin(deps: ShowcasesDeps, entries: readonly ShowcaseEntry[], slug: string, runId: string): Promise<number> {
  const entry = findEntry(entries, slug, deps.io);
  if (entry === null) return EXIT.failed;
  if (!(await pinRun(deps, entry, runId, false))) return EXIT.failed;
  deps.io.out(`next: \`pins ${entry.slug}\` stores the entities it resolved, so a rerun resolves the same ones`);
  return EXIT.ok;
}

async function unpin(deps: ShowcasesDeps, slug: string): Promise<number> {
  const ids = await unpinShowcase(deps.db(), slug);
  deps.io.out(ids.length === 0 ? `nothing was pinned as ${slug}` : `unpinned ${slug}: run ${ids.join(", ")}`);
  return EXIT.ok;
}

// pins ------------------------------------------------------------------------------------------------

/** One mention a run resolved exactly, and the entity id behind it or why it could not be read. */
export interface PinFinding {
  mention: string;
  name: string;
  type: string;
  entityId: string | null;
  /** "run pin": the run itself was pinned to it; "cache": the mention's cached /search answer. */
  source: "run pin" | "cache" | null;
  problem: string | null;
}

/**
 * The entity behind every mention the run's resolution gate resolved exactly (D20), once per normalised
 * mention. Only the gate reads pins (runAgent keys them by normalised mention alone), and it searches with
 * exactly the params rebuilt here; resolve_entities searches places in a metro its event does not record,
 * so its resolutions are left out. The first resolution of a mention wins, as the gate orders the primary
 * first. The events carry only R# refs (entity ids never stream), so each id is the run's own pin for
 * that mention, or the exact match in the mention's /search answer, read from the Qloo cache only: the
 * same answer the run classified, so no network call and no new matching.
 */
export async function findPins(
  state: Pick<RunState, "resolves" | "intent">,
  runPins: Readonly<Record<string, string>>,
  openQloo: () => Promise<{ client: QlooClient; close(): Promise<void> }>,
): Promise<PinFinding[]> {
  const seen = new Set<string>();
  const exact = state.resolves.filter((r) => {
    const key = normaliseName(r.mention);
    if (r.match !== "exact" || r.source !== "gate" || key === "" || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const findings: PinFinding[] = [];
  let session: { client: QlooClient; close(): Promise<void> } | null = null;
  try {
    for (const r of exact) {
      const base = { mention: r.mention, name: r.name ?? r.mention, type: r.entityType };
      const key = normaliseName(r.mention);
      const own = Object.hasOwn(runPins, key) ? runPins[key] : undefined;
      if (own) {
        findings.push({ ...base, entityId: own, source: "run pin", problem: null });
        continue;
      }
      const params = searchParams({ text: r.mention, type: r.entityType, metro: r.entityType === "place" && state.intent ? placeSearchMarket(state.intent.geo) : null });
      if (params === null) {
        findings.push({ ...base, entityId: null, source: null, problem: "a place with no map city or market: no /search to read" });
        continue;
      }
      session ??= await openQloo();
      const qloo = session.client.standalone().forTool(null);
      if (!(await qloo.has("/search", params))) {
        findings.push({ ...base, entityId: null, source: null, problem: "its /search answer is not in the Qloo cache" });
        continue;
      }
      const reply = await qloo.search(params);
      const match = classifyMatches({ text: r.mention, type: r.entityType }, reply.data.results);
      const applied = match.matchClass === "exact" ? match.exact[0] : undefined;
      if (applied === undefined || (r.name !== null && applied.name !== r.name)) {
        findings.push({ ...base, entityId: null, source: null, problem: "the cached /search answer no longer holds the exact match the run applied" });
        continue;
      }
      findings.push({ ...base, entityId: applied.entity_id, source: "cache", problem: null });
    }
  } finally {
    await session?.close();
  }
  return findings;
}

function openQlooOf(deps: ShowcasesDeps, io: CliIo): () => Promise<{ client: QlooClient; close(): Promise<void> }> {
  return deps.openQloo ?? (() => openCliQloo({ env: deps.env, mock: false, tag: null, store: "pg", logger: stderrLogger(io.err) }));
}

/** Stores the run's entities as the slug's pins. False when nothing could be stored. */
async function storePins(deps: ShowcasesDeps, entry: ShowcaseEntry, runId: string): Promise<boolean> {
  const { io } = deps;
  const run = await getRun(deps.db(), runId);
  if (!run) {
    io.err(`There is no run ${runId} in ${databaseLabel(deps)}.`);
    return false;
  }
  const state = reduceRunEvents(runId, await readEvents(deps.db(), runId));
  let findings: PinFinding[];
  try {
    findings = await findPins(state, storedPins(run.pins) ?? {}, openQlooOf(deps, io));
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(err.message);
    return false;
  }
  const problems = findings.filter((f) => f.entityId === null);
  if (problems.length > 0) {
    io.err(`Nothing stored for ${entry.slug}: ${problems.length} of the ${findings.length} entities run ${runId} resolved could not be read.`);
    for (const line of renderTable([{ header: "MENTION" }, { header: "TYPE" }, { header: "WHY" }], problems.map((p) => [p.mention, p.type, p.problem ?? ""]), { indent: "  " })) {
      io.err(line);
    }
    return false;
  }
  const pins: ShowcasePinInput[] = findings.map((f) => ({ mention: f.mention, entityId: f.entityId ?? "", name: f.name, type: f.type }));
  let stored: number;
  try {
    stored = await replaceShowcasePins(deps.db(), entry.slug, pins);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    io.err(`Nothing stored for ${entry.slug}: ${err.message}.`);
    return false;
  }
  io.out(`stored ${stored} pin(s) for ${entry.slug} from run ${runId}${stored === 0 ? " (it resolved no entity exactly)" : ""}`);
  const rows = findings.map((f) => [f.mention, f.name, f.type, f.entityId ?? NONE, f.source ?? NONE]);
  if (rows.length > 0) {
    for (const line of renderTable([{ header: "MENTION" }, { header: "NAME" }, { header: "TYPE" }, { header: "ENTITY" }, { header: "FROM" }], rows, { indent: "  " })) io.out(line);
  }
  return true;
}

async function pinsCommand(deps: ShowcasesDeps, entries: readonly ShowcaseEntry[], slug: string, runId: string | null): Promise<number> {
  const entry = findEntry(entries, slug, deps.io);
  if (entry === null) return EXIT.failed;
  const id = runId ?? (await getPinnedShowcase(deps.db(), slug))?.runId ?? null;
  if (id === null) {
    deps.io.err(`No run is pinned as ${slug}; pin one first, or name the run: \`pins ${slug} <runId>\`.`);
    return EXIT.failed;
  }
  return (await storePins(deps, entry, id)) ? EXIT.ok : EXIT.failed;
}

// prewarm ---------------------------------------------------------------------------------------------

/**
 * The --pins value for run-agent: normalised mention = entity id, the way runAgent looks pins up. Two
 * stored mentions that normalise alike are one pin to run-agent, so only the first is passed.
 */
async function pinsArgv(db: Queryable, slug: string, io: CliIo): Promise<string[]> {
  const byKey = new Map<string, { mention: string; entityId: string }>();
  for (const p of await listShowcasePins(db, slug)) {
    const key = normaliseName(p.mention);
    if (key === "" || /[,=]/.test(p.entityId)) {
      io.err(`  note: pin "${p.mention}" of ${slug} cannot be passed to run-agent; it is left out`);
      continue;
    }
    const first = byKey.get(key);
    if (first === undefined) byKey.set(key, { mention: p.mention, entityId: p.entityId });
    else if (first.entityId !== p.entityId) io.err(`  note: pin "${p.mention}" of ${slug} is the same mention as "${first.mention}" to run-agent; it is left out`);
  }
  const pairs = [...byKey].map(([key, p]) => `${key}=${p.entityId}`);
  return pairs.length > 0 ? ["--pins", pairs.join(",")] : [];
}

/**
 * usage_daily's metric for LLM spend in USD: apps/web/server/llm-spend.ts LLM_USD_METRIC, which tools
 * cannot import (it is server-only). A test keeps the two in step.
 */
export const LLM_USD_METRIC = "llm_usd";

/** How many live runs prewarm makes for these entries: one each, a step each for the chain. */
export function plannedRuns(entries: readonly ShowcaseEntry[]): number {
  return entries.reduce((n, e) => n + (e.kind === "chain" ? e.steps.length : 1), 0);
}

type Recorded = { kind: "run"; run: Run } | { kind: "failed"; reason: string };

/**
 * One live run through run-agent's own path (its spend guard, trace and --persist), with the slug's
 * pins and, for a chain step, the parent and its case summary that the web gives a follow-up (§7.3).
 */
async function recordRun(
  deps: ShowcasesDeps,
  question: string,
  pinArgs: readonly string[],
  tag: string | null,
  parent: { runId: string; caseSummary: string } | null,
): Promise<Recorded> {
  const agent = deps.agent?.runAgent ?? runAgent;
  let runId: string | null = null;
  const run = async (options: AgentRunOptions): Promise<AgentRunResult> => {
    runId = options.runId;
    if (parent === null) return agent(options);
    // run-agent creates the row without a parent; the web's child run has it from the start.
    await updateRun(deps.db(), options.runId, { parentRunId: parent.runId });
    return agent({ ...options, parent });
  };
  const argv = [question, "--yes", "--persist", ...pinArgs, ...(tag === null ? [] : ["--tag", tag])];
  const code = await runAgentCommand(argv, {
    ...deps.agent,
    env: deps.env,
    io: deps.io,
    signal: deps.signal,
    runAgent: run,
    // The pool stays this tool's: it is asked for again on every use.
    openDb: () => ({ db: deps.db(), close: async () => undefined }),
  });
  const id: string | null = runId;
  if (id === null) return { kind: "failed", reason: `run-agent did not start the run (exit ${code})` };
  const stored = await getRun(deps.db(), id);
  if (!stored) return { kind: "failed", reason: `run ${id} was not stored` };
  await bookSpend(deps, stored);
  return { kind: "run", run: stored };
}

/**
 * Adds what the run spent to today's LLM spend in usage_daily, per lane and under "all", as the web's
 * SpendMeter does for its own runs: run-agent books it only in its local tally, and the daily LLM
 * breaker and /api/health read usage_daily. Whatever the run's status: a failed run spent too.
 */
async function bookSpend(deps: ShowcasesDeps, run: Run): Promise<void> {
  await bookUsd(deps, run.lane, run.llmUsd, `run ${run.id}'s`);
}

/** Adds `usd` to today's LLM spend in usage_daily under `lane` and "all"; `what` names it in a failure. */
async function bookUsd(deps: ShowcasesDeps, lane: Run["lane"], usd: number, what: string): Promise<void> {
  if (!(usd > 0)) return;
  const day = utcDay((deps.agent?.now?.() ?? new Date()).getTime());
  try {
    await incrementQlooUsage(deps.db(), { day, lanes: [lane, "all"], by: usd, metric: LLM_USD_METRIC });
  } catch (err) {
    deps.io.err(`could not add ${what} ${formatUsd(usd)} to today's LLM spend (usage_daily ${LLM_USD_METRIC}): ${errorText(err)}`);
  }
}

/**
 * The parent of a chain step as the web's run manager builds it for a follow-up (RunManager.parentContext):
 * the parent's report, its ledger from the stored events, and the earlier runs of the chain.
 */
async function parentContext(db: Queryable, parent: Run): Promise<{ runId: string; caseSummary: string }> {
  const report = Report.safeParse(parent.report);
  if (!report.success) throw new PinRefused(`run ${parent.id} stored no note to follow up on`);
  const state = reduceRunEvents(parent.id, await readEvents(db, parent.id));
  const priorRunIds: string[] = [];
  let ancestor = parent.parentRunId;
  while (ancestor && priorRunIds.length < 5) {
    priorRunIds.unshift(ancestor);
    ancestor = (await getRun(db, ancestor))?.parentRunId ?? null;
  }
  const ledger = { evidence: Object.values(state.evidence), metrics: Object.values(state.metrics), datasets: [], findings: state.findings };
  return { runId: parent.id, caseSummary: buildCaseSummary(report.data, { ledger, priorRunIds }) };
}

/** A recorded run that ended as `status`, or why not. */
function endedAs(recorded: Recorded, status: RunStatus): { run: Run } | { reason: string } {
  if (recorded.kind === "failed") return { reason: recorded.reason };
  const { run } = recorded;
  return run.status === status ? { run } : { reason: `run ${run.id} ended ${run.status}${status === "completed" ? "" : `, not ${status}`}` };
}

type Prewarmed = { slug: string; runId: string | null; ok: boolean; note: string };
type PrewarmCommand = Extract<ShowcaseCommand, { kind: "prewarm" }>;

/** Whether prewarm attaches GHOST to this entry: only a completed note has a brief to diff (the trust example is a refusal). */
const getsGhost = (entry: ShowcaseEntry, command: Pick<PrewarmCommand, "ghost">): boolean => command.ghost && entry.status === "completed";

async function prewarmOne(deps: ShowcasesDeps, entry: ShowcaseEntry, command: PrewarmCommand): Promise<Prewarmed> {
  const { io } = deps;
  io.out(heading(`── ${entry.code} ${entry.slug} ──`));
  const recorded = await recordRun(deps, entry.question, await pinsArgv(deps.db(), entry.slug, io), command.tag, null);
  const ended = endedAs(recorded, entry.status);
  if ("reason" in ended) return { slug: entry.slug, runId: recorded.kind === "run" ? recorded.run.id : null, ok: false, note: `${ended.reason}; not pinned` };
  return finishPrewarm(deps, entry, ended.run.id, command);
}

/**
 * Pins a run prewarm recorded, stores its entities, then attaches GHOST (SPEC §6.6: precomputed for the
 * showcases). A failure in either of the last two is reported with how to retry it, not fatal: the pin stands.
 */
async function finishPrewarm(deps: ShowcasesDeps, entry: ShowcaseEntry, runId: string, command: PrewarmCommand): Promise<Prewarmed> {
  if (!(await pinRun(deps, entry, runId, true))) return { slug: entry.slug, runId, ok: false, note: "recorded, not pinned" };
  const pinsStored = await storePins(deps, entry, runId).catch((err: unknown) => {
    deps.io.err(`could not store the pins of ${entry.slug}: ${errorText(err)}`);
    return false;
  });
  const notes = [pinsStored ? "pinned, entities stored" : `pinned; run \`pins ${entry.slug}\` again for its entities`];
  if (getsGhost(entry, command)) notes.push(await prewarmGhost(deps, runId, command.tag));
  return { slug: entry.slug, runId, ok: true, note: notes.join("; ") };
}

/**
 * GHOST on the pinned run through the attach CLI's own path (its spend guard over run-agent's tally,
 * the cached /search under prewarm's tag), its spend added to today's LLM spend like the run's. The
 * chain's last step is a follow-up: attachGhost gives GHOST the chain's earlier questions (through
 * parent_run_id), as its ANALYST had the parent's case summary. Returns the outcome's note.
 */
async function prewarmGhost(deps: ShowcasesDeps, runId: string, tag: string | null): Promise<string> {
  const retry = `\`tools/dev/ghost.ts attach ${runId} --yes\` tries again`;
  if (deps.signal?.aborted) return `GHOST not attached (cancelled); ${retry}`;
  deps.io.out(`GHOST · ${runId}`);
  const outcome = await attachGhost(
    {
      env: deps.env,
      io: deps.io,
      db: deps.db,
      where: deps.where,
      createAnthropic: deps.agent?.createAnthropic,
      store: deps.agent?.store,
      openQloo: deps.openQloo,
      spendFile: deps.agent?.spendFile,
      now: deps.agent?.now,
      signal: deps.signal,
    },
    { runId, yes: true, model: null, replace: false, mock: false, memory: false, tag },
  ).catch((err: unknown): GhostAttachOutcome => {
    deps.io.err(`GHOST for run ${runId}: ${errorText(err)}`);
    return { status: "failed", reason: errorText(err), usd: null };
  });
  const lane = (await getRun(deps.db(), runId))?.lane ?? "public";
  switch (outcome.status) {
    case "attached":
      await bookUsd(deps, lane, outcome.usd, `run ${runId}'s GHOST`);
      return "GHOST attached";
    case "failed":
      await bookUsd(deps, lane, outcome.usd ?? 0, `run ${runId}'s GHOST`);
      return `GHOST not attached (${outcome.reason}); ${retry}`;
    case "refused":
      return `GHOST not attached (${outcome.reason}); ${retry}`;
    case "unconfirmed":
      return `GHOST not attached; ${retry}`;
  }
}

/**
 * The chain: each step a follow-up of the one before. Step 1 reuses the pinned run of the showcase it
 * comes from when that run asks the same question; every step in between gets the web's key once it
 * completes, so the next one can follow it up and the library lists it.
 */
async function prewarmChain(deps: ShowcasesDeps, entry: ShowcaseEntry, entries: readonly ShowcaseEntry[], command: PrewarmCommand): Promise<Prewarmed> {
  const { io } = deps;
  io.out(heading(`── ${entry.code} ${entry.slug} ──`));
  const fail = (runId: string | null, note: string): Prewarmed => ({ slug: entry.slug, runId, ok: false, note });
  let previous: Run | null = null;
  for (const [i, step] of entry.steps.entries()) {
    const source = step.from === null ? undefined : entries.find((e) => e.code === step.from);
    if (i === 0 && source) {
      const pinned = await getPinnedShowcase(deps.db(), source.slug);
      const run = pinned ? await getRun(deps.db(), pinned.runId) : undefined;
      if (run && runProblem(run, step.question, "completed") === null) {
        io.out(`step ${step.step} · reusing ${source.code}'s pinned run ${run.id}`);
        previous = run;
        continue;
      }
    }
    io.out(`step ${step.step} · ${step.question}`);
    let parent: { runId: string; caseSummary: string } | null = null;
    if (previous !== null) {
      try {
        parent = await parentContext(deps.db(), previous);
      } catch (err) {
        if (!(err instanceof PinRefused)) throw err;
        return fail(previous.id, `${err.message}; step ${step.step} not run`);
      }
    }
    const pinArgs = await pinsArgv(deps.db(), i === 0 && source ? source.slug : entry.slug, io);
    const ended = endedAs(await recordRun(deps, step.question, pinArgs, command.tag, parent), "completed");
    if ("reason" in ended) return fail(null, `step ${step.step}: ${ended.reason}; not pinned`);
    previous = ended.run;
    const last = i === entry.steps.length - 1;
    if (!last && !previous.questionHash.startsWith(AGENT_HASH_PREFIX)) {
      previous = (await updateRun(deps.db(), previous.id, { questionHash: adoptedHash(previous) })) ?? previous;
    }
    if (deps.signal?.aborted && !last) return fail(previous.id, "cancelled; not pinned");
  }
  if (previous === null) return fail(null, "the chain has no steps");
  return finishPrewarm(deps, entry, previous.id, command);
}

async function prewarm(deps: ShowcasesDeps, entries: readonly ShowcaseEntry[], command: PrewarmCommand): Promise<number> {
  const { io, env } = deps;
  const chosen = command.slug === null ? [...entries] : entries.filter((e) => e.slug === command.slug);
  if (chosen.length === 0) {
    io.err(`"${command.slug}" is not a slug of config/showcases.json; \`list\` shows them.`);
    return EXIT.failed;
  }
  let qlooEnv: string;
  try {
    qlooEnv = resolveQlooEnv(env);
  } catch (err) {
    io.err(errorText(err));
    return EXIT.failed;
  }
  if (qlooEnv === "mock") {
    io.err("Refusing to prewarm on synthetic data: QLOO_MOCK is set. A showcase is recorded on live Qloo data (unset QLOO_MOCK, set QLOO_API_KEY).");
    return EXIT.failed;
  }
  // Presence only: the key goes to the SDK and is never printed.
  if ((env.ANTHROPIC_API_KEY?.trim() ?? "") === "") {
    io.err("ANTHROPIC_API_KEY is not set. Run the tool with --env-file-if-exists=.env; every prewarm run calls CLERK and the ANALYST live.");
    return EXIT.failed;
  }
  const runs = plannedRuns(chosen);
  const perRun = DEFAULT_RUN_LIMITS.usdHard;
  // GHOST answers on the pinned run's ANALYST, the live one for a prewarm run (D23).
  const ghosts = chosen.filter((e) => getsGhost(e, command)).length;
  const perGhost = ghostWorstCaseUsd(ANALYST_CONFIGS.live.model);
  const worst = runs * perRun + ghosts * perGhost;
  const ghostPart = ghosts === 0 ? "" : `, ${ghosts} × ${formatUsd(perGhost)} per GHOST answer`;
  io.out(
    `prewarm · ${chosen.map((e) => e.slug).join(", ")} · up to ${runs} live run(s)${ghosts === 0 ? "" : ` and ${ghosts} GHOST answer(s)`} · ` +
      `worst case ${formatUsd(worst)} (${runs} × ${formatUsd(perRun)} per-run hard cap${ghostPart}) · Qloo ${qlooEnv} · database ${databaseLabel(deps)}`,
  );
  if (!command.yes) {
    io.err(`This calls Anthropic and Qloo live and may spend up to ${formatUsd(worst)}. Nothing was sent; add --yes to start.`);
    return EXIT.usage;
  }
  const done: Prewarmed[] = [];
  for (const entry of chosen) {
    if (deps.signal?.aborted) {
      done.push({ slug: entry.slug, runId: null, ok: false, note: "cancelled before it started" });
      continue;
    }
    done.push(entry.kind === "chain" ? await prewarmChain(deps, entry, entries, command) : await prewarmOne(deps, entry, command));
  }
  io.out(heading("prewarm"));
  const rows = done.map((d) => [d.ok ? "✓" : "✗", d.slug, d.runId ?? NONE, d.note]);
  for (const line of renderTable([{ header: "" }, { header: "SLUG" }, { header: "RUN" }, { header: "OUTCOME" }], rows, { indent: "  " })) io.out(line);
  return done.every((d) => d.ok) ? EXIT.ok : EXIT.failed;
}

// Entry ----------------------------------------------------------------------------------------------

export async function runShowcasesCommand(argv: readonly string[], deps: ShowcasesDeps): Promise<number> {
  const io = safeIo(deps.io);
  const safe = { ...deps, io };
  let command: ShowcaseCommand;
  try {
    command = parseShowcaseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(err.message);
    io.err(SHOWCASES_USAGE);
    return EXIT.usage;
  }
  if (command.kind === "help") {
    io.out(SHOWCASES_USAGE);
    return EXIT.ok;
  }
  let entries: ShowcaseEntry[];
  try {
    entries = showcaseEntries(deps.config ?? loadShowcaseConfig());
  } catch (err) {
    io.err(`config/showcases.json cannot be read: ${errorText(err)}`);
    return EXIT.failed;
  }
  try {
    switch (command.kind) {
      case "list":
        return await list(safe, entries);
      case "pin":
        return await pin(safe, entries, command.slug, command.runId);
      case "unpin":
        return await unpin(safe, command.slug);
      case "pins":
        return await pinsCommand(safe, entries, command.slug, command.runId);
      case "prewarm":
        return await prewarm(safe, entries, command);
    }
  } catch (err) {
    if (!isConnectionError(err)) throw err;
    io.err(`Postgres is not reachable at ${databaseLabel(deps)}. Start it with \`pnpm db:up\`, or set DATABASE_URL.`);
    return EXIT.failed;
  }
}

if (path.basename(process.argv[1] ?? "") === "showcases.ts") {
  const controller = new AbortController();
  // A listener that stays: with one registered, Node no longer exits on SIGINT by itself.
  process.on("SIGINT", () => {
    if (!controller.signal.aborted) {
      consoleIo.err("\ncancelling (Ctrl+C again to quit at once)");
      controller.abort(new Error("cancelled from the terminal"));
      return;
    }
    process.exit(130);
  });
  runShowcasesCommand(process.argv.slice(2), { env: process.env, io: consoleIo, db: () => getDb(), signal: controller.signal })
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
