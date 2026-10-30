/**
 * Plain readers for JSON the browser receives (the client bundle split, Part 11): small checks that keep
 * zod out of client pages. A reader returns the value it accepts, rebuilt with only the keys it knows
 * (as zod's object does), or BAD. Pure, so the API answers are still validated before anything is drawn.
 */

export const BAD: unique symbol = Symbol("bad");
export type Bad = typeof BAD;
export type Read<T> = (value: unknown) => T | Bad;
export type ReadOf<R> = R extends Read<infer T> ? T : never;

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export const str: Read<string> = (v) => (typeof v === "string" ? v : BAD);
export const nonEmpty: Read<string> = (v) => (typeof v === "string" && v.length > 0 ? v : BAD);
export const num: Read<number> = (v) => (typeof v === "number" && Number.isFinite(v) ? v : BAD);
export const bool: Read<boolean> = (v) => (typeof v === "boolean" ? v : BAD);

/** One of a closed list of strings (an enum's *_VALUES array). */
export function oneOf<const T extends string>(values: readonly T[]): Read<T> {
  return (v) => (typeof v === "string" && (values as readonly string[]).includes(v) ? (v as T) : BAD);
}

export function nullable<T>(read: Read<T>): Read<T | null> {
  return (v) => (v === null ? null : read(v));
}

/** A missing (undefined) value reads as `fallback`, as zod's `.default()` does. */
export function withDefault<T>(read: Read<T>, fallback: T): Read<T> {
  return (v) => (v === undefined ? fallback : read(v));
}

/** A missing value stays missing (the key is left out); present, it must read. */
export function optional<T>(read: Read<T>): Read<T | undefined> {
  return (v) => (v === undefined ? undefined : read(v));
}

export function array<T>(read: Read<T>): Read<T[]> {
  return (v) => {
    if (!Array.isArray(v)) return BAD;
    const out: T[] = [];
    for (const item of v) {
      const got = read(item);
      if (got === BAD) return BAD;
      out.push(got);
    }
    return out;
  };
}

export function record<T>(read: Read<T>): Read<Record<string, T>> {
  return (v) => {
    if (!isRecord(v)) return BAD;
    const out: Record<string, T> = {};
    for (const [k, item] of Object.entries(v)) {
      const got = read(item);
      if (got === BAD) return BAD;
      out[k] = got;
    }
    return out;
  };
}

type Shape = Record<string, Read<unknown>>;
type OptionalKeys<S extends Shape> = { [K in keyof S]: undefined extends ReadOf<S[K]> ? K : never }[keyof S];
export type ObjectOf<S extends Shape> = { [K in Exclude<keyof S, OptionalKeys<S>>]: ReadOf<S[K]> } & { [K in OptionalKeys<S>]?: ReadOf<S[K]> };

/** An object with these keys; unknown keys are dropped, and an optional key that is absent stays absent. */
export function object<S extends Shape>(shape: S): Read<ObjectOf<S>> {
  return (v) => {
    if (!isRecord(v)) return BAD;
    const out: Record<string, unknown> = {};
    for (const [k, read] of Object.entries(shape)) {
      const got = read(v[k]);
      if (got === BAD) return BAD;
      if (got !== undefined) out[k] = got;
    }
    return out as ObjectOf<S>;
  };
}

/** zod-like result: `{ success: true, data }` or `{ success: false }`. */
export function readAs<T>(read: Read<T>, value: unknown): { success: true; data: T } | { success: false } {
  const got = read(value);
  return got === BAD ? { success: false } : { success: true, data: got };
}
