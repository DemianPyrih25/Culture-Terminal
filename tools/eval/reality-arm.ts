// The Reality Check as the eval runs it (SPEC §6.6 item 3, tools/eval/cli.ts `reality` and `all`): the
// open cases scored together by tools/eval/reality.ts runRealityCheck over the Qloo client the CLI
// opened (QLOO_TAG, its cap, the pace and the shared cache), with GHOST's top five per case from
// @ct/agent runGhost on the run's ANALYST model (D23), asked the case's registered-before-any-run
// question (ghostQuestion) under the kind's job (REALITY_GHOST). Each case becomes one eval record,
// whose detail says whether a retry could end it otherwise (runner.ts realityRetry runs such a case
// again on --resume); the whole run, raw scores included, goes beside them in the eval directory
// (gitignored, D29). A cancelled check records nothing.
import { GhostError, runGhost } from "@ct/agent";
import type { GeoApi } from "@ct/contracts";
import { loadGeo } from "../dev/cli/geo";
import { referenceProblems, type RealityCase } from "./cases";
import type { RealityContext } from "./cli";
import { ghostWorstCaseUsd } from "./ghost";
import { ghostQuestion, ghostTop5FromAnswer, REALITY_GHOST, runRealityCheck, writeRealityRaw, type RealityRun } from "./reality";
import { loadSecondaryMarkets, type SecondaryMarket } from "./reality-location";
import type { RealityCaseResult } from "./records";
import { SpentError, type RealityArm } from "./runner";

/** What a case's GHOST answer cost; a failed answer keeps what its response cost (0 when none arrived). */
export interface GhostSpend {
  usd: number;
  ms: number;
  /** GHOST failed in a way a rerun may fix: anything but the API's own refusal, which is GHOST's answer. */
  retryable: boolean;
}

/** The parts the tests replace. */
export interface RealityArmOverrides {
  /** The gazetteer (default: @ct/geo through loadGeo). */
  geo?: () => Promise<{ geo: GeoApi; source: string }>;
  /** config/metros.json's secondary markets (default: loadSecondaryMarkets). */
  markets?: readonly SecondaryMarket[];
  runGhost?: typeof runGhost;
  runRealityCheck?: typeof runRealityCheck;
}

/** The kinds whose cases use the calls every case of the run shares (the comedian panel, the baselines). */
const SHARES_CALLS: ReadonlySet<RealityCase["kind"]> = new Set(["comedian_market", "dtc_neighbourhood"]);

/**
 * One eval record per case of the run. resolved is false when the seed or the registered choice did
 * not resolve exactly; usd and ms are the case's GHOST answer. The detail is the case's result as the
 * check returned it, its GHOST outcome marked `retryable` when GHOST failed in a way a rerun may fix;
 * with the result's own `retry` (a Qloo call the case needed failed or was refused) that is what
 * runner.ts realityRetry reads, so --resume runs such a case again, as it does a failed grounded take.
 * The calls the cases share are counted on the first case that uses them, so the records add up to
 * every call the check made.
 */
export function realityRecords(run: RealityRun, spend: ReadonlyMap<string, GhostSpend>): (RealityCaseResult & { caseId: string })[] {
  const shared = run.shared.network + run.shared.cached;
  const first = run.cases.find((c) => SHARES_CALLS.has(c.kind)) ?? run.cases[0];
  return run.cases.map((c) => {
    const sharedHere = c === first ? shared : 0;
    // A GHOST failure the arm did not see (none recorded) is retried rather than taken as an answer.
    const retryable = c.ghost.error !== null && (spend.get(c.id)?.retryable ?? true);
    const note = [
      c.status === "scored" ? null : `${c.reason ?? "not scorable"}: ${c.detail ?? "no detail"}`,
      c.ghost.error === null ? null : `GHOST: ${c.ghost.error}`,
      c.ties === null ? null : `${c.ties.tied} of ${c.ties.of} market comparisons tied`,
      sharedHere > 0 ? `includes the ${sharedHere} Qloo calls the cases share` : null,
    ].filter((p): p is string => p !== null);
    return {
      caseId: c.id,
      resolved: c.reason !== "seed_unresolved" && c.reason !== "choice_unresolved",
      percentile: c.status === "scored" ? c.percentile : null,
      ghostHit: c.ghost.hit,
      chanceHit: c.ghost.chance,
      candidates: c.of,
      ties: c.ties,
      usd: spend.get(c.id)?.usd ?? 0,
      ms: spend.get(c.id)?.ms ?? 0,
      qlooCalls: c.calls.network + c.calls.cached + sharedHere,
      note: note.length === 0 ? null : note.join("; "),
      detail: { ...c, ghost: { ...c.ghost, retryable } },
    };
  });
}

/**
 * The reality arm runEvalCommand runs. Its worst case is one GHOST answer per case at its bound: the
 * Qloo calls cost no LLM spend. A case that points at a market or gazetteer area this build does not
 * have stops the check before anything is sent. The comedian panel is every registered comedian
 * (ctx.file), so a case run alone or again scores as it would beside the others. A check that is
 * cancelled, or throws, records no case and says what GHOST spent.
 */
export function createRealityArm(ctx: RealityContext, overrides: RealityArmOverrides = {}): RealityArm {
  const ghost = overrides.runGhost ?? runGhost;
  const check = overrides.runRealityCheck ?? runRealityCheck;
  return {
    worstCaseUsd: (cases) => cases.length * ghostWorstCaseUsd(ctx.model),
    async run({ cases, signal }) {
      const { geo, source } = await (overrides.geo ?? loadGeo)();
      const markets = overrides.markets ?? loadSecondaryMarkets();
      if (source === "stub" && cases.some((c) => c.kind === "dtc_neighbourhood")) {
        throw new SpentError("the gazetteer (@ct/geo) did not load, so no neighbourhood case can be scored; nothing was sent", 0);
      }
      const problems = referenceProblems(cases, {
        markets: new Set(markets.map((m) => m.id)),
        hasArea: (metro, areaId) => geo.neighbourhood(metro, areaId) !== null,
      });
      if (problems.length > 0) throw new SpentError(`the registered cases point outside this build: ${problems.join("; ")}; nothing was sent`, 0);

      const spend = new Map<string, GhostSpend>();
      const spent = () => [...spend.values()].reduce((usd, s) => usd + s.usd, 0);
      let run: RealityRun;
      try {
        run = await check(
          { ...ctx.file, cases: [...cases] },
          {
            client: ctx.qloo,
            geo,
            localities: ctx.localities,
            markets,
            ghostTop5: async (c) => {
              try {
                // A store case's GHOST chooses from its metro's gazetteer areas, as the comedian question lists the secondary markets.
                const metro = c.kind === "dtc_neighbourhood" ? c.choice.metro : null;
                const answer = await ghost({ question: ghostQuestion(c, markets), job: REALITY_GHOST[c.kind].job, metro, geo, model: ctx.model, anthropic: ctx.anthropic, signal });
                spend.set(c.id, { usd: answer.usd, ms: answer.ms, retryable: false });
                return ghostTop5FromAnswer(answer.answer, c.kind);
              } catch (err) {
                // The case goes on without GHOST (its hit unknown); what a response cost still counts.
                const refused = err instanceof GhostError && err.code === "refusal";
                spend.set(c.id, { usd: err instanceof GhostError ? err.usd : 0, ms: 0, retryable: !refused });
                throw err;
              }
            },
            registered: ctx.file.cases,
            log: ctx.log,
            now: ctx.now,
            signal,
          },
        );
      } catch (err) {
        throw new SpentError(`the Reality Check stopped: ${err instanceof Error ? err.message : String(err)}; no case was recorded`, spent());
      }
      // A cancel turns the calls still to come into failed cases: none is recorded, so --resume runs them all.
      if (signal.aborted) throw new SpentError("the Reality Check was cancelled; no case was recorded, so --resume runs them again", spent());
      try {
        ctx.log(`Reality Check raw run (scores included, never published): ${writeRealityRaw(run, ctx.rawDir)}`);
      } catch (err) {
        ctx.log(`could not write the raw Reality Check run: ${err instanceof Error ? err.message : String(err)}`);
      }
      return realityRecords(run, spend);
    },
  };
}
