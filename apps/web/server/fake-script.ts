import "server-only";
import { isSkillAvailable, SCAN_TABLE } from "@ct/agent";
import {
  TOOL_MNEMONIC,
  unstampEvent,
  type EventInput,
  type EventInputOf,
  type Report,
  type RunEvent,
  type SkillId,
} from "@ct/contracts";
import { computeConfidence } from "@ct/quant";
import { FAKE_MODEL } from "../lib/test-run";
import { sampleEvents } from "./samples";

export { FAKE_MODEL };

/**
 * The test run ({ fake: true }): a replay of the synthetic brand-health sample (server/samples,
 * written by tools/dev/sample-run.ts from the real agent with a scripted model and mock Qloo data),
 * paced over the run's duration. It shows what a live run shows: CLERK, the resolution gate, the
 * opening scan, an ANALYST PIVOT, the CHECKER and the finished brief, plus a CODE FALLBACK for the
 * scan skills this build cannot run, so the trace exercises every event type a run takes. No Qloo or
 * model call is made, so the usage events report zero LLM spend and the receipt says the data is
 * synthetic.
 */

export const FAKE_QUESTION = "Test run: is the Juniper Cola audience a moat or a niche?";

export interface FakeStep {
  /** When to emit, as a fraction of the run's duration (0 ≤ at < 1). run.end is due at 1. */
  at: number;
  input: EventInput;
}

export interface FakeScript {
  steps: FakeStep[];
  report: Report;
}

export interface FakeScriptContext {
  runId: string;
  startedAt: number;
  durationMs: number;
}

const SAMPLE = "brand-health";
const SYNTHETIC_DATA_LINE = "Data: synthetic test data from a test run; no Qloo or model calls were made.";

/**
 * Pacing: each event takes one unit, plus the time it waited in the sample in GAP_UNIT_MS steps, at
 * most GAP_CAP of them. Bursts of Qloo calls stay quick and model turns stay slower, while no stretch
 * of the run goes quiet for long (the stream pings every 15 s).
 */
const GAP_UNIT_MS = 500;
const GAP_CAP = 4;

const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const UTC_MINUTE = /\b(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}) UTC\b/g;

const toolNames = (tools: readonly SkillId[]): string => tools.map((t) => `${t} (${TOOL_MNEMONIC[t]})`).join(" and ");

/**
 * The step the test run adds after the opening scan starts: the job's scan skills (SCAN_TABLE) that
 * this build cannot run, which left the sample's scan to the ones it did run. Null when the sample's
 * scan ran every skill in the table, or left one out that this build has: then no fallback is true.
 */
export function scanFallback(sample: readonly RunEvent[]): EventInputOf<"fallback"> | null {
  const clerk = sample.find((e) => e.type === "clerk");
  const scan = sample.filter((e) => e.type === "tool.start" && e.phase === "scan");
  const first = scan[0];
  if (clerk?.type !== "clerk" || first?.type !== "tool.start") return null;
  const planned = SCAN_TABLE[clerk.intent.job].map((entry) => entry.tool);
  const started = new Set<string>(scan.flatMap((e) => (e.type === "tool.start" ? [e.tool] : [])));
  const ran = planned.filter((tool) => started.has(tool));
  const missing = planned.filter((tool) => !started.has(tool));
  if (ran.length === 0 || missing.length === 0 || missing.some(isSkillAvailable)) return null;
  return {
    type: "fallback",
    from: planned.map((t) => TOOL_MNEMONIC[t]).join(" + "),
    to: ran.map((t) => TOOL_MNEMONIC[t]).join(" + "),
    reason: `${toolNames(missing)} ${missing.length === 1 ? "is" : "are"} not in this build, so the opening scan ran ${toolNames(ran)} alone.`,
    toolCallId: first.toolCallId,
    findingId: null,
  };
}

/** Maps a sample time onto the test run: in-run times follow the pacing, earlier ones (cached data) keep their age. */
type TimeMap = (sampleMs: number) => number;

function timeMapFor(events: readonly RunEvent[], ats: readonly number[], ctx: FakeScriptContext): TimeMap {
  const t0 = Date.parse(events[0]?.ts ?? "");
  const times = events.map((e) => Date.parse(e.ts));
  return (t) => {
    if (t <= t0) return ctx.startedAt + (t - t0);
    // The first event at or after t: its own pace when t is its time, else between it and the one before.
    const i = times.findIndex((time) => time >= t);
    let at = 1;
    if (i > 0) {
      const [before, after] = [times[i - 1] ?? t, times[i] ?? t];
      const [atBefore, atAfter] = [ats[i - 1] ?? 0, ats[i] ?? 1];
      at = after === t ? atAfter : atBefore + ((atAfter - atBefore) * (t - before)) / (after - before);
    }
    return ctx.startedAt + Math.round(at * ctx.durationMs);
  };
}

/** Moves every timestamp a payload carries (ISO strings, and "YYYY-MM-DD HH:MM UTC" in source lines) onto the test run. */
function retime<T>(value: T, map: TimeMap): T {
  const minute = (date: string, hm: string) => {
    const moved = new Date(map(Date.parse(`${date}T${hm}:00.000Z`))).toISOString();
    return `${moved.slice(0, 10)} ${moved.slice(11, 16)} UTC`;
  };
  return JSON.parse(JSON.stringify(value), (_key, v: unknown) => {
    if (typeof v !== "string") return v;
    if (ISO_TIME.test(v)) return new Date(map(Date.parse(v))).toISOString();
    return v.replace(UTC_MINUTE, (_m, date: string, hm: string) => minute(date, hm));
  }) as T;
}

/** The sample's report as the test run's: this run's id and question, one more CODE FALLBACK, and a zero-spend synthetic receipt. */
function testRunReport(report: Report, ctx: FakeScriptContext, fallbacks: number): Report {
  const count = (rule: Report["verdict"]["confidence"]["breakdown"][number]["rule"]) =>
    report.verdict.confidence.breakdown.find((line) => line.rule === rule)?.count ?? 0;
  const confidence = computeConfidence({
    droppedEntities: count("dropped_entity"),
    codeFallbacks: count("code_fallback") + fallbacks,
    coarseGeohash: count("coarse_geohash") > 0,
    staleMomentumCited: count("stale_momentum") > 0,
    thinResults: count("thin_result"),
    qualityGateDrops: count("quality_gate_drop"),
    checkerWarnings: count("checker_warning"),
    insufficientEvidence: count("insufficient_evidence") > 0,
  });
  return {
    ...report,
    runId: ctx.runId,
    question: FAKE_QUESTION,
    verdict: { ...report.verdict, confidence },
    disclaimers: [...report.disclaimers.filter((line) => !line.startsWith("Data: ")), SYNTHETIC_DATA_LINE],
    receipt: {
      ...report.receipt,
      ms: Math.round(ctx.durationMs),
      usd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      models: { clerk: null, analyst: null, ghost: null },
      economy: false,
    },
  };
}

export function buildFakeScript(ctx: FakeScriptContext): FakeScript {
  const sample = sampleEvents(SAMPLE);
  const end = sample.at(-1);
  if (end?.type !== "run.end") throw new Error(`sample ${SAMPLE} does not end with run.end`);
  const body = sample.slice(0, -1);
  const fallback = scanFallback(sample);

  // The events to replay, with the added fallback right after the scan starts; it waits no time of its own.
  const replay: { event: RunEvent; input: EventInput }[] = [];
  for (const event of body) {
    replay.push({ event, input: unstampEvent(event).input });
    if (fallback !== null && event.type === "tool.start" && event.toolCallId === fallback.toolCallId) replay.push({ event, input: fallback });
  }

  const positions: number[] = [];
  let pos = 0;
  replay.forEach(({ event }, i) => {
    const previous = replay[i - 1]?.event;
    const waited = previous === undefined || previous === event ? 0 : Date.parse(event.ts) - Date.parse(previous.ts);
    if (i > 0) pos += 1 + Math.min(Math.max(0, waited) / GAP_UNIT_MS, GAP_CAP);
    positions.push(pos);
  });
  const lastEvent = body.at(-1);
  const tail = lastEvent === undefined ? 0 : Date.parse(end.ts) - Date.parse(lastEvent.ts);
  const total = pos + 1 + Math.min(Math.max(0, tail) / GAP_UNIT_MS, GAP_CAP);
  const ats = positions.map((p) => p / total);
  const map = timeMapFor(
    replay.map((r) => r.event),
    ats,
    ctx,
  );

  const fallbacks = replay.filter((r) => r.input.type === "fallback").length;
  const steps = replay.map(({ input }, i): FakeStep => {
    const at = ats[i] ?? 0;
    switch (input.type) {
      case "run.created":
        return { at, input: { ...input, question: FAKE_QUESTION, model: FAKE_MODEL, parentRunId: null } };
      case "usage":
        return {
          at,
          input: { ...input, llmUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, elapsedMs: Math.round(at * ctx.durationMs) },
        };
      case "report.final":
        return { at, input: { ...input, report: testRunReport(retime(input.report, map), ctx, fallbacks) } };
      default:
        return { at, input: retime(input, map) };
    }
  });
  const final = steps.find((s) => s.input.type === "report.final")?.input;
  if (final?.type !== "report.final") throw new Error(`sample ${SAMPLE} has no report.final`);
  return { steps, report: final.report };
}
