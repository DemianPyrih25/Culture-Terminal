// pnpm run-agent "<question>" --yes  (tsx --env-file-if-exists=.env tools/dev/run-agent.ts)
//
// One full agent run from the terminal: a live trace (CLERK, resolution, plan, tool calls, Qloo
// chips with cache status and request id, findings, pivots, CHECKER) and the finished note with its
// receipt. The LLM calls are live and cost money: see --help for the guard. Ctrl+C cancels the run;
// a second Ctrl+C quits at once, and the spend tally already holds the run's worst case.
import { runAgentCommand } from "./cli/agent-cli";
import { consoleIo } from "./cli/io";
import { terminalSafe } from "./cli/table";

const controller = new AbortController();
// A listener that stays: with one registered, Node no longer exits on SIGINT by itself.
process.on("SIGINT", () => {
  if (!controller.signal.aborted) {
    consoleIo.err("\ncancelling the run (Ctrl+C again to quit at once)");
    controller.abort(new Error("cancelled from the terminal"));
    return;
  }
  consoleIo.err("quitting at once: the spend tally keeps this run's worst case; a --persist run is left for the web's orphan check");
  process.exit(130);
});

runAgentCommand(process.argv.slice(2), { env: process.env, io: consoleIo, signal: controller.signal }).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    consoleIo.err(terminalSafe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    process.exitCode = 1;
  },
);
