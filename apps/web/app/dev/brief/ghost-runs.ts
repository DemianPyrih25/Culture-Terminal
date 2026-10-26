import {
  GHOST_HONESTY_LINE,
  RunEvent,
  stampEvent,
  unstampEvent,
  type EntityRef,
  type EventInput,
  type GhostAnswer,
  type GhostDiff,
  type Job,
} from "@ct/contracts";
import { jobRunEvents } from "./job-runs";

/**
 * GHOST answers for the synthetic runs of ./job-runs, so the /dev/brief viewer (?job=<job>&ghost=1) and
 * the tests can show "LLM alone vs Culture Terminal" without a model call (SPEC §6.6). Every name, number
 * and headline is invented (D29); the Qloo-side names are the ones each synthetic brief already found.
 * Each answer covers every status: ✓ both, ★ found only by Qloo, ✗ LLM only that resolves in Qloo, and
 * one that does not.
 */

export interface GhostSample {
  answer: GhostAnswer;
  diff: GhostDiff;
}

type Item = GhostDiff["items"][number];

const ref = (n: number) => `R${n}` as EntityRef;
const both = (category: Item["category"], name: string, r: number): Item => ({ name, category, status: "both", resolvesInQloo: null, ref: ref(r) });
const qlooOnly = (category: Item["category"], name: string, r: number): Item => ({ name, category, status: "qloo_only", resolvesInQloo: null, ref: ref(r) });
const llmOnly = (category: Item["category"], name: string, resolves: boolean): Item => ({ name, category, status: "llm_only", resolvesInQloo: resolves, ref: null });

const NO_PICKS: GhostAnswer["picks"] = { competitors: [], markets: [], neighbourhoods: [], tenants: [], partners: [] };

export const GHOST_SAMPLES: Readonly<Partial<Record<Job, GhostSample>>> = {
  // Marlowe Vance's slate: GHOST reaches for the famous energy drink and a mass lager, and misses the
  // under-the-radar beer the brief leads with. Overlap@5 is 1 of 5 (Mesa Line Trucks); 4 of its 5 names resolve.
  sponsorship: {
    answer: {
      headline: "Voltline Energy and Granite Peak Light are the natural sponsors: about 70% of Marlowe Vance fans are 18 to 34, and a stadium run reaches 1.5 million people.",
      picks: { ...NO_PICKS, partners: ["Voltline Energy", "Granite Peak Light", "Mesa Line Trucks", "Bluebonnet Boot Co.", "Summit Rush Cola"] },
      numeric_claims: ["about 70%", "18 to 34", "1.5 million"],
    },
    diff: {
      items: [
        qlooOnly("partners", "Harrow Pale Lager", 2),
        qlooOnly("partners", "Cinder Hollow Rye", 3),
        both("partners", "Mesa Line Trucks", 4),
        qlooOnly("partners", "Lantern & Loom", 5),
        qlooOnly("partners", "Ridgeway Outdoor", 6),
        both("partners", "Voltline Energy", 7),
        llmOnly("partners", "Granite Peak Light", true),
        llmOnly("partners", "Bluebonnet Boot Co.", false),
        llmOnly("partners", "Summit Rush Cola", true),
      ],
      overlapAt5: 0.2,
      resolvability: 0.8,
      unsourcedNumericClaims: 3,
      meanPopularity: { ghost: 0.78, qloo: 0.52 },
      honestyLine: GHOST_HONESTY_LINE,
    },
  },
  // Juniper Cola: GHOST names the other colas and sodas; the brief finds an outfitter nearest. Two
  // categories, so the columns repeat per category. Overlap@5 is 3 of 5 on competitors and none on partners.
  brand_health: {
    answer: {
      headline: "Juniper Cola competes head-on with Foxglove Cola and Crestline Cola for buyers aged 25 to 34, and a 12% price cut would win them back.",
      picks: {
        ...NO_PICKS,
        competitors: ["Foxglove Cola", "Crestline Cola", "Harbor Seltzer", "Old Mill Root Beer", "Saltmarsh Seltzer"],
        partners: ["Brightline Cinemas", "Tidewater Music Fest"],
      },
      numeric_claims: ["25 to 34", "12%"],
    },
    diff: {
      items: [
        qlooOnly("competitors", "Granite Outfitters", 5),
        both("competitors", "Foxglove Cola", 2),
        both("competitors", "Harbor Seltzer", 3),
        qlooOnly("competitors", "Kettle Ridge Tonic", 6),
        both("competitors", "Saltmarsh Seltzer", 4),
        llmOnly("competitors", "Crestline Cola", true),
        llmOnly("competitors", "Old Mill Root Beer", false),
        qlooOnly("partners", "Granite Outfitters", 5),
        llmOnly("partners", "Brightline Cinemas", true),
        llmOnly("partners", "Tidewater Music Fest", false),
      ],
      overlapAt5: 0.3,
      resolvability: 0.71,
      unsourcedNumericClaims: 2,
      meanPopularity: { ghost: 0.81, qloo: 0.46 },
      honestyLine: GHOST_HONESTY_LINE,
    },
  },
};

/** The jobs whose synthetic run has a GHOST answer. */
export const GHOST_JOBS = Object.keys(GHOST_SAMPLES) as Job[];

/**
 * A finished run with its GHOST: the report carries it (as a stored showcase does) and a `ghost` event
 * lands just before run.end, then the events are numbered and timed again.
 */
export function withGhost(events: readonly RunEvent[], ghost: GhostSample, model = "claude-sonnet-5-5"): RunEvent[] {
  const first = events[0];
  if (!first) return [];
  const inputs: EventInput[] = events.map((e) => {
    const { input } = unstampEvent(e);
    if (input.type !== "report.final") return input;
    const { report } = input;
    return { ...input, report: { ...report, ghost, receipt: { ...report.receipt, models: { ...report.receipt.models, ghost: model } } } };
  });
  const end = inputs.findIndex((i) => i.type === "run.end");
  inputs.splice(end < 0 ? inputs.length : end, 0, { type: "ghost", answer: ghost.answer, diff: ghost.diff });
  const step = events.length > 1 ? (Date.parse(events.at(-1)?.ts ?? first.ts) - Date.parse(first.ts)) / (events.length - 1) : 0;
  return RunEvent.array().parse(
    inputs.map((input, i) => stampEvent(input, { seq: i + 1, ts: new Date(Date.parse(first.ts) + Math.round(i * step)).toISOString(), runId: first.runId })),
  );
}

const built = new Map<Job, readonly RunEvent[]>();

/** A job's synthetic run with its GHOST, or null when the job has no GHOST sample. Shared: never mutate it. */
export function ghostRunEvents(job: Job): readonly RunEvent[] | null {
  const sample = GHOST_SAMPLES[job];
  if (!sample) return null;
  let events = built.get(job);
  if (!events) {
    events = Object.freeze(withGhost(jobRunEvents(job), sample));
    built.set(job, events);
  }
  return events;
}
