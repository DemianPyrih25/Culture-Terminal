"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import type { Report, RunEventType, RunState, Signal } from "@ct/contracts";
import { formatElapsed } from "@/lib/event-summary";
import { proseText } from "@/lib/report-text";
import { RunStreamClient, type ConnectionStatus } from "@/lib/sse-client";
import { startRun } from "@/lib/start-run";
import { FAKE_MODEL } from "@/lib/test-run";

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

const SIGNAL_TONE: Record<Signal, string> = {
  strong: "text-emerald-300",
  mixed: "text-amber-300",
  weak: "text-orange-400",
  insufficient_evidence: "text-zinc-400",
};

/** The final note as plain text: tokens resolved against the run's metrics, nothing parsed as markup. */
function ReportCard({ report, metrics }: { report: Report; metrics: RunState["metrics"] }) {
  const text = (prose: string) => proseText(prose, metrics, report.dataFreshness.trendWindow);
  const { verdict, receipt } = report;
  return (
    <section className="flex flex-col gap-4 rounded border border-zinc-800 bg-zinc-950/60 px-4 py-4">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-xs tracking-widest uppercase">
        <span className={SIGNAL_TONE[verdict.signal]}>Signal · {verdict.signal.replace("_", " ")}</span>
        <span className="text-zinc-400">
          Confidence {verdict.confidence.score} {verdict.confidence.band}
        </span>
        <span className="text-emerald-300">
          ✓ {receipt.numbersTraced.traced}/{receipt.numbersTraced.total} numbers traced
        </span>
        {report.incomplete ? <span className="text-amber-300">Incomplete</span> : null}
      </div>
      {report.investmentBanner ? (
        <p className="rounded border border-amber-700/60 px-3 py-1 font-mono text-xs text-amber-300">
          Analytics, not financial advice.
        </p>
      ) : null}
      <h2 className="text-xl text-zinc-100">{text(verdict.headline)}</h2>
      <p className="text-sm leading-relaxed text-zinc-300">{text(verdict.thesis)}</p>
      {report.arguments.length > 0 ? (
        <ol className="flex flex-col gap-3">
          {report.arguments.map((a) => (
            <li key={a.id} className="flex flex-col gap-1 border-l border-zinc-800 pl-3 text-sm">
              <span className="font-mono text-[10px] tracking-widest text-zinc-500 uppercase">
                {a.id} · {a.section} · {a.strength}
              </span>
              <p className="text-zinc-200">
                <span className="mr-2 font-mono text-[10px] text-cyan-400">QLOO DATA</span>
                {text(a.qlooFact)}
              </p>
              <p className="text-zinc-400">
                <span className="mr-2 font-mono text-[10px] text-fuchsia-300">OUR READ</span>
                {text(a.ourRead)}
              </p>
            </li>
          ))}
        </ol>
      ) : null}
      <ul className="flex flex-col gap-1 font-mono text-[11px] text-zinc-500">
        {report.disclaimers.map((d) => (
          <li key={d}>{d}</li>
        ))}
      </ul>
    </section>
  );
}

/**
 * The resolution gate stopped the run. Once it has ended, each candidate re-asks the question with
 * that entity: the browser sends only the opaque key, and the server maps it to the entity (D20).
 */
function NeedsInputCard({
  runId,
  needsInput,
  canPick,
}: {
  runId: string;
  needsInput: NonNullable<RunState["needsInput"]>;
  canPick: boolean;
}) {
  const router = useRouter();
  const [picking, setPicking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  async function pick(key: string) {
    setPicking(key);
    setMessage(null);
    const outcome = await startRun({ pick: { runId, key } }, { onRetry: setMessage });
    if (outcome.ok) {
      router.push(`/run/${outcome.runId}`);
      return;
    }
    setPicking(null);
    setMessage(outcome.error);
  }

  return (
    <section className="flex flex-col gap-2 rounded border border-amber-700/60 bg-amber-950/20 px-4 py-3 text-sm">
      <p className="text-zinc-100">
        Which &ldquo;{needsInput.mention}&rdquo; did you mean? ({needsInput.reason.replace("_", " ")} match)
      </p>
      {needsInput.candidates.length > 0 ? (
        <ul className="flex flex-col gap-1 text-zinc-300">
          {needsInput.candidates.map((c) => (
            <li key={c.key}>
              <button
                type="button"
                onClick={() => pick(c.key)}
                disabled={!canPick || picking !== null}
                className="rounded px-1 text-left hover:bg-zinc-800 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              >
                {c.name}
                {c.disambiguation ? <span className="text-zinc-500"> · {c.disambiguation}</span> : null}
                {picking === c.key ? <span className="text-amber-300"> · starting…</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="font-mono text-xs text-zinc-500">
        {needsInput.candidates.length > 0
          ? "Pick one to run the analysis with it, or ask again with the full name."
          : "Ask again with the full name to run the analysis."}
      </p>
      {message ? <p className="font-mono text-xs text-zinc-400">{message}</p> : null}
    </section>
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
  // Unknown until run.created arrives; the test run says so in its model id.
  const isTest = state.model === FAKE_MODEL;

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
        <span className="font-mono text-xs text-zinc-500">
          {isTest ? "test run" : "run"} · {runId}
        </span>
      </header>

      <section className="flex flex-col gap-2">
        <h1 className="text-xl text-zinc-100 sm:text-2xl">{state.question ?? "Waiting for the first event…"}</h1>
        <p className="text-sm text-zinc-400">
          {isTest
            ? "A synthetic agent run on invented brands. Refresh the page mid-run: it replays from the first event and carries on live."
            : "Every number in the note traces to a Qloo request. Refresh the page mid-run: it replays from the first event and carries on live."}
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
        </section>
      ) : null}

      {state.needsInput ? (
        <NeedsInputCard runId={runId} needsInput={state.needsInput} canPick={ended?.status === "needs_input"} />
      ) : null}

      {state.report ? <ReportCard report={state.report} metrics={state.metrics} /> : null}

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
