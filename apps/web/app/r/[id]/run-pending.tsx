import Link from "next/link";
// Straight from its file: the ask barrel would bring the whole Ask panel into this page's bundle.
import { TopBarAsk } from "@/components/ask/top-bar-ask";
import { StatusLine, TopBar } from "@/components/chrome";
import { GRID_COLUMNS_MD, GRID_COLUMNS_XL } from "@/components/layout";
import { ButtonLink, cx, MetaLine } from "@/components/ui";

/**
 * The permalink of a run that has no finished brief (a 404): still being written, or ended without a
 * brief (failed, stopped, waiting for a pick). The chrome and reading column of BriefMissing, with the
 * way to the run itself, where it streams live or shows where it stopped.
 */
export function RunPending({ runId, ended }: { runId: string; ended: boolean }) {
  const href = `/run/${encodeURIComponent(runId)}`;
  return (
    <div className="flex min-h-screen flex-col bg-paper">
      <TopBar command={<TopBarAsk />} active="briefs" />
      <main id="brief" className="flex-1 pb-20">
        <div className={cx("w-full px-4 md:grid md:px-0", GRID_COLUMNS_MD, "xl:grid", GRID_COLUMNS_XL)}>
          <div className="flex max-w-[680px] min-w-0 flex-col gap-4 pt-16 md:col-start-4" data-missing={ended ? "no_brief" : "running"}>
            <MetaLine desk="404" job={ended ? "No brief to link" : "Not finished yet"} briefId={`Run ${runId}`} />
            <h1 className="m-0 type-question tracking-[-0.6px] text-ink max-md:text-[30px] max-md:leading-[37px]">
              {ended ? "This run ended without a brief." : "This brief is still being written."}
            </h1>
            <p className="m-0 type-answer text-text-2">
              {ended
                ? "It stopped before a brief was written, or it is waiting for a pick. The run page shows where it stopped and what to do next."
                : "A permalink opens once the run has finished and its numbers are checked. Follow the run live in the meantime: this address works as soon as it ends."}
            </p>
            <div className="flex flex-wrap items-center gap-5 pt-2">
              <ButtonLink href={href} variant="secondary" hint={null} data-run-link="true">
                {ended ? "Open the run" : "Follow it live"}
              </ButtonLink>
              <Link href="/briefs" className="text-[13px] font-medium text-accent hover:underline hover:underline-offset-4">
                Browse the briefs
              </Link>
            </div>
          </div>
        </div>
      </main>
      <StatusLine />
    </div>
  );
}
