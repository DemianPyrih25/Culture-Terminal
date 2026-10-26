// run-skill's generic mode: any skill from its tool input. Names given with --names resolve to R#
// refs and tag URNs given with --tags register as T# refs before the input is validated against
// the registry, the way the ANALYST's calls rely on the refs earlier tools registered.
import { readFileSync } from "node:fs";
import {
  approxTokens,
  EntityType,
  isTaxonomyTag,
  parseToolInput,
  wrapQlooData,
  type EntityRegistry,
  type MetroId,
  type RegisteredTag,
  type SkillId,
  type SkillResult,
  type ToolName,
} from "@ct/contracts";
import { tagNameFromUrn, tagTypeOf } from "@ct/quant";
import { listOption, nameArg, UsageError } from "./args";
import { formatFixed2, NONE } from "./format";
import { renderTable } from "./table";

/** A bad --input: exit code 2 like any usage error, but the message alone says what to fix. */
export class InputError extends UsageError {}

/** One name for resolve_entities: its text, type and (places only) metro. */
export interface NameMention {
  text: string;
  type: EntityType;
  metro: MetroId | null;
}

/**
 * One --names item: "Name", or "type:Name" to give that name its own type (artist:Artist Nova).
 * A prefix that is not an entity type stays part of the name.
 */
export function mentionArg(item: string, fallbackType: EntityType, metro: MetroId | null): NameMention {
  const at = item.indexOf(":");
  const prefix = EntityType.safeParse(at > 0 ? item.slice(0, at).trim().toLowerCase() : "");
  const type = prefix.success ? prefix.data : fallbackType;
  const text = nameArg(prefix.success ? item.slice(at + 1) : item, "a --names name");
  return { text, type, metro: type === "place" ? metro : null };
}

const TAG_URN = /^urn:tag:[a-z0-9_]+(?::[^\s:,]+)+$/;

/** --tags: public tag URNs (D29 allows taxonomy URNs), in order, repeats kept once. */
export function tagsOption(raw: string | undefined): string[] {
  const tags = listOption(raw);
  const bad = tags.find((t) => !TAG_URN.test(t));
  if (bad !== undefined) throw new UsageError(`--tags takes tag URNs such as urn:tag:genre:place:restaurant, got "${bad}"`);
  return tags;
}

/** The --input value: JSON text, or "@path" for a file holding it. */
export function readInputOption(raw: string): unknown {
  let text = raw;
  if (raw.startsWith("@")) {
    const file = raw.slice(1).trim();
    if (file === "") throw new InputError("--input @ needs a file path");
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      throw new InputError(`cannot read --input file "${file}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new InputError(`--input is not JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The input with trigger_finding_id and step_id set to null when absent: a turn-1 call outside any plan step. */
export function withCallMeta(input: unknown): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new InputError("--input must be a JSON object (the tool input)");
  const object = input as Record<string, unknown>;
  return { ...object, trigger_finding_id: object.trigger_finding_id ?? null, step_id: object.step_id ?? null };
}

/** The input checked against the skill's tool schema, as the agent checks the ANALYST's calls. Throws UsageError. */
export function validateInput(skill: SkillId, input: Record<string, unknown>): unknown {
  const parsed = parseToolInput(skill as ToolName, input);
  if (parsed.ok) return parsed.input;
  const issues = parsed.error.split("\n").slice(1);
  throw new InputError([`--input is not a valid ${skill} input:`, ...issues.map((l) => `  ${l}`)].join("\n"));
}

export interface InputRefs {
  entities: string[];
  tags: string[];
}

/** Every R# and T# the input names, in first-seen order. */
export function refsIn(value: unknown): InputRefs {
  const entities = new Set<string>();
  const tags = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      if (/^R\d+$/.test(v)) entities.add(v);
      else if (/^T\d+$/.test(v)) tags.add(v);
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (typeof v === "object" && v !== null) {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return { entities: [...entities], tags: [...tags] };
}

/** The highest ref number in `refs` ("R4" → 4), 0 for none. */
export function maxRefNumber(refs: readonly string[]): number {
  return refs.reduce((max, ref) => Math.max(max, Number(ref.slice(1))), 0);
}

// Tag URNs read the way find_tags reads them (@ct/quant findTags/tags.ts) ---------------------------------------

export { tagNameFromUrn, tagTypeOf };

/** Registers a tag URN as find_tags would; only taxonomy tags act as signals (G1, G6). */
export function registerTagUrn(registry: EntityRegistry, urn: string): RegisteredTag {
  return registry.registerTag({ tagId: urn, name: tagNameFromUrn(urn), type: tagTypeOf(urn), signalCapable: isTaxonomyTag(urn) });
}

/** Every ref the registry holds now, entities and tags. */
export function registryRefs(registry: EntityRegistry): Set<string> {
  return new Set([...registry.entities().map((e) => e.ref), ...registry.tags().map((t) => t.ref)]);
}

/**
 * The refs in the registry, or only those in `only`: entities with their names (never their Qloo
 * ids), then tags with their public URNs.
 */
export function renderRegistry(registry: EntityRegistry, { indent = "  ", only }: { indent?: string; only?: ReadonlySet<string> } = {}): string[] {
  const keep = (ref: string): boolean => only === undefined || only.has(ref);
  const entities = registry.entities().filter((e) => keep(e.ref));
  const tags = registry.tags().filter((t) => keep(t.ref));
  if (entities.length === 0 && tags.length === 0) return [`${indent}${only === undefined ? "(empty)" : "(none)"}`];
  return renderTable(
    // Wide enough for a whole tag URN and its marker: --tags takes the URN as printed.
    [{ header: "ref" }, { header: "type", max: 24 }, { header: "name", max: 40 }, { header: "detail", max: 110 }, { header: "pop", align: "right" }],
    [
      ...entities.map((e) => [e.ref, e.type, e.name, e.disambiguation ?? NONE, formatFixed2(e.popularity)]),
      ...tags.map((t) => [t.ref, t.type, t.name, `${t.tagId}${t.signalCapable ? "" : " (descriptive: no signal)"}`, NONE]),
    ],
    { indent },
  );
}

/**
 * What the model would read: the wrapped digest's size against the 1.5k-token budget, then its top
 * rows as `name  key=value · …`.
 */
export function renderDigest(skill: SkillId, result: SkillResult, indent = "  "): string[] {
  const tokens = approxTokens(wrapQlooData(result.forModel, { tool: skill as ToolName, step: null }));
  const { top_rows: rows, metrics, findings, registered } = result.forModel;
  const lines = [
    `${indent}~${tokens} tokens · ${rows.length} top row(s) · ${metrics.length} metric(s) · ${findings.length} finding(s) · ${registered.length} registered`,
  ];
  if (rows.length === 0) return lines;
  return [
    ...lines,
    ...renderTable(
      [{ header: "ref" }, { header: "name", max: 36 }, { header: "values", max: 120 }],
      rows.map((r) => [
        r.ref ?? NONE,
        r.name,
        Object.entries(r.values)
          .map(([k, v]) => `${k}=${v === null ? NONE : String(v)}`)
          .join(" · "),
      ]),
      { indent },
    ),
  ];
}
