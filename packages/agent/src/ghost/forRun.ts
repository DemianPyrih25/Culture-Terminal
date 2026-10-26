import type { DatasetEnvelope, EntityRegistry, GhostAnswer, GhostDiff, Job, MetroId, Report, ReportExhibit, TokenUsage } from "@ct/contracts";
import type { AnthropicLike, LlmModel } from "../anthropic";
import type { RunMarket } from "../run/markets";
import { runGhost } from "./answer";
import { buildGhostDiff } from "./diff";
import { GHOST_MARKETS, type GazetteerLike } from "./places";
import { resolveGhostPicks, type GhostSearch, type ResolvedGhostPick } from "./resolve";

/**
 * GHOST for a finished run (SPEC §6.6), for the attach CLI and the eval: one answer from the run's
 * ANALYST model, its picks resolved through the cached /search, and the diff against the brief. The
 * message lists the places the brief can rank (MARKETS, the metro's AREAS) and the chain's earlier
 * questions (ghostUserMessage). The result is the `ghost` event's payload plus what it cost; the
 * caller stores it on the report and records `model` as receipt.models.ghost.
 */

export interface GhostForRunOptions {
  report: Pick<Report, "job" | "question"> & { exhibits: readonly Pick<ReportExhibit, "datasetId">[] };
  /** The run's datasets (the ledger's, or RunState.datasets' data). */
  datasets: readonly DatasetEnvelope[];
  /** The run's registry: refs for matching and popularity. Nothing is registered. */
  registry?: Pick<EntityRegistry, "entity" | "byEntityId">;
  /** Defaults to the report's question. */
  question?: string;
  /** Defaults to the report's job. */
  job?: Job;
  /** The run's ANALYST model (Report.receipt.models.analyst). */
  model: LlmModel;
  anthropic: AnthropicLike;
  search: GhostSearch;
  /** The markets the brief can rank, listed for a job that fills markets; GHOST_MARKETS by default. */
  markets?: readonly RunMarket[];
  /** The question's gazetteer metro: its areas are listed for a job that fills neighbourhoods, and only they match a pick. */
  metro?: MetroId | null;
  geo?: GazetteerLike;
  /** The questions of the run's chain before it, oldest first (never their answers). */
  earlier?: readonly string[];
  /** Picks left unchecked (search cap, failed search), one line each. */
  log?: (line: string) => void;
  signal?: AbortSignal;
}

export interface GhostForRunResult {
  answer: GhostAnswer;
  diff: GhostDiff;
  usd: number;
  model: LlmModel;
  usage: TokenUsage;
  ms: number;
  resolved: ResolvedGhostPick[];
}

/** Throws GhostError when the model gives no usable answer; the search cap and failed searches only leave picks unchecked. */
export async function ghostForRun(options: GhostForRunOptions): Promise<GhostForRunResult> {
  const { report, registry, geo, signal } = options;
  const metro = options.metro ?? null;
  const run = await runGhost({
    question: options.question ?? report.question,
    job: options.job ?? report.job,
    markets: options.markets ?? GHOST_MARKETS,
    metro,
    geo,
    earlier: options.earlier,
    model: options.model,
    anthropic: options.anthropic,
    signal,
  });
  const resolved = await resolveGhostPicks({
    answer: run.answer,
    search: options.search,
    registry,
    geo,
    metro,
    log: options.log,
    signal,
  });
  const diff = buildGhostDiff({ answer: run.answer, resolved, report, datasets: options.datasets, registry, geo });
  return { answer: run.answer, diff, usd: run.usd, model: run.model, usage: run.usage, ms: run.ms, resolved };
}
