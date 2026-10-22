"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { startRun } from "@/lib/start-run";

export function StartRunButton({ seconds }: { seconds: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setMessage(null);
    // No body: the server starts the synthetic test run.
    const outcome = await startRun(undefined, { onRetry: setMessage });
    if (outcome.ok) {
      router.push(`/run/${outcome.runId}`);
      return;
    }
    setBusy(false);
    setMessage(outcome.error);
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="rounded border border-zinc-700 px-4 py-2 font-mono text-xs tracking-wide text-zinc-300 transition-colors hover:bg-zinc-800 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? "Starting…" : `Start a ${seconds}-second test run`}
      </button>
      {message ? <p className="font-mono text-xs text-zinc-400">{message}</p> : null}
    </div>
  );
}
