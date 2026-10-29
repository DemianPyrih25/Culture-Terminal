import "server-only";
import { Lane, Mode, QUESTION_MAX_CHARS, reduceRunEvents } from "@ct/contracts";
import { getDatasetEnvelope, getRun, isConnectionError, lastPublicSuccess, lastSeq, pingDb, requestCancel } from "@ct/db";
import type { PublicDataClient } from "@ct/publicdata";
import type { QlooClient } from "@ct/qloo";
import { z } from "zod";
import { isRunId } from "../lib/run-id";
import { getAccessService, HUMAN_CHECK_HEADER, isAdmin, type HumanCheck } from "./access";
import type { ModeDecision, ModeService } from "./breakers";
import { llmDailyUsdCapFromEnv, modeOverrideFromEnv } from "./config";
import {
  getAnswerCache,
  getAnthropic,
  getContainer,
  getDatabase,
  getMode,
  getModeService,
  getPublicDataClient,
  getQlooClient,
  getRunManager,
  getStoredMode,
  lastKnownMode,
  setMode,
} from "./container";
import { readAllEvents } from "./event-store";
import { todayLlmUsd } from "./llm-spend";
import { log } from "./log";
import { getPreviewService, PREVIEW_TOKEN } from "./preview";
import { listBriefs, parseRunListQuery } from "./run-list";
import {
  isActiveStatus,
  runManagerErrorCode,
  runManagerRetryAfterS,
  type RunManagerErrorCode,
} from "./run-manager";
import { parseCursor, sseResponse } from "./sse";
import { migrationsApplied } from "./startup";
import { runEventStream } from "./stream";
import { TURNSTILE_TOKEN_MAX } from "./turnstile";
import { appVersion } from "./version";

// Route handlers stay thin: they call these, so @ct/db is imported only under server/ (PLAN §10.1).

const NO_STORE = { "Cache-Control": "no-store" };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

const notFound = () => json({ error: "Run not found." }, 404);

function failure(err: unknown, what: string): Response {
  if (isConnectionError(err)) {
    log.warn({ err }, `${what}: database unavailable`);
    return json({ error: "We can't take new questions right now. Please try again in a moment.", retry: true }, 503, { "Retry-After": "5" });
  }
  log.error({ err }, `${what} failed`);
  return json({ error: "Something went wrong." }, 500);
}

/** Seconds until the next 00:00 UTC, when the daily LLM budget starts over. */
function secondsUntilUtcMidnight(now: number = Date.now()): number {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1, Math.ceil((next.getTime() - now) / 1000));
}

/**
 * A refusal as an HTTP answer; `retry: true` tells the client to try again by itself. `extra` adds
 * fields to the body (a preview's alreadyHave).
 */
function refusalResponse(
  code: RunManagerErrorCode,
  message: string,
  retryAfterS: number | null,
  extra: Record<string, unknown> = {},
): Response {
  switch (code) {
    case "not_accepting":
      return json({ error: message, retry: true, ...extra }, 503, { "Retry-After": "2" });
    case "busy":
      return json({ error: message, retry: true, ...extra }, 429, { "Retry-After": "10" });
    case "limited":
      // Not worth an automatic retry: the limit clears in minutes, not seconds.
      return json({ error: message, retry: false, ...extra }, 429, { "Retry-After": String(retryAfterS ?? 60) });
    case "budget":
      return json({ error: message, retry: false, ...extra }, 503, { "Retry-After": String(secondsUntilUtcMidnight()) });
    case "unavailable":
      return json({ error: message, retry: false, ...extra }, 503);
    case "invalid":
      return json({ error: message, ...extra }, 400);
  }
}

type HumanPassed = Extract<HumanCheck, { ok: true }>;

/**
 * Marks an answer, whatever it is, with a passed human check: the Set-Cookie it minted, and the
 * header that tells the browser it holds the check now (not when the check was off, and never on an
 * answer that came before the check, such as the answer cache's).
 */
function withHuman(response: Response, human: HumanPassed | null): Response {
  if (human === null) return response;
  if (human.setCookie !== null) response.headers.append("Set-Cookie", human.setCookie);
  if (human.via !== "off") response.headers.set(HUMAN_CHECK_HEADER, "passed");
  return response;
}

/**
 * A failed human check: 403 with `turnstile: true` (the browser gets a fresh token from its widget
 * and sends it once more); 503 with `retry: true` when Cloudflare could not be asked (a blip the
 * browser retries by itself, with a new token), or with `retry: false` when the check is required
 * but not configured.
 */
function humanRefusal(kind: Extract<HumanCheck, { ok: false }>["kind"]): Response {
  if (kind === "unavailable") {
    return json({ error: "The check that you are a person could not be completed. Try again shortly.", retry: true }, 503, {
      "Retry-After": "5",
    });
  }
  if (kind === "unconfigured") {
    return json({ error: "Live analysis is unavailable: the human check is not configured.", retry: false }, 503);
  }
  const error =
    kind === "missing"
      ? "Confirm you are a person to run live analysis. Answers you already have need no check."
      : "The check that you are a person did not pass. Try again.";
  return json({ error, turnstile: true, retry: false }, 403);
}

/** A RunManagerError as an HTTP answer, or null for any other error. */
function refusal(err: unknown): Response | null {
  const code = runManagerErrorCode(err);
  if (code === null) return null;
  const message = err instanceof Error ? err.message : "Try again shortly.";
  return refusalResponse(code, message, runManagerRetryAfterS(err));
}

/** Bodies are a question or a picker answer; anything bigger is not a run request. */
const MAX_BODY_BYTES = 16 * 1024;
const RUN_ID = z.string().refine(isRunId, { message: "Not a run id." });
/** packages/agent/src/run/picker.ts pickerKey: "pk_" and 16 hex digits of a one-way digest. */
const PICKER_KEY = /^pk_[0-9a-f]{16}$/;

const Question = z.string().trim().min(1).max(QUESTION_MAX_CHARS);
/** The browser's Turnstile token, single use; not needed while its ct_human cookie is valid. */
const TurnstileToken = z.string().min(1).max(TURNSTILE_TOKEN_MAX).nullish();

const AgentRunBody = z.strictObject({
  question: Question,
  parentRunId: RUN_ID.nullish(),
  /** POST /api/preview's token for this question: the run reuses that reading and skips CLERK. */
  previewToken: z.string().regex(PREVIEW_TOKEN, "Not a preview token.").nullish(),
  /** Run it live even when the answer cache has it (D26 "Re-run live"); replay-only mode still answers from the cache. */
  fresh: z.boolean().optional(),
  turnstileToken: TurnstileToken,
});
type AgentRunBody = z.infer<typeof AgentRunBody>;

/**
 * A needs_input picker answer (D20): the waiting run and the opaque key of the chosen candidate. It
 * re-asks that run's question, so it takes no question; entity ids never come from the browser.
 */
const PickBody = z.strictObject({
  pick: z.strictObject({ runId: RUN_ID, key: z.string().regex(PICKER_KEY, "Not a picker key.") }),
  turnstileToken: TurnstileToken,
});
type PickBody = z.infer<typeof PickBody>;

/** The Foundation test run: an empty body, or exactly this. */
const FakeRunBody = z.strictObject({ fake: z.literal(true) });

type StartRequest =
  | { kind: "fake" }
  | { kind: "agent"; body: AgentRunBody }
  | { kind: "pick"; body: PickBody }
  | { kind: "bad"; response: Response };

function badRequest(error: string, issues?: readonly { path: readonly PropertyKey[]; message: string }[]): Response {
  const detail = issues?.map((i) => ({ path: i.path.map(String).join("."), message: i.message }));
  return json(detail ? { error, issues: detail } : { error }, 400);
}

const tooLarge = (): JsonBody => ({ kind: "bad", response: json({ error: "The request body is too large." }, 413) });

/** The body as text, or null once it passes `limit` bytes: a body with no Content-Length is never buffered whole. */
async function readBodyWithin(request: Request, limit: number): Promise<string | null> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
}

type JsonBody = { kind: "empty" } | { kind: "json"; value: unknown } | { kind: "bad"; response: Response };

/**
 * The body of a request that spends on our behalf (a run, a preview), read with the CSRF guards:
 * 403 when a browser marks it as sent by another site, 413 past MAX_BODY_BYTES, 415 unless it is
 * JSON (which another site cannot send without a CORS preflight, which these routes never grant),
 * 400 when it does not parse. An empty body is "empty".
 */
async function readJsonBody(request: Request, crossSite: string): Promise<JsonBody> {
  if (request.headers.get("sec-fetch-site") === "cross-site") return { kind: "bad", response: json({ error: crossSite }, 403) };
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return tooLarge();
  const text = await readBodyWithin(request, MAX_BODY_BYTES);
  if (text === null) return tooLarge();
  if (text.trim() === "") return { kind: "empty" };
  const type = request.headers.get("content-type") ?? "";
  if (!/^application\/json\s*(;|$)/i.test(type.trim())) {
    return { kind: "bad", response: json({ error: "Send the request body as application/json." }, 415) };
  }
  try {
    return { kind: "json", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "bad", response: badRequest("The request body is not valid JSON.") };
  }
}

async function parseStartRequest(request: Request | undefined): Promise<StartRequest> {
  if (!request) return { kind: "fake" };
  // Browsers mark a request another site sends; runs start only from this one (CSRF).
  const read = await readJsonBody(request, "Runs can only be started from this site.");
  if (read.kind === "bad") return read;
  if (read.kind === "empty") return { kind: "fake" };
  const raw = read.value;
  if (typeof raw === "object" && raw !== null && "fake" in raw) {
    const fake = FakeRunBody.safeParse(raw);
    return fake.success ? { kind: "fake" } : { kind: "bad", response: badRequest("Invalid test run request.", fake.error.issues) };
  }
  if (typeof raw === "object" && raw !== null && "pick" in raw) {
    const pick = PickBody.safeParse(raw);
    return pick.success
      ? { kind: "pick", body: pick.data }
      : { kind: "bad", response: badRequest("Invalid picker answer.", pick.error.issues) };
  }
  const body = AgentRunBody.safeParse(raw);
  return body.success
    ? { kind: "agent", body: body.data }
    : { kind: "bad", response: badRequest("Invalid run request.", body.error.issues) };
}

/**
 * POST /api/runs. JSON `{question, parentRunId?, previewToken?, fresh?, turnstileToken?}` asks a
 * question: a completed brief for it within 72 hours (the answer cache, D26) answers at once with
 * 200 `{runId, cached: true}`, unless `fresh` asks for a live run. A follow-up (parentRunId) never
 * reads the cache: its brief must build on its parent, and no other brief does. In replay-only mode
 * the cache answers a question asked on its own, `fresh` or not; anything else is refused politely
 * (503). Otherwise an agent run starts (201) once the human check passes: a valid ct_human cookie
 * or a Turnstile token, which mints the cookie (403 `{turnstile: true}` without either). A live
 * preview token made for the same question hands the run that preview's reading and the run skips
 * CLERK, while an unknown, expired or mismatched one is ignored. `{pick: {runId, key},
 * turnstileToken?}` answers a needs_input picker with a new run, behind the same check. Runs take
 * the visitor's lane (a judge cookie, else public) and, on the public lane, count against the
 * visitor's own limits. An empty body or `{fake: true}` starts the Foundation test run, with no
 * check (tools/dev/sse-soak.ts posts nothing). 400 on a bad body, 415 on a body that is not JSON,
 * 403 from another site; 503 while the server drains, when live analysis is off or today's budget
 * is spent; 429 when the process is full or a limit is hit.
 */
export async function startRun(request?: Request): Promise<Response> {
  let parsed: StartRequest;
  try {
    parsed = await parseStartRequest(request);
  } catch (err) {
    log.warn({ err }, "could not read the start request");
    return badRequest("The request body could not be read.");
  }
  if (parsed.kind === "bad") return parsed.response;
  let passed: HumanPassed | null = null;
  try {
    const runs = getRunManager();
    const access = getAccessService();
    // The salted hash of the visitor's address (never the address), recorded on every run it starts.
    const client = access.clientKey(request);
    if (parsed.kind === "fake") return json({ runId: (await runs.startFakeRun({ client })).runId }, 201);
    const lane = access.laneOf(request);
    let started: { runId: string };
    if (parsed.kind === "pick") {
      const human = await access.checkHuman(request, parsed.body.turnstileToken);
      if (!human.ok) return humanRefusal(human.kind);
      passed = human;
      started = await runs.answerPicker({ ...parsed.body.pick, lane, client });
    } else {
      const { question, parentRunId, previewToken, fresh, turnstileToken } = parsed.body;
      const decision = await getModeService().decide(lane);
      const paused = decision.mode === "replay_only";
      if (!parentRunId && (paused || !fresh)) {
        const cached = await getAnswerCache().find(question);
        if (cached) {
          log.info({ runId: cached.runId, lane, mode: decision.mode }, "answered from the answer cache");
          return json({ runId: cached.runId, cached: true });
        }
      }
      if (paused) return refusalResponse("unavailable", decision.message ?? "Live analysis is paused.", null);
      const human = await access.checkHuman(request, turnstileToken);
      if (!human.ok) return humanRefusal(human.kind);
      passed = human;
      const intent = previewToken ? getPreviewService().intentFor(previewToken, question) : null;
      started = await runs.startAgentRun({
        question,
        lane,
        parentRunId: parentRunId ?? null,
        client,
        ...(intent ? { intent } : {}),
      });
    }
    return withHuman(json({ runId: started.runId }, 201), passed);
  } catch (err) {
    return withHuman(refusal(err) ?? failure(err, "start run"), passed);
  }
}

/** GET /api/runs/[id]/stream: Server-Sent Events from the cursor through run.end. */
export async function streamRun(request: Request, runId: string): Promise<Response> {
  if (!isRunId(runId)) return notFound();
  const { db, bus, runs } = getContainer();
  const cursor = parseCursor(request.headers.get("last-event-id"), new URL(request.url).searchParams.get("after"));
  try {
    const run = await getRun(db, runId);
    if (!run) return notFound();
    if (!isActiveStatus(run.status) && ((await lastSeq(db, runId)) ?? 0) <= cursor) {
      // The client already has run.end; 204 tells EventSource to stop reconnecting.
      return new Response(null, { status: 204, headers: NO_STORE });
    }
  } catch (err) {
    return failure(err, "open stream");
  }
  return sseResponse(
    (signal) =>
      runEventStream(
        { db, bus, isLive: (id) => runs.isLive(id), finalizeOrphan: (id) => runs.finalizeOrphan(id) },
        runId,
        cursor,
        signal,
      ),
    request.signal,
    { onError: (err) => log.error({ err, runId }, "stream failed") },
  );
}

/** GET /api/runs/[id]: the run's state rebuilt from its stored events. */
export async function runSnapshot(runId: string): Promise<Response> {
  if (!isRunId(runId)) return notFound();
  const db = getDatabase();
  try {
    const run = await getRun(db, runId);
    if (!run) return notFound();
    const state = reduceRunEvents(runId, await readAllEvents(db, runId));
    return json({
      run: {
        id: run.id,
        status: run.status,
        question: run.question,
        mode: run.mode,
        lane: run.lane,
        createdAt: run.createdAt.toISOString(),
        updatedAt: run.updatedAt.toISOString(),
        cancelRequested: run.cancelRequestedAt !== null,
        isShowcase: run.isShowcase,
      },
      state,
    });
  } catch (err) {
    return failure(err, "run snapshot");
  }
}

const DATASET_ID = /^D[1-9]\d{0,3}$/;

/**
 * GET /api/runs/[id]/datasets/[did]: a stored dataset envelope, for figures whose data was too large
 * to stream inline. 404 until the run's ledger is written; the envelope never changes after that.
 */
export async function runDataset(runId: string, datasetId: string): Promise<Response> {
  if (!isRunId(runId) || !DATASET_ID.test(datasetId)) return notFound();
  try {
    const envelope = await getDatasetEnvelope(getDatabase(), runId, datasetId);
    if (envelope === null) return json({ error: "Dataset not found." }, 404);
    return json(envelope, 200, { "Cache-Control": "private, max-age=3600" });
  } catch (err) {
    return failure(err, "run dataset");
  }
}

/**
 * GET /api/runs?limit=&before=&q=&sort=date|conviction&pillar=&ids=: the recent briefs for Home and
 * the library, newest first or by conviction, with the counts the library shows. Agent runs that
 * stored a note or ended incomplete only, and of those only the showcases plus the runs `ids` names
 * (up to 50, from the browser's own history): user-run notes are unlisted (D31). 400 on a bad
 * parameter; `next` pages on.
 */
export async function listRecentRuns(request: Request): Promise<Response> {
  const parsed = parseRunListQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return badRequest(parsed.error, parsed.issues.map((i) => ({ path: [i.path], message: i.message })));
  try {
    return json(await listBriefs(getDatabase(), parsed.query));
  } catch (err) {
    return failure(err, "list runs");
  }
}

const PreviewBody = z.strictObject({ question: Question, turnstileToken: TurnstileToken });

/**
 * POST /api/preview `{question, turnstileToken?}`: the "Understood as" panel (A02), guarded like
 * POST /api/runs, the human check included (except in replay-only mode, where no model is asked).
 * 200 with the reading, a refusal card when a brief would be declined, the answer-cache hit, the
 * estimate and the ANALYST a run would get; 429 past PREVIEW_HOURLY_CAP; 503 when live analysis is
 * paused, unconfigured or out of budget (with `alreadyHave`, which still helps); 502 when CLERK
 * could not answer.
 */
export async function previewQuestion(request: Request): Promise<Response> {
  let body: JsonBody;
  try {
    body = await readJsonBody(request, "Previews can only be requested from this site.");
  } catch (err) {
    log.warn({ err }, "could not read the preview request");
    return badRequest("The request body could not be read.");
  }
  if (body.kind === "bad") return body.response;
  const parsed = PreviewBody.safeParse(body.kind === "json" ? body.value : undefined);
  if (!parsed.success) return badRequest("Invalid preview request.", parsed.error.issues);
  let passed: HumanPassed | null = null;
  try {
    const access = getAccessService();
    const lane = access.laneOf(request);
    const decision = await getModeService().decide(lane);
    if (decision.mode !== "replay_only") {
      const human = await access.checkHuman(request, parsed.data.turnstileToken);
      if (!human.ok) return humanRefusal(human.kind);
      passed = human;
    }
    const outcome = await getPreviewService().preview(parsed.data.question, { lane, mode: decision });
    switch (outcome.kind) {
      case "ok":
        return withHuman(json(outcome.body), passed);
      case "refused":
        return withHuman(
          refusalResponse(outcome.code, outcome.message, outcome.retryAfterS, { alreadyHave: outcome.alreadyHave }),
          passed,
        );
      case "failed":
        return withHuman(json({ error: outcome.message, retry: outcome.retry }, 502), passed);
    }
  } catch (err) {
    return withHuman(failure(err, "preview"), passed);
  }
}

/** POST /api/runs/[id]/cancel: raises the cancel flag the run loop polls. */
export async function cancelRun(runId: string): Promise<Response> {
  if (!isRunId(runId)) return notFound();
  try {
    if (!(await requestCancel(getDatabase(), runId))) return notFound();
    return json({ ok: true }, 202);
  } catch (err) {
    return failure(err, "cancel run");
  }
}

const HEALTH_DB_TIMEOUT_MS = 3000;

/** Settles like `promise`, or with `fallback` after `ms` (a read that hangs must not hang health). */
async function within<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The Qloo quota snapshot (PLAN §10.3), or null when the client cannot be configured. */
function qlooHealth() {
  let client: QlooClient;
  try {
    client = getQlooClient();
  } catch {
    return null;
  }
  const quota = client.quota();
  return {
    env: client.env,
    month_remaining: quota.monthRemaining,
    today_network: quota.todayNetwork,
    floor: client.monthFloor,
    last_success: quota.lastSuccessAt,
    auth_errors: quota.consecutiveAuthErrors,
  };
}

/**
 * SEC EDGAR and US Census (PLAN §10.3, Part 9): which sources can be called, and the last 2xx network
 * call to each in this environment (ISO, or null when there has been none or the database cannot say).
 * A client that cannot be made (a malformed SEC_USER_AGENT) reads as neither configured.
 */
async function publicDataHealth(dbOk: boolean) {
  let client: PublicDataClient;
  try {
    client = getPublicDataClient();
  } catch {
    return { env: null, configured: { sec: false, census: false }, sec_last_success: null, census_last_success: null };
  }
  const last = async (source: "sec" | "census") => {
    if (!dbOk) return null;
    const at = await within(
      lastPublicSuccess(getDatabase(), { env: client.env, source }).catch(() => null),
      HEALTH_DB_TIMEOUT_MS,
      null,
    );
    return at === null ? null : at.toISOString();
  };
  const [sec, census] = await Promise.all([last("sec"), last("census")]);
  return {
    env: client.env,
    configured: { sec: client.configured.sec, census: client.configured.census },
    sec_last_success: sec,
    census_last_success: census,
  };
}

/** A lane's decision as health prints it. */
function laneHealth(decision: ModeDecision) {
  return { mode: decision.mode, breaker: decision.breaker, reason: decision.reason, until: decision.until };
}

/**
 * GET /api/health (PLAN §10.3): 503 when the database is down or its migrations have not been
 * applied yet (startup keeps retrying them), so a deploy never goes live on a missing schema. The
 * mode, Qloo quota and LLM spend are reported as far as they can be read; they never fail health.
 * `mode` is the public lane's, the first to step down; `lanes` gives each lane's mode and breaker.
 */
export async function health(): Promise<Response> {
  const started = performance.now();
  let dbOk = false;
  let runs: { active: number; accepting: boolean } | null = null;
  try {
    dbOk = await within(pingDb(getDatabase()), HEALTH_DB_TIMEOUT_MS, false);
    const manager = getRunManager();
    runs = { active: manager.activeCount(), accepting: manager.isAccepting() };
  } catch {
    // getDb throws in production when DATABASE_URL is unset.
    dbOk = false;
  }
  const latencyMs = Math.round(performance.now() - started);
  const migrations = migrationsApplied();
  const ok = dbOk && migrations;
  let mode: Mode = lastKnownMode();
  let todayUsd: number | null = null;
  let lanes: Record<Lane, ModeDecision> | null = null;
  if (ok) {
    const spend = (async () => todayLlmUsd(getDatabase()))().catch(() => null);
    const decided = (async () => getModeService().decideAll())().catch((err: unknown) => {
      log.warn({ err }, "health: could not decide the lanes' modes");
      return null;
    });
    [mode, todayUsd, lanes] = await Promise.all([
      within(getMode(), HEALTH_DB_TIMEOUT_MS, mode),
      within(spend, HEALTH_DB_TIMEOUT_MS, null),
      within(decided, HEALTH_DB_TIMEOUT_MS, null),
    ]);
    if (lanes !== null) mode = lanes.public.mode;
  }
  const access = getAccessService();
  const modes = getModeService();
  const publicdata = await publicDataHealth(ok);
  return json(
    {
      ok,
      mode,
      lanes: lanes === null ? null : { public: laneHealth(lanes.public), judge: laneHealth(lanes.judge) },
      override: modeOverrideFromEnv(),
      version: appVersion(),
      uptime_s: Math.round(process.uptime()),
      db: { ok: dbOk, latency_ms: dbOk ? latencyMs : null },
      migrations,
      runs,
      qloo: qlooHealth(),
      publicdata,
      llm: {
        today_usd: todayUsd === null ? null : Math.round(todayUsd * 10_000) / 10_000,
        cap: llmDailyUsdCapFromEnv(),
        configured: getAnthropic() !== null,
        // Today's spend at which each lane steps down (breakers.ts laneBudget).
        thresholds: Object.fromEntries(
          Lane.options.map((lane) => {
            const b = modes.budget(lane);
            return [lane, { economy_at: b.economyAt, replay_at: b.replayAt }];
          }),
        ),
      },
      // human_check: on, off (dev, or TURNSTILE_DISABLED=1), or unconfigured (required, keys missing: live runs refused).
      protection: { turnstile: access.siteKey !== null, human_check: access.humanCheck, judge_lane: access.judgeLaneOpen },
    },
    ok ? 200 : 503,
  );
}

// The visitor's access, the judge link and the admin mode switch ---------------------------------------

/** GET /api/access reuses one decision of both lanes' modes this long. */
export const ACCESS_REUSE_MS = 5_000;

const MODES_KEY = "__ctAccessModes";
type GlobalWithModes = typeof globalThis & {
  [MODES_KEY]?: { service: ModeService; at: number; decided: Promise<Record<Lane, ModeDecision>> };
};

/**
 * Both lanes' modes for GET /api/access: a new decision, or the last one of the same mode service
 * while it is younger than ACCESS_REUSE_MS. Every page asks on load (the mode banner and status
 * line), so page loads must not each read the breakers' inputs. A failed decision is not kept, and
 * a run's admission always decides afresh.
 */
function sharedModes(now: number = Date.now()): Promise<Record<Lane, ModeDecision>> {
  const g = globalThis as GlobalWithModes;
  const service = getModeService();
  const last = g[MODES_KEY];
  if (last && last.service === service && now - last.at >= 0 && now - last.at < ACCESS_REUSE_MS) return last.decided;
  const decided = (async () => service.decideAll())();
  g[MODES_KEY] = { service, at: now, decided };
  decided.catch(() => {
    if (g[MODES_KEY]?.decided === decided) g[MODES_KEY] = undefined;
  });
  return decided;
}

/**
 * GET /api/access: what the browser needs before it spends: the visitor's lane and its mode (with
 * the message a notice prints), the Turnstile site key (null while the check is off) and whether
 * this browser already passed it (its ct_human cookie, which the page cannot read). The mode is
 * null when it could not be read; it may be up to ACCESS_REUSE_MS old.
 */
export async function accessStatus(request: Request): Promise<Response> {
  const access = getAccessService();
  const lane = access.laneOf(request);
  const decided = (async () => (await sharedModes())[lane])().catch((err: unknown) => {
    log.warn({ err }, "access: could not decide the mode");
    return null;
  });
  const decision = await within(decided, HEALTH_DB_TIMEOUT_MS, null);
  return json({
    lane,
    mode: decision?.mode ?? null,
    message: decision?.message ?? null,
    until: decision?.until ?? null,
    turnstile: access.siteKey === null ? null : { siteKey: access.siteKey },
    verified: access.isVerified(request),
  });
}

/**
 * GET /api/judge?token=<JUDGE_TOKEN>: the judge link. The right token sets the signed ct_judge
 * cookie and redirects home (303, so the token leaves the address bar); anything else is 404, as
 * while JUDGE_TOKEN is unset. Past JUDGE_MISSES_PER_MINUTE wrong tokens, 429 for the rest of the minute.
 */
export function judgeLink(request: Request): Response {
  const link = getAccessService().openJudgeLane(new URL(request.url).searchParams.get("token"));
  const headers = { ...NO_STORE, "Referrer-Policy": "no-referrer" };
  switch (link.kind) {
    case "wrong":
      log.warn("judge link: wrong or missing token");
      return json({ error: "Not found." }, 404, headers);
    case "locked":
      log.warn({ retryAfterS: link.retryAfterS }, "judge link: too many wrong tokens; refusing for now");
      return json({ error: "Too many attempts. Try again in a minute." }, 429, { ...headers, "Retry-After": String(link.retryAfterS) });
    case "open":
      log.info("judge lane opened");
      return new Response(null, { status: 303, headers: { ...headers, Location: "/", "Set-Cookie": link.cookie } });
  }
}

const AdminModeBody = z.strictObject({ mode: Mode, reason: z.string().trim().min(1).max(200).optional() });

/**
 * GET or POST /api/admin/mode with `Authorization: Bearer <ADMIN_TOKEN>`: the stored mode, the
 * override and each lane's decision; POST `{mode, reason?}` first stores a mode (live clears a
 * replay-only the Qloo breaker set), and answers 503 when it could not be stored, since the other
 * processes and a restart would not see it. 404 without the token, as while ADMIN_TOKEN is unset.
 */
export async function adminMode(request: Request): Promise<Response> {
  if (!isAdmin(request)) return json({ error: "Not found." }, 404);
  let mode: z.infer<typeof AdminModeBody> | null = null;
  if (request.method === "POST") {
    let body: JsonBody;
    try {
      body = await readJsonBody(request, "The mode can only be set from this site or a script.");
    } catch {
      return badRequest("The request body could not be read.");
    }
    if (body.kind === "bad") return body.response;
    const parsed = AdminModeBody.safeParse(body.kind === "json" ? body.value : undefined);
    if (!parsed.success) return badRequest("Invalid mode request.", parsed.error.issues);
    mode = parsed.data;
  }
  try {
    if (mode !== null && !(await setMode(mode.mode, mode.reason ?? "admin"))) {
      return json({ error: "The mode could not be stored. Try again shortly.", retry: true }, 503, { "Retry-After": "5" });
    }
    // This process's pages see a switch at once; other processes within ACCESS_REUSE_MS.
    if (mode !== null) (globalThis as GlobalWithModes)[MODES_KEY] = undefined;
    const [stored, lanes] = await Promise.all([getStoredMode(), getModeService().decideAll()]);
    return json({ stored, override: modeOverrideFromEnv(), lanes });
  } catch (err) {
    return failure(err, "admin mode");
  }
}
