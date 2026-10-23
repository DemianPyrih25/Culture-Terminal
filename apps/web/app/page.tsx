import { AppChrome } from "../components/home/app-chrome";
import { HomeAsk } from "../components/home/home-ask";
import { qlooRequestsToday } from "../components/home/qloo-usage";
import { RecentBriefs } from "../components/home/recent-briefs";
import { StarterColumns } from "../components/home/starter-columns";
import { STARTER_DESKS } from "../components/home/starters";
import { TestRunButton } from "../components/home/test-run-button";
import { PAGE_GUTTER } from "../components/layout/grid";
import { cx } from "../components/ui/cx";
import { fakeRunSecondsFromEnv, qlooDailyFreshCapFromEnv } from "../server/config";
import { getDatabase, getQlooClient, peekQlooClient } from "../server/container";
import { log } from "../server/log";
import { questionKey, showcaseRunsByQuestion } from "../server/run-list";

// Rendered per request: the status line reads today's Qloo requests from the running server, and the
// starters the showcases stored so far.
export const dynamic = "force-dynamic";

/** The starters whose question has a stored showcase brief, by question; none when the list cannot be read. */
async function storedStarters(): Promise<Record<string, string>> {
  try {
    const stored = await showcaseRunsByQuestion(getDatabase());
    return Object.fromEntries(
      STARTER_DESKS.flatMap((desk) => desk.starters).flatMap((starter) => {
        const runId = stored.get(questionKey(starter.question));
        return runId ? [[starter.question, runId] as const] : [];
      }),
    );
  } catch (err) {
    log.warn({ err }, "home: could not read the showcase briefs");
    return {};
  }
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

/** A01 Home: the question field, starters by desk and the recent briefs. */
export default async function Home() {
  const stored = await storedStarters();
  return (
    <AppChrome qlooCap={qlooDailyFreshCapFromEnv()} qlooUsed={qlooRequestsToday(peekQlooClient, getQlooClient)}>
      {/* The top bar's gutter: below 1280 px the column lines up with the wordmark and the nav. */}
      <div className={cx("w-full", PAGE_GUTTER)}>
        <div className="mx-auto flex w-full max-w-[960px] flex-col pt-10 pb-16 md:pt-16">
          <div className="flex flex-col gap-[14px] pb-10">
            <h1 className="text-[11px] leading-[13px] font-semibold tracking-[1.3px] text-dim uppercase">
              Taste intelligence for investors
            </h1>
            <HomeAsk />
          </div>
          <StarterColumns stored={stored} className="pb-14" />
          <RecentBriefs limit={5} empty={<EmptyRecent />} />
        </div>
      </div>
    </AppChrome>
  );
}
