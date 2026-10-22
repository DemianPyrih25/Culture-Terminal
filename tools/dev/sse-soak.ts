// SSE soak test for the Foundation skeleton (PLAN Part 1 "Done when": the stream survives 200 s and
// a reconnect). Starts a fake run, reads its stream, drops the connection once on purpose after the
// first events, resumes with Last-Event-ID and checks that the whole sequence arrives gap-free and
// duplicate-free through run.end, that events arrive as they happen (not in one buffered burst),
// that nothing else closed the stream, and that it lasted about 200 s. Works locally and through
// terminal.<domain>. The rules live in sse-soak-check.ts.
//
//   pnpm exec tsx tools/dev/sse-soak.ts --base http://localhost:3000 [--drop-at 60] [--timeout 600]
//     [--short] [--allow-unplanned-closes]
//
// --short skips the 190 s minimum for a quick check against a shorter run (FAKE_RUN_SECONDS).
// Dependency-free on purpose: it checks the wire format, not our TypeScript types.
import { checkSoak, type SoakClose, type SoakConnection, type SoakEvent, type SoakRecord } from "./sse-soak-check";

interface Args {
  base: string;
  dropAt: number;
  timeout: number;
  short: boolean;
  allowUnplannedCloses: boolean;
}

function usage(message?: string): never {
  if (message) console.error(message);
  console.error(
    "usage: tsx tools/dev/sse-soak.ts --base <url> [--drop-at <seconds>] [--timeout <seconds>] [--short] [--allow-unplanned-closes]",
  );
  process.exit(2);
}

function parseArgs(argv: string[]): Args {
  const args: Args = { base: "", dropAt: 60, timeout: 600, short: false, allowUnplannedCloses: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "--help" || flag === "-h") usage();
    if (flag === "--short") {
      args.short = true;
      continue;
    }
    if (flag === "--allow-unplanned-closes") {
      args.allowUnplannedCloses = true;
      continue;
    }
    if (value === undefined) usage(`missing value for ${flag}`);
    i++;
    if (flag === "--base") args.base = value.replace(/\/+$/, "");
    else if (flag === "--drop-at") args.dropAt = Number(value);
    else if (flag === "--timeout") args.timeout = Number(value);
    else usage(`unknown flag ${flag}`);
  }
  if (!/^https?:\/\//.test(args.base)) usage("--base must be an http(s) URL");
  if (!Number.isFinite(args.dropAt) || args.dropAt <= 0) usage("--drop-at must be a positive number of seconds");
  if (!Number.isFinite(args.timeout) || args.timeout <= 0) usage("--timeout must be a positive number of seconds");
  return args;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Frame {
  id: string | null;
  data: string | null;
  retry: number | null;
  comment: string | null;
}

/** Splits an SSE byte stream into frames (blank-line separated), per the EventSource rules we rely on. */
async function* readFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<Frame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n?/g, "\n");
      let end = buffer.indexOf("\n\n");
      while (end !== -1) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const frame: Frame = { id: null, data: null, retry: null, comment: null };
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) frame.comment = line.slice(1).trim();
          else if (line.startsWith("id:")) frame.id = line.slice(3).trim();
          else if (line.startsWith("data:")) frame.data = (frame.data === null ? "" : `${frame.data}\n`) + line.slice(5).replace(/^ /, "");
          else if (line.startsWith("retry:")) frame.retry = Number(line.slice(6).trim());
        }
        yield frame;
        end = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function startRun(base: string): Promise<string> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(`${base}/api/runs`, { method: "POST" });
    const body = (await res.json().catch(() => null)) as { runId?: unknown; retry?: unknown; error?: unknown } | null;
    if (res.ok && typeof body?.runId === "string") return body.runId;
    if (body?.retry === true) {
      console.log(`start: ${res.status} ${String(body.error ?? "")}; retrying`);
      await sleep(2000);
      continue;
    }
    throw new Error(`POST /api/runs answered ${res.status}: ${JSON.stringify(body)}`);
  }
  throw new Error("POST /api/runs kept asking to retry");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  const secs = (at = Date.now()) => ((at - t0) / 1000).toFixed(1);
  const runId = await startRun(args.base);
  console.log(`run ${runId} started; dropping the connection once at ${args.dropAt} s, after the first event`);

  const record: SoakRecord = { startedAt: t0, events: [], connections: [], drop: null, wireProblems: [], snapshot: null };
  let lastSeq = 0;
  let pings = 0;
  let retryMs = 2000;
  let ended = false;

  while (!ended) {
    const index = record.connections.length + 1;
    if (Date.now() - t0 > args.timeout * 1000) {
      record.wireProblems.push(`timed out after ${args.timeout} s without run.end`);
      break;
    }
    const controller = new AbortController();
    const headers: Record<string, string> = { Accept: "text/event-stream" };
    if (lastSeq > 0) headers["Last-Event-ID"] = String(lastSeq);
    const connection: SoakConnection = {
      index,
      openedAt: Date.now(),
      lastEventId: headers["Last-Event-ID"] ?? null,
      close: "server-closed",
    };
    record.connections.push(connection);
    const close = (reason: SoakClose, detail?: string) => {
      connection.close = reason;
      if (detail) connection.detail = detail;
    };
    // The drop is due at --drop-at but waits for the first event, so the reconnect always resumes.
    let dropDue = false;
    let dropTimer: ReturnType<typeof setTimeout> | undefined;
    const dropNow = () => {
      record.drop = { at: Date.now(), seq: lastSeq, connection: index };
      console.log(`${secs()} s  dropping the connection after seq ${lastSeq}`);
      close("forced");
      controller.abort();
    };
    try {
      const res = await fetch(`${args.base}/api/runs/${runId}/stream`, { headers, signal: controller.signal });
      if (res.status !== 200 || !res.body) {
        close("bad-status", `HTTP ${res.status}`);
        break;
      }
      const type = res.headers.get("content-type") ?? "";
      const cache = res.headers.get("cache-control") ?? "";
      if (!type.startsWith("text/event-stream")) record.wireProblems.push(`content-type was "${type}"`);
      if (!cache.includes("no-transform")) record.wireProblems.push(`cache-control was "${cache}"`);
      if (index > 1) console.log(`${secs()} s  reconnected with Last-Event-ID ${connection.lastEventId ?? "(none)"}`);

      if (!record.drop) {
        const wait = Math.max(0, args.dropAt * 1000 - (Date.now() - t0));
        dropTimer = setTimeout(() => {
          if (lastSeq > 0) dropNow();
          else dropDue = true;
        }, wait);
      }

      for await (const frame of readFrames(res.body)) {
        if (frame.retry !== null) retryMs = frame.retry;
        if (frame.comment === "ping") pings += 1;
        if (frame.data === null) continue;
        const arrivedAt = Date.now();
        const event = JSON.parse(frame.data) as { seq?: unknown; type?: unknown; runId?: unknown; status?: unknown; ts?: unknown };
        const seq = Number(event.seq);
        if (frame.id !== String(seq)) record.wireProblems.push(`frame id ${frame.id} does not match seq ${seq}`);
        if (event.runId !== runId) record.wireProblems.push(`event ${seq} belongs to run ${String(event.runId)}`);
        const tsMs = Date.parse(String(event.ts));
        if (!Number.isFinite(tsMs)) record.wireProblems.push(`event ${seq} has no valid ts`);
        const entry: SoakEvent = { seq, type: String(event.type), tsMs, arrivedAt, connection: index };
        if (typeof event.status === "string") entry.status = event.status;
        record.events.push(entry);
        if (seq > lastSeq) lastSeq = seq;
        if (entry.type === "run.end") {
          ended = true;
          close("run.end");
          break;
        }
        if (dropDue && !record.drop) {
          dropNow();
          break;
        }
      }
      if (!ended && connection.close === "server-closed") console.log(`${secs()} s  server closed the stream before run.end`);
    } catch (err) {
      if (connection.close !== "forced") {
        close("error", (err as Error).message);
        console.log(`${secs()} s  connection error: ${(err as Error).message}`);
      }
    } finally {
      clearTimeout(dropTimer);
      controller.abort();
    }
    if (!ended) await sleep(retryMs);
  }

  // The server's own view must agree with what arrived over the wire.
  if (record.events.length > 0) {
    const res = await fetch(`${args.base}/api/runs/${runId}`).catch(() => null);
    const snap = (await res?.json().catch(() => null)) as { state?: { lastSeq?: number; status?: string } } | null;
    record.snapshot = { lastSeq: snap?.state?.lastSeq, status: snap?.state?.status };
  }

  const result = checkSoak(record, { short: args.short, allowUnplannedCloses: args.allowUnplannedCloses });
  const seqs = result.accepted.map((e) => e.seq);
  const final = result.accepted.at(-1);
  const drop = record.drop;
  const resumed = drop ? record.connections.find((c) => c.index === drop.connection + 1) : undefined;
  console.log("");
  console.log(`run         ${runId}`);
  console.log(`duration    ${(result.durationMs / 1000).toFixed(1)} s${args.short ? " (--short)" : ""}`);
  console.log(`events      ${result.accepted.length}${seqs.length ? ` (seq ${seqs[0]}..${seqs.at(-1)})` : ""}`);
  console.log(
    `reconnects  ${record.connections.length - 1}${
      drop
        ? ` (forced drop at ${secs(drop.at)} s after seq ${drop.seq}; resumed with Last-Event-ID ${resumed?.lastEventId ?? "(none)"})`
        : ""
    }`,
  );
  console.log(`unplanned   ${result.unplannedCloses}`);
  console.log(`worst lag   ${result.worstLagMs === null ? "n/a" : `${(result.worstLagMs / 1000).toFixed(2)} s`}`);
  console.log(`pings       ${pings}`);
  console.log(`final       ${final?.type === "run.end" ? (final.status ?? "?") : "no run.end"}`);
  for (const problem of result.problems) console.log(`problem     ${problem}`);
  console.log(`result      ${result.problems.length === 0 ? "PASS" : "FAIL"}`);
  process.exit(result.problems.length === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`soak failed: ${err instanceof Error ? err.message : String(err)}`);
  console.log("result      FAIL");
  process.exit(1);
});
