"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button, type ButtonProps } from "../ui/button";
import { startRun } from "../../lib/start-run";

export interface TestRunButtonProps {
  /** FAKE_RUN_SECONDS of the running server, for the label. */
  seconds: number;
  /** The label; default "Start a N-second test run". */
  label?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
}

/**
 * Starts the synthetic test run (POST /api/runs with no body), which replays a recorded brief at no
 * cost, and opens it. Test runs are never listed, so it is not kept in this browser's recent briefs.
 */
export function TestRunButton({ seconds, label, variant, size }: TestRunButtonProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function start() {
    setBusy(true);
    setMessage(null);
    const outcome = await startRun(undefined, { onRetry: setMessage });
    if (outcome.ok) {
      router.push(`/run/${outcome.runId}`);
      return;
    }
    setBusy(false);
    setMessage(outcome.error);
  }

  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button onClick={start} disabled={busy} aria-busy={busy} variant={variant} size={size}>
        {busy ? "Starting…" : (label ?? `Start a ${seconds}-second test run`)}
      </Button>
      {message ? (
        <p role="status" className="text-[12px] text-dim">
          {message}
        </p>
      ) : null}
    </div>
  );
}
