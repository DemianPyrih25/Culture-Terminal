import "server-only";
import { QUESTION_MAX_CHARS, reduceRunEvents, type Mode } from "@ct/contracts";
import { getDatasetEnvelope, getRun, isConnectionError, lastSeq, pingDb, requestCancel } from "@ct/db";
import type { QlooClient } from "@ct/qloo";
import { z } from "zod";
import { isRunId } from "../lib/run-id";
import { llmDailyUsdCapFromEnv } from "./config";
import {
  getAnthropic,
  getContainer,
  getDatabase,
  getMode,
  getQlooClient,
  getRunManager,
  lastKnownMode,
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
    return json({ error: "The database is unavailable. Try again shortly.", retry: true }, 503, { "Retry-After": "5" });
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

const AgentRunBody = z.strictObject({
  question: Question,
  parentRunId: RUN_ID.nullish(),
  /** POST /api/preview's token for this question: the run reuses that reading and skips CLERK. */
  previewToken: z.string().regex(PREVIEW_TOKEN, "Not a preview token.").nullish(),
});
type AgentRunBody = z.infer<typeof AgentRunBody>;

/**
 * A needs_input picker answer (D20): the waiting run and the opaque key of the chosen candidate. It
 * re-asks that run's question, so it takes no question; entity ids never come from the browser.
 */
const PickBody = z.strictObject({
  pick: z.strictObject({ runId: RUN_ID, key: z.string().regex(PICKER_KEY, "Not a picker key.") }),
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
 * POST /api/runs, all on the public lane. JSON `{question, parentRunId?, previewToken?}` starts an
 * agent run; a live preview token made for the same question hands the run that preview's reading
 * and the run skips CLERK, while an unknown, expired or mismatched one is ignored.
 * `{pick: {runId, key}}` answers a needs_input picker with a new run; an empty body or
 * `{fake: true}` starts the Foundation test run (tools/dev/sse-soak.ts posts nothing). 400 on a bad
 * body, 415 on a body that is not JSON, 403 from another site; 503 while the server drains, when
 * live analysis is off or today's budget is spent; 429 when the process is full or a limit is hit.
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
  try {
    const runs = getRunManager();
    let started: { runId: string };
    if (parsed.kind === "fake") {
      started = await runs.startFakeRun();
    } else if (parsed.kind === "pick") {
      started = await runs.answerPicker({ ...parsed.body.pick, lane: "public" });
    } else {
      const { question, parentRunId, previewToken } = parsed.body;
      const intent = previewToken ? getPreviewService().intentFor(previewToken, question) : null;
      started = await runs.startAgentRun({
        question,
        lane: "public",
        parentRunId: parentRunId ?? null,
        ...(intent ? { intent } : {}),
      });
    }
    return json({ runId: started.runId }, 201);
  } catch (err) {
    return refusal(err) ?? failure(err, "start run");
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

const PreviewBody = z.strictObject({ question: Question });

/**
 * POST /api/preview `{question}`: the "Understood as" panel (A02), guarded like POST /api/runs.
 * 200 with the reading, a refusal card when a brief would be declined, the answer-cache hit and the
 * estimate; 429 past PREVIEW_HOURLY_CAP; 503 when live analysis is paused, unconfigured or out of
 * budget (with `alreadyHave`, which still helps); 502 when CLERK could not answer.
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
  try {
    const outcome = await getPreviewService().preview(parsed.data.question);
    switch (outcome.kind) {
      case "ok":
        return json(outcome.body);
      case "refused":
        return refusalResponse(outcome.code, outcome.message, outcome.retryAfterS, { alreadyHave: outcome.alreadyHave });
      case "failed":
        return json({ error: outcome.message, retry: outcome.retry }, 502);
    }
  } catch (err) {
    return failure(err, "preview");
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
 * GET /api/health (PLAN §10.3): 503 when the database is down or its migrations have not been
 * applied yet (startup keeps retrying them), so a deploy never goes live on a missing schema. The
 * mode, Qloo quota and LLM spend are reported as far as they can be read; they never fail health.
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
  if (ok) {
    const spend = (async () => todayLlmUsd(getDatabase()))().catch(() => null);
    [mode, todayUsd] = await Promise.all([
      within(getMode(), HEALTH_DB_TIMEOUT_MS, mode),
      within(spend, HEALTH_DB_TIMEOUT_MS, null),
    ]);
  }
  return json(
    {
      ok,
      mode,
      version: appVersion(),
      uptime_s: Math.round(process.uptime()),
      db: { ok: dbOk, latency_ms: dbOk ? latencyMs : null },
      migrations,
      runs,
      qloo: qlooHealth(),
      llm: {
        today_usd: todayUsd === null ? null : Math.round(todayUsd * 10_000) / 10_000,
        cap: llmDailyUsdCapFromEnv(),
        configured: getAnthropic() !== null,
      },
    },
    ok ? 200 : 503,
  );
}
