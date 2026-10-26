// The offline eval from the terminal (SPEC §6.6, §6.7): `grounded`, `ghost`, `both`, `reality` and `all`
// run those arms over the registered questions and cases into one eval directory under .private/eval/;
// `summary` prints the metrics of a directory and spends nothing. The LLM and Qloo calls are live and
// cost money, so a run needs --yes and stops at --usd-cap; Qloo goes through run-agent's own setup
// (QLOO_TAG, QLOO_TAG_CAP, QLOO_RPS and the shared Postgres cache). --write-summary writes
// apps/web/content/eval-summary.json and eval/SUMMARY.md from the directory.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import {
  ANALYST_CONFIGS,
  CLERK_PROMPT,
  createAnthropic,
  DIRECTOR_PROMPT,
  isPricedModel,
  type AgentRunOptions,
  type AgentRunResult,
  type AnthropicLike,
  type LlmModel,
} from "@ct/agent";
import { DEFAULT_RUN_LIMITS, type LocalityApi } from "@ct/contracts";
import type { QlooClient, QlooStore } from "@ct/qloo";
import { openAgentQloo, type AgentQloo } from "../dev/cli/agent-cli";
import { intOption, parseCli, UsageError } from "../dev/cli/args";
import { formatUsd } from "../dev/cli/format";
import { EXIT, heading, safeIo, type CliIo } from "../dev/cli/io";
import type { KvStore } from "../dev/cli/localities";
import { CliError } from "../dev/cli/qloo-setup";
import { readSpend, readUsdCap } from "../dev/cli/spend";
import { renderTable } from "../dev/cli/table";
import { loadQuestions, loadRealityCases, type QuestionsFile, type RealityCasesFile } from "./cases";
import { createGhostArm, ghostWorstCaseUsd, type GhostApi } from "./ghost";
import { createGroundedArm } from "./grounded";
import { computeEvalMetrics, type EvalMetrics, type MetricResult } from "./metrics";
import { planRealityCalls } from "./reality";
import { loadSecondaryMarkets } from "./reality-location";
import {
  CASE_ID,
  evalDir,
  evalStamp,
  latestStamp,
  loadRecords,
  Manifest,
  QUESTION_ID,
  readRecord,
  RealityRecord,
  RecordError,
  registeredHashes,
  REPO_ROOT,
  writeJson,
  type EvalDir,
} from "./records";
import { EVAL_COMMANDS, pendingUnits, realityRetry, runSession, type EvalArm, type EvalArms, type EvalCommand, type EvalPlan, type EvalUnit, type RealityArm } from "./runner";
import { ranAtOf, SUMMARY_FILES, writeSummaries } from "./summary";

export const EVAL_USAGE = [
  "usage: pnpm exec tsx --env-file-if-exists=.env tools/eval/run.ts <command> [options]",
  "  grounded | ghost | both | reality | all   run those arms over the registered questions and cases (needs --yes)",
  "  summary            print the metrics of an eval directory (the latest, or --stamp's); no spend",
  "  --yes, -y          confirm the live LLM and Qloo spend",
  "  --only IDS         only these questions and cases, e.g. q01,a02,rc03",
  "  --usd-cap N        the most the eval directory may spend in all, earlier sessions included (default 5)",
  "  --takes N          grounded takes per question, 1 to 3 (default 1); a second one measures top-5 stability",
  "  --out DIR          where eval directories live (default .private/eval; never a tracked path)",
  "  --stamp S          the eval directory's name (default: a new one from the clock)",
  "  --resume           continue the latest eval directory (or --stamp's), skipping what is answered and running again",
  "                     what is not: a failed take, a GHOST pick whose lookup failed, a Reality Check case whose Qloo",
  "                     call failed or met the tag's cap. QLOO_TAG_CAP counts every earlier call of the tag, so after a",
  "                     cap refusal resume with a fresh --tag",
  "  --write-summary    write apps/web/content/eval-summary.json and eval/SUMMARY.md from the directory (an eval on live",
  "                     Qloo data that started with eval/questions.json and eval/reality_cases.json committed)",
  "  --mock-qloo        synthetic Qloo data (QLOO_MOCK=1); the LLM calls stay live",
  "  --memory           cache Qloo answers in memory instead of the shared Postgres cache (with --mock-qloo only)",
  "  --tag T            QLOO_TAG for the call log and the per-tag cap (default: QLOO_TAG, else eval)",
  "  -h, --help         this text",
  "env: ANTHROPIC_API_KEY, QLOO_* as for the app (QLOO_TAG_CAP, QLOO_RPS), DATABASE_URL (the shared Qloo cache)",
  "Ctrl+C stops after the unit in progress; --resume continues from there.",
  "exit codes: 0 done, 1 refused, failed or stopped early, 2 bad arguments or no --yes",
].join("\n");

/** SPEC §4.2: the Eval + Reality Check bucket. */
export const DEFAULT_EVAL_USD_CAP = 5;
const TAKES_MAX = 3;

const OPTIONS = {
  yes: { type: "boolean", short: "y" },
  only: { type: "string" },
  "usd-cap": { type: "string" },
  takes: { type: "string" },
  out: { type: "string" },
  stamp: { type: "string" },
  resume: { type: "boolean" },
  "write-summary": { type: "boolean" },
  "mock-qloo": { type: "boolean" },
  memory: { type: "boolean" },
  tag: { type: "string" },
  help: { type: "boolean", short: "h" },
} as const;

export interface EvalArgs {
  command: EvalCommand | "summary";
  yes: boolean;
  /** Question and case ids; null runs every one. */
  only: string[] | null;
  usdCap: number;
  takes: number;
  out: string | null;
  stamp: string | null;
  resume: boolean;
  writeSummary: boolean;
  mockQloo: boolean;
  memory: boolean;
  tag: string | null;
}

const isCommand = (c: string): c is EvalCommand => Object.hasOwn(EVAL_COMMANDS, c);

/** The parsed command, or null for --help. */
export function parseEvalArgs(argv: readonly string[]): EvalArgs | null {
  const { positionals, options } = parseCli(argv, OPTIONS);
  if (options.help) return null;
  const [command, ...rest] = positionals;
  if (command === undefined) throw new UsageError("name a command: grounded, ghost, both, reality, all or summary");
  if (command !== "summary" && !isCommand(command)) throw new UsageError(`unknown command "${command}": grounded, ghost, both, reality, all or summary`);
  if (rest.length > 0) throw new UsageError(`unexpected argument "${rest[0]}"`);
  let usdCap = DEFAULT_EVAL_USD_CAP;
  try {
    usdCap = readUsdCap({ CAP: options["usd-cap"] }, "CAP", DEFAULT_EVAL_USD_CAP);
  } catch {
    throw new UsageError(`--usd-cap must be a positive number of US dollars, got "${options["usd-cap"]}"`);
  }
  const only = options.only === undefined ? null : [...new Set(options.only.split(",").map((s) => s.trim()).filter((s) => s !== ""))];
  if (only !== null) {
    if (only.length === 0) throw new UsageError("--only needs at least one id, e.g. q01,rc03");
    const bad = only.filter((id) => !QUESTION_ID.test(id) && !CASE_ID.test(id));
    if (bad.length > 0) throw new UsageError(`--only takes question ids (q01, a01) and case ids (rc01), got ${bad.join(", ")}`);
  }
  const stamp = options.stamp?.trim() ?? null;
  if (stamp !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(stamp)) throw new UsageError(`--stamp must be letters, digits, - and _, got "${options.stamp}"`);
  const tag = options.tag?.trim() ?? null;
  if (tag === "") throw new UsageError("--tag needs a non-empty value");
  const out = options.out?.trim() ?? null;
  if (out === "") throw new UsageError("--out needs a directory");
  return {
    command,
    yes: options.yes === true,
    only,
    usdCap,
    takes: intOption(options.takes, "--takes", { min: 1, max: TAKES_MAX, fallback: 1 }),
    out,
    stamp,
    resume: options.resume === true,
    writeSummary: options["write-summary"] === true,
    mockQloo: options["mock-qloo"] === true,
    memory: options.memory === true,
    tag,
  };
}

/**
 * Why raw outputs may not go to `out`: inside the repository, only .private/ and eval/raw/ are kept out
 * of git (and blocked by the guard). Null when it may; a directory outside the repository may.
 */
export function outDirProblem(out: string, root: string): string | null {
  const rel = path.relative(root, out);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  const parts = rel.split(path.sep);
  if (parts[0] === ".private" || (parts[0] === "eval" && parts[1] === "raw")) return null;
  return `--out ${out} is inside the repository but outside .private/ and eval/raw/: raw eval outputs hold Qloo data and must stay out of git (D29)`;
}

/** The last commit that touched the registered files, and whether they differ from it; read-only git. */
export function gitRegistration(root: string): { commit: string | null; dirty: boolean } {
  const files = ["eval/questions.json", "eval/reality_cases.json"];
  const git = (args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  try {
    const commit = git(["log", "-1", "--format=%H", "--", ...files]);
    const status = git(["status", "--porcelain", "--", ...files]);
    return { commit: commit === "" ? null : commit, dirty: status !== "" };
  } catch {
    return { commit: null, dirty: false };
  }
}

/** What the Reality Check arm is built with (tools/eval/reality-arm.ts createRealityArm). */
export interface RealityContext {
  anthropic: AnthropicLike;
  /** The client run-agent opens: QLOO_TAG, its cap, the pace and the shared cache apply. */
  qloo: QlooClient;
  /** The pinned market localities, as a grounded run reads them. */
  localities: LocalityApi | null;
  /** The model GHOST answers each case with (D23: the ANALYST's). */
  model: LlmModel;
  /** The registered eval/reality_cases.json: its date and caveats go into the raw run. */
  file: RealityCasesFile;
  /** Where the raw run, scores included, is written: the eval directory's reality/ folder. */
  rawDir: string;
  log: (line: string) => void;
  now: () => Date;
  signal: AbortSignal;
}

export interface EvalCliDeps {
  env: NodeJS.ProcessEnv;
  io: CliIo;
  signal?: AbortSignal;
  now?: () => Date;
  /** The repository root (tests: the real one, with a temporary --out). */
  root?: string;
  /** Where --write-summary writes (tests: a temporary directory). */
  summaryFiles?: { json: string; md: string };
  /** The registered inputs (default: eval/questions.json and eval/reality_cases.json). */
  questions?: QuestionsFile;
  realityCases?: RealityCasesFile;
  /** Their sha256, recorded in the manifest and checked on --resume. */
  hashes?: () => { questionsSha256: string; realityCasesSha256: string };
  registration?: () => { commit: string | null; dirty: boolean };
  /** The agent; tests pass a scripted one. */
  runAgent?: (options: AgentRunOptions) => Promise<AgentRunResult>;
  createAnthropic?: (apiKey: string) => AnthropicLike;
  /** Replaces the Postgres or memory Qloo store, the localities kv and the live transport's fetch (tests). */
  store?: QlooStore;
  kv?: KvStore | null;
  fetch?: typeof fetch;
  /** The GHOST API (default: @ct/agent's). */
  ghostApi?: GhostApi;
  /** The Reality Check arm: tools/eval/run.ts passes createRealityArm; without it (null, the default) `reality` and `all` refuse. */
  createReality?: ((context: RealityContext) => RealityArm) | null;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One row per metric: the two arms as the page prints them, and what each was taken over. */
export function metricsTable(m: EvalMetrics): string[] {
  const value = (r: MetricResult, side: "grounded" | "ghost"): string => {
    const measure = r[side];
    if (measure === null) return "n/a";
    if (measure.value === null) return "–";
    switch (r.unit) {
      case "rate":
        return `${Math.round(measure.value * 100)}%`;
      case "seconds":
        return `${measure.value.toFixed(1)} s`;
      case "usd":
        return formatUsd(measure.value);
      default:
        return measure.value.toFixed(2);
    }
  };
  const rows = m.metrics.map((r) => [r.label, value(r, "grounded"), value(r, "ghost"), [r.grounded?.basis, r.ghost?.basis].filter(Boolean).join(" · ")]);
  return renderTable(
    [{ header: "MEASURE" }, { header: "CULTURE TERMINAL", align: "right" }, { header: "MODEL ALONE", align: "right" }, { header: "OVER", max: 60 }],
    rows,
    { indent: "  " },
  );
}

interface Registered {
  questions: QuestionsFile;
  cases: RealityCasesFile;
}

/** Why the registered inputs of a new or recorded eval may not back a published result (eval/README.md rule 1); null when they may. */
export function registrationProblem(registration: { commit: string | null; dirty: boolean }): string | null {
  if (registration.commit !== null && !registration.dirty) return null;
  return (
    `eval/questions.json and eval/reality_cases.json ${registration.commit === null ? "were not committed" : "had uncommitted changes"}, and eval/README.md rule 1 ` +
    "commits both before the first run, so that every published result cites that commit"
  );
}

/**
 * Prints the metrics and, with --write-summary, writes both summary files: only for an eval on live Qloo
 * data whose registered inputs were committed when it started, since a published figure must never come
 * from synthetic data or from inputs no commit fixes. False when they were not written.
 */
function report(deps: EvalCliDeps, io: CliIo, dir: EvalDir, registered: Registered, write: boolean): boolean {
  const records = loadRecords(dir);
  const metrics = computeEvalMetrics({ questions: registered.questions.questions, cases: registered.cases.cases, records, prompts: [CLERK_PROMPT, DIRECTOR_PROMPT] });
  const spend = metrics.spend.attempts;
  const spent = spend === null ? `${formatUsd(metrics.spend.usd.total)} measured LLM spend` : `${formatUsd(spend.totalUsd)} LLM spend over every attempt`;
  io.out(heading(`eval ${dir.stamp} · ${metrics.questions.total} questions answered · ${spent}`));
  for (const line of metricsTable(metrics)) io.out(line);
  if (metrics.reality !== null) io.out(`  Reality Check: ${metrics.reality.median.basis}, GHOST hits ${metrics.reality.ghostHitRate.basis}`);
  if (!write) return true;
  const manifest = readRecord(dir.manifest, Manifest);
  const ranAt = ranAtOf(records);
  if (manifest === null || ranAt === null || metrics.questions.total === 0) {
    io.err("--write-summary: the eval directory has no answered question; nothing written");
    return false;
  }
  if (manifest.qloo === "mock") {
    io.err(`--write-summary: eval ${dir.stamp} ran on synthetic Qloo data (QLOO_MOCK); only an eval on live data is published. Nothing written.`);
    return false;
  }
  const unregistered = registrationProblem(manifest.registration);
  if (unregistered !== null) {
    io.err(`--write-summary: when eval ${dir.stamp} started, ${unregistered}. Nothing written; commit them and run a new eval.`);
    return false;
  }
  const files = deps.summaryFiles ?? SUMMARY_FILES;
  try {
    writeSummaries(metrics, { ranAt, model: manifest.model, stamp: dir.stamp, registration: manifest.registration, realityCaveats: registered.cases.caveats }, records, files);
  } catch (err) {
    io.err(`--write-summary: ${errorText(err)}; nothing written`);
    return false;
  }
  io.out(`  wrote ${files.json} and ${files.md}`);
  return true;
}

export async function runEvalCommand(argv: readonly string[], deps: EvalCliDeps): Promise<number> {
  const io = safeIo(deps.io);
  const now = deps.now ?? (() => new Date());
  const signal = deps.signal ?? new AbortController().signal;
  const root = deps.root ?? REPO_ROOT;
  let args: EvalArgs | null;
  try {
    args = parseEvalArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    io.err(err.message);
    io.err(EVAL_USAGE);
    return EXIT.usage;
  }
  if (args === null) {
    io.out(EVAL_USAGE);
    return EXIT.ok;
  }

  let registered: Registered;
  try {
    registered = { questions: deps.questions ?? loadQuestions(), cases: deps.realityCases ?? loadRealityCases() };
  } catch (err) {
    io.err(`the registered inputs cannot be read: ${errorText(err)}`);
    return EXIT.failed;
  }
  const out = path.resolve(root, args.out ?? path.join(".private", "eval"));
  const outProblem = outDirProblem(out, root);
  if (outProblem !== null) {
    io.err(outProblem);
    return EXIT.usage;
  }
  const known = new Set([...registered.questions.questions.map((q) => q.id), ...registered.cases.cases.map((c) => c.id)]);
  const unknown = (args.only ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    io.err(`--only: ${unknown.join(", ")} not registered in eval/questions.json or eval/reality_cases.json`);
    return EXIT.usage;
  }

  try {
    if (args.command === "summary") {
      const stamp = args.stamp ?? latestStamp(out);
      if (stamp === null || !existsSync(evalDir(out, stamp).manifest)) {
        io.err(`no eval directory${stamp === null ? "" : ` ${stamp}`} under ${out}`);
        return EXIT.failed;
      }
      return report(deps, io, evalDir(out, stamp), registered, args.writeSummary) ? EXIT.ok : EXIT.failed;
    }
    return await runArms(deps, io, { args, command: args.command, registered, out, root, now, signal });
  } catch (err) {
    if (!(err instanceof RecordError)) throw err;
    io.err(err.message);
    return EXIT.failed;
  }
}

interface ArmsRun {
  args: EvalArgs;
  command: EvalCommand;
  registered: Registered;
  /** The resolved --out. */
  out: string;
  root: string;
  now: () => Date;
  signal: AbortSignal;
}

async function runArms(deps: EvalCliDeps, io: CliIo, run: ArmsRun): Promise<number> {
  const { env } = deps;
  const { args, command, registered, out, root, now, signal } = run;
  const arms: readonly EvalArm[] = EVAL_COMMANDS[command];
  const only = args.only === null ? null : new Set(args.only);
  const plan: EvalPlan = {
    arms,
    questions: registered.questions.questions.filter((q) => only === null || only.has(q.id)),
    cases: registered.cases.cases.filter((c) => only === null || only.has(c.id)),
    takes: args.takes,
  };

  // The directory: a new one, or the one --resume continues, whose registered inputs must not have changed.
  const hashes = (deps.hashes ?? registeredHashes)();
  let stamp: string;
  let manifest: Manifest | null = null;
  if (args.resume) {
    const found = args.stamp ?? latestStamp(out);
    manifest = found === null ? null : readRecord(evalDir(out, found).manifest, Manifest);
    if (found === null || manifest === null) {
      io.err(`nothing to resume: no eval directory${found === null ? "" : ` ${found}`} under ${out}`);
      return EXIT.failed;
    }
    const reg = manifest.registration;
    if (reg.questionsSha256 !== hashes.questionsSha256 || reg.realityCasesSha256 !== hashes.realityCasesSha256) {
      io.err(`Refusing to resume ${found}: eval/questions.json or eval/reality_cases.json changed since it started, and registered inputs never change (eval/README.md). Start a new eval.`);
      return EXIT.failed;
    }
    stamp = found;
  } else {
    stamp = args.stamp ?? evalStamp(now());
    if (existsSync(evalDir(out, stamp).manifest)) {
      io.err(`eval ${stamp} already exists under ${out}; pass --resume to continue it`);
      return EXIT.failed;
    }
  }
  const dir = evalDir(out, stamp);
  const model = manifest?.model ?? ANALYST_CONFIGS.live.model;
  if (!isPricedModel(model)) {
    io.err(`eval ${stamp} names the model ${model}; only ${Object.values(ANALYST_CONFIGS).map((c) => c.model).join(" and ")} may run (D23)`);
    return EXIT.failed;
  }

  // The plan and its worst case: every grounded run at the per-run hard cap, every GHOST answer (one per
  // question, one per Reality Check case) at its bound; the Reality Check's own Qloo calls cost no LLM spend.
  const units = pendingUnits(dir, plan);
  const spent = existsSync(dir.spend) ? readSpend(dir.spend).usd : 0;
  const count = (arm: EvalUnit["arm"]) => units.filter((u) => u.arm === arm).length;
  const realityCases = units.flatMap((u) => (u.arm === "reality" ? u.cases : []));
  const worst = count("grounded") * DEFAULT_RUN_LIMITS.usdHard + (count("ghost") + realityCases.length) * ghostWorstCaseUsd(model);
  const relookups = count("lookups") > 0 ? ` (and ${count("lookups")} with failed lookups to look up again)` : "";
  io.out(
    `eval ${stamp}${args.resume ? " (resumed)" : ""} · ${arms.join(" + ")} · ${units.length} unit(s) to run: grounded ${count("grounded")}, ` +
      `ghost ${count("ghost")}${relookups}, reality ${realityCases.length} · ANALYST and GHOST ${model} · worst case ${formatUsd(worst)}` +
      ` · spent so far ${formatUsd(spent)} of --usd-cap ${formatUsd(args.usdCap)}`,
  );
  if (realityCases.length > 0) {
    // The comedian panel is every registered comedian, so a subset run still counts the panel's seed searches.
    const calls = planRealityCalls(realityCases, loadSecondaryMarkets(), registered.cases.cases);
    io.out(`  Reality Check: ${realityCases.length} case(s), at most ${calls.total} Qloo network calls on a cold cache (${calls.shared} shared), fewer from the cache`);
    const capped = realityCases.filter((c) => {
      const record = readRecord(dir.reality(c.id), RealityRecord);
      return record !== null && realityRetry(record) === "budget";
    });
    if (capped.length > 0) io.out(`  ${capped.map((c) => c.id).join(", ")} met the tag's cap last time: QLOO_TAG_CAP counts every earlier call of a tag, so pass a fresh --tag`);
  }
  // eval/README.md rule 1, checked before a new eval starts: on live Qloo data it refuses below, before
  // anything is sent. A resumed eval keeps what its manifest recorded, which --write-summary checks.
  const registration = manifest?.registration ?? (deps.registration ?? (() => gitRegistration(root)))();
  const unregistered = manifest === null ? registrationProblem(registration) : null;
  if (unregistered !== null) io.out(`  ${unregistered}: only a synthetic-data eval (--mock-qloo) may start until they are`);
  if (units.length === 0) {
    io.out("nothing left to run: every selected unit is answered");
    return args.writeSummary && !report(deps, io, dir, registered, true) ? EXIT.failed : EXIT.ok;
  }
  if (spent + worst > args.usdCap) io.out("  the cap stops the session before the first unit whose worst case would pass it");

  // What refuses before anything is sent: no key, or an arm this build cannot run.
  const apiKey = env.ANTHROPIC_API_KEY?.trim() ?? "";
  if (apiKey === "") {
    io.err("ANTHROPIC_API_KEY is not set. Run the eval with --env-file-if-exists=.env; every arm calls the model live.");
    return EXIT.failed;
  }
  const createReality = deps.createReality ?? null;
  if (count("reality") > 0 && createReality === null) {
    io.err("The Reality Check arm is not wired into this command (tools/eval/run.ts passes createRealityArm); run grounded, ghost or both.");
    return EXIT.failed;
  }
  if (!args.yes) {
    io.err(`This calls Anthropic and Qloo live and may spend up to ${formatUsd(Math.max(0, args.usdCap - spent))} (--usd-cap). Nothing was sent; add --yes to start.`);
    return EXIT.usage;
  }

  const tag = args.tag ?? (env.QLOO_TAG?.trim() || "eval");
  let opened: AgentQloo;
  try {
    opened = await openAgentQloo({ env, io, mock: args.mockQloo, tag, memory: args.memory, store: deps.store, kv: deps.kv, fetch: deps.fetch });
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    io.err(err.message);
    return EXIT.failed;
  }
  const { qloo, localities } = opened;
  if (manifest !== null && manifest.qloo !== qloo.client.env) {
    io.err(`Refusing to resume ${stamp}: it ran on Qloo ${manifest.qloo}, and this session would add ${qloo.client.env} answers to it.`);
    await qloo.close();
    return EXIT.failed;
  }
  if (unregistered !== null && qloo.client.env !== "mock") {
    io.err(`Refusing to start eval ${stamp} on Qloo ${qloo.client.env}: ${unregistered}. Commit them first; nothing was sent.`);
    await qloo.close();
    return EXIT.failed;
  }
  const started = now();
  const session = { startedAt: started.toISOString(), argv: [command, ...argvOf(args)] };
  writeJson(
    dir.manifest,
    Manifest.parse(
      manifest !== null
        ? { ...manifest, sessions: [...manifest.sessions, session] }
        : {
            version: 1,
            stamp,
            createdAt: started.toISOString(),
            model,
            qloo: qloo.client.env,
            registration: { ...hashes, commit: registration.commit, dirty: registration.dirty },
            sessions: [session],
          },
    ),
  );
  io.out(`  directory ${dir.root} · Qloo ${qloo.client.env} · tag ${qloo.tag} · cache ${qloo.storeLabel}\n`);

  const anthropic = (deps.createAnthropic ?? createAnthropic)(apiKey);
  const live: EvalArms = {
    grounded: createGroundedArm({ qloo: qloo.client, anthropic, localities, runAgent: deps.runAgent, now }),
    ghost: createGhostArm(
      {
        api: deps.ghostApi,
        anthropic,
        openSearch: () => {
          let calls = 0;
          const tool = qloo.client.standalone({ onCall: () => (calls += 1), signal }).forTool(null);
          return { search: (params) => tool.search(params), calls: () => calls };
        },
        log: io.err,
      },
      model,
    ),
    reality:
      createReality === null
        ? null
        : createReality({ anthropic, qloo: qloo.client, localities, model, file: registered.cases, rawDir: path.join(dir.root, "reality"), log: io.err, now, signal }),
  };
  let outcome: Awaited<ReturnType<typeof runSession>>;
  try {
    outcome = await runSession({ dir, plan, arms: live, usdCap: args.usdCap, defaultModel: model, io, signal, now });
  } finally {
    await qloo.close();
  }
  const failed = outcome.ran.filter((r) => !r.ok);
  io.out(
    heading(
      `session · ${outcome.ran.length} ran (${failed.length} to run again), ${outcome.skipped.length} skipped` +
        `${outcome.stopped === null ? "" : `, stopped: ${outcome.stopped === "cap" ? "--usd-cap" : "cancelled"}`} · eval spend ${formatUsd(outcome.spentUsd)} of ${formatUsd(args.usdCap)}`,
    ),
  );
  if (failed.length > 0) io.out(`  --resume runs again: ${failed.map((r) => r.unit).join(", ")}`);
  const written = report(deps, io, dir, registered, args.writeSummary);
  return outcome.stopped === null && failed.length === 0 && written ? EXIT.ok : EXIT.failed;
}

/** The options of a session as the manifest records them (never the key, never the environment). */
function argvOf(args: EvalArgs): string[] {
  return [
    ...(args.only === null ? [] : ["--only", args.only.join(",")]),
    "--usd-cap",
    String(args.usdCap),
    "--takes",
    String(args.takes),
    ...(args.mockQloo ? ["--mock-qloo"] : []),
    ...(args.memory ? ["--memory"] : []),
  ];
}
