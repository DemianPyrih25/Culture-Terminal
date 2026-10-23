import type { Metadata } from "next";
import { askQuestionOf } from "../../components/ask/ask-href";
import type { AskParent } from "../../components/ask/ask-panel";
import { AskView } from "../../components/ask/ask-view";
import { AppChrome } from "../../components/home/app-chrome";
import { qlooRequestsToday } from "../../components/home/qloo-usage";
import { RecentBriefs } from "../../components/home/recent-briefs";
import { PAGE_GUTTER } from "../../components/layout/grid";
import { cx } from "../../components/ui/cx";
import { isRunId } from "../../lib/run-id";
import { qlooDailyFreshCapFromEnv } from "../../server/config";
import { getDatabase, getQlooClient, peekQlooClient } from "../../server/container";
import { log } from "../../server/log";
import { getFollowUpParent } from "../../server/run-list";

// A question in the URL is the visitor's own: never indexed.
export const metadata: Metadata = {
  title: "Ask · Culture Terminal",
  robots: { index: false, follow: false },
};

const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

/**
 * The brief a follow-up hangs from, with its question and whether POST /api/runs will take it as the
 * parent; null when the id names no run.
 */
async function parentOf(runId: string): Promise<AskParent | null> {
  if (!isRunId(runId)) return null;
  try {
    const found = await getFollowUpParent(getDatabase(), runId);
    return found === null ? null : { runId, ...found };
  } catch (err) {
    log.warn({ err }, "ask: could not read the parent brief");
    return { runId, question: null, blocked: "unreadable" };
  }
}

/** A02 Ask: /ask?q=…&parent=…, the question read back before a brief runs. */
export default async function AskPage(props: PageProps<"/ask">) {
  const params = await props.searchParams;
  const question = askQuestionOf(one(params.q));
  const parent = await parentOf(one(params.parent));
  return (
    <AppChrome qlooCap={qlooDailyFreshCapFromEnv()} qlooUsed={qlooRequestsToday(peekQlooClient, getQlooClient)}>
      {/* Home's column, in the top bar's gutter. */}
      <div className={cx("w-full", PAGE_GUTTER)}>
        <div className="mx-auto flex w-full max-w-[960px] flex-col pt-10 pb-16 md:pt-16">
          {/* Another parent is another page: the composer starts over. Another ?q= is read in place. */}
          <AskView key={parent?.runId ?? ""} initialQuestion={question} parent={parent} />
          <RecentBriefs limit={3} className="pt-12" />
        </div>
      </div>
    </AppChrome>
  );
}
