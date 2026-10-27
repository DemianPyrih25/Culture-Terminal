// One session of the offline eval (SPEC §6.7): the units a command asks for (each question's grounded
// takes and its GHOST answer, then the Reality Check's open cases together) run one at a time and are
// written as they finish, so --resume skips what is already answered and runs again what is not
// settled. A hard spend cap: before each unit its worst case is booked in the directory's spend tally
// (tools/dev/cli/spend.ts) against --usd-cap, which counts every session of the directory; the session
// stops before the first unit that would pass the cap and names every unit it skipped. A unit that
// throws keeps its worst case booked, since what it spent is unknown, unless it says (SpentError).
// Every unit's outcome goes to the attempt log before its record is written, so a rerun never hides
// what the attempt before it spent. The arms are injected: the CLI wires the real ones, the tests fakes.
import type { DatasetEnvelope, EventInput, GhostAnswer, GhostDiff, Job, MetroId, Report } from "@ct/contracts";
import { z } from "zod";
import { ordinal } from "../../apps/web/components/method/eval-ids";
import { formatMs, formatUsd } from "../dev/cli/format";
import type { CliIo } from "../dev/cli/io";
import { readSpend, reserveSpend, settleSpend } from "../dev/cli/spend";
import type { EvalQuestion, RealityCase } from "./cases";
import {
  appendAttempt,
  DiffRecord,
  GhostRecord,
  GroundedRecord,
  isChecked,
  loadRecords,
  readDatasets,
  readRecord,
  RealityRecord,
  RecordError,
  removeDiffs,
  writeGroundedRecord,
  writeJson,
  type Attempt,
  type EvalDir,
  type RealityCaseResult,
  type ResolvedGhostPick,
} from "./records";

export const EVAL_ARMS = ["grounded", "ghost", "reality"] as const;
export type EvalArm = (typeof EVAL_ARMS)[number];

/** The commands that run arms, and the arms each runs. */
export const EVAL_COMMANDS = {
  grounded: ["grounded"],
  ghost: ["ghost"],
  both: ["grounded", "ghost"],
  reality: ["reality"],
  all: ["grounded", "ghost", "reality"],
} as const satisfies Record<string, readonly EvalArm[]>;
export type EvalCommand = keyof typeof EVAL_COMMANDS;

export interface GroundedArm {
  /** Booked before each run: the per-run hard cap, CLERK included. */
  worstCaseUsd: number;
  run(input: { question: EvalQuestion; take: number; signal: AbortSignal }): Promise<{ record: GroundedRecord; events: EventInput[]; datasets: DatasetEnvelope[] }>;
}

/** One GHOST answer as the arm returns it; the runner adds the question, the job and the time. */
export type GhostOutcome = Omit<GhostRecord, "version" | "questionId" | "job" | "finishedAt">;

export interface GhostArm {
  /** Booked before each answer: a bounded figure for its one model call. */
  worstCaseUsd: number;
  /** `metro`: the question's gazetteer metro, for a neighbourhood name two metros share. */
  answer(input: { question: string; job: Job; model: string; metro: MetroId | null; signal: AbortSignal }): Promise<GhostOutcome>;
  /**
   * Looks up again the picks of a recorded answer whose lookup failed (no model call, no LLM spend): the
   * picks as they now stand, and the Qloo calls this made.
   */
  lookUpAgain(input: { answer: GhostAnswer; resolved: ResolvedGhostPick[]; metro: MetroId | null; signal: AbortSignal }): Promise<{ resolved: ResolvedGhostPick[]; lookups: number }>;
  /** buildGhostDiff against one grounded take: pure code, no spend. */
  diff(input: { answer: GhostAnswer; resolved: ResolvedGhostPick[]; report: Report; datasets: DatasetEnvelope[] }): GhostDiff;
}

/** A unit that failed after its response arrived: what it spent is known, so that is counted instead of its worst case. */
export class SpentError extends Error {
  override readonly name = "SpentError";
  constructor(
    message: string,
    readonly usd: number,
  ) {
    super(message);
  }
}

/**
 * The Reality Check (built by the reality stream, tools/eval/reality.ts): the cases scored together, by
 * the rules registered with them, since cases share calls (the comedian panel's markets).
 */
export interface RealityArm {
  /** Booked before the check starts: its worst case for these cases. */
  worstCaseUsd(cases: readonly RealityCase[]): number;
  /** One result per case given, in any order. */
  run(input: { cases: readonly RealityCase[]; signal: AbortSignal }): Promise<(RealityCaseResult & { caseId: string })[]>;
}

/** "lookups" is the GHOST arm's: a recorded answer whose failed pick lookups are looked up again. */
export type EvalUnit =
  | { arm: "grounded"; question: EvalQuestion; take: number }
  | { arm: "ghost"; question: EvalQuestion }
  | { arm: "lookups"; question: EvalQuestion }
  | { arm: "reality"; cases: readonly RealityCase[] };

/** "grounded q01 t1", "ghost q01", "ghost q01 lookups", "reality rc01,rc02". */
export function unitLabel(unit: EvalUnit): string {
  switch (unit.arm) {
    case "grounded":
      return `grounded ${unit.question.id} t${unit.take}`;
    case "ghost":
      return `ghost ${unit.question.id}`;
    case "lookups":
      return `ghost ${unit.question.id} lookups`;
    case "reality":
      return `reality ${unit.cases.map((c) => c.id).join(",")}`;
  }
}

/** A grounded take that ended failed or cancelled is run again on --resume; any other ending is its answer. */
export function isSettled(record: GroundedRecord): boolean {
  return record.status !== "failed" && record.status !== "cancelled";
}

/** Picks whose search threw (a 5xx after retries, the tag's cap, a cancel): --resume looks them up again. */
export const failedLookups = (record: Pick<GhostRecord, "resolved">): ResolvedGhostPick[] => record.resolved.filter((p) => p.lookup === "failed");

/**
 * What runRealityCheck keeps in a record's detail (tools/eval/reality.ts RealityCaseResult) that says
 * whether the case could end otherwise on a retry. Read leniently: the detail is the reality arm's.
 */
const RealityRetryDetail = z.object({
  /** The arm's own verdict: a call the case needed (a comedian case: any of the panel's) failed or was refused. */
  retry: z.boolean().optional(),
  reason: z.string().nullable().optional(),
  ghost: z.object({ error: z.string().nullable().optional(), retryable: z.boolean().optional() }).nullable().optional(),
});

/**
 * Why a Reality Check case's record is not its answer, or null when it is: a Qloo call that failed or
 * that the tag's cap refused (the per-tag count persists, so a fresh --tag lifts it), a call it shares
 * with other cases that failed, or a GHOST answer that failed in a way a retry can fix (the arm marks it
 * retryable; the API's own refusal is not). --resume runs such a case again.
 */
export function realityRetry(record: Pick<RealityCaseResult, "detail">): string | null {
  const parsed = RealityRetryDetail.safeParse(record.detail);
  if (!parsed.success) return null;
  const { retry, reason, ghost } = parsed.data;
  if (reason === "call_failed" || reason === "budget") return reason;
  if (ghost?.retryable === true && typeof ghost.error === "string") return `GHOST: ${ghost.error}`;
  return retry === true ? "marked for a retry" : null;
}

export interface EvalPlan {
  arms: readonly EvalArm[];
  questions: readonly EvalQuestion[];
  cases: readonly RealityCase[];
  /** Grounded takes per question; a second one measures top-5 stability. */
  takes: number;
}

/**
 * The units still to run, in order: per question its grounded takes then its GHOST answer (so a cap
 * leaves paired answers behind), then the Reality Check cases. A unit with a settled record is left out;
 * a GHOST answer with failed lookups keeps its answer and has only those looked up again.
 */
export function pendingUnits(dir: EvalDir, plan: EvalPlan): EvalUnit[] {
  const units: EvalUnit[] = [];
  const has = (arm: EvalArm) => plan.arms.includes(arm);
  for (const question of plan.questions) {
    if (has("grounded")) {
      for (let take = 1; take <= plan.takes; take++) {
        const record = readRecord(dir.grounded(question.id, take), GroundedRecord);
        if (record === null || !isSettled(record)) units.push({ arm: "grounded", question, take });
      }
    }
    if (has("ghost")) {
      const record = readRecord(dir.ghost(question.id), GhostRecord);
      if (record === null) units.push({ arm: "ghost", question });
      else if (record.answer !== null && failedLookups(record).length > 0) units.push({ arm: "lookups", question });
    }
  }
  if (has("reality")) {
    const cases = plan.cases.filter((c) => {
      const record = readRecord(dir.reality(c.id), RealityRecord);
      return record === null || realityRetry(record) !== null;
    });
    if (cases.length > 0) units.push({ arm: "reality", cases });
  }
  return units;
}

export interface EvalArms {
  grounded: GroundedArm | null;
  ghost: GhostArm | null;
  reality: RealityArm | null;
}

function armFor<A extends EvalArm>(arms: EvalArms, arm: A): NonNullable<EvalArms[A]> {
  const found = arms[arm];
  if (found === null) throw new Error(`the ${arm} arm is not available`);
  return found as NonNullable<EvalArms[A]>;
}

/** The worst case booked before a unit; looking picks up again calls no model. */
export function worstCaseOf(unit: EvalUnit, arms: EvalArms): number {
  switch (unit.arm) {
    case "reality":
      return armFor(arms, "reality").worstCaseUsd(unit.cases);
    case "lookups":
      return 0;
    default:
      return armFor(arms, unit.arm).worstCaseUsd;
  }
}

/**
 * Builds the diff of the question's GHOST answer against every grounded take with a report, where none
 * exists yet or the take was rerun since. Pure code and free, so it runs whichever arms the session ran.
 * Returns how many diffs it wrote; a diff that throws is reported and left for the next session.
 */
export function refreshDiffs(dir: EvalDir, ghost: GhostArm | null, questionIds: readonly string[], warn: (line: string) => void): number {
  if (ghost === null) return 0;
  let written = 0;
  const { grounded, ghost: answers, diffs } = loadRecords(dir);
  for (const { questionId, answer, resolved } of answers) {
    if (answer === null || !questionIds.includes(questionId)) continue;
    for (const run of grounded) {
      const report = run.report;
      if (run.questionId !== questionId || report === null) continue;
      const existing = diffs.find((d) => d.questionId === run.questionId && d.take === run.take);
      if (existing?.runId === run.runId) continue;
      try {
        const diff = ghost.diff({ answer, resolved, report, datasets: readDatasets(dir, run.questionId, run.take) });
        writeJson(dir.diff(run.questionId, run.take), DiffRecord.parse({ version: 1, questionId: run.questionId, take: run.take, runId: run.runId, diff }));
        written += 1;
      } catch (err) {
        if (err instanceof RecordError) throw err;
        warn(`diff ${run.questionId} t${run.take}: ${err instanceof Error ? err.message : String(err)}; left for the next session`);
      }
    }
  }
  return written;
}

export interface EvalSession {
  dir: EvalDir;
  plan: EvalPlan;
  arms: EvalArms;
  usdCap: number;
  /** The model GHOST answers a question with before any grounded run has one (D23: the ANALYST's). */
  defaultModel: string;
  io: CliIo;
  signal: AbortSignal;
  now: () => Date;
}

export interface UnitResult {
  unit: string;
  /**
   * The unit has its answer; false for a failed, cancelled or thrown one, a GHOST answer with failed
   * lookups and a Reality Check case that may end otherwise on a retry, which --resume runs again.
   */
  ok: boolean;
  note: string;
}

export interface SessionOutcome {
  ran: UnitResult[];
  /** Units not started, by label. */
  skipped: string[];
  stopped: "cap" | "cancelled" | null;
  /** The directory's tally after the session: measured spend plus the worst case of any unit that threw. */
  spentUsd: number;
}

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Appends a unit's outcome to the attempt log: before its record is written, so a rerun never hides an earlier attempt. */
function logAttempt(s: EvalSession, unit: EvalUnit, worstUsd: number, outcome: Pick<Attempt, "runId" | "ok" | "usd" | "qlooCalls" | "qlooNetwork">): void {
  appendAttempt(s.dir, { version: 1, unit: unitLabel(unit), ...outcome, worstUsd, at: s.now().toISOString() });
}

async function runUnit(s: EvalSession, unit: EvalUnit, worst: number): Promise<{ usd: number; result: UnitResult }> {
  const label = unitLabel(unit);
  const finishedAt = () => s.now().toISOString();
  switch (unit.arm) {
    case "grounded": {
      const { record, events, datasets } = await armFor(s.arms, "grounded").run({ question: unit.question, take: unit.take, signal: s.signal });
      const q = record.qloo;
      const ok = isSettled(record);
      logAttempt(s, unit, worst, { runId: record.runId, ok, usd: record.usd, qlooCalls: q.network + q.cached + q.reused, qlooNetwork: q.network });
      writeGroundedRecord(s.dir, record, events, datasets);
      const note = `${record.status} · ${formatMs(record.elapsedMs)} · ${formatUsd(record.usd)} · Qloo ${q.network + q.cached + q.reused} (${q.network} network)`;
      return { usd: record.usd, result: { unit: label, ok, note } };
    }
    case "ghost": {
      // D23: GHOST runs on the model of the question's own grounded run, with the job and metro CLERK read,
      // so its lists are the ones the brief ranks; before any grounded run, the registered job.
      const primary = readRecord(s.dir.grounded(unit.question.id, 1), GroundedRecord);
      const job = primary?.job ?? unit.question.job;
      const model = primary?.model ?? s.defaultModel;
      const out = await armFor(s.arms, "ghost").answer({ question: unit.question.question, job, model, metro: primary?.metro ?? null, signal: s.signal });
      const failed = failedLookups(out).length;
      logAttempt(s, unit, worst, { runId: null, ok: failed === 0, usd: out.usd, qlooCalls: out.lookups, qlooNetwork: null });
      writeJson(s.dir.ghost(unit.question.id), GhostRecord.parse({ version: 1, questionId: unit.question.id, job, ...out, finishedAt: finishedAt() }));
      const looked = out.resolved.filter((p) => isChecked(p.lookup));
      const what =
        out.answer === null
          ? `refused (${out.refusal ?? "no reason"})`
          : `${out.resolved.length} picks, ${looked.filter((p) => p.exact).length} of ${looked.length} looked up resolve exactly` +
            `${failed > 0 ? `, ${failed} lookup(s) failed and --resume looks them up again` : ""}`;
      return { usd: out.usd, result: { unit: label, ok: failed === 0, note: `${what} · ${formatMs(out.ms)} · ${formatUsd(out.usd)}` } };
    }
    case "lookups": {
      const record = readRecord(s.dir.ghost(unit.question.id), GhostRecord);
      if (record?.answer == null) throw new Error("no recorded GHOST answer to look up");
      const primary = readRecord(s.dir.grounded(unit.question.id, 1), GroundedRecord);
      const before = failedLookups(record).length;
      const out = await armFor(s.arms, "ghost").lookUpAgain({ answer: record.answer, resolved: record.resolved, metro: primary?.metro ?? null, signal: s.signal });
      const failed = failedLookups(out).length;
      logAttempt(s, unit, worst, { runId: null, ok: failed === 0, usd: 0, qlooCalls: out.lookups, qlooNetwork: null });
      // The diffs of the old picks go first, so a stop before refreshDiffs leaves none of them behind.
      removeDiffs(s.dir, unit.question.id);
      writeJson(s.dir.ghost(unit.question.id), GhostRecord.parse({ ...record, resolved: out.resolved, lookups: record.lookups + out.lookups }));
      const note = `${before - failed} of ${before} failed lookup(s) done${failed > 0 ? `, ${failed} failed again and --resume looks them up again` : ""} · Qloo ${out.lookups}`;
      return { usd: 0, result: { unit: label, ok: failed === 0, note } };
    }
    case "reality": {
      const results = await armFor(s.arms, "reality").run({ cases: unit.cases, signal: s.signal });
      const mine = unit.cases.flatMap((c) => {
        const out = results.find((r) => r.caseId === c.id);
        return out === undefined ? [] : [{ c, out }];
      });
      const usd = mine.reduce((n, { out }) => n + out.usd, 0);
      const missing = unit.cases.filter((c) => !results.some((r) => r.caseId === c.id)).map((c) => c.id);
      const retry = mine.flatMap(({ c, out }) => {
        const why = realityRetry(out);
        return why === null ? [] : [{ id: c.id, why }];
      });
      const ok = missing.length === 0 && retry.length === 0;
      logAttempt(s, unit, worst, { runId: null, ok, usd, qlooCalls: mine.reduce((n, { out }) => n + out.qlooCalls, 0), qlooNetwork: null });
      const scored: string[] = [];
      for (const { c, out } of mine) {
        writeJson(s.dir.reality(c.id), RealityRecord.parse({ ...out, version: 1, caseId: c.id, kind: c.kind, showcase: c.showcase, finishedAt: finishedAt() }));
        if (out.percentile !== null) scored.push(`${c.id} ${ordinal(Math.round(out.percentile * 100))}`);
      }
      const again =
        retry.length === 0
          ? ""
          : `; --resume runs again ${retry.map((r) => `${r.id} (${r.why})`).join(", ")}` +
            `${retry.some((r) => r.why === "budget") ? ", with a fresh --tag, since the tag's cap counts every earlier call" : ""}`;
      const note = `${scored.length} of ${unit.cases.length} cases scored${scored.length > 0 ? ` (${scored.join(", ")})` : ""}${missing.length > 0 ? `; no result for ${missing.join(", ")}` : ""}${again} · ${formatUsd(usd)}`;
      return { usd, result: { unit: label, ok, note } };
    }
  }
}

export async function runSession(s: EvalSession): Promise<SessionOutcome> {
  const { io } = s;
  const units = pendingUnits(s.dir, s.plan);
  const ran: UnitResult[] = [];
  let stopped: SessionOutcome["stopped"] = null;
  let next = 0;
  for (; next < units.length; next++) {
    const unit = units[next]!;
    if (s.signal.aborted) {
      stopped = "cancelled";
      break;
    }
    const worst = worstCaseOf(unit, s.arms);
    const reserved = reserveSpend(s.dir.spend, s.usdCap, worst, s.now());
    if (!reserved.check.ok) {
      io.err(
        `stopping before ${unitLabel(unit)}: ${formatUsd(reserved.check.spentUsd)} spent plus up to ${formatUsd(worst)} for it would pass ` +
          `--usd-cap ${formatUsd(s.usdCap)}`,
      );
      stopped = "cap";
      break;
    }
    let outcome: { usd: number; result: UnitResult };
    try {
      outcome = await runUnit(s, unit, worst);
    } catch (err) {
      if (err instanceof RecordError) throw err;
      // A SpentError knows what it spent; for anything else the booked worst case stands.
      const spent = err instanceof SpentError ? err.usd : null;
      logAttempt(s, unit, worst, { runId: null, ok: false, usd: spent, qlooCalls: null, qlooNetwork: null });
      if (spent !== null) settleSpend(s.dir.spend, spent - worst, s.now());
      const counted = spent === null ? `counted at its worst case ${formatUsd(worst)}` : `it spent ${formatUsd(spent)}`;
      const result = { unit: unitLabel(unit), ok: false, note: `failed: ${errorText(err)} (${counted})` };
      ran.push(result);
      io.err(`${result.unit} · ${result.note}`);
      if (s.signal.aborted) {
        stopped = "cancelled";
        next += 1;
        break;
      }
      continue;
    }
    const tally = settleSpend(s.dir.spend, outcome.usd - worst, s.now());
    ran.push(outcome.result);
    io.out(`${outcome.result.unit} · ${outcome.result.note} · eval spend ${formatUsd(tally.usd)} of ${formatUsd(s.usdCap)}`);
    if (unit.arm !== "reality") refreshDiffs(s.dir, s.arms.ghost, [unit.question.id], io.err);
    // A unit cancelled midway can still return (a cancelled run, a check whose calls were aborted): the last one too stops the session.
    if (s.signal.aborted) {
      stopped = "cancelled";
      next += 1;
      break;
    }
  }
  const skipped = units.slice(next).map(unitLabel);
  if (skipped.length > 0) io.err(`skipped ${skipped.length}: ${skipped.join(", ")}`);
  // Diffs for answers an earlier session left (a GHOST answer before its grounded run, say).
  refreshDiffs(s.dir, s.arms.ghost, s.plan.questions.map((q) => q.id), io.err);
  return { ran, skipped, stopped, spentUsd: readSpend(s.dir.spend).usd };
}
