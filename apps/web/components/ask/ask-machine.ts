import { ConfidenceBand, EntityType, Job, MatchClass, MentionRole, METRO_LABEL, Pillar, SafetyCategory, Signal } from "@ct/contracts";
import { z } from "zod";
// Types only: erased from the browser bundle, and they keep the schema below in step with the server.
import type { AlreadyHave, PreviewResponse } from "../../server/preview";

export type { AlreadyHave, PreviewResponse };

/**
 * The Ask page (A02) as a state machine, pure so it is tested without a browser. A question is
 * previewed (POST /api/preview: "Understood as", "You already have", the estimate), then run with the
 * preview's token (POST /api/runs), which lets the run skip reading the question again.
 *
 *   idle ─preview→ loading ─previewed→ ready | paused (503) | limited (429) | error
 *   ready (no refusal) and limited can run: run → starting (runRetrying keeps the server's word while
 *   it waits) → failed (or the page navigates away)
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

/** What the composing panel shows for the question last previewed. */
export type AskPhase =
  | { kind: "idle" }
  | { kind: "loading"; question: string }
  | { kind: "ready"; question: string; preview: PreviewResponse; at: number }
  | { kind: "paused"; question: string; message: string; alreadyHave: AlreadyHave | null; at: number }
  | { kind: "limited"; question: string; message: string; retryAfterS: number | null; alreadyHave: AlreadyHave | null; at: number }
  | { kind: "error"; question: string; message: string; retry: boolean };

/** Starting the brief; `message` is the server's word while the start waits and retries by itself. */
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
  | { type: "runFailed"; message: string }
  | { type: "runStarted" };

export const INITIAL_ASK_STATE: AskState = { phase: { kind: "idle" }, run: { kind: "idle" } };

const NO_RUN: RunPhase = { kind: "idle" };

/** The question the panel describes, or null when idle. */
export function phaseQuestion(phase: AskPhase): string | null {
  return phase.kind === "idle" ? null : phase.question;
}

/**
 * True when "Run brief" may start a run: a complete reading that is not refused (readingGap), or a
 * capped preview.
 */
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

/** The recent brief that already answers the question, whatever the phase found. */
export function alreadyHaveOfPhase(phase: AskPhase): AlreadyHave | null {
  switch (phase.kind) {
    case "ready":
      return phase.preview.alreadyHave;
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
    case "runStarted":
      // The page navigates to the run; the panel keeps showing "Starting…" until it does.
      return state;
  }
}

export interface RunRequestBody {
  question: string;
  previewToken?: string;
  parentRunId?: string;
  /** Run it live although the panel showed the brief that already answers it ("Re-run live", D26). */
  fresh?: true;
}

/**
 * The POST /api/runs body for the question the panel describes: with the preview's token, so the run
 * reuses that reading, and with the parent of a follow-up. When the panel showed "You already have",
 * Run brief is the choice to run it again, so the body asks for a fresh run; otherwise the server may
 * still answer from the answer cache. Null when the state cannot run.
 */
export function runRequestBody(state: AskState, parentRunId: string | null = null): RunRequestBody | null {
  if (!canRun(state)) return null;
  const { phase } = state;
  if (phase.kind !== "ready" && phase.kind !== "limited") return null;
  const body: RunRequestBody = { question: phase.question };
  if (phase.kind === "ready" && phase.preview.token !== null) body.previewToken = phase.preview.token;
  if (parentRunId) body.parentRunId = parentRunId;
  if (alreadyHaveOfPhase(phase) !== null) body.fresh = true;
  return body;
}

// What the panel prints -----------------------------------------------------------------------------

/** "≈20 data requests · ~45 s": every request the run is expected to make, cached ones included. */
export function estimateLine(estimate: PreviewResponse["estimate"]): string {
  const requests = estimate.networkCalls + estimate.cachedCalls;
  const time = estimate.seconds > 0 ? ` · ~${estimate.seconds} s` : "";
  if (requests === 0) return `No data requests${time}`;
  return `≈${requests} data ${requests === 1 ? "request" : "requests"}${time}`;
}

/** "≈9 served from cache · priors written before any data". */
export function cacheLine(estimate: PreviewResponse["estimate"]): string {
  return `≈${estimate.cachedCalls} served from cache · priors written before any data`;
}

/** "≈1% of today's quota": the fresh requests against the day's quota. */
export function quotaText(share: number): string {
  if (!(share > 0)) return "None of today's quota";
  const percent = share * 100;
  if (percent < 1) return "<1% of today's quota";
  return `≈${Math.round(percent)}% of today's quota`;
}

/**
 * A server message as a heading and its detail: the first sentence, without its full stop, and the
 * rest ("Today's budget for live analysis is used up" · "Live runs resume at 00:00 UTC."), so the panel
 * never says the same thing twice.
 */
export function messageParts(message: string): { head: string; rest: string | null } {
  const text = message.trim();
  const end = /[.!?](\s+|$)/.exec(text);
  if (end === null) return { head: text, rest: null };
  const head = text.slice(0, end.index + (text[end.index] === "." ? 0 : 1));
  const rest = text.slice(end.index + end[0].length).trim();
  return { head, rest: rest === "" ? null : rest };
}

/** "under a minute", "about 15 min", "about 2 h": how long until a capped preview may ask again. */
export function waitText(seconds: number): string {
  if (seconds < 60) return "under a minute";
  if (seconds < 3600) return `about ${Math.ceil(seconds / 60)} min`;
  return `about ${Math.round(seconds / 3600)} h`;
}

/** "just now", "12 min ago", "2h ago", "3 days ago": how old a brief is. */
export function ageText(iso: string, now: number): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";
  const minutes = Math.floor(Math.max(0, now - at) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

type Understood = NonNullable<PreviewResponse["understood"]>;

/** "Olipop, Poppi": Qloo's names where they matched exactly, else as written. */
export function subjectsText(understood: Understood): string {
  return understood.mentions.map((m) => m.name ?? m.text).join(", ");
}

type Mention = Understood["mentions"][number];

/** The question's subject: the primary mention, else the first. */
const subjectOf = (understood: Understood): Mention | undefined =>
  understood.mentions.find((m) => m.role === "primary") ?? understood.mentions[0];

/**
 * Whether a run can use a name: an exact match, or one not looked up (Qloo off). The run's gate asks
 * which entity the subject means, but leaves out any other name without an exact match.
 */
const usable = (m: Mention, subject: Mention | undefined): boolean => m === subject || m.match === null || m.match === "exact";

/**
 * Names that did not match exactly, e.g. "Brand Gamma (brand): no exact match". The subject's is
 * picked when the brief runs; any other is left out of it.
 */
export function matchProblems(understood: Understood): string[] {
  const label: Record<MatchClass, string> = {
    exact: "matched exactly",
    ambiguous: "more than one match",
    inexact: "no exact match",
    not_found: "not found in Qloo",
  };
  const subject = subjectOf(understood);
  return understood.mentions
    .filter((m) => m.match !== null && m.match !== "exact")
    .map((m) => {
      const next = m !== subject ? ", left out" : m.match === "ambiguous" ? ", you will pick one" : "";
      return `${m.text} (${m.type.replace(/_/g, " ")}): ${label[m.match as MatchClass]}${next}`;
    });
}

/** What a reading still lacks before a brief can run on it. */
export interface ReadingGap {
  /** "A second brand to compare with Juniper Cola". */
  need: string;
  /** How to add it. */
  hint: string;
}

/** The placeholders compileMnemonic prints for a part the reading lacks; a type such as <BRAND> is none. */
const MNEMONIC_GAP = /<(?:NAME|A|B|AREA|CITY|CONCEPT)>/;

/** What the named jobs need when the question names no one ("<NAME> HLTH"). */
const NAME_NEED: Readonly<Record<Exclude<Job, "head_to_head" | "site_selection" | "area_profile" | "tenant_mix">, string>> = {
  brand_health: "A brand to read",
  sponsorship: "An artist to find sponsors for",
  market_selection: "A brand or artist to launch or tour",
  audience_discovery: "A brand, artist or show whose audience to read",
};

const ADD_IT = "Name it in the question and press ↵ to read it again.";
const ADD_THEM = "Name them in the question and press ↵ to read it again.";
/** "Nashville or Austin": the cities a place question can name. */
const METROS = Object.values(METRO_LABEL).join(" or ");

/**
 * What the reading lacks before a brief can run, or null when it is complete: a head-to-head with
 * fewer than two usable brands, or a reading whose compiled command still holds a placeholder (no
 * name, neighbourhood, city or concept). The panel says this instead of the command and the estimate,
 * and offers no Run brief until the question is read again.
 */
export function readingGap(understood: Understood): ReadingGap | null {
  const has = (part: string) => understood.mnemonic.includes(`<${part}>`);
  switch (understood.job) {
    case "head_to_head": {
      const subject = subjectOf(understood);
      const peers = understood.mentions.filter((m) => m !== subject && m.role === "peer");
      if (subject !== undefined && peers.some((m) => usable(m, subject))) return null;
      if (subject === undefined) return { need: "Two brands to compare", hint: ADD_THEM };
      const name = subject.name ?? subject.text;
      const missed = peers[0];
      const other = understood.mentions.find((m) => m !== subject && m.type === "brand");
      const hint = missed
        ? `Check the spelling of ${missed.text}, or name another brand, then press ↵.`
        : other
          ? `Ask it as “${subject.text} vs ${other.text}” and press ↵.`
          : ADD_IT;
      return { need: `A second brand to compare with ${name}`, hint };
    }
    case "site_selection": {
      const concept = has("CONCEPT");
      const city = has("CITY");
      if (concept && city) return { need: `A concept to open and a city, ${METROS}`, hint: ADD_THEM };
      if (concept) return { need: "A concept to open, such as a listening bar", hint: ADD_IT };
      return city ? { need: `A city, ${METROS}`, hint: ADD_IT } : null;
    }
    case "area_profile":
    case "tenant_mix": {
      const area = has("AREA");
      const city = has("CITY");
      if (area && city) return { need: `A neighbourhood and its city, ${METROS}`, hint: ADD_THEM };
      if (area) return { need: understood.metros[0] ? `A neighbourhood in ${understood.metros[0]}` : "A neighbourhood", hint: ADD_IT };
      return city ? { need: `The neighbourhood's city, ${METROS}`, hint: ADD_IT } : null;
    }
    default:
      return has("NAME") ? { need: NAME_NEED[understood.job], hint: ADD_IT } : null;
  }
}

/** The command a reading compiles to, for "Compiled to": none while the reading lacks a part. */
export function compiledMnemonic(understood: Understood): string | null {
  return MNEMONIC_GAP.test(understood.mnemonic) || readingGap(understood) !== null ? null : understood.mnemonic;
}
