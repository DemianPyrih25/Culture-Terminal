import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Job, reduceRunEvents, type RunEvent } from "@ct/contracts";
import { BriefView } from "@/components/brief";
import { JOB_LABEL } from "@/lib/brief/format";
import { GHOST_JOBS, ghostRunEvents } from "./ghost-runs";
import { jobRunEvents } from "./job-runs";
import { listSampleFiles, readSampleFile } from "./samples";

// Development viewer: any recorded sample run in server/samples (invented entities, D29) as a finished
// brief, or with &replay=1 as a replay served from the recording, so the brief page can be checked
// without a server run or a database. ?job=<job> renders the synthetic brief of a job (./job-runs), with
// &ghost=1 its GHOST answer beside it (./ghost-runs), and ?index=1 lists everything there is to open.

export const metadata: Metadata = {
  title: "Brief · dev samples",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Short ?sample= names for the first recordings; any other file name in server/samples works as is. */
const ALIASES: Readonly<Record<string, string>> = {
  incomplete: "brand-health-incomplete",
};

const one = (value: string | string[] | undefined): string | null => (typeof value === "string" ? value : null);

function SampleIndex({ samples }: { samples: readonly string[] }) {
  const row = "flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line py-2 text-[14px]";
  const link = "text-accent hover:underline hover:underline-offset-4";
  return (
    <main className="mx-auto flex max-w-[760px] flex-col gap-8 px-4 py-10">
      <h1 className="m-0 font-serif text-[28px] text-ink">Brief · dev samples</h1>
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-[11px] font-semibold tracking-[1.3px] text-dim uppercase">Recorded samples · server/samples</h2>
        <ul className="m-0 list-none p-0">
          {samples.map((name) => (
            <li key={name} className={row}>
              <span className="min-w-0 flex-1 font-mono text-[12px] text-ink">{name}.events.json</span>
              <Link className={link} href={`/dev/brief?sample=${name}`}>
                Brief
              </Link>
              <Link className={link} href={`/dev/brief?sample=${name}&replay=1`}>
                Replay
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-[11px] font-semibold tracking-[1.3px] text-dim uppercase">Synthetic briefs · one per job</h2>
        <ul className="m-0 list-none p-0">
          {Job.options.map((job) => (
            <li key={job} className={row}>
              <span className="min-w-0 flex-1 text-ink">
                {JOB_LABEL[job]} <span className="font-mono text-[12px] text-dim">{job}</span>
              </span>
              <Link className={link} href={`/dev/brief?job=${job}`}>
                Brief
              </Link>
              <Link className={link} href={`/dev/brief?job=${job}&replay=1`}>
                Replay
              </Link>
            </li>
          ))}
        </ul>
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="m-0 text-[11px] font-semibold tracking-[1.3px] text-dim uppercase">With GHOST · LLM alone vs Culture Terminal</h2>
        <ul className="m-0 list-none p-0">
          {GHOST_JOBS.map((job) => (
            <li key={job} className={row}>
              <span className="min-w-0 flex-1 text-ink">
                {JOB_LABEL[job]} <span className="font-mono text-[12px] text-dim">{job}</span>
              </span>
              <Link className={link} href={`/dev/brief?job=${job}&ghost=1`}>
                Brief
              </Link>
              <Link className={link} href={`/dev/brief?job=${job}&ghost=1&replay=1`}>
                Replay
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

function InvalidSample({ name, error }: { name: string; error: string }) {
  return (
    <main className="mx-auto flex max-w-[760px] flex-col gap-3 px-4 py-10">
      <h1 className="m-0 font-serif text-[24px] text-ink">{name}.events.json does not parse</h1>
      <p className="m-0 text-[13px] text-text-2">Every event must pass the RunEvent schema of @ct/contracts.</p>
      <pre className="m-0 overflow-x-auto rounded-brief bg-canvas p-3 font-mono text-[11px] whitespace-pre-wrap text-ink">{error}</pre>
      <Link className="text-[13px] text-accent hover:underline" href="/dev/brief?index=1">
        All samples
      </Link>
    </main>
  );
}

export default async function DevBriefPage(props: PageProps<"/dev/brief">) {
  if (process.env.NODE_ENV === "production") notFound();
  const query = await props.searchParams;
  if (one(query.index) === "1") return <SampleIndex samples={listSampleFiles()} />;
  const replay = one(query.replay) === "1";

  let events: readonly RunEvent[];
  let key: string;
  let path: string;
  const job = one(query.job);
  if (job !== null) {
    const parsed = Job.safeParse(job);
    if (!parsed.success) notFound();
    const ghost = one(query.ghost) === "1";
    const withGhost = ghost ? ghostRunEvents(parsed.data) : null;
    if (ghost && !withGhost) notFound();
    events = withGhost ?? jobRunEvents(parsed.data);
    key = `job:${parsed.data}${ghost ? ":ghost" : ""}`;
    path = `/dev/brief?job=${encodeURIComponent(parsed.data)}${ghost ? "&ghost=1" : ""}`;
  } else {
    const asked = one(query.sample) ?? "brand-health";
    const sample = readSampleFile(ALIASES[asked] ?? asked);
    if (sample.kind === "missing") notFound();
    if (sample.kind === "invalid") return <InvalidSample name={sample.name} error={sample.error} />;
    events = sample.events;
    key = `sample:${sample.name}`;
    path = `/dev/brief?sample=${encodeURIComponent(asked)}`;
  }

  const first = events[0];
  const last = events.at(-1);
  if (!first) notFound();
  return (
    <BriefView
      key={`${key}:${replay ? "replay" : "brief"}`}
      runId={first.runId}
      initialState={reduceRunEvents(first.runId, events)}
      // The recording's own clock, so the page prints the same on every load.
      serverNow={last ? Date.parse(last.ts) : 0}
      mode={replay ? "replay" : "static"}
      events={replay ? events : null}
      links={{ permalink: path, replay: `${path}&replay=1`, exitReplay: path }}
    />
  );
}
