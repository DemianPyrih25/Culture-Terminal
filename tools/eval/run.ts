// pnpm exec tsx --env-file-if-exists=.env tools/eval/run.ts <grounded|ghost|both|reality|all> --yes [options]
// pnpm exec tsx tools/eval/run.ts summary [--stamp S] [--write-summary]
//
// The offline eval and the Reality Check (SPEC §6.6, §6.7): see tools/eval/cli.ts and --help; the
// Reality Check arm is tools/eval/reality-arm.ts. The LLM and Qloo calls are live and cost money;
// --usd-cap stops the eval before a unit whose worst case would pass it. Ctrl+C stops after the unit in
// progress; a second Ctrl+C quits at once, and the eval's spend tally keeps that unit's worst case.
import { consoleIo } from "../dev/cli/io";
import { terminalSafe } from "../dev/cli/table";
import { runEvalCommand } from "./cli";
import { createRealityArm } from "./reality-arm";

const controller = new AbortController();
// A listener that stays: with one registered, Node no longer exits on SIGINT by itself.
process.on("SIGINT", () => {
  if (!controller.signal.aborted) {
    consoleIo.err("\nstopping after the unit in progress (Ctrl+C again to quit at once)");
    controller.abort(new Error("cancelled from the terminal"));
    return;
  }
  consoleIo.err("quitting at once: the eval's spend tally keeps the unit's worst case; --resume runs it again");
  process.exit(130);
});

runEvalCommand(process.argv.slice(2), { env: process.env, io: consoleIo, signal: controller.signal, createReality: (context) => createRealityArm(context) }).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    consoleIo.err(terminalSafe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    process.exitCode = 1;
  },
);
