// The working view and drawer tests: the recorded sample runs (invented entities, D29), cut at any event.
// Test files that import this mock "server-only" (server/samples) first.
import { reduceRunEvents, stampEvent, type EventInput, type RunEvent, type RunState } from "@ct/contracts";
import { buildBriefModel, type BriefModel } from "../../lib/brief";
import { sampleEvents, type SampleName } from "../../server/samples";

export function events(name: SampleName): RunEvent[] {
  return [...sampleEvents(name)];
}

export const stateOf = (list: readonly RunEvent[]): RunState => reduceRunEvents(list[0]?.runId ?? "none", list);

/** A second after the last event: the clock a live render reads. */
export const after = (list: readonly RunEvent[]): number => Date.parse(list.at(-1)?.ts ?? "") + 1000;

/** The model and state of the events, as the page builds them. */
export function modelOf(list: readonly RunEvent[]): { state: RunState; model: BriefModel } {
  const state = stateOf(list);
  return { state, model: buildBriefModel(state, after(list)) };
}

/** Events up to and including the nth one of this type. */
export function upTo(list: readonly RunEvent[], type: RunEvent["type"], nth = 1): RunEvent[] {
  let seen = 0;
  const i = list.findIndex((e) => e.type === type && ++seen === nth);
  if (i === -1) throw new Error(`no ${type} #${nth}`);
  return list.slice(0, i + 1);
}

/** Events before the first one of this type. */
export function before(list: readonly RunEvent[], type: RunEvent["type"]): RunEvent[] {
  const i = list.findIndex((e) => e.type === type);
  if (i === -1) throw new Error(`no ${type}`);
  return list.slice(0, i);
}

/** Appends an event, stamped a second after the last. */
export function plus(list: readonly RunEvent[], input: EventInput): RunEvent[] {
  const last = list.at(-1);
  if (!last) throw new Error("no events");
  const ts = new Date(Date.parse(last.ts) + 1000).toISOString();
  return [...list, stampEvent(input, { seq: last.seq + 1, ts, runId: last.runId })];
}

/** The events cut short by a run.end of this status. */
export function endedAs(list: readonly RunEvent[], status: Extract<EventInput, { type: "run.end" }>["status"], reason: string | null): RunEvent[] {
  const first = list[0];
  const last = list.at(-1);
  if (!first || !last) throw new Error("no events");
  const elapsedMs = Date.parse(last.ts) + 1000 - Date.parse(first.ts);
  return plus(list, { type: "run.end", status, elapsedMs, reason });
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'", nbsp: " " };

/** The markup's text, tags dropped and entities decoded, spaces collapsed. */
export function text(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#?\w+);/g, (m, e: string) => ENTITIES[e] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/** The markup from the tag that holds `marker` to the end of the markup or the next `next`. */
export function slice(html: string, marker: string, next?: string): string {
  const at = html.indexOf(marker);
  if (at < 0) throw new Error(`no ${marker} in the markup`);
  const start = html.lastIndexOf("<", at);
  const end = next ? html.indexOf(next, at + marker.length) : -1;
  return html.slice(start, end < 0 ? undefined : html.lastIndexOf("<", end));
}

/** Every value of an attribute in the markup, in order. */
export function attrValues(html: string, attr: string): string[] {
  return [...html.matchAll(new RegExp(`${attr}="([^"]*)"`, "g"))].map((m) => m[1] ?? "");
}
