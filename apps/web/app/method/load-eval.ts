import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEvalSummary, type EvalState } from "../../components/method/eval-summary";

/**
 * Where the eval writes its summary: apps/web/content/eval-summary.json. The app runs from apps/web
 * (next dev and next build); tools and tests run from the repository root.
 */
export function evalSummaryCandidates(cwd: string = process.cwd()): string[] {
  return [path.join(cwd, "content", "eval-summary.json"), path.join(cwd, "apps", "web", "content", "eval-summary.json")];
}

/**
 * The eval summary for /method#eval, read when the page renders (at build time for the static page,
 * so a new summary ships with the next build). Missing until the eval has run.
 */
export function loadEvalSummary(files: readonly string[] = evalSummaryCandidates()): EvalState {
  for (const file of files) {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      return { state: "invalid", reason: (err as Error).message };
    }
    return parseEvalSummary(text);
  }
  return { state: "missing" };
}
