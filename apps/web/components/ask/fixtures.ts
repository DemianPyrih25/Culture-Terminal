import type { AccessPause, AlreadyHave, AskState, PreviewResponse } from "./ask-machine";
import type { AskParent } from "./ask-parent";

/**
 * Invented previews for the /dev/ask gallery and the tests (D29: no real entities, values or ids).
 * Brand names, run ids, tokens and counts match nothing in Qloo or the design exports.
 */

/** When the fixtures' previews arrived: ages print against it. */
export const FIXTURE_AT = Date.parse("2026-07-06T12:00:00.000Z");

export const FIXTURE_QUESTION = "Juniper Cola vs Brand Beta: who wins where?";

export const FIXTURE_HAVE: AlreadyHave = {
  runId: "run-fixture-a1b2",
  question: FIXTURE_QUESTION,
  createdAt: "2026-07-06T09:40:00.000Z",
  signal: "mixed",
  confidence: { score: 71, band: "MED" },
};

export const FIXTURE_PREVIEW: PreviewResponse = {
  token: `pv_${"0f".repeat(16)}`,
  expiresAt: "2026-07-06T12:10:00.000Z",
  understood: {
    pillar: "investment",
    job: "head_to_head",
    jobLabel: "Compare two brands",
    mnemonic: "JUNIPER COLA VS BRAND BETA",
    mentions: [
      { text: "Juniper Cola", type: "brand", role: "primary", match: "exact", name: "Juniper Cola" },
      { text: "Brand Beta", type: "brand", role: "peer", match: "exact", name: "Brand Beta" },
    ],
    metros: [],
    scope: "US metros & ages",
    lens: "Investment lens · both names matched exactly · vs US baseline",
  },
  alreadyHave: null,
  estimate: { networkCalls: 12, cachedCalls: 7, seconds: 45, quotaShare: 0.0063 },
  mode: "live",
  modeNote: null,
};

export const FIXTURE_PREVIEW_HAVE: PreviewResponse = { ...FIXTURE_PREVIEW, alreadyHave: FIXTURE_HAVE };

/** What a paused lane says (the LLM spend breaker's message). */
export const FIXTURE_PAUSED_MESSAGE = "Live analysis is paused: today's budget is used up. It resumes at 00:00 UTC.";

export const FIXTURE_PREVIEW_UNMATCHED: PreviewResponse = {
  ...FIXTURE_PREVIEW,
  understood: {
    ...FIXTURE_PREVIEW.understood!,
    mentions: [
      { text: "Juniper Cola", type: "brand", role: "primary", match: "exact", name: "Juniper Cola" },
      { text: "Brand Betta", type: "brand", role: "peer", match: "inexact", name: null },
    ],
    mnemonic: "JUNIPER COLA VS BRAND BETTA",
    lens: "Investment lens · 1 of 2 names matched exactly · vs US baseline",
  },
  estimate: { networkCalls: 9, cachedCalls: 2, seconds: 40, quotaShare: 0.0047 },
};

/** The subject has more than one match: the run asks which one is meant, so it still runs. */
export const FIXTURE_PREVIEW_PICK: PreviewResponse = {
  ...FIXTURE_PREVIEW,
  understood: {
    ...FIXTURE_PREVIEW.understood!,
    mentions: [
      { text: "Junipr Cola", type: "brand", role: "primary", match: "ambiguous", name: null },
      { text: "Brand Beta", type: "brand", role: "peer", match: "exact", name: "Brand Beta" },
    ],
    mnemonic: "JUNIPR COLA VS BRAND BETA",
    lens: "Investment lens · pick the Junipr Cola you mean · vs US baseline",
  },
  estimate: { networkCalls: 0, cachedCalls: 2, seconds: 5, quotaShare: 0 },
};

/** Compare two brands, but the question names one: code compiles "JUNIPER COLA VS <B>". */
export const FIXTURE_PREVIEW_ONE_NAME: PreviewResponse = {
  ...FIXTURE_PREVIEW,
  understood: {
    ...FIXTURE_PREVIEW.understood!,
    mentions: [{ text: "Juniper Cola", type: "brand", role: "primary", match: "exact", name: "Juniper Cola" }],
    mnemonic: "JUNIPER COLA VS <B>",
    lens: "Investment lens · the name matched exactly · vs US baseline",
  },
  estimate: { networkCalls: 12, cachedCalls: 1, seconds: 45, quotaShare: 0.0063 },
};

/** Where to open, with no city: "RAMEN COUNTER SITE <CITY>". */
export const FIXTURE_PREVIEW_NO_CITY: PreviewResponse = {
  ...FIXTURE_PREVIEW,
  understood: {
    pillar: "location",
    job: "site_selection",
    jobLabel: "Where to open",
    mnemonic: "RAMEN COUNTER SITE <CITY>",
    mentions: [],
    metros: [],
    scope: "Neighbourhoods in 13 US cities",
    lens: "Location lens · vs the city",
  },
  estimate: { networkCalls: 8, cachedCalls: 0, seconds: 40, quotaShare: 0.0042 },
};

export const FIXTURE_REFUSAL: PreviewResponse = {
  token: `pv_${"1e".repeat(16)}`,
  expiresAt: "2026-07-06T12:10:00.000Z",
  understood: {
    pillar: "location",
    job: "area_profile",
    jobLabel: "Read a neighbourhood",
    mnemonic: "<AREA>, <CITY> DNA",
    mentions: [],
    metros: [],
    scope: "A neighbourhood in one of 13 US cities",
    lens: "Location lens · vs the city",
  },
  refusal: {
    category: "political_targeting",
    reason: "Culture Terminal does not answer this kind of question (political targeting).",
    reframe: "What is the group-level taste profile of the Riverside district for a new café?",
  },
  alreadyHave: null,
  estimate: { networkCalls: 0, cachedCalls: 0, seconds: 0, quotaShare: 0 },
  mode: "live",
  modeNote: null,
};

export const FIXTURE_PARENT: AskParent = { runId: "run-fixture-c3d4", question: "Who really competes with Juniper Cola?", blocked: null };


/** A paused lane that says when it reopens (GET /api/access, replay only). */
export const FIXTURE_PAUSE: AccessPause = { until: "2026-07-06T20:00:00.000Z", message: FIXTURE_PAUSED_MESSAGE };

const at = FIXTURE_AT;
const idle: AskState["run"] = { kind: "idle" };

/** One state of the question box for the gallery: the text in the box and the state behind it. */
export interface AskGalleryEntry {
  name: string;
  draft: string;
  state: AskState;
  pause?: AccessPause;
  parent?: AskParent;
  /** Draw the focused look (the gallery has no focus). */
  focus?: boolean;
}

const REFUSED_QUESTION = "Which Riverside voters should a campaign target?";

/** Every state of the box the gallery shows (N01, N02, N16 1-3), from invented previews. */
export const ASK_GALLERY: readonly AskGalleryEntry[] = [
  { name: "Idle", draft: "", state: { phase: { kind: "idle" }, run: idle } },
  { name: "Typing", draft: "Juniper Cola", state: { phase: { kind: "idle" }, run: idle }, focus: true },
  { name: "Loading", draft: FIXTURE_QUESTION, state: { phase: { kind: "loading", question: FIXTURE_QUESTION }, run: idle } },
  {
    name: "Starting the run",
    draft: FIXTURE_QUESTION,
    state: { phase: { kind: "ready", question: FIXTURE_QUESTION, preview: FIXTURE_PREVIEW, at }, run: { kind: "starting", message: null } },
  },
  { name: "Paused, with the reopen time", draft: FIXTURE_QUESTION, state: { phase: { kind: "idle" }, run: idle }, pause: FIXTURE_PAUSE },
  {
    name: "Paused by the preview (503), no reopen time",
    draft: FIXTURE_QUESTION,
    state: { phase: { kind: "paused", question: FIXTURE_QUESTION, message: FIXTURE_PAUSED_MESSAGE, alreadyHave: null, at }, run: idle },
  },
  {
    name: "Refused, with a reframe",
    draft: REFUSED_QUESTION,
    state: { phase: { kind: "ready", question: REFUSED_QUESTION, preview: FIXTURE_REFUSAL, at }, run: idle },
  },
  {
    name: "Needs input: a second brand",
    draft: "Juniper Cola: who wins?",
    state: { phase: { kind: "ready", question: "Juniper Cola: who wins?", preview: FIXTURE_PREVIEW_ONE_NAME, at }, run: idle },
    focus: true,
  },
  {
    name: "Needs input: a name not found",
    draft: "Juniper Cola vs Brand Betta",
    state: { phase: { kind: "ready", question: "Juniper Cola vs Brand Betta", preview: FIXTURE_PREVIEW_UNMATCHED, at }, run: idle },
    focus: true,
  },
  {
    name: "Needs input: a city",
    draft: "Where to open a ramen counter?",
    state: { phase: { kind: "ready", question: "Where to open a ramen counter?", preview: FIXTURE_PREVIEW_NO_CITY, at }, run: idle },
    focus: true,
  },
  {
    name: "Error, with Try again",
    draft: FIXTURE_QUESTION,
    state: {
      phase: { kind: "error", question: FIXTURE_QUESTION, message: "The question could not be sent: the connection failed.", retry: true },
      run: idle,
    },
  },
  {
    name: "The run did not start",
    draft: FIXTURE_QUESTION,
    state: {
      phase: { kind: "ready", question: FIXTURE_QUESTION, preview: FIXTURE_PREVIEW, at },
      run: { kind: "failed", message: "You have started a lot of answers this hour. Try again in a few minutes." },
    },
  },
  { name: "Follow-up", draft: "", state: { phase: { kind: "idle" }, run: idle }, parent: FIXTURE_PARENT },
];
