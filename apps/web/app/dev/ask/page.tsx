// /dev/ask: the question box (N01, N02, N16 1-3) in every state, the suggestion list and Your answers,
// from fixtures, without calling the server (a live preview reads the question with CLERK, which costs,
// and most states cannot be reached at will). Development only. Every entity, id and count is invented
// (D29). Also the dev way to start the synthetic test run.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { SiteShell } from "../../../components/chrome/site-shell";
import { TestRunButton } from "../../../components/home/test-run-button";
import { fakeRunSecondsFromEnv } from "../../../server/config";
import { AskGallery } from "./gallery";

export const metadata: Metadata = {
  title: "Ask states · Culture Terminal",
  robots: { index: false, follow: false },
};

// Per request, so the test-run button shows FAKE_RUN_SECONDS of the running server.
export const dynamic = "force-dynamic";

export default function AskStatesPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return (
    <SiteShell mainClassName="flex flex-col gap-10 pt-12 pb-24">
      <header className="flex flex-col gap-3">
        <p className="m-0 type-label text-accent-ink">Dev</p>
        <h1 className="m-0 type-display-m text-ink">Ask states</h1>
        <p className="m-0 max-w-[680px] type-body text-ink-2">
          The question box, its inline states, the suggestion list and Your answers, from fixtures. Nothing here
          calls the server.
        </p>
        <TestRunButton seconds={Math.round(fakeRunSecondsFromEnv())} />
      </header>
      <AskGallery />
    </SiteShell>
  );
}
