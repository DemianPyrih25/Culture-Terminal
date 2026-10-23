import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { reduceRunEvents } from "@ct/contracts";
import { BriefView } from "@/components/brief";
import { sampleEvents, sampleRunId, type SampleName } from "@/server/samples";

// Development viewer: the recorded sample runs (invented entities, D29) as finished briefs, or with
// &replay=1 as replays served from the recording, so the brief page can be checked without a server
// run or a database.

export const metadata: Metadata = {
  title: "Brief · dev samples",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

/** ?sample= names, to the recordings in server/samples. */
const SAMPLES: Readonly<Record<string, SampleName>> = {
  "brand-health": "brand-health",
  incomplete: "brand-health-incomplete",
  "needs-input": "needs-input",
};

export default async function DevBriefPage(props: PageProps<"/dev/brief">) {
  if (process.env.NODE_ENV === "production") notFound();
  const query = await props.searchParams;
  const key = typeof query.sample === "string" ? query.sample : "brand-health";
  const name = SAMPLES[key];
  if (!name) notFound();
  const replay = query.replay === "1";

  const events = sampleEvents(name);
  const runId = sampleRunId(name);
  const last = events.at(-1);
  const path = `/dev/brief?sample=${encodeURIComponent(key)}`;
  return (
    <BriefView
      key={`${key}:${replay ? "replay" : "brief"}`}
      runId={runId}
      initialState={reduceRunEvents(runId, events)}
      // The recording's own clock, so the page prints the same on every load.
      serverNow={last ? Date.parse(last.ts) : 0}
      mode={replay ? "replay" : "static"}
      events={replay ? events : null}
      links={{ permalink: path, replay: `${path}&replay=1`, exitReplay: path }}
    />
  );
}
