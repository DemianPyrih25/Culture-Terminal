import { z } from "zod";

/**
 * JSON Schema helpers for model-facing schemas.
 *
 * Strict tool use and structured outputs accept only a subset of JSON Schema: the basic types,
 * enum, const, anyOf, allOf, $ref/$defs, a few string formats, and `additionalProperties: false`
 * on every object. Numeric bounds, string lengths, patterns and array counts are not accepted, so
 * they stay in zod and are enforced server-side (CHECKER V1 for id patterns, V9 for the rest). We
 * also require every property, so absent values are explicit nulls.
 */

export type JsonSchema = { [keyword: string]: unknown };

/** The `input_schema` of an API tool definition: always an object at the top level. */
export type ToolInputSchema = {
  type: "object";
  properties: Record<string, JsonSchema>;
  required: string[];
  additionalProperties?: false;
  [keyword: string]: unknown;
};

export const STRICT_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "anyOf",
  "allOf",
  "$ref",
  "$defs",
  "description",
  "title",
  "format",
]);

export const STRICT_STRING_FORMATS: ReadonlySet<string> = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Keywords whose meaning cannot survive being dropped: converting a schema that uses them throws. */
const STRUCTURAL_UNSUPPORTED: ReadonlySet<string> = new Set([
  "propertyNames",
  "patternProperties",
  "prefixItems",
  "not",
  "if",
  "then",
  "else",
  "dependentSchemas",
]);

const BASIC_TYPES: ReadonlySet<string> =new Set(["object", "array", "string", "integer", "number", "boolean", "null"]);

function isRecord(v: unknown): v is JsonSchema {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** zod → JSON Schema with the `$schema` header removed; throws on anything JSON Schema cannot represent. */
export function zodToJsonSchema(schema: z.ZodType, io: "input" | "output" = "input"): JsonSchema {
  const out: JsonSchema = { ...z.toJSONSchema(schema, { io, unrepresentable: "throw", reused: "inline" }) };
  delete out.$schema;
  return out;
}

/**
 * Rewrites every `oneOf` as `anyOf`. zod emits oneOf for discriminated unions; with a const
 * discriminator the two mean the same, and anyOf is the form tool schemas support everywhere.
 */
export function oneOfAsAnyOf(schema: JsonSchema): JsonSchema {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isRecord(v)) return v;
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k === "oneOf" ? "anyOf" : k, walk(x)]));
  };
  return walk(schema) as JsonSchema;
}

/**
 * Rewrites a JSON Schema into the strict subset: unsupported keywords are dropped, oneOf becomes anyOf,
 * every object gets `additionalProperties: false` and lists all of its properties as required.
 */
export function toStrictJsonSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    switch (key) {
      case "properties": {
        if (!isRecord(value)) break;
        const props: Record<string, JsonSchema> = {};
        for (const [name, sub] of Object.entries(value)) props[name] = toStrictJsonSchema(sub as JsonSchema);
        out.properties = props;
        out.required = Object.keys(props);
        out.additionalProperties = false;
        break;
      }
      case "items":
        if (isRecord(value)) out.items = toStrictJsonSchema(value);
        break;
      case "anyOf":
      case "oneOf":
      case "allOf":
        if (Array.isArray(value)) {
          const target = key === "allOf" ? "allOf" : "anyOf";
          out[target] = value.map((v) => toStrictJsonSchema(v as JsonSchema));
        }
        break;
      case "$defs":
        if (isRecord(value)) {
          out.$defs = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toStrictJsonSchema(v as JsonSchema)]));
        }
        break;
      case "format":
        if (typeof value === "string" && STRICT_STRING_FORMATS.has(value)) out.format = value;
        break;
      case "required":
        break; // rebuilt from properties above
      case "additionalProperties":
        if (value !== false) throw new Error("strict schemas cannot hold records (additionalProperties must be false)");
        break;
      default:
        if (STRUCTURAL_UNSUPPORTED.has(key)) throw new Error(`strict schemas cannot use "${key}"`);
        if (STRICT_KEYWORDS.has(key)) out[key] = value;
    }
  }
  if (out.type === "object" && out.properties === undefined) {
    out.properties = {};
    out.required = [];
    out.additionalProperties = false;
  }
  return out;
}

/**
 * The schema for `output_config.format` (structured outputs) of a zod schema such as Intent or
 * GhostAnswer. Unlike the SDK's zodOutputFormat helper, which moves enum and const into the
 * description text, this keeps them as real constraints. Parse the reply with the same zod schema.
 */
export function structuredOutputSchema(schema: z.ZodType): JsonSchema {
  return toStrictJsonSchema(zodToJsonSchema(schema, "output"));
}

/**
 * Every way `schema` breaks the strict subset, as JSON-pointer-ish paths with a reason.
 * An empty list means the schema is safe for `strict: true` tools and structured outputs.
 */
export function strictSchemaViolations(schema: unknown, path = "#"): string[] {
  if (!isRecord(schema)) return [`${path}: schema node is not an object`];
  const issues: string[] = [];
  const defs = isRecord(schema.$defs) ? schema.$defs : undefined;

  const visit = (node: unknown, at: string): void => {
    if (!isRecord(node)) {
      issues.push(`${at}: schema node is not an object`);
      return;
    }
    for (const key of Object.keys(node)) {
      if (!STRICT_KEYWORDS.has(key) && !(at === path && key === "$schema")) {
        issues.push(`${at}: unsupported keyword "${key}"`);
      }
    }
    const types = Array.isArray(node.type) ? node.type : node.type === undefined ? [] : [node.type];
    for (const t of types) if (typeof t !== "string" || !BASIC_TYPES.has(t)) issues.push(`${at}: unsupported type ${String(t)}`);
    if (types.length === 0 && node.anyOf === undefined && node.allOf === undefined && node.$ref === undefined && node.const === undefined && node.enum === undefined) {
      issues.push(`${at}: node has no type, anyOf, allOf, $ref, const or enum`);
    }
    if ("additionalProperties" in node && node.additionalProperties !== false) {
      issues.push(`${at}: additionalProperties must be false`);
    }
    if (types.includes("object")) {
      if (node.additionalProperties !== false) issues.push(`${at}: object without additionalProperties: false`);
      const props = isRecord(node.properties) ? node.properties : {};
      const required = Array.isArray(node.required) ? node.required : [];
      for (const name of Object.keys(props)) {
        if (!required.includes(name)) issues.push(`${at}.${name}: property is optional (every property must be required)`);
        visit(props[name], `${at}.${name}`);
      }
      for (const name of required) if (!(name in props)) issues.push(`${at}: required "${String(name)}" is not a property`);
    }
    if (types.includes("array")) {
      if (!isRecord(node.items)) issues.push(`${at}: array without an items schema`);
      else visit(node.items, `${at}[]`);
    }
    if (typeof node.format === "string" && !STRICT_STRING_FORMATS.has(node.format)) {
      issues.push(`${at}: unsupported string format "${node.format}"`);
    }
    for (const key of ["anyOf", "allOf"] as const) {
      const list = node[key];
      if (list === undefined) continue;
      if (!Array.isArray(list)) issues.push(`${at}: ${key} is not an array`);
      else list.forEach((v, i) => visit(v, `${at}/${key}/${i}`));
    }
    if (typeof node.$ref === "string") {
      const name = node.$ref.replace(/^#\/\$defs\//, "");
      if (!node.$ref.startsWith("#/$defs/") || defs === undefined || !(name in defs)) {
        issues.push(`${at}: $ref ${node.$ref} does not point into $defs`);
      } else if (refersTo(defs[name], `#/$defs/${name}`, defs, new Set())) {
        issues.push(`${at}: recursive schema via ${node.$ref}`);
      }
    }
  };

  visit(schema, path);
  if (defs) for (const [name, def] of Object.entries(defs)) visit(def, `${path}/$defs/${name}`);
  return issues;
}

function refersTo(node: unknown, ref: string, defs: JsonSchema, seen: Set<unknown>): boolean {
  if (seen.has(node) || (typeof node !== "object" || node === null)) return false;
  seen.add(node);
  if (Array.isArray(node)) return node.some((n) => refersTo(n, ref, defs, seen));
  const rec = node as JsonSchema;
  if (rec.$ref === ref) return true;
  if (typeof rec.$ref === "string" && rec.$ref.startsWith("#/$defs/")) {
    const target = defs[rec.$ref.slice("#/$defs/".length)];
    if (refersTo(target, ref, defs, seen)) return true;
  }
  return Object.values(rec).some((v) => refersTo(v, ref, defs, seen));
}
