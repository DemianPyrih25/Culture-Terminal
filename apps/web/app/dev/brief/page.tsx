import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { Job, reduceRunEvents, type RunEvent } from "@ct/contracts";
import { BriefView } from "@/components/brief";
import { ANSWER_JOB_LABEL } from "@/lib/answer";
import { GHOST_JOBS, ghostRunEvents } from "./ghost-runs";
import { jobRunEvents } from "./job-runs";
import { listSampleFiles, readSampleFile } from "./samples";
import { isVariant, variantEvents } from "./variants";

// Development viewer: any recorded sample run in server/samples (invented entities, D29) as a finished
// answer, or with &replay=1 as a replay served from the recording, so the answer page can be checked
// without a server run or a database. ?job=<job> renders the synthetic answer of a job (./job-runs), with
// &ghost=1 its AI-alone answer beside it (./ghost-runs) and &variant=notenough with too little data
// (./variants); ?index=1 lists everything there is to open.

export const metadata: Metadata = {
  title: "Answer samples · Culture Terminal",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** Short ?sample= names for the first recordings; any other file name in server/samples works as is. */
const ALIASES: Readonly<Record<string, string>> = {
  incomplete: "brand-health-incomplete",
};

const one = (value: string | string[] | undefined): string | null => (typeof value === "string" ? value : null);

const ROW = "flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-line py-2.5 type-body";
const LINK = "font-medium text-accent hover:underline hover:underline-offset-4";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2 rounded-card border border-line bg-surface p-6 shadow-xs">
      <h2 className="type-title text-ink">{title}</h2>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function SampleIndex({ samples }: { samples: readonly string[] }) {
  return (
    <main className="mx-auto flex min-h-screen max-w-[760px] flex-col gap-6 bg-canvas px-4 py-10">
      <h1 className="type-display-m text-ink">Answer samples</h1>
      <Section title="Recorded samples (server/samples)">
        {samples.map((name) => (
          <li key={name} className={ROW}>
            <span className="min-w-0 flex-1 font-mono text-[12px] text-ink">{name}.events.json</span>
            <Link className={LINK} href={`/dev/brief?sample=${name}`}>
              Answer
            </Link>
            <Link className={LINK} href={`/dev/brief?sample=${name}&replay=1`}>
              Replay
            </Link>
          </li>
        ))}
      </Section>
      <Section title="Synthetic answers, one per job">
        {Job.options.map((job) => (
          <li key={job} className={ROW}>
            <span className="min-w-0 flex-1 text-ink">
              {ANSWER_JOB_LABEL[job]} <span className="font-mono text-[12px] text-ink-2">{job}</span>
            </span>
            <Link className={LINK} href={`/dev/brief?job=${job}`}>
              Answer
            </Link>
            {GHOST_JOBS.includes(job) ? (
              <Link className={LINK} href={`/dev/brief?job=${job}&ghost=1`}>
                With AI alone
              </Link>
            ) : null}
            <Link className={LINK} href={`/dev/brief?job=${job}&variant=notenough`}>
              Not enough data
            </Link>
            <Link className={LINK} href={`/dev/brief?job=${job}&replay=1`}>
              Replay
            </Link>
          </li>
        ))}
      </Section>
    </main>
  );
}

function InvalidSample({ name, error }: { name: string; error: string }) {
  return (
    <main className="mx-auto flex max-w-[760px] flex-col gap-3 bg-canvas px-4 py-10">
      <h1 className="type-title text-ink">{name}.events.json does not parse</h1>
      <p className="type-body text-ink-2">Every event must pass the RunEvent schema of @ct/contracts.</p>
      <pre className="overflow-x-auto rounded-control bg-sunken p-3 font-mono text-[12px] whitespace-pre-wrap text-ink">{error}</pre>
      <Link className={LINK} href="/dev/brief?index=1">
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
    const variant = one(query.variant);
    const base = withGhost ?? jobRunEvents(parsed.data);
    events = isVariant(variant) ? variantEvents(base, variant) : base;
    key = `job:${parsed.data}${ghost ? ":ghost" : ""}${isVariant(variant) ? `:${variant}` : ""}`;
    path = `/dev/brief?job=${encodeURIComponent(parsed.data)}${ghost ? "&ghost=1" : ""}${isVariant(variant) ? `&variant=${variant}` : ""}`;
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
