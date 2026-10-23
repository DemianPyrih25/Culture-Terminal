import Link from "next/link";
// Straight from its file: the ask barrel would bring the whole Ask panel into this page's bundle.
import { TopBarAsk } from "../ask/top-bar-ask";
import { StatusLine, TopBar } from "../chrome";
import { GRID_COLUMNS_MD, GRID_COLUMNS_XL } from "../layout";
import { ButtonLink, cx, MetaLine } from "../ui";

/**
 * The brief page when there is no brief to show: a run id that does not exist (the styled 404), or a
 * database that could not be read. Same chrome and reading column as a brief, so the reader can ask
 * again from here; no outline and no Report | Sources tabs, since there is nothing to switch to.
 */
export function BriefMissing({ kind, runId }: { kind: "not_found" | "unavailable"; runId?: string | null }) {
  const missing = kind === "not_found";
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <TopBar command={<TopBarAsk />} active="briefs" />
      <main id="brief" className="flex-1 pb-20">
        <div className={cx("w-full px-4 md:grid md:px-0", GRID_COLUMNS_MD, "xl:grid", GRID_COLUMNS_XL)}>
          <div className="flex max-w-[680px] min-w-0 flex-col gap-4 pt-16 md:col-start-4" data-missing={kind}>
            <MetaLine desk={missing ? "404" : "Unavailable"} job={missing ? "No brief here" : "Try again shortly"} briefId={runId ? `Run ${runId}` : undefined} />
            <h1 className="m-0 type-question tracking-[-0.6px] text-ink max-md:text-[30px] max-md:leading-[37px]">
              {missing ? "There is no brief at this address." : "This brief could not be loaded."}
            </h1>
            <p className="m-0 type-answer text-text-2">
              {missing
                ? "The link may be mistyped, or the run was never stored. Ask the question again and a new brief is written, every number traced to its Qloo request."
                : "The briefs store did not answer. Nothing is lost: reload in a moment, or ask a new question."}
            </p>
            <div className="flex flex-wrap items-center gap-5 pt-2">
              <ButtonLink href="/" variant="secondary" hint={null}>
                Back to Culture Terminal
              </ButtonLink>
              {missing ? (
                <Link href="/briefs" className="text-[13px] font-medium text-accent hover:underline hover:underline-offset-4">
                  Browse the briefs
                </Link>
              ) : null}
            </div>
          </div>
        </div>
      </main>
      <StatusLine />
    </div>
  );
}
