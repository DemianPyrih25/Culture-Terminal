import { StartRunButton } from "@/components/start-run-button";
import { fakeRunSecondsFromEnv } from "@/server/config";

// Rendered per request so the button reflects FAKE_RUN_SECONDS on the running server.
export const dynamic = "force-dynamic";

export default function Home() {
  const seconds = Math.round(fakeRunSecondsFromEnv());
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col justify-center gap-8 px-6 py-16">
      <div className="flex flex-col gap-3">
        <h1 className="font-mono text-3xl tracking-[0.2em] text-amber-300 uppercase sm:text-4xl">Culture Terminal</h1>
        <p className="text-lg text-zinc-300">
          A Bloomberg Terminal for taste: ask a business question in plain English and get a research note where
          every number traces to a Qloo request.
        </p>
      </div>
      <StartRunButton seconds={seconds} />
      <p className="max-w-xl font-mono text-xs leading-relaxed text-zinc-500">
        The test run is a synthetic agent run on invented brands. It streams event by event; refresh the page
        mid-run and it resumes where it left off.
      </p>
    </main>
  );
}
