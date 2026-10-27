// The answer page tests: the recorded sample runs (invented entities, D29) rendered to static markup.
// Test files that import this mock "server-only" (server/samples) and "next/navigation" first.
import { renderToStaticMarkup } from "react-dom/server";
import { reduceRunEvents, stampEvent, type EventInput, type RunEvent, type RunState } from "@ct/contracts";
import { buildBriefModel, type BriefModel } from "../../lib/brief";
import { PermalinkAnswer } from "../../components/answer";
import { sampleEvents, sampleRunId, type SampleName } from "../../server/samples";

export { decode, text } from "../figures/markup";

export function events(name: SampleName): RunEvent[] {
  return [...sampleEvents(name)];
}

export const stateOf = (list: readonly RunEvent[]): RunState => reduceRunEvents(list[0]?.runId ?? "none", list);

/** A second after the last event: the clock a live render reads. */
export const after = (list: readonly RunEvent[]): number => Date.parse(list.at(-1)?.ts ?? "") + 1000;

/** Events up to and including the nth one of this type. */
export function upTo(list: readonly RunEvent[], type: RunEvent["type"], nth = 1): RunEvent[] {
  let seen = 0;
  const i = list.findIndex((e) => e.type === type && ++seen === nth);
  if (i === -1) throw new Error(`no ${type} #${nth}`);
  return list.slice(0, i + 1);
}

/** The events cut short by a run.end of this status. */
export function endedAs(list: readonly RunEvent[], status: Extract<EventInput, { type: "run.end" }>["status"], reason: string | null): RunEvent[] {
  const last = list.at(-1);
  if (!last) throw new Error("no events");
  const ts = new Date(Date.parse(last.ts) + 1000).toISOString();
  const elapsedMs = Date.parse(ts) - Date.parse(list[0]?.ts ?? ts);
  return [...list, stampEvent({ type: "run.end", status, elapsedMs, reason }, { seq: last.seq + 1, ts, runId: last.runId })];
}

export interface Rendered {
  html: string;
  model: BriefModel;
  state: RunState;
}

/** The finished answer for a state (with its How we know drawer), as the server's first paint prints it. */
export function renderState(state: RunState, now: number): Rendered {
  const model = buildBriefModel(state, now);
  const html = renderToStaticMarkup(
    <PermalinkAnswer
      model={model}
      state={state}
      runId={state.runId}
      mode="static"
      links={{ permalink: `/r/${state.runId}`, replay: `/run/${state.runId}?replay=1` }}
    />,
  );
  return { html, model, state };
}

export function render(list: readonly RunEvent[]): Rendered {
  return renderState(stateOf(list), after(list));
}

export const SAMPLE_RUN = (name: SampleName) => sampleRunId(name);

/**
 * The markup from `marker` up to the tag that holds the next `next` (or the end), so the next element's
 * opening tag is never cut in half.
 */
export function slice(html: string, marker: string, next?: string): string {
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker} in the markup`);
  const start = marker.startsWith("<") ? at : html.lastIndexOf("<", at);
  const found = next ? html.indexOf(next, at + marker.length) : -1;
  const end = found < 0 ? -1 : next?.startsWith("<") ? found : html.lastIndexOf("<", found);
  return html.slice(start, end < 0 ? undefined : end);
}

/** The opening tag that carries `marker`. */
export function tagOf(html: string, marker: string): string {
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker} in the markup`);
  return html.slice(html.lastIndexOf("<", at), html.indexOf(">", at) + 1);
}

/** Every value of an attribute in the markup, in order. */
export function attrValues(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, "g"))].map((m) => m[1] ?? "");
}

export function eventInput(input: EventInput, seq: number, ts: string, runId: string): RunEvent {
  return stampEvent(input, { seq, ts, runId });
}
