import type { AlreadyHave, AskState, PreviewResponse } from "./ask-machine";
import type { AskParent } from "./ask-panel";

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

/** The economy breaker has tripped: the brief would run on the economy ANALYST. */
export const FIXTURE_PREVIEW_ECONOMY: PreviewResponse = {
  ...FIXTURE_PREVIEW,
  mode: "economy",
  modeNote: "Live briefs run on the economy analyst until 00:00 UTC: today's live budget is nearly used.",
};

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
    scope: "Nashville or Austin neighbourhoods",
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
    scope: "A Nashville or Austin neighbourhood",
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

/** A parent the server would refuse: its brief is still being written. */
export const FIXTURE_PARENT_RUNNING: AskParent = { ...FIXTURE_PARENT, runId: "run-fixture-e5f6", blocked: "running" };

const at = FIXTURE_AT;

/** Every state the gallery shows, with the field's text. */
export const ASK_GALLERY: ReadonlyArray<{ name: string; draft: string; state: AskState; parent?: AskParent }> = [
  { name: "Loading", draft: FIXTURE_QUESTION, state: { phase: { kind: "loading", question: FIXTURE_QUESTION }, run: { kind: "idle" } } },
  {
    name: "Loading · a mnemonic compiles at once",
    draft: "JUNIPER COLA HLTH",
    state: { phase: { kind: "loading", question: "JUNIPER COLA HLTH" }, run: { kind: "idle" } },
  },
  {
    name: "Understood",
    draft: FIXTURE_QUESTION,
    state: { phase: { kind: "ready", question: FIXTURE_QUESTION, preview: FIXTURE_PREVIEW, at }, run: { kind: "idle" } },
  },
  {
    name: "You already have",
    draft: FIXTURE_QUESTION,
    state: { phase: { kind: "ready", question: FIXTURE_QUESTION, preview: FIXTURE_PREVIEW_HAVE, at }, run: { kind: "idle" } },
  },
  {
    name: "A subject with more than one match: picked when the brief runs",
    draft: "Junipr Cola vs Brand Beta",
    state: { phase: { kind: "ready", question: "Junipr Cola vs Brand Beta", preview: FIXTURE_PREVIEW_PICK, at }, run: { kind: "idle" } },
  },
  {
    name: "Still needed: the second name has no exact match",
    draft: "Juniper Cola vs Brand Betta",
    state: { phase: { kind: "ready", question: "Juniper Cola vs Brand Betta", preview: FIXTURE_PREVIEW_UNMATCHED, at }, run: { kind: "idle" } },
  },
  {
    name: "Still needed: two brands to compare, one named",
    draft: "Is Juniper Cola winning?",
    state: { phase: { kind: "ready", question: "Is Juniper Cola winning?", preview: FIXTURE_PREVIEW_ONE_NAME, at }, run: { kind: "idle" } },
  },
  {
    name: "Still needed: where to open, no city",
    draft: "Where should a ramen counter open?",
    state: { phase: { kind: "ready", question: "Where should a ramen counter open?", preview: FIXTURE_PREVIEW_NO_CITY, at }, run: { kind: "idle" } },
  },
  {
    name: "Refusal, with a reframe",
    draft: "Which Riverside residents vote, and how?",
    state: { phase: { kind: "ready", question: "Which Riverside residents vote, and how?", preview: FIXTURE_REFUSAL, at }, run: { kind: "idle" } },
  },
  {
    name: "Economy: today's live budget is nearly used",
    draft: FIXTURE_QUESTION,
    state: { phase: { kind: "ready", question: FIXTURE_QUESTION, preview: FIXTURE_PREVIEW_ECONOMY, at }, run: { kind: "idle" } },
  },
  {
    name: "Paused by a breaker (503): showcases and replays still work",
    draft: FIXTURE_QUESTION,
    state: {
      phase: { kind: "paused", question: FIXTURE_QUESTION, message: FIXTURE_PAUSED_MESSAGE, alreadyHave: FIXTURE_HAVE, at },
      run: { kind: "idle" },
    },
  },
  {
    name: "Paused (503): live analysis off or out of budget",
    draft: FIXTURE_QUESTION,
    state: {
      phase: {
        kind: "paused",
        question: FIXTURE_QUESTION,
        message: "Today's budget for live analysis is used up. Live runs resume at 00:00 UTC.",
        alreadyHave: FIXTURE_HAVE,
        at,
      },
      run: { kind: "idle" },
    },
  },
  {
    name: "Paused (503), with no brief to open",
    draft: "Who drinks Brand Gamma?",
    state: {
      phase: {
        kind: "paused",
        question: "Who drinks Brand Gamma?",
        message: "Live analysis is unavailable: this server has no Anthropic API key.",
        alreadyHave: null,
        at,
      },
      run: { kind: "idle" },
    },
  },
  {
    name: "Previews capped (429)",
    draft: FIXTURE_QUESTION,
    state: {
      phase: {
        kind: "limited",
        question: FIXTURE_QUESTION,
        message: "Question previews are paused for a while. You can still run the brief.",
        retryAfterS: 900,
        alreadyHave: null,
        at,
      },
      run: { kind: "idle" },
    },
  },
  {
    name: "Error, with Try again",
    draft: FIXTURE_QUESTION,
    state: {
      phase: { kind: "error", question: FIXTURE_QUESTION, message: "The question could not be sent: the connection failed.", retry: true },
      run: { kind: "idle" },
    },
  },
  {
    name: "Follow-up",
    draft: "Where does Brand Beta win?",
    parent: FIXTURE_PARENT,
    state: {
      phase: {
        kind: "ready",
        question: "Where does Brand Beta win?",
        preview: {
          ...FIXTURE_PREVIEW,
          understood: {
            ...FIXTURE_PREVIEW.understood!,
            job: "market_selection",
            pillar: "marketing",
            jobLabel: "Launch & tour cities",
            mnemonic: "BRAND BETA <BRAND> MKTS",
            mentions: [{ text: "Brand Beta", type: "brand", role: "primary", match: "exact", name: "Brand Beta" }],
            scope: "US markets",
            lens: "Marketing lens · the name matched exactly · vs US baseline",
          },
          estimate: { networkCalls: 6, cachedCalls: 11, seconds: 40, quotaShare: 0.0032 },
        },
        at,
      },
      run: { kind: "idle" },
    },
  },
  {
    name: "Follow-up on a brief still being written",
    draft: "Where does Brand Beta win?",
    parent: FIXTURE_PARENT_RUNNING,
    state: { phase: { kind: "loading", question: "Where does Brand Beta win?" }, run: { kind: "idle" } },
  },
  {
    name: "Edited: a new question waits for ↵",
    draft: "BRAND BETA, AUSTIN DNA",
    state: { phase: { kind: "ready", question: FIXTURE_QUESTION, preview: FIXTURE_PREVIEW, at }, run: { kind: "idle" } },
  },
  {
    name: "Starting: the server asks to wait",
    draft: FIXTURE_QUESTION,
    state: {
      phase: { kind: "ready", question: FIXTURE_QUESTION, preview: FIXTURE_PREVIEW, at },
      run: { kind: "starting", message: "Too many runs are active. Try again shortly." },
    },
  },
  {
    name: "Run refused",
    draft: FIXTURE_QUESTION,
    state: {
      phase: { kind: "ready", question: FIXTURE_QUESTION, preview: FIXTURE_PREVIEW, at },
      run: { kind: "failed", message: "Live analysis is paused. Recorded runs are still available." },
    },
  },
];
