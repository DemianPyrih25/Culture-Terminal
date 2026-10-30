import "server-only";
import { createHash, randomBytes } from "node:crypto";
import {
  FollowCreate,
  FollowDelete,
  FollowSetLatest,
  FOLLOWS_PER_VISITOR_MAX,
  followSubjectKey,
  isVerdictTag,
  Job,
  MarketId,
  reduceRunEvents,
  Signal,
  StoredIntent,
  type Follow,
  type FollowError,
  type FollowKind,
  type Intent,
  type ResolvedMention,
  type RunStatus,
} from "@ct/contracts";
import {
  addFollow,
  getFollow,
  getRun,
  isConnectionError,
  listFollows,
  removeFollow,
  setFollowLatestRun,
  setPending,
  type AddFollowResult,
  type FollowListRow,
  type FollowRow,
  type NewFollow,
  type Queryable,
} from "@ct/db";
import { scrubString } from "@ct/qloo";
import { noteSubjects, profileSubject, sameQuestion, type NoteSubject } from "../components/following/subjects";
import { cookieHeader, getAccessService, HUMAN_CHECK_HEADER, readCookies, type HumanCheck } from "./access";
import { getDatabase } from "./container";
import { readAllEvents } from "./event-store";
import { log } from "./log";
import { TURNSTILE_TOKEN_MAX } from "./turnstile";

/**
 * Following (PLAN Part 10, §2.4, §8.1): GET, POST, PATCH and DELETE /api/follows. A follow belongs to
 * one browser, with no login (D31: private, never listed): the browser holds a random first-party
 * ct_visitor cookie, and the table keeps only a one-way hash of it as visitor_key, so neither the
 * cookie nor an address is stored. POST is behind the human check like a live run (§10.3); the
 * subject, label and re-run come from the run or the profile name, never from a key the browser sends.
 * There are no alerts and nothing is compared with an earlier note: a follow shows its latest note.
 */

export const VISITOR_COOKIE = "ct_visitor";
/** The longest a browser keeps a cookie (400 days); every visit to Following starts it again. */
export const VISITOR_TTL_S = 400 * 24 * 3600;
/** 128 random bits, base64url. */
const VISITOR_VALUE = /^[A-Za-z0-9_-]{22}$/;
/** A follow request is a run id and a kind, or a name, and a Turnstile token. */
const MAX_BODY_BYTES = 4 * 1024;
/** Statuses whose run has a note a follow can point at. */
const NOTE_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "incomplete"]);
/** A re-run stopped at the picker: the follow waits on it (pending) until the picked run has a note. */
const PICKER_STATUS: RunStatus = "needs_input";

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

function refuse(status: number, error: string, code?: FollowError["code"]): Response {
  return json(code ? ({ error, code } satisfies FollowError) : ({ error } satisfies FollowError), status);
}

function failure(err: unknown, what: string): Response {
  if (isConnectionError(err)) {
    log.warn({ err }, `${what}: database unavailable`);
    return json({ error: "Following is unavailable right now. Try again in a moment.", retry: true }, 503, { "Retry-After": "5" });
  }
  log.error({ err }, `${what} failed`);
  return json({ error: "Something went wrong." }, 500);
}

// The visitor ------------------------------------------------------------------------------------

/** The table's key for a visitor cookie: a one-way hash of 128 random bits (22 base64url characters). */
export function visitorKeyOf(value: string): string {
  return createHash("sha256").update(`ct-visitor|${value}`).digest("base64url").slice(0, 22);
}

/** The request's ct_visitor value, or null when it has none (or a malformed one). */
export function visitorCookie(request: Request): string | null {
  const value = readCookies(request.headers.get("cookie")).get(VISITOR_COOKIE);
  return value !== undefined && VISITOR_VALUE.test(value) ? value : null;
}

const mintVisitor = (): string => randomBytes(16).toString("base64url");

function withVisitor(response: Response, value: string, secure: boolean): Response {
  response.headers.append("Set-Cookie", cookieHeader(VISITOR_COOKIE, value, VISITOR_TTL_S, secure));
  return response;
}

// Storage ----------------------------------------------------------------------------------------

/** What a follow reads from a run. */
export interface FollowRunFacts {
  id: string;
  status: RunStatus;
  createdAt: Date;
  question: string;
  questionHash: string;
  job: string | null;
  intent: Intent | null;
}

/** The follows table and the runs it reads, behind one seam so the handlers are tested without a database. */
export interface FollowStore {
  list(visitorKey: string): Promise<FollowListRow[]>;
  get(visitorKey: string, id: string): Promise<FollowRow | undefined>;
  add(input: NewFollow): Promise<AddFollowResult>;
  remove(visitorKey: string, id: string): Promise<boolean>;
  setLatest(visitorKey: string, id: string, runId: string): Promise<boolean>;
  /** Marks the follow as waiting on a re-run that stopped at the picker, or clears it (null). */
  setPending(id: string, runId: string | null): Promise<boolean>;
  run(runId: string): Promise<FollowRunFacts | null>;
  /** The run's resolved mentions, from its stored events. */
  resolves(runId: string): Promise<ResolvedMention[]>;
}

export function dbFollowStore(db: Queryable): FollowStore {
  return {
    list: (visitorKey) => listFollows(db, visitorKey),
    get: (visitorKey, id) => getFollow(db, visitorKey, id),
    add: (input) => addFollow(db, input),
    remove: (visitorKey, id) => removeFollow(db, visitorKey, id),
    setLatest: (visitorKey, id, runId) => setFollowLatestRun(db, visitorKey, id, runId),
    setPending: (id, runId) => setPending(db, id, runId),
    async run(runId) {
      const run = await getRun(db, runId);
      if (!run) return null;
      const intent = StoredIntent.safeParse(run.intent);
      return {
        id: run.id,
        status: run.status,
        createdAt: run.createdAt,
        question: run.question,
        questionHash: run.questionHash,
        job: run.job,
        intent: intent.success ? intent.data : null,
      };
    },
    async resolves(runId) {
      return reduceRunEvents(runId, await readAllEvents(db, runId)).resolves;
    },
  };
}

export interface FollowDeps {
  store?: FollowStore;
  access?: { checkHuman(request: Request | undefined, token: string | null | undefined): Promise<HumanCheck> };
  secureCookies?: boolean;
  /** A new visitor cookie value (fixed in tests). */
  mintVisitor?: () => string;
}

function deps(given: FollowDeps) {
  return {
    store: () => given.store ?? dbFollowStore(getDatabase()),
    access: () => given.access ?? getAccessService(),
    secure: given.secureCookies ?? process.env.NODE_ENV === "production",
    mint: given.mintVisitor ?? mintVisitor,
  };
}

// Shapes -----------------------------------------------------------------------------------------

/** R8: the free text a follow shows never carries a Qloo entity id (a stored headline is model text). */
const noIds = (text: string): string => scrubString(text, () => null);

/** A stored follow as the API answers it; a tag that does not keep the verdict_tag rule reads as none. */
export function toFollow(row: FollowListRow): Follow {
  const job = Job.safeParse(row.job);
  const metro = MarketId.safeParse(row.metro);
  const signal = Signal.safeParse(row.latest?.signal);
  return {
    id: row.id,
    kind: row.kind,
    subjectKey: row.subjectKey,
    label: noIds(row.label),
    rerun: { question: row.question, job: job.success ? job.data : null, metro: metro.success ? metro.data : null },
    latest: row.latest
      ? {
          runId: row.latest.runId,
          status: row.latest.status,
          createdAt: row.latest.createdAt.toISOString(),
          headline: row.latest.headline === null ? null : noIds(row.latest.headline),
          tag: isVerdictTag(row.latest.tag) ? row.latest.tag : null,
          signal: signal.success ? signal.data : null,
        }
      : null,
    // A re-run waiting for the visitor's pick (FOLLOW_PENDING_LABEL with a link to that run).
    pending: row.pendingRunId ? { runId: row.pendingRunId } : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function oneFollow(store: FollowStore, visitorKey: string, id: string): Promise<Follow | null> {
  const row = (await store.list(visitorKey)).find((r) => r.id === id);
  return row ? toFollow(row) : null;
}

// Request bodies ---------------------------------------------------------------------------------

type Body = { kind: "empty" } | { kind: "json"; value: unknown } | { kind: "bad"; response: Response };

/**
 * A mutating request's body with the CSRF guards POST /api/runs uses: 403 when the browser marks it as
 * sent by another site, 413 past MAX_BODY_BYTES (never buffered past it), 415 unless JSON, 400 when it
 * does not parse.
 */
async function readBody(request: Request): Promise<Body> {
  if (request.headers.get("sec-fetch-site") === "cross-site") {
    return { kind: "bad", response: refuse(403, "Follows can only be changed from this site.") };
  }
  const tooLarge: Body = { kind: "bad", response: refuse(413, "The request body is too large.") };
  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return tooLarge;
  let text = "";
  if (request.body) {
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return tooLarge;
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  }
  if (text.trim() === "") return { kind: "empty" };
  if (!/^application\/json\s*(;|$)/i.test((request.headers.get("content-type") ?? "").trim())) {
    return { kind: "bad", response: refuse(415, "Send the request body as application/json.", "invalid") };
  }
  try {
    return { kind: "json", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "bad", response: refuse(400, "The request body is not valid JSON.", "invalid") };
  }
}

const tokenOf = (raw: unknown): string | null => {
  const token = typeof raw === "object" && raw !== null ? (raw as { turnstileToken?: unknown }).turnstileToken : null;
  return typeof token === "string" && token.length > 0 && token.length <= TURNSTILE_TOKEN_MAX ? token : null;
};

/** A failed human check, in the shape humanFetch answers (403 `{turnstile: true}` gets a new token). */
function humanRefusal(kind: Extract<HumanCheck, { ok: false }>["kind"]): Response {
  if (kind === "unavailable") {
    return json({ error: "The check that you are a person could not be completed. Try again shortly.", retry: true }, 503, { "Retry-After": "5" });
  }
  if (kind === "unconfigured") return json({ error: "Following is unavailable: the human check is not configured.", retry: false }, 503);
  const error = kind === "missing" ? "Confirm you are a person to follow this." : "The check that you are a person did not pass. Try again.";
  return json({ error, turnstile: true, retry: false }, 403);
}

function withHuman(response: Response, human: Extract<HumanCheck, { ok: true }>): Response {
  if (human.setCookie !== null) response.headers.append("Set-Cookie", human.setCookie);
  if (human.via !== "off") response.headers.set(HUMAN_CHECK_HEADER, "passed");
  return response;
}

const NO_SUBJECT: Readonly<Record<FollowKind, string>> = {
  brand: "This answer is not about one brand Qloo matched exactly, so there is no brand to follow. Follow its question instead.",
  place: "This answer is not about one map city or area, so there is no place to follow. Follow its question instead.",
  question: "This answer has no question to follow.",
};

// Handlers ---------------------------------------------------------------------------------------

/** GET /api/follows: this browser's follows, newest first, each with its latest note (FollowList). */
export async function listFollowsResponse(request: Request, given: FollowDeps = {}): Promise<Response> {
  const d = deps(given);
  const value = visitorCookie(request);
  if (value === null) return json({ follows: [], max: FOLLOWS_PER_VISITOR_MAX });
  try {
    const rows = await d.store().list(visitorKeyOf(value));
    return withVisitor(json({ follows: rows.map(toFollow), max: FOLLOWS_PER_VISITOR_MAX }), value, d.secure);
  } catch (err) {
    return failure(err, "list follows");
  }
}

/**
 * POST /api/follows (FollowCreate plus turnstileToken): follows a note's brand, place or question, or a
 * profile's brand. 201 with a new follow, 200 when the browser already followed it (refreshed); 400 on
 * a bad body, 403 without the human check, 404 for an unknown run, 422 when the run has no subject of
 * that kind, 409 at FOLLOWS_PER_VISITOR_MAX. A follow made from a finished note starts with that note,
 * unless the follow already points at a newer one.
 */
export async function createFollowResponse(request: Request, given: FollowDeps = {}): Promise<Response> {
  const d = deps(given);
  let body: Body;
  try {
    body = await readBody(request);
  } catch {
    return refuse(400, "The request body could not be read.", "invalid");
  }
  if (body.kind === "bad") return body.response;
  const raw = body.kind === "json" ? body.value : undefined;
  const parsed = FollowCreate.safeParse(raw);
  if (!parsed.success) return refuse(400, "Invalid follow request.", "invalid");
  try {
    const human = await d.access().checkHuman(request, tokenOf(raw));
    if (!human.ok) return humanRefusal(human.kind);
    const store = d.store();
    const value = visitorCookie(request) ?? d.mint();
    const visitorKey = visitorKeyOf(value);

    let subject: NoteSubject;
    let subjectKey: string;
    let run: FollowRunFacts | null = null;
    if (parsed.data.from === "profile") {
      subject = profileSubject(parsed.data.name);
      subjectKey = subject.subjectKey ?? followSubjectKey("brand", parsed.data.name);
    } else {
      const { runId, kind } = parsed.data;
      run = await store.run(runId);
      if (!run) return refuse(404, "That answer was not found.", "not_found");
      const resolves = kind === "brand" ? await store.resolves(runId) : [];
      const found = noteSubjects({ question: run.question, job: run.job, intent: run.intent, resolves }).find((s) => s.kind === kind);
      if (!found) return refuse(422, NO_SUBJECT[kind], "no_subject");
      subject = found;
      subjectKey = found.subjectKey ?? followSubjectKey("question", run.questionHash);
    }

    let latestRunId: string | null = run && NOTE_STATUSES.has(run.status) ? run.id : null;
    if (latestRunId !== null && run) {
      // Following again from an older note keeps the newer one the follow already shows.
      const existing = (await store.list(visitorKey)).find((r) => r.kind === subject.kind && r.subjectKey === subjectKey);
      if (existing?.latest && existing.latest.createdAt > run.createdAt) latestRunId = null;
    }
    const added = await store.add({
      visitorKey,
      kind: subject.kind,
      subjectKey,
      label: subject.label,
      question: subject.rerun.question,
      job: subject.rerun.job,
      metro: subject.rerun.metro,
      latestRunId,
    });
    if (!added.ok) {
      return withHuman(
        withVisitor(
          refuse(409, `You already follow ${FOLLOWS_PER_VISITOR_MAX}, the most one browser can. Unfollow one to add another.`, "limit"),
          value,
          d.secure,
        ),
        human,
      );
    }
    const follow = (await oneFollow(store, visitorKey, added.follow.id)) ?? toFollow({ ...added.follow, latest: null });
    return withHuman(withVisitor(json({ follow, created: added.created }, added.created ? 201 : 200), value, d.secure), human);
  } catch (err) {
    return failure(err, "create follow");
  }
}

/**
 * PATCH /api/follows (FollowSetLatest): points a follow at the re-run it started, once that run has a
 * note, and clears any pick it waited on. A re-run that stopped at the picker (needs_input) is stored as
 * the follow's pending run instead: the follow keeps its last note and shows "Needs your pick" with a link,
 * and when the picked run completes the run manager moves the follow to it. 404 for an unknown follow or
 * run; 422 when the run has no note and waits for no pick (still working, failed, declined: the follow keeps
 * its last note) or asks another question. Answers `{follow}`.
 */
export async function setFollowLatestResponse(request: Request, given: FollowDeps = {}): Promise<Response> {
  const d = deps(given);
  let body: Body;
  try {
    body = await readBody(request);
  } catch {
    return refuse(400, "The request body could not be read.", "invalid");
  }
  if (body.kind === "bad") return body.response;
  const parsed = FollowSetLatest.safeParse(body.kind === "json" ? body.value : undefined);
  if (!parsed.success) return refuse(400, "Invalid request.", "invalid");
  const value = visitorCookie(request);
  if (value === null) return refuse(404, "You do not follow that.", "not_found");
  try {
    const store = d.store();
    const visitorKey = visitorKeyOf(value);
    const follow = await store.get(visitorKey, parsed.data.id);
    if (!follow) return refuse(404, "You do not follow that.", "not_found");
    const run = await store.run(parsed.data.runId);
    if (!run) return refuse(404, "That run was not found.", "not_found");
    const waits = run.status === PICKER_STATUS;
    if (!waits && !NOTE_STATUSES.has(run.status)) return refuse(422, "That run has no answer, so the follow keeps its last note.", "invalid");
    if (!sameQuestion(run.question, follow.question)) return refuse(422, "That run asks a different question.", "invalid");
    if (waits) {
      if (!(await store.setPending(follow.id, run.id))) return refuse(404, "You do not follow that.", "not_found");
    } else {
      if (!(await store.setLatest(visitorKey, follow.id, run.id))) return refuse(404, "You do not follow that.", "not_found");
      // The note supersedes any pick the follow waited on.
      if (follow.pendingRunId !== null) await store.setPending(follow.id, null);
    }
    const updated = await oneFollow(store, visitorKey, follow.id);
    if (!updated) return refuse(404, "You do not follow that.", "not_found");
    return withVisitor(json({ follow: updated }), value, d.secure);
  } catch (err) {
    return failure(err, "update follow");
  }
}

/** DELETE /api/follows?id=… or JSON `{id}`: unfollows. `{removed: true}`, or 404 when this browser has no such follow. */
export async function deleteFollowResponse(request: Request, given: FollowDeps = {}): Promise<Response> {
  const d = deps(given);
  let body: Body;
  try {
    body = await readBody(request);
  } catch {
    return refuse(400, "The request body could not be read.", "invalid");
  }
  if (body.kind === "bad") return body.response;
  const fromQuery = new URL(request.url).searchParams.get("id");
  const parsed = FollowDelete.safeParse(body.kind === "json" ? body.value : { id: fromQuery ?? undefined });
  if (!parsed.success) return refuse(400, "Invalid request.", "invalid");
  const value = visitorCookie(request);
  if (value === null) return refuse(404, "You do not follow that.", "not_found");
  try {
    if (!(await d.store().remove(visitorKeyOf(value), parsed.data.id))) return refuse(404, "You do not follow that.", "not_found");
    return json({ removed: true });
  } catch (err) {
    return failure(err, "delete follow");
  }
}
