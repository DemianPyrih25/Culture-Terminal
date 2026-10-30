import "server-only";
import { unstampEvent, type EventInput, type Report, type RunEvent } from "@ct/contracts";
import { FAKE_MODEL } from "../lib/test-run";
import { sampleEvents } from "./samples";
import { sampleAiContext, sampleWebContext } from "./samples/context";

export { FAKE_MODEL };

/**
 * The test run ({ fake: true }): a replay of the synthetic brand-health sample (server/samples,
 * written by tools/dev/sample-run.ts from the real agent with a scripted model and mock Qloo data),
 * paced over the run's duration. It shows what a live run shows: CLERK, the resolution gate, the
 * opening scan, an ANALYST PIVOT, the CHECKER and the finished brief. No Qloo or model call is
 * made, so the usage events report zero LLM spend and the receipt says the data is synthetic. When the
 * sample has no side context events (samples recorded before Part 11), invented "What AI knows" and "From
 * the web" blocks (samples/context.ts) are added after the plan, as a live run's side calls would settle
 * while the ANALYST works, and the finished brief carries them.
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

/** The sample's report as the test run's: this run's id and question, and a zero-spend synthetic receipt. */
function testRunReport(report: Report, ctx: FakeScriptContext, context: SideBlocks | null): Report {
  return {
    ...report,
    ...(context ? { aiContext: context.ai, webContext: context.web } : {}),
    runId: ctx.runId,
    question: FAKE_QUESTION,
    disclaimers: [...report.disclaimers.filter((line) => !line.startsWith("Data: ")), SYNTHETIC_DATA_LINE],
    receipt: {
      ...report.receipt,
      ms: Math.round(ctx.durationMs),
      usd: 0,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      models: { clerk: null, analyst: null, ghost: null, ...(context ? { context: null, web: null } : {}) },
      economy: false,
      ...(context ? { context: { aiUsd: 0, webUsd: 0, webSearches: 0 } } : {}),
    },
  };
}

interface SideBlocks {
  ai: ReturnType<typeof sampleAiContext>;
  web: ReturnType<typeof sampleWebContext>;
}

export function buildFakeScript(ctx: FakeScriptContext): FakeScript {
  const sample = sampleEvents(SAMPLE);
  const end = sample.at(-1);
  if (end?.type !== "run.end") throw new Error(`sample ${SAMPLE} does not end with run.end`);
  const body = sample.slice(0, -1);
  const replay: { event: RunEvent; input: EventInput }[] = body.map((event) => ({ event, input: unstampEvent(event).input }));

  const positions: number[] = [];
  let pos = 0;
  replay.forEach(({ event }, i) => {
    const previous = replay[i - 1]?.event;
    const waited = previous === undefined ? 0 : Date.parse(event.ts) - Date.parse(previous.ts);
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

  // Samples recorded before Part 11 have no side context events: the test run adds invented ones after
  // the plan (or CLERK), at that step's time, as a live run's side calls settle while the ANALYST works.
  const hasContext = body.some((e) => e.type === "context.ai" || e.type === "context.web");
  const planAt = replay.findIndex(({ event }) => event.type === "plan");
  const contextAt = planAt >= 0 ? planAt : replay.findIndex(({ event }) => event.type === "clerk");
  const contextTs = new Date(ctx.startedAt + Math.round((ats[contextAt] ?? 0) * ctx.durationMs)).toISOString();
  const context: SideBlocks | null = hasContext || contextAt < 0 ? null : { ai: sampleAiContext(contextTs), web: sampleWebContext(contextTs) };

  const stepFor = (input: EventInput, at: number): FakeStep => {
    switch (input.type) {
      case "run.created":
        return { at, input: { ...input, question: FAKE_QUESTION, model: FAKE_MODEL, parentRunId: null } };
      case "usage":
        return {
          at,
          input: { ...input, llmUsd: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }, elapsedMs: Math.round(at * ctx.durationMs) },
        };
      case "report.final":
        return { at, input: { ...input, report: testRunReport(retime(input.report, map), ctx, context) } };
      default:
        return { at, input: retime(input, map) };
    }
  };
  const steps = replay.flatMap(({ input }, i): FakeStep[] => {
    const at = ats[i] ?? 0;
    const step = stepFor(input, at);
    if (context === null || i !== contextAt) return [step];
    // Between this step and the next, so every step still has its own moment.
    const gap = ((ats[i + 1] ?? 1) - at) / 3;
    return [
      step,
      { at: at + gap, input: { type: "context.ai", block: context.ai, usd: 0, ms: 0 } },
      { at: at + 2 * gap, input: { type: "context.web", block: context.web, usd: 0, ms: 0 } },
    ];
  });
  const final = steps.find((s) => s.input.type === "report.final")?.input;
  if (final?.type !== "report.final") throw new Error(`sample ${SAMPLE} has no report.final`);
  return { steps, report: final.report };
}
