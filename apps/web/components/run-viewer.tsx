"use client";

import Link from "next/link";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { RunEventType } from "@ct/contracts";
import { formatElapsed } from "@/lib/event-summary";
import { RunStreamClient, type ConnectionStatus } from "@/lib/sse-client";

const CONNECTION_LABEL: Record<ConnectionStatus, { label: string; dot: string }> = {
  idle: { label: "idle", dot: "bg-zinc-500" },
  connecting: { label: "connecting", dot: "bg-sky-400 animate-pulse" },
  open: { label: "live", dot: "bg-emerald-400" },
  reconnecting: { label: "reconnecting", dot: "bg-amber-400 animate-pulse" },
  ended: { label: "closed (run ended)", dot: "bg-zinc-400" },
  not_found: { label: "run not found", dot: "bg-red-500" },
  failed: { label: "disconnected", dot: "bg-red-500" },
};

// The trace rail's colour cues: CODE FALLBACK orange, ANALYST PIVOT orchid (PLAN §4.1).
function typeColor(type: RunEventType): string {
  switch (type) {
    case "fallback":
      return "text-orange-400";
    case "pivot":
      return "text-fuchsia-400";
    case "finding":
      return "text-amber-300";
    case "qloo":
      return "text-cyan-400";
    case "error":
      return "text-red-400";
    case "note":
      return "text-zinc-500";
    case "run.created":
    case "run.end":
    case "report.final":
      return "text-emerald-300";
    default:
      return "text-zinc-300";
  }
}

/** Wall clock that ticks while `active`; null until the first tick so render stays pure. */
function useNow(active: boolean, intervalMs = 500): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, intervalMs);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [active, intervalMs]);
  return now;
}

function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="flex flex-col gap-1 rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-widest text-zinc-500">{label}</span>
      <span className={`font-mono text-sm ${tone ?? "text-zinc-100"}`}>{value}</span>
    </div>
  );
}

export function RunViewer({ runId }: { runId: string }) {
  const [client] = useState(() => new RunStreamClient(runId));
  useEffect(() => {
    client.start();
    return () => client.stop();
  }, [client]);
  const snap = useSyncExternalStore(client.subscribe, client.getSnapshot, client.getSnapshot);
  const { state } = snap;
  const ended = state.ended;
  const now = useNow(ended === null && state.createdAt !== null);
  const [cancel, setCancel] = useState<"idle" | "sent" | "failed">("idle");

  const elapsedMs = ended
    ? ended.elapsedMs
    : state.createdAt && now !== null
      ? Math.max(0, now - Date.parse(state.createdAt))
      : null;
  const connection = CONNECTION_LABEL[snap.connection];
  const findings = state.findings.length;
  const live = snap.connection === "open" || snap.connection === "reconnecting" || snap.connection === "connecting";

  async function requestCancel() {
    const res = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" }).catch(() => null);
    setCancel(res?.ok ? "sent" : "failed");
  }

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <Link href="/" className="font-mono text-sm tracking-[0.3em] text-amber-300 uppercase">
          Culture Terminal
        </Link>
        <span className="font-mono text-xs text-zinc-500">test run · {runId}</span>
      </header>

      <section className="flex flex-col gap-2">
        <h1 className="text-xl text-zinc-100 sm:text-2xl">{state.question ?? "Waiting for the first event…"}</h1>
        <p className="text-sm text-zinc-400">
          A synthetic agent run on invented brands. Refresh the page mid-run: it replays from the first event and
          carries on live.
        </p>
      </section>

      <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Stat
          label="Connection"
          value={
            <span className="flex items-center gap-2">
              <span className={`inline-block h-2 w-2 rounded-full ${connection.dot}`} />
              {connection.label}
            </span>
          }
        />
        <Stat label="Last seq" value={state.lastSeq} />
        <Stat label="Reconnects" value={snap.reconnects} />
        <Stat label="Elapsed" value={elapsedMs === null ? "–" : formatElapsed(elapsedMs)} />
        <Stat
          label="Run status"
          value={state.status}
          tone={state.status === "completed" ? "text-emerald-300" : ended ? "text-amber-300" : undefined}
        />
        <Stat
          label="Gaps · dupes"
          value={`${snap.gaps} · ${snap.duplicates}`}
          tone={snap.gaps + snap.duplicates + snap.invalid > 0 ? "text-red-400" : "text-zinc-100"}
        />
      </section>

      <section className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={() => client.forceReconnect()}
          disabled={!live}
          className="rounded border border-zinc-700 px-3 py-2 font-mono text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          Simulate a dropped connection
        </button>
        <button
          type="button"
          onClick={requestCancel}
          disabled={ended !== null || cancel === "sent"}
          className="rounded border border-zinc-700 px-3 py-2 font-mono text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          {cancel === "sent" ? "Cancel requested" : "Cancel run"}
        </button>
        {cancel === "failed" ? <span className="font-mono text-xs text-red-400">Cancel failed.</span> : null}
        <span className="font-mono text-xs text-zinc-500">
          {state.toolCalls.length} tool calls · Qloo {state.qloo.network} network / {state.qloo.cached} cached /{" "}
          {state.qloo.reused} reused · {findings} findings · {Object.keys(state.metrics).length} metrics ·{" "}
          {Object.keys(state.datasets).length} datasets
        </span>
      </section>

      {ended ? (
        <section
          className={`rounded border px-4 py-3 ${
            ended.status === "completed" ? "border-emerald-700/60 bg-emerald-950/30" : "border-amber-700/60 bg-amber-950/30"
          }`}
        >
          <p className="font-mono text-sm text-zinc-100">
            Run {ended.status} after {formatElapsed(ended.elapsedMs)}
            {ended.reason ? ` · ${ended.reason}` : ""}
          </p>
          {state.report ? (
            <p className="mt-1 text-sm text-zinc-300">
              {state.report.verdict.headline} · confidence {state.report.verdict.confidence.score}{" "}
              {state.report.verdict.confidence.band}
            </p>
          ) : null}
        </section>
      ) : null}

      {snap.connection === "not_found" ? (
        <p className="font-mono text-sm text-red-400">No run with this id.</p>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="font-mono text-xs tracking-widest text-zinc-500 uppercase">Event log · newest first</h2>
        <ol className="max-h-[60vh] overflow-y-auto rounded border border-zinc-800 bg-black/40 font-mono text-xs">
          {snap.log.length === 0 ? <li className="px-3 py-2 text-zinc-500">No events yet.</li> : null}
          {snap.log
            .slice()
            .reverse()
            .map((entry) => (
              <li key={entry.seq} className="grid grid-cols-[3.5rem_7.5rem_1fr] gap-2 border-b border-zinc-900 px-3 py-1">
                <span className="text-right text-zinc-600">{entry.seq}</span>
                <span className={typeColor(entry.type)}>{entry.type}</span>
                <span className="break-words text-zinc-300">{entry.summary}</span>
              </li>
            ))}
        </ol>
      </section>
    </main>
  );
}
