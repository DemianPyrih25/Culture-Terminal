import "server-only";
import { reduceRunEvents } from "@ct/contracts";
import { getRun, isConnectionError, lastSeq, pingDb, requestCancel } from "@ct/db";
import { isRunId } from "../lib/run-id";
import { getContainer, getDatabase, getRunManager } from "./container";
import { readAllEvents } from "./event-store";
import { log } from "./log";
import { isActiveStatus, runManagerErrorCode } from "./run-manager";
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

/** POST /api/runs: starts a fake run. 503 while the server drains, 429 when the process is full. */
export async function startRun(): Promise<Response> {
  try {
    const { runId } = await getRunManager().startFakeRun();
    return json({ runId }, 201);
  } catch (err) {
    const code = runManagerErrorCode(err);
    const message = err instanceof Error ? err.message : "Try again shortly.";
    if (code === "not_accepting") return json({ error: message, retry: true }, 503, { "Retry-After": "2" });
    if (code === "busy") return json({ error: message, retry: true }, 429, { "Retry-After": "10" });
    return failure(err, "start run");
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
      },
      state,
    });
  } catch (err) {
    return failure(err, "run snapshot");
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

/**
 * GET /api/health (PLAN §10.3): 503 when the database is down or its migrations have not been
 * applied yet (startup keeps retrying them), so a deploy never goes live on a missing schema.
 */
export async function health(): Promise<Response> {
  const started = performance.now();
  let dbOk = false;
  let runs: { active: number; accepting: boolean } | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), HEALTH_DB_TIMEOUT_MS);
    });
    dbOk = await Promise.race([pingDb(getDatabase()), timeout]);
    const manager = getRunManager();
    runs = { active: manager.activeCount(), accepting: manager.isAccepting() };
  } catch {
    // getDb throws in production when DATABASE_URL is unset.
    dbOk = false;
  } finally {
    clearTimeout(timer);
  }
  const latencyMs = Math.round(performance.now() - started);
  const migrations = migrationsApplied();
  const ok = dbOk && migrations;
  return json(
    {
      ok,
      mode: "live",
      version: appVersion(),
      uptime_s: Math.round(process.uptime()),
      db: { ok: dbOk, latency_ms: dbOk ? latencyMs : null },
      migrations,
      runs,
    },
    ok ? 200 : 503,
  );
}
