import type { EntityType, Job, RunState, SafetyCategory } from "@ct/contracts";
import { formatClockShort, JOB_LABEL } from "./format";
import { checkedDraft, followUpsDone, happened } from "./live";

/**
 * The working view's five steps (design/redesign.pen N03, N04): read the question, find the names in
 * Qloo, pull taste data, write the answer, check every number. Each step's state comes from the run's
 * events; the status title is the active step's label (a job phrase while the data is pulled). Pure, so
 * the server's first paint and the live stream print the same words.
 */

export type WorkingStepKey = "read" | "find" | "pull" | "write" | "check";

export type WorkingStepState = "pending" | "active" | "done";

export interface WorkingStep {
  key: WorkingStepKey;
  state: WorkingStepState;
  /** The label in the tense of its state: "Read your question", "Reading your question". */
  label: string;
}

/** The job labels the answer and working views print (area_profile reads as the design names it). */
export const WORKING_JOB_LABEL: Readonly<Record<Job, string>> = {
  ...JOB_LABEL,
  area_profile: "What an area is like",
};

/** The status title while the taste data is pulled, per job. */
export const JOB_ACTIVE_PHRASE: Readonly<Record<Job, string>> = {
  brand_health: "Comparing audiences",
  head_to_head: "Comparing the two audiences",
  site_selection: "Mapping interest by area",
  tenant_mix: "Scoring tenants for the block",
  area_profile: "Reading the area's taste",
  sponsorship: "Scoring sponsor fit",
  market_selection: "Ranking markets",
  audience_discovery: "Profiling the audience",
  taste_twins: "Matching areas across the two cities",
  brand_collab: "Scoring possible partners",
  creator_fit: "Scoring creators for the audience",
  launch_test: "Checking the concept against the data",
  city_compare: "Comparing the cities",
};

/** How long a run usually takes, by lane: the public lane is the fast one. */
export const LANE_ESTIMATE: Readonly<Record<"public" | "judge", string>> = {
  public: "Usually under a minute",
  judge: "Usually 1–2 minutes",
};

/** Plural nouns for "and 5 similar brands". */
const ENTITY_NOUN: Readonly<Record<EntityType, string>> = {
  brand: "brands",
  artist: "artists",
  person: "people",
  podcast: "podcasts",
  tv_show: "shows",
  movie: "films",
  place: "places",
  destination: "places",
};

type Tenses = readonly [pending: string, active: string, done: string];

function tenses(key: WorkingStepKey, primary: string | null, publicData: boolean): Tenses {
  switch (key) {
    case "read":
      return ["Read your question", "Reading your question", "Read your question"];
    case "find": {
      const what = primary ?? "the names";
      return [`Find ${what} in Qloo`, `Finding ${what} in Qloo`, `Found ${what} in Qloo`];
    }
    case "pull":
      // SEC filings or Census figures joined the taste data (company_financials, area_economics).
      return publicData
        ? ["Pull taste and public data", "Pulling taste and public data", "Pulled taste and public data"]
        : ["Pull taste data", "Pulling taste data", "Pulled taste data"];
    case "write":
      return ["Write the answer", "Writing the answer", "Wrote the answer"];
    case "check":
      return ["Check every number", "Checking every number", "Checked every number"];
  }
}

const STEP_KEYS: readonly WorkingStepKey[] = ["read", "find", "pull", "write", "check"];

/** The name the run is about: the primary mention as Qloo matched it, else as written, else the area. */
export function primaryName(state: RunState): string | null {
  const resolved = state.resolves.find((r) => r.role === "primary" && r.match === "exact");
  if (resolved?.name) return resolved.name;
  const mention = state.intent?.mentions.find((m) => m.role === "primary") ?? state.intent?.mentions[0];
  if (mention) return mention.text;
  return state.intent?.geo.area ?? state.intent?.geo.metro ?? null;
}

/** Where each step stands. A run that stopped keeps the states it reached. */
export function stepStates(state: RunState): Record<WorkingStepKey, WorkingStepState> {
  const started = state.lastSeq > 0;
  const read = state.intent !== null;
  const refused = state.intent?.safety.allowed === false || state.status === "refused";
  const found = happened(state, "resolve") || state.toolCalls.length > 0;
  const report = state.report !== null;
  const drafted = state.draft !== null || report;
  const running = state.toolCalls.some((t) => t.status === "running");
  const pullStarted = happened(state, "plan") || state.toolCalls.length > 0;
  // The tools are done: a draft is in, or the plan's follow-ups have run and nothing is running.
  const pulled = drafted || (state.plan !== null && !running && followUpsDone(state));
  const checked = report || checkedDraft(state)?.ok === true;

  const find: WorkingStepState = found ? "done" : read && !refused && state.needsInput === null ? "active" : "pending";
  return {
    read: read ? "done" : started ? "active" : "pending",
    find,
    pull: pulled ? "done" : pullStarted && find === "done" ? "active" : "pending",
    write: drafted ? "done" : pulled ? "active" : "pending",
    check: checked ? "done" : drafted ? "active" : "pending",
  };
}

export interface WorkingProgress {
  steps: WorkingStep[];
  /** The status title: the active step's label, or the job's phrase while the data is pulled. */
  title: string;
  /** The active step's label alone, for the polite live region. */
  announcement: string;
  primary: string | null;
}

/** The five steps and the status title. */
export function workingProgress(state: RunState): WorkingProgress {
  const primary = primaryName(state);
  const states = stepStates(state);
  // Runs stored before public data have no publicCalls.
  const publicData = (state.publicCalls?.chips.length ?? 0) > 0;
  const steps = STEP_KEYS.map((key): WorkingStep => {
    const [pending, active, done] = tenses(key, primary, publicData);
    const s = states[key];
    return { key, state: s, label: s === "done" ? done : s === "active" ? active : pending };
  });
  const active = steps.find((s) => s.state === "active");
  const job = state.intent?.job ?? null;
  const title = active ? (active.key === "pull" && job ? JOB_ACTIVE_PHRASE[job] : active.label) : (steps.findLast((s) => s.state === "done")?.label ?? steps[0]!.label);
  return { steps, title, announcement: active?.label ?? title, primary };
}

/** "Usually under a minute · 0:06" (the time from the run's first event). */
export function workingTime(state: RunState, elapsedMs: number): string {
  return `${LANE_ESTIMATE[state.lane ?? "public"]} · ${formatClockShort(elapsedMs)}`;
}

/** "Recording · 0:12 of 0:26": a replay's place in its recording. */
export function replayTime(positionMs: number, durationMs: number | null): string {
  return `Recording · ${formatClockShort(positionMs)}${durationMs !== null ? ` of ${formatClockShort(durationMs)}` : ""}`;
}

/**
 * "Real competitors · Liquid Death and 5 similar brands": how the question was read, once CLERK has
 * read it. The peers are the other names matched exactly; one peer is named, more are counted.
 */
export function readingAs(state: RunState): string | null {
  const intent = state.intent;
  if (!intent || intent.safety.allowed === false) return null;
  const job = WORKING_JOB_LABEL[intent.job];
  const primary = primaryName(state);
  if (!primary) return job;
  const others = [...new Set(state.resolves.filter((r) => r.match === "exact" && r.name !== null && r.name !== primary).map((r) => r.name as string))];
  const type = state.resolves.find((r) => r.name === primary)?.entityType ?? intent.mentions[0]?.entity_type ?? null;
  let subjects = primary;
  if (others.length === 1) subjects = `${primary} and ${others[0]}`;
  else if (others.length > 1) subjects = `${primary} and ${others.length} similar ${type ? ENTITY_NOUN[type] : "names"}`;
  return `${job} · ${subjects}`;
}

/** Longer findings read as a paragraph, not a note: they are left out. */
export const NOTICED_MAX = 140;

/**
 * "Noticed: Pinecone Soap Co., from outside the category, has very similar fans. Looking closer.": the
 * latest finding that made the analyst pivot, while the run looks closer. Null when there is none, or
 * when its text is too long for one line.
 */
export function noticed(state: RunState): string | null {
  for (const pivot of [...state.pivots].reverse()) {
    const finding = state.findings.find((f) => f.id === pivot.triggerFindingId);
    if (!finding) continue;
    const text = finding.text.trim().replace(/[.\s]+$/, "");
    if (text === "" || text.length > NOTICED_MAX) return null;
    return `Noticed: ${text}. Looking closer.`;
  }
  return null;
}

/** "We don't answer political targeting questions.": why a question was declined, in one line. */
export const REFUSAL_SENTENCE: Readonly<Record<SafetyCategory, string>> = {
  private_individual: "We don't answer questions about private individuals.",
  sensitive_inference: "We don't answer questions about sensitive traits.",
  political_targeting: "We don't answer political targeting questions.",
  eligibility: "We don't answer housing, credit, job or insurance questions.",
  residential_screening: "We don't answer tenant screening questions.",
  injection: "We don't follow instructions written into a question.",
  financial_advice: "We don't give buy, sell or price advice.",
  out_of_scope: "We only answer questions about taste and audiences.",
};

export function refusalSentence(category: SafetyCategory | null): string {
  return category ? REFUSAL_SENTENCE[category] : "We don't answer this kind of question.";
}
