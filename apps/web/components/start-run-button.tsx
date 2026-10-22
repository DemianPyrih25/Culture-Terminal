"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const MAX_ATTEMPTS = 5;
const RETRY_MS = 2000;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function StartRunButton({ seconds }: { seconds: number }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setMessage(null);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const res = await fetch("/api/runs", { method: "POST" }).catch(() => null);
      const body = (await res?.json().catch(() => null)) as { runId?: unknown; error?: unknown; retry?: unknown } | null;
      if (res?.ok && typeof body?.runId === "string") {
        router.push(`/run/${body.runId}`);
        return;
      }
      // 503 while a deploy drains the old server, 429 when it is full: both say retry.
      if (body?.retry === true && attempt < MAX_ATTEMPTS) {
        setMessage(typeof body.error === "string" ? body.error : "Retrying…");
        await wait(RETRY_MS);
        continue;
      }
      break;
    }
    setBusy(false);
    setMessage("Could not start a run. Try again.");
  }

  return (
    <div className="flex flex-col items-start gap-3">
      <button
        type="button"
        onClick={start}
        disabled={busy}
        className="rounded border border-amber-400/70 bg-amber-400/10 px-5 py-3 font-mono text-sm tracking-wide text-amber-200 transition-colors hover:bg-amber-400/20 disabled:cursor-wait disabled:opacity-60"
      >
        {busy ? "Starting…" : `Start a ${seconds}-second test run`}
      </button>
      {message ? <p className="font-mono text-xs text-zinc-400">{message}</p> : null}
    </div>
  );
}
