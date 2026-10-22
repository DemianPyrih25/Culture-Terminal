// The dev LLM spend guard for run-agent: LLM_DEV_USD_CAP against what run-agent has spent so far,
// kept in a local tally under .private/ (gitignored). A run reserves its worst case before it starts
// and settles to its measured spend when it returns, so a crash, a hard quit or a second run started
// meanwhile never sees less than the worst case of a run still in flight.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const SPEND_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.private/run-agent/spend.json");

/** .env.example's development bucket. */
export const DEFAULT_DEV_USD_CAP = 15;

export interface SpendTally {
  usd: number;
  runs: number;
  updatedAt: string | null;
}

/** A tally that exists but cannot be read: the guard refuses rather than start again from $0. */
export class SpendFileError extends Error {
  override readonly name = "SpendFileError";
}

/** A USD amount from the environment, or `fallback` when unset or empty. */
export function readUsdCap(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of US dollars, got "${raw}"`);
  return value;
}

const isCode = (err: unknown, code: string): boolean => typeof err === "object" && err !== null && (err as { code?: unknown }).code === code;

/** The tally; zero only when the file does not exist yet. Throws SpendFileError for any other failure. */
export function readSpend(file: string): SpendTally {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    if (isCode(err, "ENOENT")) return { usd: 0, runs: 0, updatedAt: null };
    throw new SpendFileError(`the spend tally ${file} cannot be read (${err instanceof Error ? err.message : String(err)})`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    raw = null;
  }
  const t = (typeof raw === "object" && raw !== null ? raw : {}) as Partial<Record<keyof SpendTally, unknown>>;
  const valid =
    typeof t.usd === "number" &&
    Number.isFinite(t.usd) &&
    t.usd >= 0 &&
    typeof t.runs === "number" &&
    Number.isInteger(t.runs) &&
    t.runs >= 0 &&
    (t.updatedAt === null || typeof t.updatedAt === "string");
  if (!valid) throw new SpendFileError(`the spend tally ${file} is not a valid tally; fix it, or delete it to start again from $0`);
  return { usd: t.usd as number, runs: t.runs as number, updatedAt: t.updatedAt as string | null };
}

/** Written to a temporary file and renamed into place, so a crash mid-write never leaves a torn tally. */
function writeSpend(file: string, tally: SpendTally): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(tally, null, 2)}\n`, "utf8");
  renameSync(temp, file);
}

export interface SpendCheck {
  ok: boolean;
  capUsd: number;
  spentUsd: number;
  estimateUsd: number;
}

/** Refuses when what was spent plus the worst case of the next run would pass the cap. */
export function checkSpend(capUsd: number, spentUsd: number, estimateUsd: number): SpendCheck {
  return { ok: spentUsd + estimateUsd <= capUsd, capUsd, spentUsd, estimateUsd };
}

/**
 * Re-reads the tally, checks the cap and, when the run fits, books its worst case and counts the run,
 * with nothing in between the read and the write. The tally is unchanged when the run does not fit.
 */
export function reserveSpend(file: string, capUsd: number, worstCaseUsd: number, now: Date): { check: SpendCheck; tally: SpendTally } {
  const before = readSpend(file);
  const check = checkSpend(capUsd, before.usd, worstCaseUsd);
  if (!check.ok) return { check, tally: before };
  const tally: SpendTally = { usd: before.usd + worstCaseUsd, runs: before.runs + 1, updatedAt: now.toISOString() };
  writeSpend(file, tally);
  return { check, tally };
}

/** Replaces a reservation with what the run measured: adds `deltaUsd` (negative when it spent less). */
export function settleSpend(file: string, deltaUsd: number, now: Date): SpendTally {
  const before = readSpend(file);
  const tally: SpendTally = { usd: Math.max(0, before.usd + deltaUsd), runs: before.runs, updatedAt: now.toISOString() };
  writeSpend(file, tally);
  return tally;
}
