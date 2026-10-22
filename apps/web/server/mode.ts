import "server-only";
import { Mode } from "@ct/contracts";
import { getKv, setKv, type Queryable } from "@ct/db";
import { z } from "zod";
import { log } from "./log";

/**
 * The service mode in kv (PLAN §11.6): live, economy or replay_only. Absent means live. The Qloo
 * client asks for replay_only after repeated auth failures or below its month floor; the admin
 * mode switch (Part 7) writes the same key.
 */

export const MODE_KV_KEY = "mode";

/** What writeMode stores. A bare mode string, as someone might set by hand, is read too. */
const StoredMode = z.union([Mode, z.looseObject({ mode: Mode })]);

export async function readMode(db: Queryable): Promise<Mode> {
  const raw = await getKv(db, MODE_KV_KEY);
  if (raw === undefined) return "live";
  const parsed = StoredMode.safeParse(raw);
  if (!parsed.success) {
    log.warn({ key: MODE_KV_KEY }, "stored mode is malformed; treating it as live");
    return "live";
  }
  return typeof parsed.data === "string" ? parsed.data : parsed.data.mode;
}

/** Stores the mode with why and when, for the replay-only banner ("Live analysis paused (<reason>)"). */
export async function writeMode(db: Queryable, mode: Mode, reason: string, now: Date = new Date()): Promise<void> {
  await setKv(db, MODE_KV_KEY, { mode, reason, since: now.toISOString() });
}
