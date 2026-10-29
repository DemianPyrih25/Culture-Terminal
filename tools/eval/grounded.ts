// The grounded arm of the eval (SPEC §6.7): each registered question through runAgent as a web live run
// takes it (live mode, the public lane, DEFAULT_RUN_LIMITS, no pins, the pinned market localities), over
// the Qloo client run-agent opens (tools/dev/cli/agent-cli.ts openAgentQloo). Nothing is stored in the
// runs table: the record and the run's events go to the eval directory. Run ids start "cli-eval-", a
// dev-CLI id the web leaves out of its run counts (apps/web/server/run-counts.ts), and the Qloo call log
// and cache carry it as the origin run.
import { ghostMetroOf, privatePersonRefusal, refusalOf, runAgent, type AgentRunOptions, type AgentRunResult, type AnthropicLike } from "@ct/agent";
import { DEFAULT_RUN_LIMITS, type EventInput, type EventInputOf, type Intent, type LocalityApi, type RunLimits, type SafetyCategory } from "@ct/contracts";
import type { QlooClient } from "@ct/qloo";
import type { PublicDataClient } from "@ct/publicdata";
import type { EvalQuestion } from "./cases";
import type { GroundedRecord } from "./records";
import type { GroundedArm } from "./runner";

/** Every eval run id starts with this; "cli-" is the dev CLIs' prefix (tools/dev/cli/skill-cli.ts cliRunId). */
export const EVAL_RUN_PREFIX = "cli-eval-";

/** "cli-eval-q01t1-20261023T101500123Z": one per attempt, so a retried take never shares a run id with the one before. */
export function evalRunId(questionId: string, take: number, now: Date): string {
  return `${EVAL_RUN_PREFIX}${questionId}t${take}-${now.toISOString().replace(/[-:.]/g, "")}`;
}

/**
 * The category a refusal of this intent applies, as runAgent decides it and apps/web/server/preview.ts
 * reads it: CLERK's category when its safety call refuses, private_individual for the code backstop on a
 * private primary person, and null when the intent itself would go ahead.
 */
export function refusalCategoryOf(intent: Intent): SafetyCategory | null {
  if (refusalOf(intent) !== null) return intent.safety.category;
  return privatePersonRefusal(intent) === null ? null : "private_individual";
}

const first = <T extends EventInput["type"]>(events: readonly EventInput[], type: T, match: (e: EventInputOf<T>) => boolean = () => true) =>
  events.find((e): e is EventInputOf<T> => e.type === type && match(e as EventInputOf<T>));

export interface GroundedRun {
  question: EvalQuestion;
  take: number;
  runId: string;
  result: AgentRunResult;
  events: readonly EventInput[];
  finishedAt: Date;
}

/** The record of one grounded run: the result, and what only its events hold (CLERK's reading, the plan, the CHECKER's first verdict). */
export function groundedRecordOf(run: GroundedRun): GroundedRecord {
  const { result, events } = run;
  // runAgent leaves `intent` null on a refusal; the clerk event still carries what CLERK read.
  const intent = first(events, "clerk")?.intent ?? null;
  const firstCheck = first(events, "validation", (e) => e.attempt === 1);
  return {
    version: 1,
    questionId: run.question.id,
    take: run.take,
    runId: run.runId,
    status: result.status,
    reason: result.reason,
    model: result.model,
    job: intent?.job ?? null,
    // GHOST's neighbourhood picks resolve in this metro: taste_twins' target city, else CLERK's metro.
    metro: intent === null ? null : ghostMetroOf(intent),
    refusalCategory: result.status === "refused" && intent !== null ? refusalCategoryOf(intent) : null,
    plannedHypotheses: first(events, "plan")?.plan.hypotheses.length ?? null,
    checkerFirstPass: firstCheck?.ok ?? null,
    numbersTraced: result.validation?.numbersTraced ?? null,
    qloo: { ...result.qloo },
    usd: result.usd,
    elapsedMs: result.elapsedMs,
    report: result.report,
    finishedAt: run.finishedAt.toISOString(),
  };
}

export interface GroundedArmDeps {
  qloo: QlooClient;
  /** The SEC and Census client (company_financials, area_economics); null runs them as unavailable. */
  publicdata?: PublicDataClient | null;
  anthropic: AnthropicLike;
  localities: LocalityApi | null;
  /** The agent; tests pass a scripted one. */
  runAgent?: (options: AgentRunOptions) => Promise<AgentRunResult>;
  limits?: RunLimits;
  now?: () => Date;
}

export function createGroundedArm(deps: GroundedArmDeps): GroundedArm {
  const limits = deps.limits ?? DEFAULT_RUN_LIMITS;
  const now = deps.now ?? (() => new Date());
  const agent = deps.runAgent ?? runAgent;
  return {
    // The run stops itself at usdHard, CLERK included (analystLimits), so that is its worst case.
    worstCaseUsd: limits.usdHard,
    async run({ question, take, signal }) {
      const runId = evalRunId(question.id, take, now());
      const events: EventInput[] = [];
      const result = await agent({
        runId,
        question: question.question,
        lane: "public",
        mode: "live",
        emit: (event) => events.push(event),
        qloo: deps.qloo,
        publicdata: deps.publicdata ?? null,
        anthropic: deps.anthropic,
        limits,
        signal,
        parent: null,
        localities: deps.localities,
      });
      return { record: groundedRecordOf({ question, take, runId, result, events, finishedAt: now() }), events, datasets: result.ledger.datasets };
    },
  };
}
