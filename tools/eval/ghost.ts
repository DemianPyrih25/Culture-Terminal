// The GHOST arm of the eval (SPEC §6.6 layer 2, D23): the run's ANALYST model answers each question with
// no tools (@ct/agent runGhost); its picks are resolved through the cached Qloo /search, at most ten
// searches an answer (resolveGhostPicks), and diffed against each grounded take's brief (buildGhostDiff).
// The answer is resolved once and diffed against every take, so a rerun costs no second GHOST call; a
// pick whose search failed is looked up again on --resume, with the answer kept.
import {
  buildGhostDiff,
  GHOST_MARKETS,
  GHOST_SEARCH_MAX,
  GhostError,
  ghostWorstCaseUsd,
  isPricedModel,
  resolveGhostPicks,
  runGhost,
  type AnthropicLike,
  type GhostSearch,
  type LlmModel,
} from "@ct/agent";
import { GhostPickCategory, type GhostAnswer } from "@ct/contracts";
import { SpentError, type GhostArm } from "./runner";

/** The GHOST API the arm calls; the tests pass fakes of the same signatures. */
export interface GhostApi {
  runGhost: typeof runGhost;
  resolveGhostPicks: typeof resolveGhostPicks;
  buildGhostDiff: typeof buildGhostDiff;
}

export const AGENT_GHOST_API: GhostApi = { runGhost, resolveGhostPicks, buildGhostDiff };

/** One GHOST answer's worst case (@ct/agent): the longest request, its MARKETS, AREAS and earlier questions included. */
export { ghostWorstCaseUsd };

export interface GhostArmDeps {
  api?: GhostApi;
  anthropic: AnthropicLike;
  /** A fresh /search for one answer's lookups, and how many Qloo calls went through it. */
  openSearch: () => { search: GhostSearch; calls: () => number };
  /** Picks left unchecked (search cap, failed search). */
  log?: (line: string) => void;
}

export function createGhostArm(deps: GhostArmDeps, model: LlmModel): GhostArm {
  const api = deps.api ?? AGENT_GHOST_API;
  return {
    worstCaseUsd: ghostWorstCaseUsd(model),
    async answer({ question, job, model: wanted, metro, signal }) {
      if (!isPricedModel(wanted)) throw new Error(`GHOST cannot run on ${wanted}: only the ANALYST's models are allowed (D23)`);
      let run: Awaited<ReturnType<GhostApi["runGhost"]>>;
      try {
        // The places the brief can rank, as the ANALYST's MARKETS and AREAS (D23: config, not a tool).
        run = await api.runGhost({ question, job, model: wanted, anthropic: deps.anthropic, markets: GHOST_MARKETS, metro, signal });
      } catch (err) {
        if (!(err instanceof GhostError)) throw err;
        // The API's own refusal is GHOST's outcome for this question, not a failure to retry.
        if (err.code === "refusal") {
          const refusal = err.refusal?.category ?? err.refusal?.explanation ?? err.message;
          return { answer: null, refusal, resolved: [], model: err.model, tokens: err.usage, usd: err.usd, ms: 0, lookups: 0 };
        }
        // A response arrived, so its cost is known; with none, the worst case stands.
        throw err.usage === null ? err : new SpentError(err.message, err.usd);
      }
      const lookups = deps.openSearch();
      let resolved: Awaited<ReturnType<GhostApi["resolveGhostPicks"]>>;
      try {
        resolved = await api.resolveGhostPicks({ answer: run.answer, search: lookups.search, max: GHOST_SEARCH_MAX, metro, log: deps.log, signal });
      } catch (err) {
        throw new SpentError(`the picks could not be looked up: ${err instanceof Error ? err.message : String(err)}`, run.usd);
      }
      // A cancel during the searches fails every search still out: no answer is kept with picks that were never looked up.
      if (signal.aborted) throw new SpentError("cancelled while its picks were looked up", run.usd);
      return { answer: run.answer, refusal: null, resolved, model: run.model, tokens: run.usage, usd: run.usd, ms: run.ms, lookups: lookups.calls() };
    },
    async lookUpAgain({ answer, resolved, metro, signal }) {
      const failed = resolved.filter((p) => p.lookup === "failed");
      if (failed.length === 0) return { resolved, lookups: 0 };
      // Only the failed picks, as an answer of their own: they were searched within the cap the first
      // time, and every other pick keeps its lookup. Each keeps its rank in GHOST's own list.
      const picks = Object.fromEntries(GhostPickCategory.options.map((c) => [c, failed.filter((p) => p.category === c).map((p) => p.name)])) as GhostAnswer["picks"];
      const lookups = deps.openSearch();
      const again = await api.resolveGhostPicks({ answer: { ...answer, picks }, search: lookups.search, max: failed.length, metro, log: deps.log, signal });
      signal.throwIfAborted();
      return {
        resolved: resolved.map((p) => {
          if (p.lookup !== "failed") return p;
          const found = again.find((a) => a.category === p.category && a.name === p.name);
          return found === undefined ? p : { ...found, rank: p.rank };
        }),
        lookups: lookups.calls(),
      };
    },
    diff: ({ answer, resolved, report, datasets }) => api.buildGhostDiff({ answer, resolved, report, datasets }),
  };
}
