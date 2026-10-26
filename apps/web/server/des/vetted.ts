import "server-only";
import { normaliseName } from "@ct/quant";
import { log } from "../log";

/**
 * CLERK's public-figure rule at $0 (SPEC §4.6): beyond the curated persons, a tearsheet looks up only
 * a person CLERK already marked `public_figure` in a brief that ran, read from the stored intents.
 * The decision never asks Qloo, so a private person's name is never sent there. The names are read
 * at most once per VETTED_TTL_MS; a read that fails vets nobody until the next one.
 */

export const VETTED_TTL_MS = 60_000;

export interface VettedOptions {
  now?: () => number;
  ttlMs?: number;
}

/** Whether a person's name, compared as the resolution gate compares names, was vetted as a public figure. */
export type VettedPerson = (name: string) => Promise<boolean>;

/** The vetting check on a source of public-figure names (the stored runs' intents). */
export function vettedPersonFrom(names: () => Promise<readonly string[]>, options: VettedOptions = {}): VettedPerson {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? VETTED_TTL_MS;
  let held: { keys: ReadonlySet<string>; at: number } | null = null;
  // Lookups that arrive while the names are read wait for the same read.
  let reading: Promise<ReadonlySet<string>> | null = null;

  const read = async (): Promise<ReadonlySet<string>> => {
    try {
      return new Set((await names()).map(normaliseName).filter((key) => key !== ""));
    } catch (err) {
      log.warn({ err }, "des: the vetted public figures could not be read; no uncurated person is looked up");
      return new Set();
    }
  };

  const current = async (): Promise<ReadonlySet<string>> => {
    if (held !== null && held.at + ttlMs > now()) return held.keys;
    reading ??= read().then((keys) => {
      held = { keys, at: now() };
      reading = null;
      return keys;
    });
    return reading;
  };

  return async (name) => {
    const key = normaliseName(name);
    return key !== "" && (await current()).has(key);
  };
}
