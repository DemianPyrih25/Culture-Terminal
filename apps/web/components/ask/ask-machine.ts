import { ConfidenceBand, EntityType, Job, MatchClass, MentionRole, Pillar, SafetyCategory, Signal } from "@ct/contracts";
import { z } from "zod";
import { MAP_CITIES, wordList } from "../../lib/answer/copy";
// Types only: erased from the browser bundle, and they keep the schema below in step with the server.
import type { AlreadyHave, PreviewResponse } from "../../server/preview";

export type { AlreadyHave, PreviewResponse };

/**
 * The question box on Home (and /ask) as a state machine, pure so it is tested without a browser.
 * "Get answer" previews the question (POST /api/preview), then, with no confirm step, opens the answer
 * the visitor already has, starts the run with the preview's token (POST /api/runs), or shows one
 * inline state under the box: paused, refused, needs input or an error.
 *
 *   idle ─preview→ loading ─previewed→ ready | paused (503) | limited (429) | error
 *   ready (no refusal, nothing missing) and limited run: run → starting (runRetrying keeps the
 *   server's word while it waits) → failed (or the page moves to the run)
 */

// The preview answer, as the browser reads it ---------------------------------------------------------

const AlreadyHaveSchema = z.object({
  runId: z.string(),
  question: z.string(),
  createdAt: z.string(),
  signal: Signal.nullable(),
  confidence: z.object({ score: z.number(), band: ConfidenceBand }).nullable(),
}) satisfies z.ZodType<AlreadyHave>;

const PreviewSchema = z.object({
  token: z.string().nullable(),
  expiresAt: z.string(),
  understood: z
    .object({
      pillar: Pillar,
      job: Job,
      jobLabel: z.string(),
      mnemonic: z.string(),
      mentions: z.array(
        z.object({
          text: z.string(),
          type: EntityType,
          role: MentionRole,
          match: MatchClass.nullable(),
          name: z.string().nullable(),
        }),
      ),
      metros: z.array(z.string()),
      scope: z.string(),
      lens: z.string(),
    })
    .nullable(),
  refusal: z
    .object({ category: SafetyCategory.nullable(), reason: z.string(), reframe: z.string().nullable() })
    .optional(),
  alreadyHave: AlreadyHaveSchema.nullable(),
  estimate: z.object({
    networkCalls: z.number(),
    cachedCalls: z.number(),
    seconds: z.number(),
    quotaShare: z.number(),
  }),
  // A server from before the economy breaker sends neither: live, no note.
  mode: z.enum(["live", "economy"]).default("live"),
  modeNote: z.string().nullable().default(null),
}) satisfies z.ZodType<PreviewResponse, unknown>;

/** How a preview request ended. */
export type PreviewOutcome =
  | { kind: "ok"; preview: PreviewResponse }
  /** 503 without retry: live analysis is paused, unconfigured or out of today's budget. */
  | { kind: "paused"; message: string; alreadyHave: AlreadyHave | null }
  /** 429: previews are capped for a while; a run may still go ahead, without a token. */
  | { kind: "limited"; message: string; retryAfterS: number | null; alreadyHave: AlreadyHave | null }
  /** Anything else: the network, a 5xx that may pass, a bad request. */
  | { kind: "error"; message: string; retry: boolean };

const NETWORK_ERROR = "The question could not be sent: the connection failed.";
const UNREADABLE = "The answer could not be read. Try again.";

function stringField(body: unknown, key: string): string | null {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>)[key] : undefined;
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function alreadyHaveOf(body: unknown): AlreadyHave | null {
  const value = typeof body === "object" && body !== null ? (body as Record<string, unknown>).alreadyHave : null;
  const parsed = AlreadyHaveSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * A preview response as an outcome: `status` null when the request never got an answer. The body is
 * whatever JSON came back (null when none), validated here, never trusted.
 */
export function readPreviewResponse(status: number | null, body: unknown, retryAfter: string | null = null): PreviewOutcome {
  if (status === null) return { kind: "error", message: NETWORK_ERROR, retry: true };
  const message = stringField(body, "error");
  const retry = typeof body === "object" && body !== null && (body as { retry?: unknown }).retry === true;
  if (status === 200) {
    const parsed = PreviewSchema.safeParse(body);
    return parsed.success ? { kind: "ok", preview: parsed.data } : { kind: "error", message: UNREADABLE, retry: true };
  }
  if (status === 429) {
    const seconds = retryAfter === null ? NaN : Number(retryAfter);
    return {
      kind: "limited",
      message: message ?? "Question previews are paused for a while.",
      retryAfterS: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null,
      alreadyHave: alreadyHaveOf(body),
    };
  }
  if (status === 503 && !retry) {
    return { kind: "paused", message: message ?? "Live analysis is paused.", alreadyHave: alreadyHaveOf(body) };
  }
  if (status >= 500) return { kind: "error", message: message ?? "Something went wrong. Try again.", retry: true };
  return { kind: "error", message: message ?? "The question could not be read.", retry: false };
}

// The machine ---------------------------------------------------------------------------------------

/** What the box knows about the question last sent. */
export type AskPhase =
  | { kind: "idle" }
  | { kind: "loading"; question: string }
  | { kind: "ready"; question: string; preview: PreviewResponse; at: number }
  | { kind: "paused"; question: string; message: string; alreadyHave: AlreadyHave | null; at: number }
  | { kind: "limited"; question: string; message: string; retryAfterS: number | null; alreadyHave: AlreadyHave | null; at: number }
  | { kind: "error"; question: string; message: string; retry: boolean };

/** Starting the run; `message` is the server's word while the start waits and retries by itself. */
export type RunPhase = { kind: "idle" } | { kind: "starting"; message: string | null } | { kind: "failed"; message: string };

export interface AskState {
  phase: AskPhase;
  run: RunPhase;
}

export type AskEvent =
  | { type: "preview"; question: string }
  | { type: "previewed"; question: string; outcome: PreviewOutcome; at: number }
  | { type: "clear" }
  | { type: "run" }
  | { type: "runRetrying"; message: string }
  | { type: "runFailed"; message: string };

export const INITIAL_ASK_STATE: AskState = { phase: { kind: "idle" }, run: { kind: "idle" } };

const NO_RUN: RunPhase = { kind: "idle" };

/** The question the box last sent, or null when idle. */
export function phaseQuestion(phase: AskPhase): string | null {
  return phase.kind === "idle" ? null : phase.question;
}

/** True while the box waits: the preview is out, or the run is starting. */
export function isBusy(state: AskState): boolean {
  return state.phase.kind === "loading" || state.run.kind === "starting";
}

/** True when a run may start: a complete reading that is not refused (readingGap), or a capped preview. */
export function canRun(state: AskState): boolean {
  if (state.run.kind === "starting") return false;
  const { phase } = state;
  if (phase.kind === "limited") return true;
  return (
    phase.kind === "ready" &&
    phase.preview.refusal === undefined &&
    phase.preview.understood !== null &&
    readingGap(phase.preview.understood) === null
  );
}

/** The recent answer that already answers the question, whatever the phase found; none for a refusal. */
export function alreadyHaveOfPhase(phase: AskPhase): AlreadyHave | null {
  switch (phase.kind) {
    case "ready":
      return phase.preview.refusal === undefined ? phase.preview.alreadyHave : null;
    case "paused":
    case "limited":
      return phase.alreadyHave;
    default:
      return null;
  }
}

export function askReducer(state: AskState, event: AskEvent): AskState {
  switch (event.type) {
    case "preview":
      return { phase: { kind: "loading", question: event.question }, run: NO_RUN };
    case "previewed": {
      // A late answer for a question no longer being read is dropped.
      if (state.phase.kind !== "loading" || state.phase.question !== event.question) return state;
      const { question, outcome, at } = event;
      switch (outcome.kind) {
        case "ok":
          return { phase: { kind: "ready", question, preview: outcome.preview, at }, run: NO_RUN };
        case "paused":
          return { phase: { kind: "paused", question, message: outcome.message, alreadyHave: outcome.alreadyHave, at }, run: NO_RUN };
        case "limited":
          return {
            phase: { kind: "limited", question, message: outcome.message, retryAfterS: outcome.retryAfterS, alreadyHave: outcome.alreadyHave, at },
            run: NO_RUN,
          };
        case "error":
          return { phase: { kind: "error", question, message: outcome.message, retry: outcome.retry }, run: NO_RUN };
      }
      return state;
    }
    case "clear":
      return INITIAL_ASK_STATE;
    case "run":
      return canRun(state) ? { ...state, run: { kind: "starting", message: null } } : state;
    case "runRetrying":
      return state.run.kind === "starting" ? { ...state, run: { kind: "starting", message: event.message } } : state;
    case "runFailed":
      return state.run.kind === "starting" ? { ...state, run: { kind: "failed", message: event.message } } : state;
  }
}

/**
 * What follows a preview, with no confirm step: open the answer the visitor already has, start the run,
 * or stay and show the inline state.
 */
export type AskStep = { kind: "open"; runId: string } | { kind: "run" } | { kind: "show" };

export function nextStep(state: AskState): AskStep {
  const have = alreadyHaveOfPhase(state.phase);
  if (have !== null) return { kind: "open", runId: have.runId };
  return canRun(state) ? { kind: "run" } : { kind: "show" };
}

export interface RunRequestBody {
  question: string;
  previewToken?: string;
  parentRunId?: string;
}

/**
 * The POST /api/runs body for the question previewed: with the preview's token, so the run reuses that
 * reading, and with the parent of a follow-up. Null when the state cannot run.
 */
export function runRequestBody(state: AskState, parentRunId: string | null = null): RunRequestBody | null {
  if (!canRun(state)) return null;
  const { phase } = state;
  if (phase.kind !== "ready" && phase.kind !== "limited") return null;
  const body: RunRequestBody = { question: phase.question };
  if (phase.kind === "ready" && phase.preview.token !== null) body.previewToken = phase.preview.token;
  if (parentRunId) body.parentRunId = parentRunId;
  return body;
}

// What the box says -------------------------------------------------------------------------------

type Understood = NonNullable<PreviewResponse["understood"]>;
type Mention = Understood["mentions"][number];

/** The question's subject: the primary mention, else the first. */
const subjectOf = (understood: Understood): Mention | undefined =>
  understood.mentions.find((m) => m.role === "primary") ?? understood.mentions[0];

/**
 * Whether a run can use a name: an exact match, or one not looked up (Qloo off). The run's gate asks
 * which entity the subject means, but leaves out any other name without an exact match.
 */
const usable = (m: Mention, subject: Mention | undefined): boolean => m === subject || m.match === null || m.match === "exact";

/** What a reading still lacks before a run can start on it. */
export interface ReadingGap {
  /** "A second brand to compare with Juniper Cola". */
  need: string;
  /** The one sentence the box shows: "Add a second brand to compare with Juniper Cola." */
  text: string;
}

type NamedJob = Exclude<Job, "head_to_head" | "site_selection" | "area_profile" | "tenant_mix" | "taste_twins" | "launch_test" | "city_compare">;

/** What the named jobs need when the question names no one. */
const NAME_NEED: Readonly<Record<NamedJob, ReadingGap>> = {
  brand_health: { need: "A brand to read", text: "Add the brand you want to know about." },
  sponsorship: { need: "An artist to find sponsors for", text: "Add the artist you want to find sponsors for." },
  market_selection: { need: "A brand or artist to launch or tour", text: "Add the brand or artist you want to launch or tour." },
  audience_discovery: {
    need: "A brand, artist or show whose audience to read",
    text: "Add the brand, artist or show whose audience you want to know.",
  },
  brand_collab: { need: "A brand to find collaboration partners for", text: "Add the brand you want to find collaboration partners for." },
  creator_fit: { need: "A brand whose audience the creators should fit", text: "Add the brand whose audience the creators should fit." },
};

/** "Atlanta, Austin, … or Seattle": the 13 map cities a place question can name. */
const METROS = wordList(MAP_CITIES, "or");
/** "one of the 13 cities we map": the short form for a need's label. */
const MAPPED = `one of the ${MAP_CITIES.length} cities we map`;

/**
 * What the reading lacks before a run can start, or null when it is complete: a head-to-head with fewer
 * than two usable brands, or a reading whose command still holds a placeholder (no name,
 * neighbourhood, city or concept). The box shows the sentence instead of starting the run.
 */
export function readingGap(understood: Understood): ReadingGap | null {
  const has = (part: string) => understood.mnemonic.includes(`<${part}>`);
  switch (understood.job) {
    case "head_to_head": {
      const subject = subjectOf(understood);
      const peers = understood.mentions.filter((m) => m !== subject && m.role === "peer");
      if (subject !== undefined && peers.some((m) => usable(m, subject))) return null;
      if (subject === undefined) return { need: "Two brands to compare", text: "Add the two brands you want to compare." };
      const name = subject.name ?? subject.text;
      const need = `A second brand to compare with ${name}`;
      const missed = peers[0];
      if (missed) return { need, text: `We couldn't find "${missed.text}". Check the spelling, or name another brand to compare.` };
      const other = understood.mentions.find((m) => m !== subject && m.type === "brand");
      return other
        ? { need, text: `Ask it as "${subject.text} vs ${other.text}" to compare the two.` }
        : { need, text: `Add a second brand to compare with ${name}.` };
    }
    case "site_selection": {
      const concept = has("CONCEPT");
      const city = has("CITY");
      if (concept && city) return { need: `A concept to open and ${MAPPED}`, text: `Add what you want to open, and the city: ${METROS}.` };
      if (concept) return { need: "A concept to open", text: "Add what you want to open." };
      return city ? { need: `A city, ${MAPPED}`, text: `Add the city: ${METROS}.` } : null;
    }
    case "area_profile":
    case "tenant_mix": {
      const area = has("AREA");
      const city = has("CITY");
      if (area && city) return { need: `A neighbourhood and its city, ${MAPPED}`, text: `Add a neighbourhood and its city: ${METROS}.` };
      if (area) {
        const metro = understood.metros[0];
        return metro
          ? { need: `A neighbourhood in ${metro}`, text: `Add a neighbourhood in ${metro}.` }
          : { need: "A neighbourhood", text: "Add the neighbourhood you mean." };
      }
      return city ? { need: `The neighbourhood's city, ${MAPPED}`, text: `Add the neighbourhood's city: ${METROS}.` } : null;
    }
    case "taste_twins": {
      // "<AREA>, <CITY> TWIN <CITY>": the source area and its city, then the city to look in.
      const area = has("AREA");
      const source = understood.mnemonic.includes(", <CITY> ");
      const target = /TWIN <CITY>$/.test(understood.mnemonic.trim());
      if ((area || source) && target) {
        return {
          need: `An area, its city and a city to look in, ${MAPPED}`,
          text: `Add the neighbourhood you want to match, its city and the city to look for its twin in: ${METROS}.`,
        };
      }
      if (area || source) {
        return {
          need: `The area to match and its city, ${MAPPED}`,
          text: `Add the neighbourhood you want to match and its city: ${METROS}.`,
        };
      }
      return target ? { need: `The city to look in, ${MAPPED}`, text: `Add the city to look for its twin in: ${METROS}.` } : null;
    }
    case "city_compare":
      return has("CITY") ? { need: "Two to four US cities to compare", text: "Add the two to four US cities you want to compare." } : null;
    case "launch_test":
      return has("CONCEPT") ? { need: "The product or concept to test", text: "Add the product or concept you want to test, in a few words." } : null;
    default:
      return has("NAME") ? NAME_NEED[understood.job] : null;
  }
}

/** The refusal sentence per category; the box adds "Try this instead:" when there is a reframe. */
export const REFUSAL_TEXT: Readonly<Record<SafetyCategory, string>> = {
  private_individual: "We don't answer questions about private people.",
  sensitive_inference: "We don't answer questions that guess sensitive traits.",
  political_targeting: "We don't answer political targeting questions.",
  eligibility: "We don't answer eligibility questions.",
  residential_screening: "We don't answer tenant or resident screening questions.",
  injection: "We can't follow instructions written into a question.",
  financial_advice: "We don't give investment advice.",
  out_of_scope: "That's outside what taste data can answer.",
};

/** "We don't answer political targeting questions. Try this instead:", or the sentence alone. */
export function refusalText(category: SafetyCategory | null, hasReframe: boolean): string {
  const sentence = category ? REFUSAL_TEXT[category] : "We can't answer that question as asked.";
  return hasReframe ? `${sentence} Try this instead:` : sentence;
}

/** "8:00 pm" in the visitor's time zone (or `timeZone`); null when `iso` is not a time. */
export function reopenTime(iso: string | null | undefined, timeZone?: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("hour")}:${part("minute")} ${part("dayPeriod").toLowerCase()}`;
}

/** What the paused and limited states add: earlier answers never need the live service. */
export const STILL_OPEN = "Answers you already have still open.";

/**
 * The paused sentence: "New questions reopen at 8:00 pm your time." when the server says when, else its
 * own message; then that earlier answers still open.
 */
export function pausedText(until: string | null | undefined, message: string | null | undefined, timeZone?: string): string {
  const time = reopenTime(until, timeZone);
  if (time !== null) return `New questions reopen at ${time} your time. ${STILL_OPEN}`;
  const said = (message ?? "").trim();
  const head = said === "" ? "New questions are paused for now." : /[.!?]$/.test(said) ? said : `${said}.`;
  return `${head} ${STILL_OPEN}`;
}

/** "under a minute", "about 15 min", "about 2 h": how long until a capped preview may ask again. */
export function waitText(seconds: number): string {
  if (seconds < 60) return "under a minute";
  if (seconds < 3600) return `about ${Math.ceil(seconds / 60)} min`;
  return `about ${Math.round(seconds / 3600)} h`;
}

/** The one inline state under the box (N16), or null when there is nothing to say. */
export type AskNotice =
  | { kind: "paused"; text: string }
  | { kind: "refused"; text: string; reframe: string | null }
  | { kind: "needs_input"; text: string }
  | { kind: "limited"; text: string }
  | { kind: "error"; text: string; retry: boolean }
  | { kind: "run_failed"; text: string };

/** Live questions paused for this visitor before anything was sent (GET /api/access, replay only). */
export interface AccessPause {
  until: string | null;
  message: string | null;
}

/**
 * What the box shows under it. `pause` is the access's replay-only mode, which disables the box before
 * anything is sent; a preview that answers 503 says the same.
 */
export function askNotice(state: AskState, pause: AccessPause | null = null, timeZone?: string): AskNotice | null {
  const { phase, run } = state;
  if (run.kind === "failed") return { kind: "run_failed", text: run.message };
  if (run.kind === "starting" || phase.kind === "loading") return null;
  if (phase.kind === "paused") return { kind: "paused", text: pausedText(pause?.until, pause?.message ?? phase.message, timeZone) };
  if (pause !== null) return { kind: "paused", text: pausedText(pause.until, pause.message, timeZone) };
  switch (phase.kind) {
    case "idle":
      return null;
    case "ready": {
      const { refusal, understood } = phase.preview;
      if (refusal) {
        const reframe = refusal.reframe?.trim() || null;
        return { kind: "refused", text: refusalText(refusal.category, reframe !== null), reframe };
      }
      if (understood === null) return { kind: "needs_input", text: "We couldn't read that as a question. Try asking it another way." };
      const gap = readingGap(understood);
      return gap === null ? null : { kind: "needs_input", text: gap.text };
    }
    case "limited":
      return { kind: "limited", text: `You can ask again in ${waitText(phase.retryAfterS ?? 60)}. ${STILL_OPEN}` };
    case "error":
      return { kind: "error", text: phase.message, retry: phase.retry };
  }
}

/** What the box's live region says, politely, as the question is read and the answer starts. */
export function askStatusText(state: AskState, notice: AskNotice | null, waitingForCheck = false): string {
  if (state.run.kind === "starting") return state.run.message ?? "Starting your answer…";
  if (state.phase.kind === "loading") return waitingForCheck ? "Waiting for the check below the question." : "Reading your question…";
  return notice?.text ?? "";
}
