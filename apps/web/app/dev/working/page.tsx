import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { reduceRunEvents, stampEvent, type EventInput, type RunEvent } from "@ct/contracts";
import { BriefView } from "@/components/brief/brief-view";
import { DraftChartCard, draftKeyNumber, WorkingView, type WorkingViewProps } from "@/components/working";
import { buildAnswerModel } from "@/lib/answer";
import { buildBriefModel } from "@/lib/brief";
import { sampleEvents } from "@/server/samples";

// Development viewer of the working view and its end states (design/redesign.pen N03, N04, N16), from the
// recorded sample runs cut at a chosen event (invented entities, D29). Nothing streams: each state is the
// first paint of a run at that point. ?state=<name>; ?index=1 lists them.

export const metadata: Metadata = {
  title: "Working · dev samples",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

type Cut = { sample: "brand-health" | "needs-input"; until?: { type: RunEvent["type"]; nth?: number; before?: boolean }; end?: { status: "cancelled" | "failed" | "incomplete" | "refused"; reason: string | null } };

const STATES = {
  start: { sample: "brand-health", until: { type: "run.created" } },
  early: { sample: "brand-health", until: { type: "tool.start", nth: 3 } },
  late: { sample: "brand-health", until: { type: "validation", before: true } },
  replay: { sample: "brand-health", until: { type: "tool.start", nth: 3 } },
  reconnecting: { sample: "brand-health", until: { type: "tool.start", nth: 3 } },
  stopped: { sample: "brand-health", until: { type: "plan" }, end: { status: "cancelled", reason: "stopped by the reader" } },
  failed: { sample: "brand-health", until: { type: "plan" }, end: { status: "failed", reason: "The model did not answer in time." } },
  "failed-late": { sample: "brand-health", until: { type: "report.draft" }, end: { status: "failed", reason: "The model did not answer in time." } },
  partial: { sample: "brand-health", until: { type: "plan" }, end: { status: "incomplete", reason: "stopped at the time limit" } },
  refused: { sample: "brand-health", until: { type: "clerk" }, end: { status: "refused", reason: null } },
  pick: { sample: "needs-input" },
  notfound: { sample: "needs-input" },
} as const satisfies Record<string, Cut>;

type StateName = keyof typeof STATES;

function cut(name: StateName): RunEvent[] {
  const spec: Cut = STATES[name];
  let list = [...sampleEvents(spec.sample)];
  if (spec.until) {
    let seen = 0;
    const i = list.findIndex((e) => e.type === spec.until?.type && ++seen === (spec.until.nth ?? 1));
    if (i >= 0) list = list.slice(0, spec.until.before ? i : i + 1);
  }
  if (name === "refused") {
    list = list.map((e) =>
      e.type === "clerk"
        ? { ...e, intent: { ...e.intent, safety: { allowed: false, category: "political_targeting" as const, reframe: "Which artists do Juniper Cola's fans love?" } } }
        : e,
    );
  }
  if (name === "notfound") {
    list = list.map((e) => (e.type === "needs_input" ? { ...e, reason: "not_found" as const, candidates: [] } : e));
  }
  if (spec.end) {
    const first = list[0];
    const last = list.at(-1);
    if (first && last) {
      const ts = new Date(Date.parse(last.ts) + 1000).toISOString();
      const input: EventInput = { type: "run.end", status: spec.end.status, elapsedMs: Date.parse(ts) - Date.parse(first.ts), reason: spec.end.reason };
      list.push(stampEvent(input, { seq: last.seq + 1, ts, runId: last.runId }));
    }
  }
  return list;
}

function Index() {
  return (
    <main className="mx-auto flex max-w-[760px] flex-col gap-4 px-4 py-10">
      <h1 className="type-display-m text-ink">Working · dev samples</h1>
      <ul className="flex flex-col gap-2">
        {(Object.keys(STATES) as StateName[]).map((name) => (
          <li key={name}>
            <Link className="text-accent hover:underline" href={`/dev/working?state=${name}`}>
              {name}
            </Link>
          </li>
        ))}
      </ul>
    </main>
  );
}

export default async function DevWorkingPage(props: PageProps<"/dev/working">) {
  if (process.env.NODE_ENV === "production") notFound();
  const query = await props.searchParams;
  const asked = typeof query.state === "string" ? query.state : null;
  if (query.index === "1" || asked === null) return <Index />;
  if (!(asked in STATES)) notFound();
  const name = asked as StateName;
  const list = cut(name);
  const first = list[0];
  const last = list.at(-1);
  if (!first || !last) notFound();
  if (name === "replay") {
    const all = [...sampleEvents("brand-health")];
    const path = "/dev/working?state=replay";
    return (
      <BriefView
        runId={first.runId}
        initialState={reduceRunEvents(first.runId, all)}
        serverNow={Date.parse(all.at(-1)?.ts ?? last.ts)}
        mode="replay"
        events={all}
        links={{ permalink: path, replay: path, exitReplay: path }}
      />
    );
  }
  const state = reduceRunEvents(first.runId, list);
  const now = Date.parse(last.ts) + 1000;
  const model = buildBriefModel(state, now);
  const answer = buildAnswerModel(model, { resolves: state.resolves, ghost: state.ghost, report: state.report, metrics: state.metrics });
  const view: WorkingViewProps = {
    runId: state.runId,
    model,
    state,
    mode: state.ended ? "static" : "live",
    elapsedMs: now - Date.parse(first.ts),
    connectionLost: name === "reconnecting",
    keyNumbers: answer.keyNumbers.map(draftKeyNumber),
    chart: answer.charts.main ? <DraftChartCard chart={answer.charts.main} draft={state.draft} /> : null,
    sharePath: `/dev/working?state=${name}`,
  };
  return <WorkingView {...view} />;
}
