// The eval's session loop on fake arms and a temporary directory: unit order, the spend cap, resume,
// the diffs and cancellation. No model, no Qloo, no network (D29: invented records only).
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { GhostDiff, Job, MetroId } from "@ct/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { memoryIo } from "../dev/cli/io";
import { readSpend } from "../dev/cli/spend";
import { coreQuestion, ghostDiff, ghostRecord, groundedRecord, pick, realityCase, realityRecord } from "./fixtures";
import { attemptSpend } from "./metrics";
import { DiffRecord, evalDir, GhostRecord, GroundedRecord, loadRecords, readAttempts, readRecord, RealityRecord, writeJson, type EvalDir } from "./records";
import {
  isSettled,
  pendingUnits,
  realityRetry,
  refreshDiffs,
  runSession,
  SpentError,
  unitLabel,
  type EvalArm,
  type EvalArms,
  type EvalPlan,
  type GhostArm,
  type GroundedArm,
  type RealityArm,
} from "./runner";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): EvalDir {
  const out = mkdtempSync(path.join(tmpdir(), "ct-eval-runner-"));
  dirs.push(out);
  return evalDir(out, "20261023T100000Z");
}

const QUESTIONS = [coreQuestion("q01"), coreQuestion("q02", { job: "head_to_head" })];
const CASES = [realityCase("rc01"), realityCase("rc02")];

function plan(arms: readonly EvalArm[], takes = 1): EvalPlan {
  return { arms, questions: QUESTIONS, cases: CASES, takes };
}

type GroundedScript = (questionId: string, take: number, attempt: number) => Partial<GroundedRecord> | Error;

/**
 * Fake arms: grounded $0.20 a run (worst $0.60), GHOST $0.03 (worst $0.10), the Reality Check $0.02 a
 * case (worst $0.05 each). With `failedLookup`, GHOST's second pick comes back with its search failed;
 * looking it up again finds it, one Qloo call. The diff's resolvability says whether a lookup had failed.
 */
function fakeArms(script: GroundedScript = () => ({}), ghost: { fail?: Error; failedLookup?: boolean } = {}) {
  const attempts = new Map<string, number>();
  const ghostCalls: { question: string; job: Job; model: string; metro: MetroId | null }[] = [];
  const lookUps: string[][] = [];
  let n = 0;
  const grounded: GroundedArm = {
    worstCaseUsd: 0.6,
    async run({ question, take }) {
      const key = `${question.id}t${take}`;
      const attempt = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, attempt);
      const scripted = script(question.id, take, attempt);
      if (scripted instanceof Error) throw scripted;
      n += 1;
      const record = groundedRecord(question.id, { take, runId: `cli-eval-${key}-${n}`, ...scripted });
      return { record, events: [{ type: "note", text: "invented" }], datasets: [] };
    },
  };
  const ghostArm: GhostArm = {
    worstCaseUsd: 0.1,
    async answer(input) {
      ghostCalls.push({ question: input.question, job: input.job, model: input.model, metro: input.metro });
      if (ghost.fail) throw ghost.fail;
      const { answer, refusal, resolved, model, tokens, usd, ms, lookups } = ghostRecord("q01");
      const picks = ghost.failedLookup ? resolved.map((p) => (p.rank === 2 ? { ...p, lookup: "failed" as const } : p)) : resolved;
      return { answer, refusal, resolved: picks, model, tokens, usd, ms, lookups };
    },
    async lookUpAgain({ resolved }) {
      lookUps.push(resolved.filter((p) => p.lookup === "failed").map((p) => p.name));
      return { resolved: resolved.map((p) => (p.lookup === "failed" ? pick(p.name, { rank: p.rank }) : p)), lookups: 1 };
    },
    diff: ({ report, resolved }): GhostDiff =>
      ghostDiff({ overlapAt5: report.runId.endsWith("t2-2") ? 0.6 : 0.2, resolvability: resolved.some((p) => p.lookup === "failed") ? 0.25 : 0.5 }),
  };
  const reality: RealityArm = {
    worstCaseUsd: (cases) => cases.length * 0.05,
    async run({ cases }) {
      return cases.map((c) => ({ ...realityRecord(c.id), caseId: c.id }));
    },
  };
  const arms: EvalArms = { grounded, ghost: ghostArm, reality };
  return { arms, ghostCalls, attempts, lookUps };
}

function session(dir: EvalDir, arms: EvalArms, p: EvalPlan, usdCap = 5, signal = new AbortController().signal) {
  const io = memoryIo();
  let t = Date.parse("2026-10-23T10:00:00.000Z");
  const now = () => new Date((t += 1000));
  return { io, run: () => runSession({ dir, plan: p, arms, usdCap, defaultModel: "claude-sonnet-5-5", io, signal, now }) };
}

describe("the units", () => {
  it("runs each question's takes, then its GHOST answer, then the Reality Check cases together", () => {
    const dir = tempDir();
    expect(pendingUnits(dir, plan(["grounded", "ghost", "reality"], 2)).map(unitLabel)).toEqual([
      "grounded q01 t1",
      "grounded q01 t2",
      "ghost q01",
      "grounded q02 t1",
      "grounded q02 t2",
      "ghost q02",
      "reality rc01,rc02",
    ]);
  });

  it("treats a failed or cancelled take as unanswered", () => {
    expect(isSettled(groundedRecord("q01", { status: "refused" }))).toBe(true);
    expect(isSettled(groundedRecord("q01", { status: "needs_input" }))).toBe(true);
    expect(isSettled(groundedRecord("q01", { status: "failed" }))).toBe(false);
    expect(isSettled(groundedRecord("q01", { status: "cancelled" }))).toBe(false);
  });
});

describe("a session", () => {
  it("writes every record, a diff per grounded take, and the measured spend", async () => {
    const dir = tempDir();
    const { arms } = fakeArms();
    const { run, io } = session(dir, arms, plan(["grounded", "ghost", "reality"], 2));
    const outcome = await run();
    expect(outcome.stopped).toBeNull();
    expect(outcome.skipped).toEqual([]);
    expect(outcome.ran.every((r) => r.ok)).toBe(true);
    const records = loadRecords(dir);
    expect(records.grounded.map((r) => `${r.questionId}t${r.take}`)).toEqual(["q01t1", "q01t2", "q02t1", "q02t2"]);
    expect(records.ghost.map((r) => r.questionId)).toEqual(["q01", "q02"]);
    expect(records.diffs.map((d) => `${d.questionId}t${d.take}:${d.diff.overlapAt5}`)).toEqual(["q01t1:0.2", "q01t2:0.6", "q02t1:0.2", "q02t2:0.2"]);
    expect(records.reality.map((r) => r.caseId)).toEqual(["rc01", "rc02"]);
    // 4 × $0.20 + 2 × $0.03 + 2 × $0.02, each worst case settled to what the unit spent.
    expect(readSpend(dir.spend).usd).toBeCloseTo(0.9);
    expect(outcome.spentUsd).toBeCloseTo(0.9);
    expect(JSON.parse(readFileSync(dir.groundedEvents("q01", 1), "utf8"))).toEqual([{ type: "note", text: "invented" }]);
    expect(io.text()).toMatch(/grounded q01 t1 · completed · 40\.0 s · \$0\.20 · Qloo 6 \(4 network\) · eval spend \$0\.20 of \$5\.00/);
    expect(io.text()).toMatch(/reality rc01,rc02 · 2 of 2 cases scored \(rc01 80th, rc02 80th\)/);
  });

  it("gives GHOST the grounded run's model, job and metro, and the registered job before any grounded run", async () => {
    const dir = tempDir();
    const { arms, ghostCalls } = fakeArms((q) => (q === "q01" ? { job: "head_to_head", metro: "austin", model: "claude-haiku-5-5" } : {}));
    await session(dir, arms, { ...plan(["grounded", "ghost"]), questions: [QUESTIONS[0]!] }).run();
    expect(ghostCalls[0]).toMatchObject({ job: "head_to_head", metro: "austin", model: "claude-haiku-5-5" });
    const alone = tempDir();
    const second = fakeArms();
    await session(alone, second.arms, { ...plan(["ghost"]), questions: [QUESTIONS[1]!] }).run();
    expect(second.ghostCalls[0]).toMatchObject({ job: "head_to_head", metro: null, model: "claude-sonnet-5-5" });
    expect(readRecord(alone.ghost("q02"), GhostRecord)?.job).toBe("head_to_head");
  });
});

describe("the spend cap", () => {
  it("stops before the first unit whose worst case would pass it, and names every unit it skipped", async () => {
    const dir = tempDir();
    const { arms } = fakeArms();
    // $0.20 for q01, $0.03 for its GHOST answer; then $0.23 + $0.60 > $0.75.
    const { run, io } = session(dir, arms, plan(["grounded", "ghost", "reality"]), 0.75);
    const outcome = await run();
    expect(outcome.stopped).toBe("cap");
    expect(outcome.ran.map((r) => r.unit)).toEqual(["grounded q01 t1", "ghost q01"]);
    expect(outcome.skipped).toEqual(["grounded q02 t1", "ghost q02", "reality rc01,rc02"]);
    expect(io.stderr.join("\n")).toContain("stopping before grounded q02 t1: $0.23 spent plus up to $0.60 for it would pass --usd-cap $0.75");
    expect(io.stderr.join("\n")).toContain("skipped 3: grounded q02 t1, ghost q02, reality rc01,rc02");
    expect(readSpend(dir.spend).usd).toBeCloseTo(0.23);
  });

  it("counts every session of the directory", async () => {
    const dir = tempDir();
    const first = fakeArms();
    await session(dir, first.arms, { ...plan(["grounded"]), questions: [QUESTIONS[0]!] }).run();
    const second = await session(dir, fakeArms().arms, plan(["grounded"]), 0.7).run();
    expect(second.stopped).toBe("cap");
    expect(second.skipped).toEqual(["grounded q02 t1"]);
  });

  it("keeps the worst case of a unit that threw, and counts what a SpentError says it spent", async () => {
    const dir = tempDir();
    const { arms } = fakeArms((q) => (q === "q01" ? new Error("socket hang up") : {}));
    const outcome = await session(dir, arms, plan(["grounded"])).run();
    expect(outcome.ran.map((r) => [r.unit, r.ok])).toEqual([
      ["grounded q01 t1", false],
      ["grounded q02 t1", true],
    ]);
    expect(outcome.ran[0]!.note).toBe("failed: socket hang up (counted at its worst case $0.60)");
    expect(readSpend(dir.spend).usd).toBeCloseTo(0.8);

    const spent = tempDir();
    const ghost = fakeArms(() => ({}), { fail: new SpentError("the answer was cut off", 0.08) });
    const result = await session(spent, ghost.arms, { ...plan(["ghost"]), questions: [QUESTIONS[0]!] }).run();
    expect(result.ran[0]).toMatchObject({ ok: false, note: "failed: the answer was cut off (it spent $0.080)" });
    expect(readSpend(spent.spend).usd).toBeCloseTo(0.08);
  });
});

describe("resume", () => {
  it("skips what is answered and runs again what failed, threw or was never started", async () => {
    const dir = tempDir();
    const first = fakeArms((q) => (q === "q02" ? { status: "failed", report: null } : {}), { fail: new Error("overloaded") });
    await session(dir, first.arms, plan(["grounded", "ghost"])).run();
    expect(pendingUnits(dir, plan(["grounded", "ghost", "reality"])).map(unitLabel)).toEqual(["ghost q01", "grounded q02 t1", "ghost q02", "reality rc01,rc02"]);

    const second = fakeArms();
    const outcome = await session(dir, second.arms, plan(["grounded", "ghost"])).run();
    expect(outcome.ran.map((r) => r.unit)).toEqual(["ghost q01", "grounded q02 t1", "ghost q02"]);
    expect(second.attempts.has("q01t1")).toBe(false);
    expect(readRecord(dir.grounded("q02", 1), GroundedRecord)?.status).toBe("completed");
    expect(pendingUnits(dir, plan(["grounded", "ghost"]))).toEqual([]);
  });

  it("asks for one more take of each question with --takes 2", async () => {
    const dir = tempDir();
    await session(dir, fakeArms().arms, plan(["grounded"])).run();
    expect(pendingUnits(dir, plan(["grounded"], 2)).map(unitLabel)).toEqual(["grounded q01 t2", "grounded q02 t2"]);
  });

  it("runs only the Reality Check cases without a record", async () => {
    const dir = tempDir();
    writeJson(dir.reality("rc01"), RealityRecord.parse(realityRecord("rc01")));
    const units = pendingUnits(dir, plan(["reality"]));
    expect(units.map(unitLabel)).toEqual(["reality rc02"]);
  });
});

describe("diffs", () => {
  it("rebuilds a diff whose grounded take was run again under a new id, and leaves current ones", async () => {
    const dir = tempDir();
    const { arms } = fakeArms();
    await session(dir, arms, { ...plan(["grounded", "ghost"]), questions: [QUESTIONS[0]!] }).run();
    expect(refreshDiffs(dir, arms.ghost, ["q01"], () => undefined)).toBe(0);
    writeJson(dir.diff("q01", 1), DiffRecord.parse({ version: 1, questionId: "q01", take: 1, runId: "cli-eval-q01t1-older", diff: ghostDiff({ overlapAt5: 1 }) }));
    expect(refreshDiffs(dir, arms.ghost, ["q01"], () => undefined)).toBe(1);
    expect(readRecord(dir.diff("q01", 1), DiffRecord)?.diff.overlapAt5).toBe(0.2);
  });

  it("builds none without a GHOST arm, and none for an answer the API refused", () => {
    const dir = tempDir();
    writeJson(dir.grounded("q01", 1), GroundedRecord.parse(groundedRecord("q01")));
    writeJson(dir.ghost("q01"), GhostRecord.parse(ghostRecord("q01", { answer: null, refusal: "cyber", resolved: [] })));
    expect(refreshDiffs(dir, null, ["q01"], () => undefined)).toBe(0);
    expect(refreshDiffs(dir, fakeArms().arms.ghost, ["q01"], () => undefined)).toBe(0);
  });
});

describe("cancellation", () => {
  it("stops after the unit in progress and lists the rest as skipped", async () => {
    const dir = tempDir();
    const controller = new AbortController();
    const { arms } = fakeArms((q) => {
      if (q === "q01") controller.abort();
      return {};
    });
    const outcome = await session(dir, arms, plan(["grounded", "ghost"]), 5, controller.signal).run();
    expect(outcome.stopped).toBe("cancelled");
    expect(outcome.ran.map((r) => r.unit)).toEqual(["grounded q01 t1"]);
    expect(outcome.skipped).toEqual(["ghost q01", "grounded q02 t1", "ghost q02"]);
  });
});

describe("the attempt log", () => {
  it("logs every unit before its record, a failed take that is run again and a unit that threw included", async () => {
    const dir = tempDir();
    const first = fakeArms((q) => (q === "q02" ? { status: "failed", report: null, usd: 0.35 } : {}), { fail: new Error("overloaded") });
    await session(dir, first.arms, plan(["grounded", "ghost"])).run();
    await session(dir, fakeArms().arms, plan(["grounded", "ghost"])).run();
    const log = readAttempts(dir);
    expect(log.map((a) => [a.unit, a.ok, a.usd])).toEqual([
      ["grounded q01 t1", true, 0.2],
      ["ghost q01", false, null],
      ["grounded q02 t1", false, 0.35],
      ["ghost q02", false, null],
      ["ghost q01", true, 0.03],
      ["grounded q02 t1", true, 0.2],
      ["ghost q02", true, 0.03],
    ]);
    expect(log[0]).toMatchObject({ runId: "cli-eval-q01t1-1", worstUsd: 0.6, qlooCalls: 6, qlooNetwork: 4 });
    expect(log[1]).toMatchObject({ runId: null, worstUsd: 0.1, qlooCalls: null });
    // The rerun overwrote q02's failed record; the log and the tally still hold what that attempt spent.
    const records = loadRecords(dir);
    expect(records.grounded.find((r) => r.questionId === "q02")?.usd).toBe(0.2);
    const spend = attemptSpend(records.attempts, records.tally);
    expect(spend).toMatchObject({ units: 7, unknown: 2 });
    expect(spend?.measuredUsd).toBeCloseTo(0.2 + 0.35 + 0.03 + 0.2 + 0.03);
    expect(spend?.totalUsd).toBeCloseTo(0.2 + 0.1 + 0.35 + 0.1 + 0.03 + 0.2 + 0.03);
  });
});

describe("GHOST lookups that failed", () => {
  it("keep the answer, mark the unit to run again, and are looked up again on --resume with no model call", async () => {
    const dir = tempDir();
    const p = { ...plan(["grounded", "ghost"]), questions: [QUESTIONS[0]!] };
    const first = await session(dir, fakeArms(() => ({}), { failedLookup: true }).arms, p).run();
    expect(first.ran[1]).toMatchObject({ unit: "ghost q01", ok: false });
    expect(first.ran[1]!.note).toContain("3 picks, 1 of 1 looked up resolve exactly, 1 lookup(s) failed and --resume looks them up again");
    expect(readRecord(dir.diff("q01", 1), DiffRecord)?.diff.resolvability).toBe(0.25);
    expect(pendingUnits(dir, p).map(unitLabel)).toEqual(["ghost q01 lookups"]);

    const spent = readSpend(dir.spend).usd;
    const again = fakeArms();
    const second = await session(dir, again.arms, p).run();
    expect(second.ran).toEqual([{ unit: "ghost q01 lookups", ok: true, note: "1 of 1 failed lookup(s) done · Qloo 1" }]);
    expect(again.ghostCalls).toHaveLength(0);
    expect(again.lookUps).toEqual([["Crestline Cola"]]);
    const record = readRecord(dir.ghost("q01"), GhostRecord)!;
    expect(record.answer).toEqual(ghostRecord("q01").answer);
    expect(record.resolved.map((r) => [r.name, r.rank, r.lookup, r.exact])).toEqual([
      ["Foxglove Cola", 1, "search", true],
      ["Crestline Cola", 2, "search", true],
      ["Harbor Seltzer", 3, "skipped", false],
    ]);
    expect(record.lookups).toBe(3);
    expect(readRecord(dir.diff("q01", 1), DiffRecord)?.diff.resolvability).toBe(0.5);
    expect(readSpend(dir.spend).usd).toBeCloseTo(spent);
    expect(readAttempts(dir).at(-1)).toMatchObject({ unit: "ghost q01 lookups", usd: 0, worstUsd: 0, qlooCalls: 1 });
    expect(pendingUnits(dir, p)).toEqual([]);
  });

  it("are not looked up again by a session that does not run the GHOST arm", async () => {
    const dir = tempDir();
    await session(dir, fakeArms(() => ({}), { failedLookup: true }).arms, { ...plan(["ghost"]), questions: [QUESTIONS[0]!] }).run();
    expect(pendingUnits(dir, { ...plan(["grounded"]), questions: [QUESTIONS[0]!] }).map(unitLabel)).toEqual(["grounded q01 t1"]);
  });
});

describe("Reality Check cases that may end otherwise on a retry", () => {
  it("are told apart from settled ones by the arm's detail", () => {
    expect(realityRetry({ detail: { reason: "call_failed", retry: true } })).toBe("call_failed");
    expect(realityRetry({ detail: { reason: "budget" } })).toBe("budget");
    expect(realityRetry({ detail: { reason: null, retry: true } })).toBe("marked for a retry");
    expect(realityRetry({ detail: { reason: null, retry: false, ghost: { error: "overloaded", retryable: true } } })).toBe("GHOST: overloaded");
    expect(realityRetry({ detail: { reason: null, retry: false, ghost: { error: "the model refused", retryable: false } } })).toBeNull();
    expect(realityRetry({ detail: { reason: "seed_unresolved", retry: false, ghost: { error: null } } })).toBeNull();
    expect(realityRetry({ detail: { affinity: 0.98765 } })).toBeNull();
    expect(realityRetry({ detail: "not an object" })).toBeNull();
  });

  it("are written, reported as not settled, and run again on --resume", async () => {
    const dir = tempDir();
    const { arms } = fakeArms();
    const flaky: RealityArm = {
      ...arms.reality!,
      run: async ({ cases }) =>
        cases.map((c) => ({
          ...realityRecord(c.id, c.id === "rc02" ? { percentile: null, detail: { reason: "budget", retry: true, ghost: { error: null } } } : {}),
          caseId: c.id,
        })),
    };
    const outcome = await session(dir, { ...arms, reality: flaky }, plan(["reality"])).run();
    expect(outcome.ran[0]).toMatchObject({ ok: false });
    expect(outcome.ran[0]!.note).toBe("1 of 2 cases scored (rc01 80th); --resume runs again rc02 (budget), with a fresh --tag, since the tag's cap counts every earlier call · $0.040");
    expect(pendingUnits(dir, plan(["reality"])).map(unitLabel)).toEqual(["reality rc02"]);
    await session(dir, arms, plan(["reality"])).run();
    expect(readRecord(dir.reality("rc02"), RealityRecord)?.percentile).toBe(0.8);
    expect(pendingUnits(dir, plan(["reality"]))).toEqual([]);
  });

  it("stop the session as cancelled when Ctrl+C came during the check, the last unit included", async () => {
    const dir = tempDir();
    const controller = new AbortController();
    const { arms } = fakeArms();
    const aborted: RealityArm = {
      ...arms.reality!,
      run: async ({ cases }) => {
        controller.abort();
        return cases.map((c) => ({ ...realityRecord(c.id, { percentile: null, detail: { reason: "call_failed", retry: true } }), caseId: c.id }));
      },
    };
    const outcome = await session(dir, { ...arms, reality: aborted }, plan(["reality"]), 5, controller.signal).run();
    expect(outcome.stopped).toBe("cancelled");
    expect(outcome.ran[0]).toMatchObject({ ok: false });
    expect(pendingUnits(dir, plan(["reality"])).map(unitLabel)).toEqual(["reality rc01,rc02"]);
  });
});

describe("a Reality Check that returns no result for a case", () => {
  it("writes the cases it has and leaves the rest for --resume", async () => {
    const dir = tempDir();
    const { arms } = fakeArms();
    const partial: RealityArm = { ...arms.reality!, run: async () => [{ ...realityRecord("rc02", { percentile: null, resolved: false }), caseId: "rc02" }] };
    const outcome = await session(dir, { ...arms, reality: partial }, plan(["reality"])).run();
    expect(outcome.ran[0]).toMatchObject({ ok: false, note: "0 of 2 cases scored; no result for rc01 · $0.020" });
    expect(readRecord(dir.reality("rc02"), RealityRecord)?.resolved).toBe(false);
    expect(pendingUnits(dir, plan(["reality"])).map(unitLabel)).toEqual(["reality rc01"]);
  });
});
