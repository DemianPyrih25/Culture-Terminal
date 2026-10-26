import "server-only";
import { Lane } from "@ct/contracts";
import type { Queryable } from "@ct/db";
import { QUESTION_HASH_PREFIX } from "./question-hash";

/**
 * Agent runs of one lane created within the window, whatever their status, counted on the database
 * clock like countRunsSince (which has no lane filter yet). The statement is built only from the
 * Lane enum, the fixed hash prefix and a whole number of seconds: nothing from a request reaches it.
 */
export async function countLaneRunsSince(db: Queryable, lane: Lane, sinceMs: number): Promise<number> {
  const checked = Lane.parse(lane);
  const seconds = Math.round(sinceMs / 1000);
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new RangeError(`countLaneRunsSince: window must be a positive number of ms, got ${sinceMs}`);
  if (!/^[a-z0-9]+:$/.test(QUESTION_HASH_PREFIX)) throw new Error("countLaneRunsSince: unexpected hash prefix");
  const rows = await db.execute(
    // Runs the dev CLI recorded (ids "cli-...", e.g. a showcase prewarm) are not visitors' runs.
    `select count(*)::int as n from runs where lane = '${checked}' and question_hash like '${QUESTION_HASH_PREFIX}%' ` +
      `and id not like 'cli-%' and created_at >= now() - make_interval(secs => ${seconds})`,
  );
  const first = (rows as unknown as ReadonlyArray<{ n?: unknown }>)[0];
  return Number(first?.n ?? 0);
}
