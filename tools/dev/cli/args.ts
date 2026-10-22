// Argument parsing for the dev CLIs on node:util parseArgs (no new dependencies), with the
// validators the commands share. Every bad argument becomes a UsageError, which the commands turn
// into exit code 2 and the usage text.
import { parseArgs } from "node:util";
import { ResolveEntitiesInput } from "@ct/contracts";
import { normaliseName } from "@ct/quant";

/** A bad command line: exit code 2 with the usage text. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

export type OptionSpec = { type: "string"; short?: string } | { type: "boolean"; short?: string };
export type OptionSpecs = Readonly<Record<string, OptionSpec>>;

type ValueOf<S extends OptionSpec> = S extends { type: "boolean" } ? boolean : string;
export type ParsedOptions<T extends OptionSpecs> = { [K in keyof T]?: ValueOf<T[K]> };

export interface ParsedCli<T extends OptionSpecs> {
  positionals: string[];
  options: ParsedOptions<T>;
}

/**
 * Strict parsing: unknown flags, a string flag without a value and a value given to a boolean flag
 * are usage errors. Boolean flags also accept `--no-<flag>`; `--` ends the flags.
 */
export function parseCli<T extends OptionSpecs>(argv: readonly string[], specs: T): ParsedCli<T> {
  try {
    const { values, positionals } = parseArgs({
      args: [...argv],
      options: specs as Record<string, OptionSpec>,
      allowPositionals: true,
      allowNegative: true,
      strict: true,
    });
    return { positionals, options: values as ParsedOptions<T> };
  } catch (err) {
    // parseArgs throws TypeErrors with ERR_PARSE_ARGS_* codes and readable messages.
    throw new UsageError(err instanceof Error ? err.message : String(err));
  }
}

/** An integer flag within [min, max], or `fallback` when the flag is absent. */
export function intOption(raw: string | undefined, flag: string, range: { min: number; max: number; fallback: number }): number {
  if (raw === undefined) return range.fallback;
  const n = Number(raw.trim());
  if (raw.trim() === "" || !Number.isInteger(n) || n < range.min || n > range.max) {
    throw new UsageError(`${flag} must be an integer from ${range.min} to ${range.max}, got "${raw}"`);
  }
  return n;
}

/** A comma-separated list: items trimmed, empty items dropped, repeats (by normalised name) kept once. */
export function listOption(raw: string | undefined): string[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw.split(",")) {
    const text = item.trim();
    const key = normaliseName(text);
    if (text === "" || seen.has(key)) continue;
    seen.add(key);
    out.push(text);
  }
  return out;
}

/**
 * `--pins "Name=entityId,Other=entityId"` as AgentRunOptions.pins: keyed by the normalised mention
 * text, the way runAgent looks pins up. The id is everything after the first "=".
 */
export function pinsOption(raw: string | undefined): Record<string, string> {
  const pins: Record<string, string> = {};
  if (raw === undefined) return pins;
  for (const item of raw.split(",")) {
    if (item.trim() === "") continue;
    const at = item.indexOf("=");
    const name = at < 0 ? "" : normaliseName(item.slice(0, at));
    const id = at < 0 ? "" : item.slice(at + 1).trim();
    if (name === "" || id === "") throw new UsageError(`--pins expects name=entityId pairs separated by commas, got "${item.trim()}"`);
    if (name in pins && pins[name] !== id) throw new UsageError(`--pins names "${item.slice(0, at).trim()}" twice with different ids`);
    pins[name] = id;
  }
  return pins;
}

/** The longest name resolve_entities takes: its contract's limit on a mention's text. */
export const NAME_MAX: number = ResolveEntitiesInput.shape.mentions.element.shape.text.maxLength ?? Number.POSITIVE_INFINITY;

/** A trimmed, non-empty name that resolve_entities accepts; `what` names it in the error. */
export function nameArg(raw: string, what: string): string {
  const name = raw.trim();
  if (name === "") throw new UsageError(`${what} must not be empty`);
  if (name.length > NAME_MAX) throw new UsageError(`${what} is ${name.length} characters; resolve_entities takes at most ${NAME_MAX}`);
  return name;
}

/** One value out of a fixed set, or `fallback` when the flag is absent. */
export function choiceOption<C extends string>(raw: string | undefined, flag: string, choices: readonly C[], fallback: C): C {
  if (raw === undefined) return fallback;
  const value = raw.trim() as C;
  if (!choices.includes(value)) throw new UsageError(`${flag} must be one of ${choices.join(", ")}, got "${raw}"`);
  return value;
}
