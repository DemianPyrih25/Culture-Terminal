import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { askQuestionOf } from "../../components/ask/ask-href";
import type { AskParent } from "../../components/ask/ask-parent";
import { SiteShell } from "../../components/chrome/site-shell";
import { desCommandHref } from "../../components/des/des-href";
import { HomeView } from "../../components/home/home-view";
import { isRunId } from "../../lib/run-id";
import { getDatabase } from "../../server/container";
import { log } from "../../server/log";
import { getFollowUpParent } from "../../server/run-list";

// A question in the URL is the visitor's own: never indexed.
export const metadata: Metadata = {
  title: "Ask · Culture Terminal",
  robots: { index: false, follow: false },
};

const one = (value: string | string[] | undefined): string => (Array.isArray(value) ? (value[0] ?? "") : (value ?? ""));

/**
 * The answer a follow-up hangs from, with its question and whether POST /api/runs will take it as the
 * parent; null when the id names no run.
 */
async function parentOf(runId: string): Promise<AskParent | null> {
  if (!isRunId(runId)) return null;
  try {
    const found = await getFollowUpParent(getDatabase(), runId);
    return found === null ? null : { runId, ...found };
  } catch (err) {
    log.warn({ err }, "ask: could not read the parent answer");
    return { runId, question: null, blocked: "unreadable" };
  }
}

/**
 * /ask?q=…&parent=…: Home with the question in the box, sent at once (the same flow as "Get answer"),
 * and a follow-up's parent above the field.
 */
export default async function AskPage(props: PageProps<"/ask">) {
  const params = await props.searchParams;
  const question = askQuestionOf(one(params.q));
  // "<NAME> DES" is a profile, not a run: every way here opens it.
  const des = desCommandHref(question);
  if (des !== null) redirect(des);
  const parent = await parentOf(one(params.parent));
  return (
    <SiteShell header="home">
      <HomeView key={`${parent?.runId ?? ""}|${question}`} initialQuestion={question} parent={parent} />
    </SiteShell>
  );
}
