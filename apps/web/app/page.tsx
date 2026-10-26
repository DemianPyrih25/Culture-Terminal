import { listPinnedShowcases } from "@ct/db";
import { AppChrome } from "../components/home/app-chrome";
import { HomeAsk } from "../components/home/home-ask";
import { qlooRequestsToday } from "../components/home/qloo-usage";
import { RecentBriefs } from "../components/home/recent-briefs";
import { StarterColumns } from "../components/home/starter-columns";
import { STARTER_DESKS } from "../components/home/starters";
import { TestRunButton } from "../components/home/test-run-button";
import { DeskGrid } from "../components/launchpad/desk-grid";
import { JudgeStrip } from "../components/launchpad/judge-strip";
import { LaunchpadFooter } from "../components/launchpad/launchpad-footer";
import { ASK_ANCHOR } from "../components/launchpad/links";
import { pinnedShowcases, pinsBySlug, readEvalSummary } from "../components/launchpad/load";
import { ProofStrip } from "../components/launchpad/proof-strip";
import { SHOWCASES, TRUST_QUESTION, TRUST_SLUG } from "../components/launchpad/showcases";
import { judgeTile, launchpadTiles, showcasesTraced } from "../components/launchpad/tiles";
import { PAGE_GUTTER } from "../components/layout/grid";
import { cx } from "../components/ui/cx";
import { fakeRunSecondsFromEnv, qlooDailyFreshCapFromEnv } from "../server/config";
import { getDatabase, getQlooClient, peekQlooClient } from "../server/container";
import { log } from "../server/log";
import { questionKey, showcaseRunsByQuestion } from "../server/run-list";

// Rendered per request: the status line reads today's Qloo requests from the running server, the
// starters the showcase briefs stored so far, and the showcase tiles the runs pinned so far.
export const dynamic = "force-dynamic";

/** The stored showcase briefs by question (questionKey); none when the list cannot be read. */
async function storedShowcases(): Promise<Map<string, string>> {
  try {
    return await showcaseRunsByQuestion(getDatabase());
  } catch (err) {
    log.warn({ err }, "home: could not read the showcase briefs");
    return new Map();
  }
}

/** The run each pinned showcase slug opens (the pin store: curated runs only, D31); none when the pins cannot be read. */
async function showcasePins(): Promise<Map<string, string>> {
  try {
    return pinsBySlug(await listPinnedShowcases(getDatabase()));
  } catch (err) {
    log.warn({ err }, "home: could not read the pinned showcases");
    return new Map();
  }
}

/** The starters whose question has a stored showcase brief: such a starter opens it instead of asking again. */
function storedStarters(stored: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries(
    STARTER_DESKS.flatMap((desk) => desk.starters).flatMap((starter) => {
      const runId = stored.get(questionKey(starter.question));
      return runId ? [[starter.question, runId] as const] : [];
    }),
  );
}

/** What RECENT BRIEFS says before there is any: the starters above, and in development the test run. */
function EmptyRecent() {
  return (
    <>
      <p>No briefs yet. Pick a starter above or ask your own question: the briefs you run in this browser are listed here.</p>
      {process.env.NODE_ENV === "production" ? null : (
        <TestRunButton seconds={Math.round(fakeRunSecondsFromEnv())} label="Watch a test run" variant="secondary" size="sm" />
      )}
    </>
  );
}

/**
 * A01 Home as the Launchpad (PLAN §8.1): the hero and the question field, starters by desk, "Judge in 60
 * seconds", the showcase tiles by desk, the proof strip with the trust tile, the recent briefs (showcases
 * and this browser's own, D31) and the footer.
 */
export default async function Home() {
  const [stored, pins] = await Promise.all([storedShowcases(), showcasePins()]);
  const tiles = launchpadTiles(SHOWCASES, await pinnedShowcases(SHOWCASES, pins));
  return (
    <AppChrome qlooCap={qlooDailyFreshCapFromEnv()} qlooUsed={qlooRequestsToday(peekQlooClient, getQlooClient)}>
      {/* The top bar's gutter: below 1280 px the column lines up with the wordmark and the nav. */}
      <div className={cx("w-full", PAGE_GUTTER)}>
        <div className="mx-auto flex w-full max-w-[960px] flex-col pt-10 pb-16 md:pt-16">
          <div className="flex flex-col gap-[14px] pb-10">
            <p className="m-0 text-[11px] leading-[13px] font-semibold tracking-[1.3px] text-dim uppercase">
              Taste intelligence for investors
            </p>
            <h1 className="m-0 type-question tracking-[-0.6px] text-ink max-md:text-[30px] max-md:leading-[37px]">
              Taste is a market. Now it has a terminal.
            </h1>
            <p className="m-0 max-w-[720px] type-answer text-text-2 max-md:text-[17px] max-md:leading-[26px]">
              Ask about a brand, an artist, a place or an audience in plain English. The answer is a one-page brief, and
              every number in it traces to the Qloo request behind it.
            </p>
            <div id={ASK_ANCHOR} className="scroll-mt-24 pt-4">
              <HomeAsk />
            </div>
          </div>
          <StarterColumns stored={storedStarters(stored)} className="pb-14" />
          <JudgeStrip showcase={judgeTile(tiles)} className="pb-14" />
          <DeskGrid tiles={tiles} className="pb-14" />
          <ProofStrip
            traced={showcasesTraced(tiles)}
            evalSummary={readEvalSummary()}
            trustQuestion={TRUST_QUESTION}
            trustRunId={pins.get(TRUST_SLUG) ?? null}
            className="pb-14"
          />
          <RecentBriefs limit={5} empty={<EmptyRecent />} />
          <LaunchpadFooter className="mt-14" />
        </div>
      </div>
    </AppChrome>
  );
}
