// The offline eval's raw outputs (SPEC §6.7): one directory per eval under .private/eval/<stamp>/
// (gitignored, and blocked by pnpm guard), one file per question and arm, written as each finishes, so
// a session that stops, fails or meets the spend cap resumes where it stopped, and an attempt log that
// keeps what every attempt spent once a rerun has overwritten its record. These files hold Qloo
// values, entity refs and request ids: only the aggregates tools/eval/summary.ts derives from them are
// published (D29).
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DatasetEnvelope,
  EntityRefSchema,
  GhostAnswer,
  GhostDiff,
  GhostPickCategory,
  IsoDateTime,
  Job,
  MarketId,
  MetroId,
  NumbersTraced,
  Report,
  SafetyCategory,
  TerminalRunStatus,
  TokenUsage,
  type EventInput,
} from "@ct/contracts";
import { z } from "zod";
import { readSpend, type SpendTally } from "../dev/cli/spend";
import { QUESTIONS_FILE, REALITY_CASES_FILE, RealityKind } from "./cases";

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const Usd = z.number().nonnegative();
const Rate = z.number().min(0).max(1);
const Count = z.int().nonnegative();

/** A question id of eval/questions.json (q01, a01): safe in a file name. */
export const QUESTION_ID = /^[qao]\d{2}$/;
/** A case id of eval/reality_cases.json (rc01). */
export const CASE_ID = /^rc\d{2}$/;

// Records ---------------------------------------------------------------------------------------------

/** One grounded run (the full system, as a web live run takes it) of one question; take 2 and on are reruns. */
export const GroundedRecord = z.object({
  version: z.literal(1),
  questionId: z.string().regex(QUESTION_ID),
  take: z.int().positive(),
  /** "cli-eval-…": a dev-CLI id, which the web leaves out of its run counts (apps/web/server/run-counts.ts). */
  runId: z.string().min(1),
  status: TerminalRunStatus,
  reason: z.string().nullable(),
  /** The ANALYST model, or null when the run ended before it. */
  model: z.string().nullable(),
  /** CLERK's job, or null when CLERK never read the question. */
  job: Job.nullable(),
  /** The gazetteer metro GHOST's neighbourhood picks resolve in (CLERK's metro; taste_twins' target city); null when none. */
  metro: MetroId.nullable(),
  /** For a refused run, the category the refusal applied (apps/web/server/preview.ts's rule); null otherwise. */
  refusalCategory: SafetyCategory.nullable(),
  /** Hypotheses in submit_plan, or null when the run made no plan. */
  plannedHypotheses: Count.nullable(),
  /** Whether the CHECKER accepted the first draft (validation attempt 1); null when no draft reached it. */
  checkerFirstPass: z.boolean().nullable(),
  /** The CHECKER's count on the shipped draft; null when it never ran. */
  numbersTraced: NumbersTraced.nullable(),
  qloo: z.object({ network: Count, cached: Count, reused: Count }),
  usd: Usd,
  elapsedMs: z.number().nonnegative(),
  report: Report.nullable(),
  finishedAt: IsoDateTime,
});
export type GroundedRecord = z.infer<typeof GroundedRecord>;

/**
 * A GHOST pick as @ct/agent's resolveGhostPicks returns it, kept whole so a later session can diff it
 * against a rerun. entityId is a Qloo id: it stays in .private/eval/ (D29).
 */
export const ResolvedGhostPick = z.object({
  name: z.string(),
  category: GhostPickCategory,
  rank: z.int().positive(),
  ref: EntityRefSchema.nullable(),
  entityId: z.string().nullable(),
  market: MarketId.nullable(),
  area: z.object({ metro: MetroId, id: z.string() }).nullable(),
  matchedName: z.string().nullable(),
  /** Qloo popularity (0 to 1) of the matched entity; null when unknown. */
  popularity: z.number().nullable(),
  /** The pick resolves exactly (D20). */
  exact: z.boolean(),
  /** catalogue, gazetteer and search are checked lookups; skipped (past the ten searches) and failed are not. */
  lookup: z.enum(["catalogue", "gazetteer", "search", "skipped", "failed"]),
});
export type ResolvedGhostPick = z.infer<typeof ResolvedGhostPick>;

/** A lookup that ran (catalogue, gazetteer or search); skipped and failed leave the pick unchecked. */
export const isChecked = (lookup: ResolvedGhostPick["lookup"]): boolean => lookup === "catalogue" || lookup === "gazetteer" || lookup === "search";

/** GHOST's answer to one question (the same model with no tools, D23) and its picks as resolved. */
export const GhostRecord = z.object({
  version: z.literal(1),
  questionId: z.string().regex(QUESTION_ID),
  /** Null when the API refused to answer (stop_reason refusal), a settled outcome. */
  answer: GhostAnswer.nullable(),
  /** The API's refusal, in words; null when GHOST answered. */
  refusal: z.string().nullable(),
  /** Every pick, looked up or not (ten searches at most an answer); a failed lookup is done again on --resume. */
  resolved: z.array(ResolvedGhostPick),
  model: z.string().min(1),
  /** The job GHOST was told: the grounded run's, else the registered one. */
  job: Job,
  tokens: TokenUsage.nullable(),
  usd: Usd,
  ms: z.number().nonnegative(),
  /** Qloo calls the lookups made (cached or not), a later lookup of failed picks included; GHOST itself makes none. */
  lookups: Count,
  finishedAt: IsoDateTime,
});
export type GhostRecord = z.infer<typeof GhostRecord>;

/** buildGhostDiff of a question's GHOST answer against one grounded take's report (pure code, no spend). */
export const DiffRecord = z.object({
  version: z.literal(1),
  questionId: z.string().regex(QUESTION_ID),
  take: z.int().positive(),
  /** The grounded run the diff was built from; a rerun of that take under a new id makes it stale. */
  runId: z.string().min(1),
  diff: GhostDiff,
});
export type DiffRecord = z.infer<typeof DiffRecord>;

/** One Reality Check case as the reality arm scored it (SPEC §6.6, the rules in eval/reality_cases.json). */
export const RealityCaseResult = z.object({
  /** The registered choice resolved exactly in Qloo; an unresolved case is reported, never replaced. */
  resolved: z.boolean(),
  /** The real choice's percentile among the scored candidates (comedian: the median over its booked markets); null when not scored. */
  percentile: Rate.nullable(),
  /** The real choice is among GHOST's picks (comedian: a booked market in its top 5); null when GHOST did not answer. */
  ghostHit: z.boolean().nullable(),
  /** Comedian cases: the chance of a hit given the booked share of the secondary markets; null otherwise. */
  chanceHit: Rate.nullable(),
  /** Candidates scored in the one call. */
  candidates: Count.nullable(),
  /** Comedian cases: the booked-versus-unbooked market comparisons, and how many tied (counts only); null otherwise. */
  ties: z.object({ tied: Count, of: Count }).nullable(),
  usd: Usd,
  ms: z.number().nonnegative(),
  qlooCalls: Count,
  note: z.string().nullable(),
  /** Whatever else the arm keeps (scores, picks); private, never read by the summary. */
  detail: z.unknown(),
});
export type RealityCaseResult = z.infer<typeof RealityCaseResult>;

export const RealityRecord = RealityCaseResult.extend({
  version: z.literal(1),
  caseId: z.string().regex(CASE_ID),
  kind: RealityKind,
  showcase: z.string().nullable(),
  finishedAt: IsoDateTime,
});
export type RealityRecord = z.infer<typeof RealityRecord>;

/**
 * One unit as the runner saw it end, appended to attempts.jsonl before its record is written: a rerun
 * overwrites the record of the attempt before it, and a unit that threw writes none, so only this log
 * holds what every attempt spent.
 */
export const Attempt = z.object({
  version: z.literal(1),
  /** The unit's label (runner.ts unitLabel): "grounded q01 t1", "ghost q01", "reality rc01,rc02". */
  unit: z.string().min(1),
  /** The grounded run's id; null for the other arms and for a unit that threw. */
  runId: z.string().nullable(),
  /** The unit has its answer (runner.ts UnitResult.ok). */
  ok: z.boolean(),
  /** Measured LLM spend; null when unknown (the unit threw before a response), so its worst case stays booked. */
  usd: Usd.nullable(),
  worstUsd: Usd,
  /** Qloo calls the unit made, cached or not; null when unknown. */
  qlooCalls: Count.nullable(),
  /** Of those, the ones that went to the network: grounded runs only, null for the other arms. */
  qlooNetwork: Count.nullable(),
  at: IsoDateTime,
});
export type Attempt = z.infer<typeof Attempt>;

/** The eval's identity: the registered inputs it answers, checked again on every --resume. */
export const Manifest = z.object({
  version: z.literal(1),
  stamp: z.string().min(1),
  createdAt: IsoDateTime,
  /** The ANALYST model both arms use (D23: GHOST is the same model). */
  model: z.string().min(1),
  /** The Qloo environment (prod, dev or mock): every session of the eval uses the same, and a mock eval publishes nothing. */
  qloo: z.string().min(1),
  registration: z.object({
    questionsSha256: z.string().regex(/^[0-9a-f]{64}$/),
    realityCasesSha256: z.string().regex(/^[0-9a-f]{64}$/),
    /** The last commit that touched the registered files; null when they were never committed. */
    commit: z.string().nullable(),
    /** The registered files differ from that commit. */
    dirty: z.boolean(),
  }),
  sessions: z.array(z.object({ startedAt: IsoDateTime, argv: z.array(z.string()) })),
});
export type Manifest = z.infer<typeof Manifest>;

// The directory ------------------------------------------------------------------------------------------

export interface EvalDir {
  root: string;
  stamp: string;
  manifest: string;
  /** The spend tally (tools/dev/cli/spend.ts): worst cases booked before each unit, settled after. */
  spend: string;
  /** Every unit's outcome, one Attempt a line, failed and overwritten attempts included. */
  attempts: string;
  grounded(questionId: string, take: number): string;
  /** Every event the grounded run emitted, for reading a result later. */
  groundedEvents(questionId: string, take: number): string;
  /** The run's ledger datasets, which buildGhostDiff reads the brief's picks from. */
  groundedDatasets(questionId: string, take: number): string;
  ghost(questionId: string): string;
  diff(questionId: string, take: number): string;
  reality(caseId: string): string;
}

function checked(id: string, pattern: RegExp): string {
  if (!pattern.test(id)) throw new RangeError(`not an eval id: "${id}"`);
  return id;
}

export function evalDir(out: string, stamp: string): EvalDir {
  const root = path.join(out, stamp);
  return {
    root,
    stamp,
    manifest: path.join(root, "manifest.json"),
    spend: path.join(root, "spend.json"),
    attempts: path.join(root, "attempts.jsonl"),
    grounded: (q, take) => path.join(root, "grounded", `${checked(q, QUESTION_ID)}.t${take}.json`),
    groundedEvents: (q, take) => path.join(root, "grounded", `${checked(q, QUESTION_ID)}.t${take}.events.json`),
    groundedDatasets: (q, take) => path.join(root, "grounded", `${checked(q, QUESTION_ID)}.t${take}.datasets.json`),
    ghost: (q) => path.join(root, "ghost", `${checked(q, QUESTION_ID)}.json`),
    diff: (q, take) => path.join(root, "diff", `${checked(q, QUESTION_ID)}.t${take}.json`),
    reality: (c) => path.join(root, "reality", `${checked(c, CASE_ID)}.json`),
  };
}

/** "20261023T101500Z": a directory name that sorts by time. */
export function evalStamp(now: Date): string {
  return now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** The newest eval directory under `out` (by name, which sorts by time), or null. */
export function latestStamp(out: string): string | null {
  let names: string[];
  try {
    names = readdirSync(out, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  return names.sort().at(-1) ?? null;
}

/** Written to a temporary file and renamed into place, so a crash mid-write never leaves a torn record. */
export function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

const isMissing = (err: unknown): boolean => typeof err === "object" && err !== null && (err as { code?: unknown }).code === "ENOENT";

/** A record that exists but does not parse: the eval refuses to go on rather than redo or skip it silently. */
export class RecordError extends Error {
  override readonly name = "RecordError";
}

/** The record in `file`, or null when there is none. */
export function readRecord<T extends z.ZodType>(file: string, schema: T): z.infer<T> | null {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (isMissing(err)) return null;
    throw new RecordError(`${file} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new RecordError(`${file} is not JSON; delete it to redo that unit`);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new RecordError(`${file} is not a valid record (${parsed.error.issues[0]?.message ?? "invalid"}); delete it to redo that unit`);
  return parsed.data;
}

export function writeGroundedRecord(dir: EvalDir, record: GroundedRecord, events: readonly EventInput[], datasets: readonly DatasetEnvelope[]): void {
  // The record last: a record on disk always has its events and datasets beside it.
  writeJson(dir.groundedEvents(record.questionId, record.take), events);
  writeJson(dir.groundedDatasets(record.questionId, record.take), datasets);
  writeJson(dir.grounded(record.questionId, record.take), GroundedRecord.parse(record));
}

/** A grounded take's ledger datasets; empty when the file is missing. */
export function readDatasets(dir: EvalDir, questionId: string, take: number): DatasetEnvelope[] {
  return readRecord(dir.groundedDatasets(questionId, take), z.array(DatasetEnvelope)) ?? [];
}

/** One line appended to attempts.jsonl; a line is short, so an append never interleaves with another. */
export function appendAttempt(dir: EvalDir, attempt: Attempt): void {
  mkdirSync(path.dirname(dir.attempts), { recursive: true });
  appendFileSync(dir.attempts, `${JSON.stringify(Attempt.parse(attempt))}\n`, "utf8");
}

/** Every attempt in the log, in order; empty when there is none. A line that does not parse throws RecordError. */
export function readAttempts(dir: EvalDir): Attempt[] {
  let text: string;
  try {
    text = readFileSync(dir.attempts, "utf8");
  } catch (err) {
    if (isMissing(err)) return [];
    throw new RecordError(`${dir.attempts} cannot be read: ${err instanceof Error ? err.message : String(err)}`);
  }
  return text.split(/\r?\n/).flatMap((line, i) => {
    if (line.trim() === "") return [];
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      raw = null;
    }
    const parsed = Attempt.safeParse(raw);
    if (!parsed.success) throw new RecordError(`${dir.attempts} line ${i + 1} is not a valid attempt; fix or delete that line`);
    return [parsed.data];
  });
}

/**
 * Deletes every diff of a question, so the next refreshDiffs builds them again (a diff is pure code over
 * the records). Used before the question's GHOST picks are rewritten: a crash in between leaves no diff
 * of the old picks behind.
 */
export function removeDiffs(dir: EvalDir, questionId: string): void {
  const folder = path.dirname(dir.diff(questionId, 1));
  const pattern = new RegExp(`^${questionId}\\.t\\d+\\.json$`);
  for (const name of listFiles(folder, pattern)) rmSync(path.join(folder, name), { force: true });
}

export interface EvalRecordSet {
  grounded: GroundedRecord[];
  ghost: GhostRecord[];
  diffs: DiffRecord[];
  reality: RealityRecord[];
  /** The attempt log, failed and overwritten attempts included. */
  attempts: Attempt[];
  /** The directory's spend tally: measured spend plus the worst case of every unit whose cost is unknown. */
  tally: SpendTally;
}

function listFiles(dir: string, pattern: RegExp): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => pattern.test(name))
      .sort();
  } catch (err) {
    if (isMissing(err)) return [];
    throw err;
  }
}

function readAll<T extends z.ZodType>(dir: string, pattern: RegExp, schema: T): z.infer<T>[] {
  return listFiles(dir, pattern).flatMap((name) => {
    const record = readRecord(path.join(dir, name), schema);
    return record === null ? [] : [record];
  });
}

/**
 * Every record in the directory, its attempt log and its spend tally. Files of other names are ignored; a
 * record that does not parse throws RecordError.
 */
export function loadRecords(dir: EvalDir): EvalRecordSet {
  return {
    grounded: readAll(path.join(dir.root, "grounded"), /^[qao]\d{2}\.t\d+\.json$/, GroundedRecord),
    ghost: readAll(path.join(dir.root, "ghost"), /^[qao]\d{2}\.json$/, GhostRecord),
    diffs: readAll(path.join(dir.root, "diff"), /^[qao]\d{2}\.t\d+\.json$/, DiffRecord),
    reality: readAll(path.join(dir.root, "reality"), /^rc\d{2}\.json$/, RealityRecord),
    attempts: readAttempts(dir),
    tally: readSpend(dir.spend),
  };
}

// The registered inputs -------------------------------------------------------------------------------------

export function sha256File(file: URL | string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

/** The sha256 of eval/questions.json and eval/reality_cases.json as they are now. */
export function registeredHashes(files: { questions: URL | string; realityCases: URL | string } = { questions: QUESTIONS_FILE, realityCases: REALITY_CASES_FILE }) {
  return { questionsSha256: sha256File(files.questions), realityCasesSha256: sha256File(files.realityCases) };
}
