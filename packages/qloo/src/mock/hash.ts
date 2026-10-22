import { createHash } from "node:crypto";

/**
 * Every synthetic value derives from sha256 of its inputs, never from Math.random, so the same
 * request always yields the same bytes and two processes agree on every score.
 */

export type HashPart = string | number;

export function hashHex(...parts: readonly HashPart[]): string {
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** A uniform number in [0, 1) derived from the parts (52 bits of the hash). */
export function unit(...parts: readonly HashPart[]): number {
  return Number.parseInt(hashHex(...parts).slice(0, 13), 16) / 2 ** 52;
}

export function pick<T>(items: readonly T[], ...parts: readonly HashPart[]): T {
  const item = items[Math.floor(unit(...parts) * items.length)];
  if (item === undefined) throw new Error("pick: empty list");
  return item;
}

/** An integer in [min, max], inclusive. */
export function intBetween(min: number, max: number, ...parts: readonly HashPart[]): number {
  return min + Math.floor(unit(...parts) * (max - min + 1));
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** Rounds so response bytes stay short and stable. */
export function round(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}
