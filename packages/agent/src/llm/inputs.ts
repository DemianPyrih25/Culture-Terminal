import { ANALYST_TOOLS, ID_PREFIXES, type IdPrefix, type SkillId } from "@ct/contracts";
import type { z } from "zod";

/**
 * Reads a skill call's input against its contracts schema for the loop, with an INVALID_INPUT answer
 * that names each field, what it takes and what the call sent, so the model can fix the call in one
 * try.
 *
 * An id sent inside an extra pair of quotes ("\"S2\"", the JSON of a string written into a string)
 * is accepted as the id it wraps. The double encoding leaves one reading only, and refusing it cost
 * a live tenant_mix run its planned rank and the prior it decided. Only a field that failed its id
 * format is unwrapped, only when the quotes hold an id (R#, T#, F# or S#), and the unwrapped input
 * is checked again, so an id of the wrong kind is still refused and no other value is ever changed.
 */

export type SkillInputRead = { ok: true; input: unknown } | { ok: false; issues: string[] };

type Issue = z.core.$ZodIssue;

/** At most this many issue lines, each at most ISSUE_LINE_MAX characters, go back with INVALID_INPUT. */
export const INPUT_ISSUES_MAX = 6;
export const ISSUE_LINE_MAX = 160;

const QUOTED_ID = /^"([RTFS][1-9]\d*)"$/;
const ID_FORMAT = /^\/\^([A-Z])\[1-9\]\\d\*\$\/$/;
/** The id fields that also take null, with the kind of id each takes, also named for a wrong type. */
const NULLABLE_IDS: ReadonlyMap<string, IdPrefix> = new Map([
  ["step_id", "S"],
  ["trigger_finding_id", "F"],
  ["compare_with", "R"],
]);
/** Values echoed back as written: ids and short code words. Names and other text are only described. */
const ECHOED = /^(?:[A-Z]\d{1,4}|[a-z0-9][a-z0-9_-]{0,31})$/;
const FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

export function readSkillInput(tool: SkillId, raw: unknown): SkillInputRead {
  const schema = ANALYST_TOOLS[tool].input;
  const first = schema.safeParse(raw);
  if (first.success) return { ok: true, input: first.data };
  const unwrapped = unwrapQuotedIds(raw, first.error.issues);
  if (unwrapped === null) return { ok: false, issues: issueSummary(raw, first.error.issues) };
  const second = schema.safeParse(unwrapped);
  return second.success ? { ok: true, input: second.data } : { ok: false, issues: issueSummary(unwrapped, second.error.issues) };
}

const keyOf = (path: readonly PropertyKey[]): string | null => {
  const last = path.at(-1);
  return typeof last === "string" ? last : null;
};

function valueAt(raw: unknown, path: readonly PropertyKey[]): unknown {
  let value: unknown = raw;
  for (const key of path) {
    if (typeof value !== "object" || value === null) return undefined;
    value = (value as Record<PropertyKey, unknown>)[key];
  }
  return value;
}

/** A copy of `raw` with each quoted id that failed its format unwrapped, or null when there is none. */
function unwrapQuotedIds(raw: unknown, issues: readonly Issue[]): unknown {
  const fixes = issues.flatMap((issue) => {
    const value = issue.code === "invalid_format" ? valueAt(raw, issue.path) : undefined;
    const id = typeof value === "string" ? QUOTED_ID.exec(value)?.[1] : undefined;
    return id === undefined || issue.path.length === 0 ? [] : [{ path: issue.path, id }];
  });
  if (fixes.length === 0) return null;
  const copy: unknown = structuredClone(raw);
  for (const { path, id } of fixes) {
    const parent = valueAt(copy, path.slice(0, -1)) as Record<PropertyKey, unknown>;
    parent[path.at(-1)!] = id;
  }
  return copy;
}

/** What the call sent, without echoing names or other text: ids, code words, numbers and booleans only. */
export function describedValue(value: unknown): string {
  if (value === undefined) return "no value";
  if (value === null || typeof value === "boolean") return String(value);
  if (typeof value === "number") return Number.isFinite(value) && String(value).length <= 12 ? String(value) : "a number";
  if (typeof value === "string") {
    if (value === "") return "an empty string";
    if (value.length > 1 && value.startsWith('"') && value.endsWith('"')) return "a quoted string";
    return ECHOED.test(value) ? `"${value}"` : "text";
  }
  return Array.isArray(value) ? `a list of ${value.length}` : "an object";
}

const idExpectation = (prefix: IdPrefix, nullable: boolean): string => {
  const noun = ID_PREFIXES[prefix];
  return `expected ${/^[aeiou]/.test(noun) ? "an" : "a"} ${noun} id such as "${prefix}1"${nullable ? " or null" : ""}`;
};

/** What a field takes: an id expectation in place of the schema's pattern message, else zod's own words. */
function expectation(issue: Issue): string {
  const key = keyOf(issue.path);
  const nullable = key === null ? undefined : NULLABLE_IDS.get(key);
  const prefix = issue.code === "invalid_format" ? ID_FORMAT.exec(issue.pattern ?? "")?.[1] : undefined;
  if (prefix !== undefined && prefix in ID_PREFIXES) return idExpectation(prefix as IdPrefix, nullable !== undefined);
  if (issue.code === "invalid_type" && nullable !== undefined) return idExpectation(nullable, true);
  if (issue.code === "invalid_type") return `expected ${issue.expected}`;
  return issue.message;
}

function issueLine(raw: unknown, issue: Issue): string {
  const path = issue.path.length === 0 ? "(input)" : issue.path.map(String).join(".");
  if (issue.code === "unrecognized_keys") {
    const named = issue.keys.filter((k) => FIELD_NAME.test(k)).map((k) => `"${k}"`);
    const unnamed = issue.keys.length - named.length;
    const keys = [...named, ...(unnamed === 0 ? [] : [`${unnamed} more`])].join(", ");
    return `${path}: unexpected ${issue.keys.length === 1 ? "field" : "fields"} ${keys}; remove ${issue.keys.length === 1 ? "it" : "them"}`;
  }
  const got = issue.path.length === 0 || issue.code === "custom" ? "" : `; got ${describedValue(valueAt(raw, issue.path))}`;
  return `${path}: ${expectation(issue)}${got}`;
}

const capped = (line: string): string => (line.length <= ISSUE_LINE_MAX ? line : `${line.slice(0, ISSUE_LINE_MAX - 1)}…`);

/** INVALID_INPUT issue lines held to INPUT_ISSUES_MAX lines of ISSUE_LINE_MAX characters, then "… and N more". */
export function capIssueLines(lines: readonly string[]): string[] {
  const kept = lines.slice(0, INPUT_ISSUES_MAX).map(capped);
  if (lines.length > INPUT_ISSUES_MAX) kept.push(`… and ${lines.length - INPUT_ISSUES_MAX} more`);
  return kept;
}

/**
 * The INVALID_INPUT issue lines: per field its path, what it takes and what was sent, e.g.
 * `step_id: expected a plan step id such as "S1" or null; got a quoted string`.
 */
export function issueSummary(raw: unknown, issues: readonly Issue[]): string[] {
  return capIssueLines(issues.map((issue) => issueLine(raw, issue)));
}
