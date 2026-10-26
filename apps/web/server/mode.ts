import "server-only";
import { Mode } from "@ct/contracts";
import { getKv, setKv, type Queryable } from "@ct/db";
import { z } from "zod";
import { log } from "./log";

/**
 * The service mode in kv (PLAN §11.6): live, economy or replay_only. Absent means live. The Qloo
 * client asks for replay_only after repeated auth failures or below its month floor; the admin
 * mode switch (POST /api/admin/mode) writes the same key. The daily breakers never write it: they
 * are worked out from today's counters (breakers.ts), so they lift by themselves at 00:00 UTC.
 */

export const MODE_KV_KEY = "mode";

/** What writeMode stores. A bare mode string, as someone might set by hand, is read too. */
const StoredMode = z.union([Mode, z.looseObject({ mode: Mode, reason: z.unknown().optional(), since: z.unknown().optional() })]);

/** The stored mode with why and since when; reason and since are null when they were not stored. */
export interface StoredModeValue {
  mode: Mode;
  /** Who set it: "qloo" (the Qloo client's breaker), "admin", or what the admin switch was told. */
  reason: string | null;
  /** ISO time it was set. */
  since: string | null;
}

export const LIVE_STORED: StoredModeValue = { mode: "live", reason: null, since: null };

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() !== "" ? value : null);

export async function readStoredMode(db: Queryable): Promise<StoredModeValue> {
  const raw = await getKv(db, MODE_KV_KEY);
  if (raw === undefined) return LIVE_STORED;
  const parsed = StoredMode.safeParse(raw);
  if (!parsed.success) {
    log.warn({ key: MODE_KV_KEY }, "stored mode is malformed; treating it as live");
    return LIVE_STORED;
  }
  const value = parsed.data;
  if (typeof value === "string") return { mode: value, reason: null, since: null };
  return { mode: value.mode, reason: text(value.reason), since: text(value.since) };
}

export async function readMode(db: Queryable): Promise<Mode> {
  return (await readStoredMode(db)).mode;
}

/** Stores the mode with why and when, for the replay-only banner ("Live analysis paused (<reason>)"). */
export async function writeMode(db: Queryable, mode: Mode, reason: string, now: Date = new Date()): Promise<void> {
  await setKv(db, MODE_KV_KEY, { mode, reason, since: now.toISOString() });
}
