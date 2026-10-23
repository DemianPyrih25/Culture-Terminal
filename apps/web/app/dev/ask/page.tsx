// /dev/ask: the Ask panel (A02, sl4ja) in every state from fixtures, without calling the server (a live
// preview reads the question with CLERK, which costs, and most states cannot be reached at will).
// Development only. Every entity, id and count is invented (D29). Also the dev way to start the
// synthetic test run.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fakeRunSecondsFromEnv } from "../../../server/config";
import { TestRunButton } from "../../../components/home/test-run-button";
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
    <main className="mx-auto flex w-full max-w-[1008px] flex-col gap-10 bg-paper px-6 py-10">
      <header className="flex flex-col gap-3">
        <p className="text-[11px] font-semibold tracking-[1.3px] text-accent uppercase">Dev · Concept A</p>
        <h1 className="font-serif text-[28px] font-medium text-ink">Ask states</h1>
        <p className="max-w-[680px] text-[13px] leading-5 text-dim">
          The composing panel of A02 in each state, from fixtures: nothing here calls the server. Type in a field to
          see the mnemonic grammar compile (JUNIPER COLA HLTH, BRAND ALPHA VS BRAND BETA, EAST SIDE, AUSTIN DNA).
        </p>
        <TestRunButton seconds={Math.round(fakeRunSecondsFromEnv())} />
      </header>
      <AskGallery />
    </main>
  );
}
