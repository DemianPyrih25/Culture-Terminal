// pnpm kit-parity <name…> [--live-kit]  (tsx --env-file-if-exists=.env tools/kit-parity/run.ts)
//
// D30 kit parity, dev only: our resolve_entities against the Qloo kit CLI for a few public names.
// Without --live-kit it prints what it would compare and calls nothing. See --help.
import { consoleIo } from "../dev/cli/io";
import { terminalSafe } from "../dev/cli/table";
import { runKitParityCommand } from "./parity";

runKitParityCommand(process.argv.slice(2), { env: process.env, io: consoleIo }).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    consoleIo.err(terminalSafe(err instanceof Error ? (err.stack ?? err.message) : String(err)));
    process.exitCode = 1;
  },
);
