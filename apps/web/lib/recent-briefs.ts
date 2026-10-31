import { isRunId } from "./run-id";

/**
 * This browser's own briefs (D31: user-run notes are unlisted). Home and the library list the
 * showcases plus the runs this browser started, which it names to GET /api/runs as `ids`; the server
 * keeps no list of who ran what. The ids live in localStorage, newest first and bounded. Storage can
 * be missing or blocked (private windows, a strict privacy setting, a server render): every access is
 * guarded, and without it the lists simply show the showcases.
 */

/** The localStorage item name. */
export const RECENT_BRIEFS_SLOT = "ct.recent-briefs.v1";
/** Most run ids kept; the oldest go first. */
export const RECENT_BRIEFS_MAX = 100;
/** Most ids one list request names (GET /api/runs takes up to 50). */
export const RECENT_BRIEFS_QUERY_MAX = 50;

/** The two Storage methods used, so tests can pass a stand-in. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** window.localStorage, or null where there is none or reading it throws (blocked storage). */
export function browserStorage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Valid, distinct run ids from what was stored, newest first; anything else reads as nothing. */
function parseIds(raw: string | null): string[] {
  if (raw === null) return [];
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter(isRunId))].slice(0, RECENT_BRIEFS_MAX);
}

/** The run ids this browser started, newest first; empty when storage is missing or blocked. */
export function readRecentRunIds(storage: StorageLike | null = browserStorage()): string[] {
  if (storage === null) return [];
  try {
    return parseIds(storage.getItem(RECENT_BRIEFS_SLOT));
  } catch {
    return [];
  }
}

/**
 * Records a run this browser started (from Ask or a picker answer) as its newest brief, and returns
 * the list as stored. Never throws: a run that cannot be recorded still runs, it just is not listed.
 */
export function rememberRun(runId: string, storage: StorageLike | null = browserStorage()): string[] {
  if (!isRunId(runId)) return readRecentRunIds(storage);
  const ids = [runId, ...readRecentRunIds(storage).filter((id) => id !== runId)].slice(0, RECENT_BRIEFS_MAX);
  if (storage === null) return ids;
  try {
    storage.setItem(RECENT_BRIEFS_SLOT, JSON.stringify(ids));
  } catch {
    // A full or blocked storage: the run is not listed, nothing else changes.
  }
  return ids;
}

/** Stores `ids` as the list; false when storage is missing, full or blocked. Never throws. */
function writeIds(ids: readonly string[], storage: StorageLike | null): boolean {
  if (storage === null) return false;
  try {
    storage.setItem(RECENT_BRIEFS_SLOT, JSON.stringify(ids));
    return true;
  } catch {
    return false;
  }
}

/**
 * Takes a run off this browser's list (the answer itself stays at its link) and returns where it was,
 * for restoreRun, or -1 when it was not listed. Never throws: with blocked storage the row comes back
 * on the next visit.
 */
export function forgetRun(runId: string, storage: StorageLike | null = browserStorage()): number {
  const ids = readRecentRunIds(storage);
  const index = ids.indexOf(runId);
  if (index === -1) return -1;
  writeIds([...ids.slice(0, index), ...ids.slice(index + 1)], storage);
  return index;
}

/**
 * Puts a forgotten run back at `index` (clamped to the list; an id already listed stays where it is)
 * and returns the list as stored. Never throws.
 */
export function restoreRun(runId: string, index: number, storage: StorageLike | null = browserStorage()): string[] {
  const ids = readRecentRunIds(storage);
  if (!isRunId(runId) || ids.includes(runId)) return ids;
  const at = Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : 0, ids.length));
  const next = [...ids.slice(0, at), runId, ...ids.slice(at)].slice(0, RECENT_BRIEFS_MAX);
  writeIds(next, storage);
  return next;
}

/** Empties this browser's list (shared links keep working). False when storage is missing or blocked. */
export function clearRecentRuns(storage: StorageLike | null = browserStorage()): boolean {
  return writeIds([], storage);
}

/** The `ids` parameter of a list request: the newest RECENT_BRIEFS_QUERY_MAX ids, or null for none. */
export function recentIdsParam(ids: readonly string[]): string | null {
  const newest = ids.filter(isRunId).slice(0, RECENT_BRIEFS_QUERY_MAX);
  return newest.length === 0 ? null : newest.join(",");
}
