import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { RunEvent } from "@ct/contracts";

/**
 * Every recorded sample run in apps/web/server/samples, read from disk on each request so a sample the
 * agent stream adds (`<name>.events.json`, written by tools/dev/sample-run.ts) shows up without a code
 * change here. Development only: the /dev/brief page that uses it answers 404 in production.
 */

const SUFFIX = ".events.json";
/** A sample's name: the file name without its suffix. Nothing else reaches the file system. */
const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The samples folder, whether the server runs from apps/web (next dev) or the repo root (tests). */
export function samplesDir(cwd: string = process.cwd()): string {
  const local = path.join(cwd, "server", "samples");
  return existsSync(local) ? local : path.join(cwd, "apps", "web", "server", "samples");
}

/** The sample names on disk, sorted. */
export function listSampleFiles(dir: string = samplesDir()): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(SUFFIX))
    .map((f) => f.slice(0, -SUFFIX.length))
    .filter((name) => NAME.test(name))
    .sort();
}

export type SampleFile = { kind: "ok"; name: string; runId: string; events: RunEvent[] } | { kind: "missing" } | { kind: "invalid"; name: string; error: string };

/** One sample's events, checked against the RunEvent schema; "missing" for an unknown or unsafe name. */
export function readSampleFile(name: string, dir: string = samplesDir()): SampleFile {
  if (!NAME.test(name) || !listSampleFiles(dir).includes(name)) return { kind: "missing" };
  try {
    const events = RunEvent.array().min(1).parse(JSON.parse(readFileSync(path.join(dir, `${name}${SUFFIX}`), "utf8")));
    return { kind: "ok", name, runId: (events[0] as RunEvent).runId, events };
  } catch (error) {
    return { kind: "invalid", name, error: error instanceof Error ? error.message.slice(0, 600) : String(error) };
  }
}
